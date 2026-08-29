// DATASOURCE INDEX — a FLAT, full-text-searchable map of every field in every datasource, on the same store.
// One row per field. The key is a flat, NAME-based string `SOURCE.CONTAINER.FIELD` (CONTAINER = table or API
// collection; FIELD = column / attribute). Because a container/field name may itself contain dots, the source,
// container and field are ALSO stored split-out (the RHS) so they're always recoverable unambiguously.
//
// This is NOT introspection: introspection is live, per-source, and does stats/joins. This index is the
// always-available, CROSS-source structure map an agent searches FIRST — in the index ⇒ it exists; not in it ⇒
// it doesn't. A separate process (the connector agent) keeps it fresh; readers only search. Enable/disable and
// (later) authorization live here too. No statistics — pure structure.

import type { NodeStore } from './store.js'

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
  enabled?: boolean           // false disables this field (or whole table) from being used; default true
}

/** Preference order for a field's description: human > ai > source-default. */
export function describeEntry(e: Pick<DataSourceEntry, 'descHuman' | 'descAi' | 'descDefault'>): string {
  return (e.descHuman?.trim() || e.descAi?.trim() || e.descDefault?.trim() || '')
}

export function ensureDataSourceIndex(store: NodeStore): void {
  store.db.exec(`
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
  `)
}

export function dsiKey(source: string, container: string, field: string): string {
  return `${source}.${container}.${field}`
}

/** Upsert one entry (idempotent on key). The updater process calls this; readers never write. */
export function putEntry(store: NodeStore, e: DataSourceEntry): void {
  ensureDataSourceIndex(store)
  store.db.prepare(`
    INSERT INTO datasource_index (key, source, container, field, type, desc_default, desc_ai, desc_human, is_optional, is_key, references_, enabled)
    VALUES (@key, @source, @container, @field, @type, @descDefault, @descAi, @descHuman, @isOptional, @isKey, @references, @enabled)
    ON CONFLICT(key) DO UPDATE SET
      type=excluded.type, desc_default=excluded.desc_default, is_optional=excluded.is_optional,
      is_key=excluded.is_key, references_=excluded.references_
      -- NOTE: desc_ai/desc_human/enabled are curated, so a refresh from the source never clobbers them.
  `).run({
    key: e.key, source: e.source, container: e.container, field: e.field, type: e.type ?? null,
    descDefault: e.descDefault ?? null, descAi: e.descAi ?? null, descHuman: e.descHuman ?? null,
    isOptional: e.isOptional == null ? null : (e.isOptional ? 1 : 0),
    isKey: e.isKey == null ? null : (e.isKey ? 1 : 0), references: e.references ?? null,
    enabled: e.enabled === false ? 0 : 1,
  })
}

export function putEntries(store: NodeStore, entries: DataSourceEntry[]): number {
  ensureDataSourceIndex(store)
  const tx = store.db.transaction((es: DataSourceEntry[]) => { for (const e of es) putEntry(store, e) })
  tx(entries)
  return entries.length
}

function rowToEntry(r: any): DataSourceEntry {
  return { key: r.key, source: r.source, container: r.container, field: r.field, type: r.type ?? undefined,
    descDefault: r.desc_default ?? undefined, descAi: r.desc_ai ?? undefined, descHuman: r.desc_human ?? undefined,
    isOptional: r.is_optional == null ? undefined : !!r.is_optional,
    isKey: r.is_key == null ? undefined : !!r.is_key, references: r.references_ ?? undefined, enabled: !!r.enabled }
}

/** Full-text search across the whole index (all sources), or filtered to one `source`. Disabled rows hidden
 *  unless includeDisabled. Falls back to a LIKE scan when the query isn't valid FTS (e.g. bare punctuation). */
export function searchDataSource(store: NodeStore, query: string, opts: { source?: string; limit?: number; includeDisabled?: boolean } = {}): DataSourceEntry[] {
  ensureDataSourceIndex(store)
  const limit = Math.min(opts.limit ?? 50, 500)
  const where: string[] = []
  const bind: any[] = []
  if (opts.source) { where.push('d.source = ?'); bind.push(opts.source) }
  if (!opts.includeDisabled) where.push('d.enabled = 1')
  const filter = where.length ? 'AND ' + where.join(' AND ') : ''
  const q = String(query || '').trim()
  try {
    const ftsQuery = q.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"*`).join(' ')
    if (ftsQuery) {
      const rows = store.db.prepare(
        `SELECT d.* FROM datasource_index_fts f JOIN datasource_index d ON d.rowid = f.rowid
         WHERE datasource_index_fts MATCH ? ${filter} ORDER BY rank LIMIT ?`
      ).all(ftsQuery, ...bind, limit) as any[]
      if (rows.length || !q) return rows.map(rowToEntry)
    }
  } catch { /* fall through to LIKE */ }
  const like = `%${q}%`
  return (store.db.prepare(
    `SELECT * FROM datasource_index d WHERE (key LIKE ? OR container LIKE ? OR field LIKE ?) ${filter} LIMIT ?`
  ).all(like, like, like, ...bind, limit) as any[]).map(rowToEntry)
}

/** Enable/disable by exact key, or a whole container/source via a LIKE pattern on the key (e.g. 'fusion5.employee.%'). */
export function setEnabled(store: NodeStore, keyOrPattern: string, enabled: boolean): number {
  ensureDataSourceIndex(store)
  const op = keyOrPattern.includes('%') ? 'LIKE' : '='
  return store.db.prepare(`UPDATE datasource_index SET enabled=? WHERE key ${op} ?`).run(enabled ? 1 : 0, keyOrPattern).changes
}

export function dataSourceStats(store: NodeStore): { source: string; containers: number; fields: number; disabled: number }[] {
  ensureDataSourceIndex(store)
  return store.db.prepare(
    `SELECT source, COUNT(DISTINCT container) AS containers, COUNT(*) AS fields,
            SUM(CASE WHEN enabled=0 THEN 1 ELSE 0 END) AS disabled
     FROM datasource_index GROUP BY source ORDER BY source`
  ).all() as any[]
}
