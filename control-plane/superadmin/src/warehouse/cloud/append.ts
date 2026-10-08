// Appending rows to an Iceberg table from a Worker: one Parquet data file (columns carry the table's field ids), one
// manifest naming it, a manifest list that carries the parent snapshot's manifests forward, and a commit that adds the
// snapshot only if the table has not moved meanwhile (on a conflict, the list is made again on the new parent).
// Unpartitioned tables only (the tables this module makes); the catalog's maintenance compacts the small files.

import { parquetWriteBuffer } from 'hyparquet-writer'
import { readAvro, writeAvro, type AvroSchema } from './avro'
import { CatalogError, type IcebergCatalog, type IcebergField, type TableMetadata } from './catalog'

/** Where the data and metadata files go: the bucket the catalog keeps the warehouse in. */
export interface ObjectStore {
  /** The address every file under it starts with: s3://<bucket> for the cloud. */
  root: string
  put(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
}

const MANIFEST: AvroSchema = { type: 'record', name: 'manifest_entry', fields: [
  { name: 'status', type: 'int', 'field-id': 0 },
  { name: 'snapshot_id', type: ['null', 'long'], default: null, 'field-id': 1 },
  { name: 'sequence_number', type: ['null', 'long'], default: null, 'field-id': 3 },
  { name: 'file_sequence_number', type: ['null', 'long'], default: null, 'field-id': 4 },
  { name: 'data_file', 'field-id': 2, type: { type: 'record', name: 'r2', fields: [
    { name: 'content', type: 'int', 'field-id': 134 },
    { name: 'file_path', type: 'string', 'field-id': 100 },
    { name: 'file_format', type: 'string', 'field-id': 101 },
    { name: 'partition', type: { type: 'record', name: 'r102', fields: [] }, 'field-id': 102 },
    { name: 'record_count', type: 'long', 'field-id': 103 },
    { name: 'file_size_in_bytes', type: 'long', 'field-id': 104 },
  ] } },
] }
const MANIFEST_LIST: AvroSchema = { type: 'record', name: 'manifest_file', fields: [
  { name: 'manifest_path', type: 'string', 'field-id': 500 },
  { name: 'manifest_length', type: 'long', 'field-id': 501 },
  { name: 'partition_spec_id', type: 'int', 'field-id': 502 },
  { name: 'content', type: 'int', 'field-id': 517 },
  { name: 'sequence_number', type: 'long', 'field-id': 515 },
  { name: 'min_sequence_number', type: 'long', 'field-id': 516 },
  { name: 'added_snapshot_id', type: 'long', 'field-id': 503 },
  { name: 'added_files_count', type: 'int', 'field-id': 504 },
  { name: 'existing_files_count', type: 'int', 'field-id': 505 },
  { name: 'deleted_files_count', type: 'int', 'field-id': 506 },
  { name: 'added_rows_count', type: 'long', 'field-id': 512 },
  { name: 'existing_rows_count', type: 'long', 'field-id': 513 },
  { name: 'deleted_rows_count', type: 'long', 'field-id': 514 },
] }

/** <root>/path → path, under the store's root only (a table elsewhere is not written to). */
function keyOf(uri: string, store: ObjectStore): string {
  const root = store.root.replace(/\/$/, '') + '/'
  const u = uri.replace(/^s3a:\/\//, 's3://')
  if (!u.startsWith(root)) throw new Error(`the table lives at "${uri}", outside the warehouse's storage (${store.root})`)
  return u.slice(root.length)
}
const snapshotId = () => { const b = crypto.getRandomValues(new Uint8Array(8)); b[0] &= 0x7f; return BigInt('0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')).toString() }

/** A value as the column's Parquet physical type wants it. */
function cell(type: string, v: unknown): unknown {
  if (v === null || v === undefined || v === '') return null
  switch (type) {
    case 'long': return typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? BigInt(v.trim()) : BigInt(Math.trunc(Number(v)))   // an integer as text, exactly
    case 'int': return Math.trunc(Number(v))
    case 'double': case 'float': return Number(v)
    case 'boolean': return v === true || v === 'true' || v === 1
    case 'date': { const d = typeof v === 'number' ? v : Math.floor(Date.parse(String(v).slice(0, 10) + 'T00:00:00Z') / 86400000); return Number.isFinite(d) ? d : null }
    case 'timestamptz': case 'timestamp': { const ms = typeof v === 'number' ? v : Date.parse(String(v)); return Number.isFinite(ms) ? BigInt(ms) * 1000n : null }
    default: return String(v)
  }
}
function element(f: IcebergField) {
  const base = { name: f.name, repetition_type: f.required ? 'REQUIRED' : 'OPTIONAL', field_id: f.id }
  switch (f.type) {
    case 'long': return { ...base, type: 'INT64' }
    case 'int': return { ...base, type: 'INT32' }
    case 'double': return { ...base, type: 'DOUBLE' }
    case 'float': return { ...base, type: 'FLOAT' }
    case 'boolean': return { ...base, type: 'BOOLEAN' }
    case 'date': return { ...base, type: 'INT32', converted_type: 'DATE', logical_type: { type: 'DATE' } }
    case 'timestamptz': return { ...base, type: 'INT64', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' } }
    case 'timestamp': return { ...base, type: 'INT64', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: false, unit: 'MICROS' } }
    case 'string': return { ...base, type: 'BYTE_ARRAY', converted_type: 'UTF8', logical_type: { type: 'STRING' } }
    default: throw new Error(`a column of type ${f.type} cannot be written here`)
  }
}

/** The rows as one Parquet file for the table's current schema (a column the rows do not carry is written empty). */
export function parquetFor(fields: IcebergField[], rows: Record<string, unknown>[]): Uint8Array {
  for (const f of fields) if (f.required && rows.some((r) => r[f.name] === null || r[f.name] === undefined)) throw new Error(`column ${f.name} is required and a row has no value for it`)
  const schema = [{ name: 'table', num_children: fields.length }, ...fields.map(element)]
  const columnData = fields.map((f) => ({ name: f.name, data: rows.map((r) => cell(f.type, r[f.name])) }))
  return new Uint8Array(parquetWriteBuffer({ columnData, schema: schema as any }))
}

export async function appendRows(catalog: IcebergCatalog, store: ObjectStore, namespace: string, table: string, rows: Record<string, unknown>[], attempts = 5): Promise<{ snapshot: string; file: string; rows: number }> {
  if (!rows.length) throw new Error('there are no rows to append')
  const first = await catalog.load(namespace, table)
  const meta0 = first.metadata
  const spec = (meta0['partition-specs'] ?? []).find((s) => s['spec-id'] === (meta0['default-spec-id'] ?? 0))
  if (spec && spec.fields.length) throw new Error(`${namespace}.${table} is partitioned; appending to a partitioned table is not supported here`)
  const schema = meta0.schemas.find((s) => s['schema-id'] === meta0['current-schema-id'])!
  const loc = meta0.location.replace(/\/$/, '')
  const snap = snapshotId()
  const uuid = crypto.randomUUID()

  // The data file and its manifest are written once; only the manifest list depends on the parent.
  const data = parquetFor(schema.fields, rows)
  const dataPath = `${loc}/data/${uuid}.parquet`
  await store.put(keyOf(dataPath, store), data)
  const manifest = writeAvro(MANIFEST, [{ status: 1, snapshot_id: BigInt(snap), sequence_number: null, file_sequence_number: null,
    data_file: { content: 0, file_path: dataPath, file_format: 'PARQUET', partition: {}, record_count: BigInt(rows.length), file_size_in_bytes: BigInt(data.length) } }],
    { schema: JSON.stringify(schema), 'schema-id': String(schema['schema-id']), 'partition-spec': '[]', 'partition-spec-id': '0', 'format-version': '2', content: 'data' })
  const manifestPath = `${loc}/metadata/${uuid}-m0.avro`
  await store.put(keyOf(manifestPath, store), manifest)

  let meta: TableMetadata = meta0
  for (let attempt = 0; ; attempt++) {
    const parent = meta['current-snapshot-id'] && meta['current-snapshot-id'] !== '-1' ? String(meta['current-snapshot-id']) : null
    const seq = (meta['last-sequence-number'] ?? 0) + 1
    const previous: any[] = []
    if (parent) {
      const p = (meta.snapshots ?? []).find((s) => String(s['snapshot-id']) === parent)
      const bytes = p ? await store.get(keyOf(p['manifest-list'], store)) : null
      if (!bytes) throw new Error(`the manifest list of snapshot ${parent} could not be read`)
      for (const m of (await readAvro(bytes)).records) previous.push({
        manifest_path: m.manifest_path, manifest_length: m.manifest_length, partition_spec_id: m.partition_spec_id, content: m.content ?? 0,
        sequence_number: m.sequence_number ?? 0n, min_sequence_number: m.min_sequence_number ?? 0n, added_snapshot_id: m.added_snapshot_id,
        added_files_count: m.added_files_count ?? m.added_data_files_count ?? 0, existing_files_count: m.existing_files_count ?? m.existing_data_files_count ?? 0, deleted_files_count: m.deleted_files_count ?? m.deleted_data_files_count ?? 0,
        added_rows_count: m.added_rows_count ?? 0n, existing_rows_count: m.existing_rows_count ?? 0n, deleted_rows_count: m.deleted_rows_count ?? 0n,
      })
    }
    const list = writeAvro(MANIFEST_LIST, [{ manifest_path: manifestPath, manifest_length: BigInt(manifest.length), partition_spec_id: 0, content: 0,
      sequence_number: BigInt(seq), min_sequence_number: BigInt(seq), added_snapshot_id: BigInt(snap), added_files_count: 1, existing_files_count: 0, deleted_files_count: 0,
      added_rows_count: BigInt(rows.length), existing_rows_count: 0n, deleted_rows_count: 0n }, ...previous],
      { 'snapshot-id': snap, 'parent-snapshot-id': parent ?? 'null', 'sequence-number': String(seq), 'format-version': '2' })
    const listPath = `${loc}/metadata/snap-${snap}-${attempt}-${uuid}.avro`
    await store.put(keyOf(listPath, store), list)
    // The table's rows so far: none before its first append; otherwise what the parent snapshot counted (if it did).
    // Where the parent did not count (an older writer), its manifests do: the rows each data manifest added or kept. Any
    // delete manifest and the count is left out rather than guessed.
    const counted = parent ? (meta.snapshots ?? []).find((s) => String(s['snapshot-id']) === parent)?.summary?.['total-records'] : '0'
    const fromManifests = previous.every((m) => Number(m.content) === 0) ? String(previous.reduce((n, m) => n + Number(m.added_rows_count) + Number(m.existing_rows_count), 0)) : undefined
    const total = counted ?? fromManifests
    const snapshot = { 'snapshot-id': snap, ...(parent ? { 'parent-snapshot-id': parent } : {}), 'sequence-number': seq, 'timestamp-ms': Date.now(), 'manifest-list': listPath, 'schema-id': schema['schema-id'],
      summary: { operation: 'append', 'added-data-files': '1', 'added-records': String(rows.length), 'added-files-size': String(data.length), ...(total !== undefined ? { 'total-records': String(Number(total) + rows.length) } : {}) } }
    try {
      await catalog.commit(namespace, table, [{ type: 'assert-ref-snapshot-id', ref: 'main', 'snapshot-id': parent }],
        [{ action: 'add-snapshot', snapshot }, { action: 'set-snapshot-ref', 'ref-name': 'main', type: 'branch', 'snapshot-id': snap }])
      return { snapshot: snap, file: dataPath, rows: rows.length }
    } catch (e) {
      if (!(e instanceof CatalogError && e.status === 409) || attempt + 1 >= attempts) throw e
      meta = (await catalog.load(namespace, table)).metadata   // someone else committed: make the list again on theirs
    }
  }
}
