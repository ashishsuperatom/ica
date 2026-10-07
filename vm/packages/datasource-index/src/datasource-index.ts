// DATASOURCE INDEX — a FLAT, full-text-searchable map of every field in every datasource.
// One row per field. The key is a flat, NAME-based string `SOURCE.CONTAINER.FIELD` (CONTAINER = table or API
// collection; FIELD = column / attribute). Because a container/field name may itself contain dots, the source,
// container and field are ALSO stored split-out (the RHS) so they're always recoverable unambiguously.
//
// This is NOT introspection: introspection is live, per-source, and does stats/joins. This index is the
// always-available, CROSS-source structure map an agent searches FIRST — in the index ⇒ it exists; not in it ⇒
// it doesn't. It is a REPLICA: the platform holds each source's index (built wherever the source's connector runs) and
// this engine applies what changed after its cursor (applyItems); nothing else writes it. A table is a row of
// dsi_tables, its fields rows of datasource_index; a disabled or gone table hides all its fields, a disabled or gone
// field itself — from find-schema and get-schema (queries are not blocked).

import type { DataSourceIndex } from './store.js'

export interface DataSourceEntry {
  key: string                 // 'SOURCE.CONTAINER.FIELD' — flat, name-based, stable; the FTS key
  source: string              // datasource NAME (e.g. 'erp') — names, never ids, so search reads meaningfully
  container: string           // table / collection name
  field: string               // column / attribute / field name
  type?: string               // the field's type — native for SQL ('nvarchar','int','NUMBER'); a shape for API/JSON ('string[]','object')
  descDefault?: string        // description defined in the source (a column comment, if any)
  descAi?: string             // AI-written description
  descHuman?: string          // a person's description (wins the preference order)
  isOptional?: boolean        // nullable
  isKey?: boolean             // part of the primary key
  references?: string         // the FK target this field joins to, as 'CONTAINER.FIELD' (cheap-if-available only)
  rows?: number               // approximate row count of this field's CONTAINER (0 = empty → auto-disabled). null = unknown
  enabled?: boolean           // false disables this field (or whole table) from being used; default true
}

/** Preference order for a description: a person's, then the source's own, then an AI's. */
export function describeEntry(e: Pick<DataSourceEntry, 'descHuman' | 'descAi' | 'descDefault'>): string {
  return (e.descHuman?.trim() || e.descDefault?.trim() || e.descAi?.trim() || '')
}

/** A field shows only when it, and its table, are enabled and still in the source (d: the field's row). */
const VISIBLE = `d.enabled = 1 AND d.gone = 0 AND NOT EXISTS (SELECT 1 FROM dsi_tables t WHERE t.source = d.source AND t.container = d.container AND (t.enabled = 0 OR t.gone = 1))`

/** One item of the platform's index, as it pulls (a table when field is ''). */
export interface ReplicaItem { source: string; table: string; field: string; type: string | null; descSource: string | null; descHuman: string | null; descAi: string | null
  optional: boolean | null; key: boolean | null; references: string | null; rows: number | null; enabled: boolean; gone: boolean; seq: number }

