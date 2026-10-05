// The Iceberg REST catalog (Basin Catalog speaks it): namespaces, tables, their metadata, and commits. Ids that do not
// fit in a double (snapshot ids, which others' writers — and the catalog's own maintenance — pick at random over 63
// bits) are kept as strings on the way in and written back as bare numbers on the way out.

export interface IcebergField { id: number; name: string; required: boolean; type: string }
export interface IcebergSchema { type: 'struct'; 'schema-id': number; fields: IcebergField[] }
export interface Snapshot { 'snapshot-id': string; 'parent-snapshot-id'?: string; 'sequence-number'?: number; 'timestamp-ms': number; 'manifest-list': string; summary: Record<string, string>; 'schema-id'?: number }
export interface TableMetadata {
  'format-version': number; 'table-uuid': string; location: string; 'last-sequence-number'?: number; 'last-column-id': number
  'current-schema-id': number; schemas: IcebergSchema[]; 'current-snapshot-id'?: string | null; snapshots?: Snapshot[]
  'default-spec-id'?: number; 'partition-specs'?: { 'spec-id': number; fields: unknown[] }[]; properties?: Record<string, string>
}

const ID_KEYS = /"(snapshot-id|parent-snapshot-id|current-snapshot-id)"\s*:\s*(-?\d+)/g
/** JSON with the snapshot ids kept exact (as strings). */
export const parseExact = (text: string) => JSON.parse(text.replace(ID_KEYS, '"$1":"$2"'))
/** JSON with the snapshot ids written as numbers again (the catalog expects longs). */
export const stringifyExact = (v: unknown) => JSON.stringify(v).replace(/"(snapshot-id|parent-snapshot-id|current-snapshot-id)":"(-?\d+)"/g, '"$1":$2')

export class CatalogError extends Error { constructor(message: string, public status: number, public kind?: string) { super(message) } }

export interface CatalogConfig { uri: string; warehouse: string; token: string }

export function icebergCatalog(cfg: CatalogConfig, fetcher: typeof fetch = fetch) {
  let prefix: Promise<string> | null = null
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetcher(`${cfg.uri.replace(/\/$/, '')}${path}`, { method, headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: typeof body === 'string' ? body : stringifyExact(body) } : {}) })
    const text = await r.text()
    const json = text ? (() => { try { return parseExact(text) } catch { return { raw: text } } })() : {}
    if (!r.ok) throw new CatalogError(json?.error?.message ?? json?.raw ?? `${r.status} ${r.statusText}`, r.status, json?.error?.type)
    return json
  }
  // The catalog names a prefix for this warehouse (GET /v1/config); every other path sits under it.
  const base = () => (prefix ??= call('GET', `/v1/config?warehouse=${encodeURIComponent(cfg.warehouse)}`).then((c) => {
    const p = c?.overrides?.prefix ?? c?.defaults?.prefix
    return p ? `/v1/${encodeURIComponent(p).replace(/%2F/gi, '/')}` : '/v1'
  }).catch((e) => { prefix = null; throw e }))
  const ns = (n: string) => encodeURIComponent(n)

  return {
    async namespaces(): Promise<string[]> { const r = await call('GET', `${await base()}/namespaces`); return (r.namespaces ?? []).map((x: string[]) => x.join('.')) },
    async ensureNamespace(name: string, properties: Record<string, string> = {}) {
      try { await call('POST', `${await base()}/namespaces`, { namespace: [name], properties }) }
      catch (e) { if (!(e instanceof CatalogError && e.status === 409)) throw e }
    },
    async tables(namespace: string): Promise<string[]> {
      try { const r = await call('GET', `${await base()}/namespaces/${ns(namespace)}/tables`); return (r.identifiers ?? []).map((x: { name: string }) => x.name) }
      catch (e) { if (e instanceof CatalogError && e.status === 404) return []; throw e }
    },
    async load(namespace: string, table: string): Promise<{ metadata: TableMetadata; location?: string }> {
      const r = await call('GET', `${await base()}/namespaces/${ns(namespace)}/tables/${encodeURIComponent(table)}`)
      return { metadata: r.metadata, location: r['metadata-location'] }
    },
    async create(namespace: string, table: string, schema: IcebergSchema, properties: Record<string, string> = {}): Promise<TableMetadata> {
      const r = await call('POST', `${await base()}/namespaces/${ns(namespace)}/tables`, { name: table, schema, properties: { 'format-version': '2', ...properties } })
      return r.metadata
    },
    /** A commit: what must still be true (requirements), what changes (updates). A conflict is a CatalogError with status 409. */
    async commit(namespace: string, table: string, requirements: unknown[], updates: unknown[]): Promise<TableMetadata> {
      const r = await call('POST', `${await base()}/namespaces/${ns(namespace)}/tables/${encodeURIComponent(table)}`, { requirements, updates })
      return r.metadata
    },
  }
}
export type IcebergCatalog = ReturnType<typeof icebergCatalog>
