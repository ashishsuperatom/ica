// PER-TYPE INDEXERS ("templates"). Each turns a source of a given dialect into flat DataSourceEntry rows for
// the datasource index. Generic per TYPE — zero source-specific coupling: a catalog-less type (e.g. NetSuite)
// takes a seed table list from config, never a hard-coded name. This is the registry the bootstrap script and
// (later) the connector agent both call: buildEntries(dialect, SOURCE_NAME, query, opts).
//
// `source` is the CANONICAL (UPPERCASE) datasource name — it is BOTH the query id (after the rename, the
// manager registers sources under this name) AND the SOURCE segment of every index key. Table/field names are
// preserved EXACTLY as the source spells them.
import { dsiKey, type DataSourceEntry } from '@superatom/node-store'

export type RawQuery = (source: string, sql: string) => Promise<any[]>
export interface IndexerOpts { seedTables?: string[] }   // catalog-less types (NetSuite) index these tables
export type Indexer = (source: string, query: RawQuery, opts: IndexerOpts) => Promise<DataSourceEntry[]>

const trim = (s: any) => String(s ?? '').trim()

// Infer a field's type from a real value (for catalog-less sources). Undefined for null → caller keeps looking.
export function inferType(v: any): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return 'datetime'
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return 'date'
  return 'string'
}

// ── mssql (T-SQL) — has a full catalog: all columns + PKs + FKs in a few bulk queries ──────────────────────
const mssqlIndexer: Indexer = async (source, query) => {
  const cols = await query(source, `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS`)
  const pks = new Set<string>()
  try {
    for (const r of await query(source, `SELECT ku.TABLE_NAME t, ku.COLUMN_NAME c FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`))
      pks.add(trim(r.t) + '.' + trim(r.c))
  } catch { /* PKs optional */ }
  const fks = new Map<string, string>()
  try {
    for (const r of await query(source, `SELECT fk.TABLE_NAME ft, fk.COLUMN_NAME fc, pk.TABLE_NAME tt, pk.COLUMN_NAME tc FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk ON rc.CONSTRAINT_NAME = fk.CONSTRAINT_NAME JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk ON rc.UNIQUE_CONSTRAINT_NAME = pk.CONSTRAINT_NAME AND fk.ORDINAL_POSITION = pk.ORDINAL_POSITION`))
      fks.set(trim(r.ft) + '.' + trim(r.fc), trim(r.tt) + '.' + trim(r.tc))
  } catch { /* FKs optional */ }
  return cols.map((r) => {
    const container = trim(r.TABLE_NAME), field = trim(r.COLUMN_NAME), type = trim(r.DATA_TYPE)
    const ck = container + '.' + field
    return { key: dsiKey(source, container, field), source, container, field, type,
      isOptional: trim(r.IS_NULLABLE).toUpperCase() === 'YES', isKey: pks.has(ck), references: fks.get(ck) }
  })
}

// ── suiteql (NetSuite/REST) — NO catalog: sample several rows of each SEED table, type from first non-null ──
const suiteqlIndexer: Indexer = async (source, query, opts) => {
  const seeds = opts.seedTables ?? []
  const out: DataSourceEntry[] = []
  for (const table of seeds) {
    try {
      const rows = await query(source, `SELECT * FROM ${table} WHERE ROWNUM <= 25`)
      if (!rows.length) continue
      const cols = new Map<string, string | undefined>()
      for (const r of rows) for (const [k, v] of Object.entries(r)) {
        if (!cols.has(k)) cols.set(k, inferType(v))
        else if (cols.get(k) == null && v != null) cols.set(k, inferType(v))
      }
      for (const [field, type] of cols) out.push({ key: dsiKey(source, table, field), source, container: table, field, type })
    } catch { /* skip a table we can't sample */ }
  }
  return out
}

export const INDEXERS: Record<string, Indexer> = { mssql: mssqlIndexer, suiteql: suiteqlIndexer }

/** Build the index rows for ONE source of a given dialect. Throws if the type has no indexer template yet. */
export async function buildEntries(dialect: string, source: string, query: RawQuery, opts: IndexerOpts = {}): Promise<DataSourceEntry[]> {
  const idx = INDEXERS[dialect]
  if (!idx) throw new Error(`no indexer for dialect "${dialect}" (have: ${Object.keys(INDEXERS).join(', ')})`)
  return idx(source, query, opts)
}