/** Apply what the platform's index changed — the replica's only writer — and move its cursor to the last applied. */
export function applyItems(store: DataSourceIndex, items: ReplicaItem[], cursor: number): void {
  const table = store.db.prepare(`INSERT INTO dsi_tables (source, container, rows, enabled, gone, desc_source, desc_human, desc_ai) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, container) DO UPDATE SET rows = excluded.rows, enabled = excluded.enabled, gone = excluded.gone, desc_source = excluded.desc_source, desc_human = excluded.desc_human, desc_ai = excluded.desc_ai`)
  const field = store.db.prepare(`INSERT INTO datasource_index (key, source, container, field, type, desc_default, desc_ai, desc_human, is_optional, is_key, references_, rows, enabled, gone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT (key) DO UPDATE SET type = excluded.type, desc_default = excluded.desc_default, desc_ai = excluded.desc_ai,
    desc_human = excluded.desc_human, is_optional = excluded.is_optional, is_key = excluded.is_key, references_ = excluded.references_, enabled = excluded.enabled, gone = excluded.gone`)
  const b = (v: boolean | null) => (v == null ? null : v ? 1 : 0)
  store.db.transaction(() => {
    for (const i of items) {
      if (i.field === '') table.run(i.source, i.table, i.rows, i.enabled ? 1 : 0, i.gone ? 1 : 0, i.descSource, i.descHuman, i.descAi)
      else field.run(dsiKey(i.source, i.table, i.field), i.source, i.table, i.field, i.type, i.descSource, i.descAi, i.descHuman, b(i.optional), b(i.key), i.references, i.enabled ? 1 : 0, i.gone ? 1 : 0)
    }
    store.db.prepare("INSERT INTO dsi_meta (key, value) VALUES ('cursor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(cursor))
  })()
}
/** How far the replica has the platform's index (0: nothing yet). */
export function replicaCursor(store: DataSourceIndex): number {
  return Number((store.db.prepare("SELECT value FROM dsi_meta WHERE key = 'cursor'").get() as any)?.value ?? 0)
}
/** Empty the replica (it is rebuilt from the platform). */
export function wipeReplica(store: DataSourceIndex): void {
  store.db.transaction(() => { store.db.exec('DELETE FROM datasource_index; DELETE FROM dsi_tables; DELETE FROM dsi_meta') })()
}

/** The index's SCHEMA. Exported so the store creates it when its database is opened.
 *
 *  This is not an optional extra: every project has datasources, and this table is how an agent finds where a
 *  field lives. Creating it lazily meant it existed only once something had already touched it — so on a
 *  database nobody had used yet the builder read a table no writer had created, and the whole build died on
 *  its first act. Foundational things are bootstrapped, not waited for. */
export const DATASOURCE_INDEX_SCHEMA = `
    CREATE TABLE IF NOT EXISTS datasource_index (
      key          TEXT PRIMARY KEY,       -- SOURCE.CONTAINER.FIELD (flat, name-based)
      source       TEXT NOT NULL,
      container    TEXT NOT NULL,
      field        TEXT NOT NULL,
      type         TEXT,
      desc_default TEXT,
      desc_ai      TEXT,
      desc_human   TEXT,
      is_optional  INTEGER,
      is_key       INTEGER,
      references_  TEXT,                    -- FK target 'CONTAINER.FIELD' (trailing _ : REFERENCES is reserved)
      rows         INTEGER,                 -- approx row count of the CONTAINER (0 = empty → auto-disabled)
      enabled      INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS dsi_source    ON datasource_index(source);
    CREATE INDEX IF NOT EXISTS dsi_container ON datasource_index(source, container);
    -- The searchable "line" = the flat key + the type + all descriptions (search by field name, by type, or by
    -- what a column MEANS — not just its name).
    CREATE VIRTUAL TABLE IF NOT EXISTS datasource_index_fts USING fts5(
      key, container, field, type, desc_default, desc_ai, desc_human,
      content='datasource_index', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS dsi_ai AFTER INSERT ON datasource_index BEGIN
      INSERT INTO datasource_index_fts(rowid, key, container, field, type, desc_default, desc_ai, desc_human)
      VALUES (new.rowid, new.key, new.container, new.field, new.type, new.desc_default, new.desc_ai, new.desc_human);
    END;
    CREATE TRIGGER IF NOT EXISTS dsi_ad AFTER DELETE ON datasource_index BEGIN
      INSERT INTO datasource_index_fts(datasource_index_fts, rowid, key, container, field, type, desc_default, desc_ai, desc_human)
      VALUES ('delete', old.rowid, old.key, old.container, old.field, old.type, old.desc_default, old.desc_ai, old.desc_human);
    END;
    CREATE TRIGGER IF NOT EXISTS dsi_au AFTER UPDATE ON datasource_index BEGIN
      INSERT INTO datasource_index_fts(datasource_index_fts, rowid, key, container, field, type, desc_default, desc_ai, desc_human)
      VALUES ('delete', old.rowid, old.key, old.container, old.field, old.type, old.desc_default, old.desc_ai, old.desc_human);
      INSERT INTO datasource_index_fts(rowid, key, container, field, type, desc_default, desc_ai, desc_human)
      VALUES (new.rowid, new.key, new.container, new.field, new.type, new.desc_default, new.desc_ai, new.desc_human);
    END;
  `

export function dsiKey(source: string, container: string, field: string): string {
  return `${source}.${container}.${field}`
}

function rowToEntry(r: any): DataSourceEntry {
  return { key: r.key, source: r.source, container: r.container, field: r.field, type: r.type ?? undefined,
    descDefault: r.desc_default ?? undefined, descAi: r.desc_ai ?? undefined, descHuman: r.desc_human ?? undefined,
    isOptional: r.is_optional == null ? undefined : !!r.is_optional,
    isKey: r.is_key == null ? undefined : !!r.is_key, references: r.references_ ?? undefined,
    rows: r.rows == null ? undefined : r.rows, enabled: !!r.enabled }
}

/** What a schema search found — the rows, AND how much it did not show.
 *
 *  The count is not a nicety. This returns a bounded slice, and an agent handed six fields with no total
 *  concludes there are six. That happened: a search for "customer" returned 6 fields of one source out of 324 in
 *  the index, and the agent reasonably decided that source had almost no customer data. A truncated answer that
 *  cannot be recognised as truncated is worse than a short one. */
export interface DataSourceSearchResult {
  entries: DataSourceEntry[]
  shown: number
  matched: number                    // total rows matching, before the cap
  bySource: Record<string, number>   // matched per source, so a crowded-out source is visible
}

/** Full-text search across the whole index (all sources), or filtered to one `source`. Disabled rows hidden
 *  unless includeDisabled. Falls back to a LIKE scan when the query isn't valid FTS (e.g. bare punctuation).
 *
 *  THREE THINGS THIS GETS RIGHT that the first version did not, each of which made a real search look empty:
 *
 *  1. WORDS ARE OR-ED WHEN AND FINDS NOTHING. Tokens were joined with FTS5's implicit AND, so "vehicle number"
 *     demanded both words in ONE field and returned nothing at all — against an index holding 1,570 vehicle
 *     fields. A two-word search is the most natural thing to type and it could not work. AND is still tried
 *     first, because when it hits it is the better answer; OR is the fallback rather than the default.
 *
 *  2. SOURCES GET A FAIR SHARE. One cap across every source, ordered by bm25, let a source with shorter names
 *     take the whole budget: "customer" returned 54 fields from one source and 6 from another, though the second
 *     had 324 matches to NetSuite's 179 — bm25 favours short documents, and `invoice` is shorter than
 *     `vw_rpt_invoice_register`. Each source now gets its own slice of the limit, and unused slices are given
 *     back, so a wide source cannot be crowded out by a terse one.
 *
 *  3. IT SAYS WHAT IT DID NOT SHOW. See DataSourceSearchResult. */
export function searchDataSource(store: DataSourceIndex, query: string, opts: { source?: string; limit?: number; includeDisabled?: boolean } = {}): DataSourceSearchResult {
  const limit = Math.min(opts.limit ?? 50, 500)
  const where: string[] = []
  const bind: any[] = []
  if (opts.source) { where.push('d.source = ?'); bind.push(opts.source) }
  if (!opts.includeDisabled) where.push(VISIBLE)
  const filter = where.length ? 'AND ' + where.join(' AND ') : ''
  const q = String(query || '').trim()
  const empty = (): DataSourceSearchResult => ({ entries: [], shown: 0, matched: 0, bySource: {} })
  if (!q) return empty()

  const words = q.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"*`)
  const counts = (m: string): Record<string, number> => {
    const rows = store.db.prepare(
      `SELECT d.source AS source, COUNT(*) AS n FROM datasource_index_fts f
       JOIN datasource_index d ON d.rowid = f.rowid
       WHERE datasource_index_fts MATCH ? ${filter} GROUP BY d.source`
    ).all(m, ...bind) as any[]
    return Object.fromEntries(rows.map((r) => [r.source, r.n]))
  }

  try {
    // AND first (precise), then OR (recall). A single word makes both identical, so nothing is paid twice.
    let match = words.join(' ')
    let bySource = counts(match)
    if (!Object.keys(bySource).length && words.length > 1) {
      match = words.join(' OR ')
      bySource = counts(match)
    }
    const matched = Object.values(bySource).reduce((a, b) => a + b, 0)
    if (matched) {
      // FAIR SHARES. Every source with a hit gets limit/N, then whatever the small ones leave over is handed
      // back to the sources that still have more to give — so the budget is spent without any source being
      // silently squeezed out.
      const names = Object.keys(bySource)
      const take: Record<string, number> = {}
      let spare = limit
      let per = Math.max(1, Math.floor(limit / names.length))
      for (const n of names) { take[n] = Math.min(bySource[n], per); spare -= take[n] }
      for (const n of names) {
        if (spare <= 0) break
        const more = Math.min(spare, bySource[n] - take[n])
        take[n] += more; spare -= more
      }
      const entries: DataSourceEntry[] = []
      for (const n of names) {
        if (!take[n]) continue
        const rows = store.db.prepare(
          `SELECT d.* FROM datasource_index_fts f JOIN datasource_index d ON d.rowid = f.rowid
           WHERE datasource_index_fts MATCH ? AND d.source = ? ${filter} ORDER BY rank LIMIT ?`
        ).all(match, n, ...bind, take[n]) as any[]
        entries.push(...rows.map(rowToEntry))
      }
      return { entries, shown: entries.length, matched, bySource }
    }
  } catch { /* not valid FTS (bare punctuation, say) — fall through to LIKE */ }

  const like = `%${q}%`
  const rows = (store.db.prepare(
    `SELECT * FROM datasource_index d WHERE (key LIKE ? OR container LIKE ? OR field LIKE ?) ${filter} LIMIT ?`
  ).all(like, like, like, ...bind, limit) as any[]).map(rowToEntry)
  const total = (store.db.prepare(
    `SELECT COUNT(*) AS n FROM datasource_index d WHERE (key LIKE ? OR container LIKE ? OR field LIKE ?) ${filter}`
  ).get(like, like, like, ...bind) as any)?.n ?? rows.length
  const bySource: Record<string, number> = {}
  for (const e of rows) bySource[e.source] = (bySource[e.source] ?? 0) + 1
  return { entries: rows, shown: rows.length, matched: total, bySource }
}

export function dataSourceStats(store: DataSourceIndex): { source: string; containers: number; fields: number; disabled: number }[] {
  return store.db.prepare(
    `SELECT d.source AS source, COUNT(DISTINCT d.container) AS containers, COUNT(*) AS fields,
            SUM(CASE WHEN ${VISIBLE} THEN 0 ELSE 1 END) AS disabled
     FROM datasource_index d WHERE d.gone = 0 GROUP BY d.source ORDER BY d.source`
  ).all() as any[]
}

/** One level of the index, whole: every source (no arguments), a source's tables with their row counts and field
 *  counts, or one table's fields with type, key, nullability, what each references and its description. Disabled
 *  tables and fields are left out unless asked for. */
export function getSchema(store: DataSourceIndex, source?: string, container?: string, opts: { includeDisabled?: boolean } = {}):
  | { sources: { source: string; tables: number; fields: number }[] }
  | { source: string; tables: { table: string; rows: number | null; fields: number }[] }
  | { source: string; table: string; rows: number | null; fields: { field: string; type: string | null; key: boolean; optional: boolean; references: string | null; description: string }[] } {
  const enabled = opts.includeDisabled ? ' AND d.gone = 0' : ` AND ${VISIBLE}`
  if (!source) {
    const rows = store.db.prepare(`SELECT d.source AS source, COUNT(DISTINCT d.container) AS tables, COUNT(*) AS fields FROM datasource_index d WHERE 1=1${enabled} GROUP BY d.source ORDER BY d.source`).all() as any[]
    return { sources: rows.map((r) => ({ source: r.source, tables: Number(r.tables), fields: Number(r.fields) })) }
  }
  if (!container) {
    const rows = store.db.prepare(`SELECT d.container AS container, (SELECT t.rows FROM dsi_tables t WHERE t.source = d.source AND t.container = d.container) AS rows, COUNT(*) AS fields FROM datasource_index d WHERE d.source = ?${enabled} GROUP BY d.container ORDER BY d.container`).all(source) as any[]
    if (!rows.length) throw new Error(`the index holds no tables for "${source}" — the sources it holds: ${(getSchema(store) as any).sources.map((s: any) => s.source).join(', ') || 'none'}`)
    return { source, tables: rows.map((r) => ({ table: r.container, rows: r.rows == null ? null : Number(r.rows), fields: Number(r.fields) })) }
  }
  const rows = store.db.prepare(`SELECT d.* FROM datasource_index d WHERE d.source = ? AND d.container = ?${enabled} ORDER BY d.rowid`).all(source, container) as any[]
  if (!rows.length) throw new Error(`the index holds no table "${container}" in "${source}" — find it with find-schema`)
  const t = store.db.prepare('SELECT rows FROM dsi_tables WHERE source = ? AND container = ?').get(source, container) as any
  return { source, table: container, rows: t?.rows == null ? null : Number(t.rows), fields: rows.map((r) => ({
    field: r.field, type: r.type ?? null, key: !!r.is_key, optional: !!r.is_optional, references: r.references_ ?? null,
    description: describeEntry({ descHuman: r.desc_human, descAi: r.desc_ai, descDefault: r.desc_default }),
  })) }
}
