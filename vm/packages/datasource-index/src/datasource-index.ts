// DATASOURCE INDEX — a FLAT, full-text-searchable map of every field in every datasource.
// One row per field. The key is a flat, NAME-based string `SOURCE.CONTAINER.FIELD` (CONTAINER = table or API
// collection; FIELD = column / attribute). Because a container/field name may itself contain dots, the source,
// container and field are ALSO stored split-out (the RHS) so they're always recoverable unambiguously.
//
// This is NOT introspection: introspection is live, per-source, and does stats/joins. This index is the
// always-available, CROSS-source structure map an agent searches FIRST — in the index ⇒ it exists; not in it ⇒
// it doesn't. A separate process (the connector agent) keeps it fresh; readers only search. Enable/disable and
// (later) authorization live here too. No statistics — pure structure.

import type { DataSourceIndex } from './store.js'

export interface DataSourceEntry {
  key: string                 // 'SOURCE.CONTAINER.FIELD' — flat, name-based, stable; the FTS key
  source: string              // datasource NAME (e.g. 'fusion5') — names, never ids, so search reads meaningfully
  container: string           // table / collection name
  field: string               // column / attribute / field name
  type?: string               // the field's type — native for SQL ('nvarchar','int','NUMBER'); a shape for API/JSON ('string[]','object')
  descDefault?: string        // description defined in the source (a column comment, if any)
  descAi?: string             // AI-filled description (later; empty for now)
  descHuman?: string          // human-written description (later; wins the preference order)
  isOptional?: boolean        // nullable
  isKey?: boolean             // part of the primary key
  references?: string         // the FK target this field joins to, as 'CONTAINER.FIELD' (cheap-if-available only)
  rows?: number               // approximate row count of this field's CONTAINER (0 = empty → auto-disabled). null = unknown
  enabled?: boolean           // false disables this field (or whole table) from being used; default true
}

/** Preference order for a field's description: human > ai > source-default. */
export function describeEntry(e: Pick<DataSourceEntry, 'descHuman' | 'descAi' | 'descDefault'>): string {
  return (e.descHuman?.trim() || e.descAi?.trim() || e.descDefault?.trim() || '')
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

/** Still here because callers use it, and it costs nothing to call: every statement is IF NOT EXISTS and the
 *  store has already run the same DDL at open. The ALTER is the one migration this table has ever needed. */
export function ensureDataSourceIndex(store: DataSourceIndex): void {
  store.db.exec(DATASOURCE_INDEX_SCHEMA)
  try { store.db.exec(`ALTER TABLE datasource_index ADD COLUMN rows INTEGER`) } catch { /* column already present */ }
}

/**
 * Record known row counts for a source's containers and AUTO-DISABLE the empty ones (so they never surface in
 * search — an empty table/column is pure distraction). CRITICAL: only pass counts you DEFINITIVELY got (a real
 * 0 = empty). A timeout/error means "unknown, possibly huge" — do NOT include it here, so it stays enabled.
 * Never re-enables a manually-disabled non-empty table (only flips enabled for the containers passed in).
 */
export function applyRowCounts(store: DataSourceIndex, source: string, counts: Record<string, number>): { disabled: number; enabled: number } {
  ensureDataSourceIndex(store)
  let disabled = 0, enabled = 0
  const upd = store.db.prepare('UPDATE datasource_index SET rows=?, enabled=? WHERE source=? AND container=?')
  const tx = store.db.transaction((entries: [string, number][]) => {
    for (const [container, n] of entries) {
      const en = n > 0 ? 1 : 0
      upd.run(n, en, source, container)
      if (en) enabled++; else disabled++
    }
  })
  tx(Object.entries(counts))
  return { disabled, enabled }
}

export function dsiKey(source: string, container: string, field: string): string {
  return `${source}.${container}.${field}`
}

/** Upsert one entry (idempotent on key). The updater process calls this; readers never write. */
export function putEntry(store: DataSourceIndex, e: DataSourceEntry): void {
  ensureDataSourceIndex(store)
  store.db.prepare(`
    INSERT INTO datasource_index (key, source, container, field, type, desc_default, desc_ai, desc_human, is_optional, is_key, references_, rows, enabled)
    VALUES (@key, @source, @container, @field, @type, @descDefault, @descAi, @descHuman, @isOptional, @isKey, @references, @rows, @enabled)
    ON CONFLICT(key) DO UPDATE SET
      type=excluded.type, desc_default=excluded.desc_default, is_optional=excluded.is_optional,
      is_key=excluded.is_key, references_=excluded.references_
      -- NOTE: desc_ai/desc_human/rows/enabled are curated (rows/enabled owned by applyRowCounts), so a refresh never clobbers them.
  `).run({
    key: e.key, source: e.source, container: e.container, field: e.field, type: e.type ?? null,
    descDefault: e.descDefault ?? null, descAi: e.descAi ?? null, descHuman: e.descHuman ?? null,
    isOptional: e.isOptional == null ? null : (e.isOptional ? 1 : 0),
    isKey: e.isKey == null ? null : (e.isKey ? 1 : 0), references: e.references ?? null,
    rows: e.rows == null ? null : e.rows, enabled: e.enabled === false ? 0 : 1,
  })
}

export function putEntries(store: DataSourceIndex, entries: DataSourceEntry[]): number {
  ensureDataSourceIndex(store)
  const tx = store.db.transaction((es: DataSourceEntry[]) => { for (const e of es) putEntry(store, e) })
  tx(entries)
  return entries.length
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
 *  concludes there are six. That happened: a search for "customer" returned 6 TotalGroup fields out of 324 in
 *  the index, and the agent reasonably decided TotalGroup had almost no customer data. A truncated answer that
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
 *     take the whole budget: "customer" returned 54 NetSuite fields and 6 TotalGroup ones, though TotalGroup
 *     had 324 matches to NetSuite's 179 — bm25 favours short documents, and `invoice` is shorter than
 *     `vw_rpt_invoice_register`. Each source now gets its own slice of the limit, and unused slices are given
 *     back, so a wide source cannot be crowded out by a terse one.
 *
 *  3. IT SAYS WHAT IT DID NOT SHOW. See DataSourceSearchResult. */
export function searchDataSource(store: DataSourceIndex, query: string, opts: { source?: string; limit?: number; includeDisabled?: boolean } = {}): DataSourceSearchResult {
  ensureDataSourceIndex(store)
  const limit = Math.min(opts.limit ?? 50, 500)
  const where: string[] = []
  const bind: any[] = []
  if (opts.source) { where.push('d.source = ?'); bind.push(opts.source) }
  if (!opts.includeDisabled) where.push('d.enabled = 1')
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

/** Enable/disable by exact key, or a whole container/source via a LIKE pattern on the key (e.g. 'fusion5.employee.%'). */
export function setEnabled(store: DataSourceIndex, keyOrPattern: string, enabled: boolean): number {
  ensureDataSourceIndex(store)
  const op = keyOrPattern.includes('%') ? 'LIKE' : '='
  return store.db.prepare(`UPDATE datasource_index SET enabled=? WHERE key ${op} ?`).run(enabled ? 1 : 0, keyOrPattern).changes
}

export function dataSourceStats(store: DataSourceIndex): { source: string; containers: number; fields: number; disabled: number }[] {
  ensureDataSourceIndex(store)
  return store.db.prepare(
    `SELECT source, COUNT(DISTINCT container) AS containers, COUNT(*) AS fields,
            SUM(CASE WHEN enabled=0 THEN 1 ELSE 0 END) AS disabled
     FROM datasource_index GROUP BY source ORDER BY source`
  ).all() as any[]
}
