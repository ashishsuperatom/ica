// ── Grounding store (isolated) ────────────────────────────────────────────────
// A per-project store of its own (db/grounding.sqlite), holding ONLY resolution indexes:
// entity values (for fuzzy/semantic name→id), hierarchy specs (+ optional materialized edges), and learned
// value patterns. The grounding AGENT writes it (build-time); the analyst reads it (query-time) through the
// GroundingResolver interface. Skeleton: schema + builder/reader shells — the real resolvers (FTS/vec, edge
// execution, pattern learning) land in the next pieces.

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fuzzyScore, normalize } from './fuzzy.js'
import type { SourceQuery } from './build.js'
import type {
  Candidate, EntityRef, GroundingResolver, GroundingStats, HierarchyNode, HierarchySpec, ResolveOpts, ResolveResult, ValuePattern,
} from './types.js'

export * from './types.js'
export * from './fuzzy.js'
export * from './build.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entity_value (   -- one row per resolvable value (name) of an entity
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  value       TEXT NOT NULL,                -- the searchable string (a name / code)
  norm        TEXT NOT NULL,                -- normalised (lower, trimmed) for lexical match
  source      TEXT,
  PRIMARY KEY (entity_type, entity_id, value)
);
CREATE INDEX IF NOT EXISTS idx_entity_value_norm ON entity_value(norm);

CREATE TABLE IF NOT EXISTS hierarchy (      -- a named hierarchy: parent type → child type. The store keeps
  name        TEXT PRIMARY KEY,             -- the SPEC (how to resolve), not a copy of the tree — except the
  entity_type TEXT NOT NULL,                -- 'materialized' kind, whose edges live in hierarchy_edge below.
  child_type  TEXT NOT NULL,                -- child type (may differ, e.g. location → service-network)
  resolver    TEXT NOT NULL,                -- column | derived-query | cross-source | materialized
  spec_json   TEXT NOT NULL,
  source      TEXT,                         -- which data source to resolve against (live kinds), NULL = default
  one_to_many INTEGER,
  note        TEXT
);
CREATE TABLE IF NOT EXISTS hierarchy_edge ( -- materialized parent→child edges (ONLY for materialized resolvers)
  hierarchy   TEXT NOT NULL,
  parent_id   TEXT NOT NULL,
  child_id    TEXT NOT NULL,
  PRIMARY KEY (hierarchy, parent_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_edge_parent ON hierarchy_edge(hierarchy, parent_id);

CREATE TABLE IF NOT EXISTS value_pattern (  -- learned format → where an identifier lives
  name        TEXT PRIMARY KEY,
  regex       TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  location    TEXT NOT NULL,
  how_to_find TEXT NOT NULL,
  confidence  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS alias (          -- curated human synonyms feeding resolution
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  alias       TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id, alias)
);
`

export class GroundingStore implements GroundingResolver {
  readonly db: Database.Database
  // The data seam for LIVE hierarchy resolution (column/derived-query/cross-source). Optional: a store used
  // only for entity/pattern resolution, or one holding solely materialized hierarchies, needs no source.
  private source?: SourceQuery
  private _ftsReady?: boolean   // cached: is the trigram FTS populated? (else resolveEntity full-scans)

  constructor(path = ':memory:', opts: { source?: SourceQuery; readonly?: boolean } = {}) {
    if (opts.readonly) {
      // Read-only open (the inspector): never creates the file or the schema, never writes.
      this.db = new Database(path, { readonly: true, fileMustExist: true })
    } else {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
      this.db = new Database(path)
      this.db.pragma('journal_mode = WAL')
      this.db.exec(SCHEMA)
      // Trigram FTS over the values, for SCALE (resolveEntity generates candidates from it instead of
      // scanning every row). Best-effort: if this SQLite build lacks the trigram tokenizer, we simply run
      // without it and fall back to the full scan — the core store never fails to open over it.
      try { this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entity_fts USING fts5(entity_type UNINDEXED, entity_id UNINDEXED, value UNINDEXED, norm, tokenize='trigram')`) } catch { /* no trigram FTS — scan path */ }
    }
    this.source = opts.source
  }
  /** Wire (or rewire) the live data seam after construction. */
  withSource(source: SourceQuery): this { this.source = source; return this }
  /** Fold the WAL into the main file so a separate READER (the admin inspector, opened read-only) sees the
   *  complete data — a read-only connection can't apply an uncheckpointed WAL, so it would otherwise read
   *  stale/empty. Called after a build and on close. No-op / harmless if read-only or busy. */
  checkpoint() { try { this.db.pragma('wal_checkpoint(TRUNCATE)') } catch { /* read-only or contended */ } }
  close() { this.checkpoint(); this.db.close() }

  /** Rebuild the trigram FTS from the current entity values — one bulk, transactional pass. Called at the end
   *  of a build so resolveEntity can generate candidates from an index instead of scanning + scoring every
   *  row. Safe no-op if FTS is unavailable (resolveEntity then falls back to the full scan). */
  reindexFts(): void {
    try {
      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM entity_fts`).run()
        this.db.prepare(`INSERT INTO entity_fts (entity_type, entity_id, value, norm) SELECT entity_type, entity_id, value, norm FROM entity_value`).run()
      })()
      this._ftsReady = undefined
    } catch { /* FTS unavailable — resolveEntity will full-scan */ }
  }

  private ftsReady(): boolean {
    if (this._ftsReady === undefined) {
      try { this._ftsReady = ((this.db.prepare(`SELECT COUNT(*) AS n FROM entity_fts`).get() as any).n) > 0 }
      catch { this._ftsReady = false }
    }
    return this._ftsReady
  }

  // Candidate rows for a query. At SCALE this is the point: a trigram-FTS lookup narrows a huge value set to
  // the rows that share 3-char sequences with the query (an indexed MATCH), so fuzzyScore only ranks those —
  // not a linear scan over every value. Short queries / stores without FTS fall back to the full table.
  private candidateRows(text: string): any[] {
    const norm = normalize(text)
    if (norm.length >= 3 && this.ftsReady()) {
      const seen = new Set<string>(), tris: string[] = []
      for (let i = 0; i <= norm.length - 3; i++) { const t = norm.slice(i, i + 3); if (!seen.has(t)) { seen.add(t); tris.push(t) } }
      if (tris.length) {
        try {
          const match = tris.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
          const hits = this.db.prepare(`SELECT entity_type, entity_id, value FROM entity_fts WHERE entity_fts MATCH ? ORDER BY bm25(entity_fts) LIMIT 800`).all(match) as any[]
          if (hits.length) return hits.map((h) => ({ entity_type: h.entity_type, entity_id: h.entity_id, value: h.value, source: null }))
        } catch { /* bad FTS query / unavailable — fall through to scan */ }
      }
    }
    return this.db.prepare(`SELECT entity_type, entity_id, value, source FROM entity_value`).all() as any[]
  }

  // ── Build-time (the grounding agent writes these) ───────────────────────────
  upsertEntityValue(v: { entityType: string; entityId: string | number; value: string; source?: string }): void {
    const norm = v.value.trim().toLowerCase()
    this.db.prepare(`INSERT OR REPLACE INTO entity_value (entity_type, entity_id, value, norm, source) VALUES (?,?,?,?,?)`)
      .run(v.entityType, String(v.entityId), v.value, norm, v.source ?? null)
  }
  defineHierarchy(h: HierarchySpec): void {
    this.db.prepare(`INSERT OR REPLACE INTO hierarchy (name, entity_type, child_type, resolver, spec_json, source, one_to_many, note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(h.name, h.entityType, h.childType ?? h.entityType, h.resolver, JSON.stringify(h.spec), h.source ?? null, h.oneToMany ? 1 : 0, h.note ?? null)
  }
  upsertEdge(hierarchy: string, parentId: string | number, childId: string | number): void {
    this.db.prepare(`INSERT OR REPLACE INTO hierarchy_edge (hierarchy, parent_id, child_id) VALUES (?,?,?)`)
      .run(hierarchy, String(parentId), String(childId))
  }
  addAlias(entityType: string, entityId: string | number, alias: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO alias (entity_type, entity_id, alias) VALUES (?,?,?)`).run(entityType, String(entityId), normalize(alias))
  }
  upsertPattern(p: ValuePattern): void {
    this.db.prepare(`INSERT OR REPLACE INTO value_pattern (name, regex, entity_type, location, how_to_find, confidence) VALUES (?,?,?,?,?,?)`)
      .run(p.name, p.regex, p.entityType, p.location, p.howToFind, p.confidence)
  }

  // ── Query-time (the analyst reads these) ────────────────────────────────────
  // Per-type fuzzy resolution: score every value, keep the best per (type,id), return the top-N WITHIN each
  // type (never one global list). A `typeHint` softly boosts one type; aliases resolve too. Scan is over a
  // bounded entity set — fine at these cardinalities; swap in FTS5/sqlite-vec for scale/semantics later.
  resolveEntity(text: string, opts: ResolveOpts = {}): ResolveResult {
    const perType = opts.perType ?? 5
    const min = 0.35
    const rows = this.candidateRows(text)   // FTS-narrowed at scale, full scan for small stores / short queries
    const aliases = this.db.prepare(`SELECT entity_type, entity_id, alias FROM alias`).all() as any[]
    // best candidate per (type,id)
    const best = new Map<string, Candidate>()
    const consider = (type: string, id: string, label: string, source: string | undefined, score: number, via: Candidate['via'], evidence: string) => {
      if (score < min) return
      if (opts.typeHint && type === opts.typeHint) score = Math.min(1, score + 0.1)
      const key = type + ' ' + id
      const prev = best.get(key)
      if (!prev || score > prev.score) best.set(key, { ref: { type, id, label, source }, score, via, evidence })
    }
    for (const r of rows) consider(r.entity_type, r.entity_id, r.value, r.source ?? undefined, fuzzyScore(text, r.value), fuzzyScore(text, r.value) >= 0.999 ? 'exact' : 'fuzzy', r.value)
    for (const a of aliases) consider(a.entity_type, a.entity_id, a.alias, undefined, fuzzyScore(text, a.alias), 'alias', a.alias)
    const byType: Record<string, Candidate[]> = {}
    for (const c of best.values()) (byType[c.ref.type] ??= []).push(c)
    for (const t of Object.keys(byType)) byType[t] = byType[t].sort((a, b) => b.score - a.score).slice(0, perType)
    return { query: text, byType }
  }

  // Resolve a hierarchy honouring its resolver kind. The live kinds (column/derived-query/cross-source) run
  // against the SOURCE at query time — always fresh, nothing copied, nothing to sync. Only 'materialized'
  // reads the copied edge table. Descendants = children of the node; ancestors = its parents. Ids carry the
  // hierarchy's declared child/parent type.
  async resolveHierarchy(node: HierarchyNode, dir: 'descendants' | 'ancestors' = 'descendants', hierarchy?: string): Promise<EntityRef[]> {
    if (!hierarchy) return []
    const h = this.db.prepare(`SELECT entity_type, child_type, resolver, spec_json, source FROM hierarchy WHERE name = ?`).get(hierarchy) as any
    if (!h) return []
    const outType = dir === 'descendants' ? h.child_type : h.entity_type
    const wrap = (rows: any[]) => rows.map((r) => ({ type: outType, id: r.id }))

    if (h.resolver === 'materialized') {                       // the ONLY kind that reads a copy
      const sql = dir === 'descendants'
        ? `SELECT child_id AS id FROM hierarchy_edge WHERE hierarchy = ? AND parent_id = ?`
        : `SELECT parent_id AS id FROM hierarchy_edge WHERE hierarchy = ? AND child_id = ?`
      return wrap(this.db.prepare(sql).all(hierarchy, String(node.id)) as any[])
    }

    // LIVE resolution — needs the data seam.
    if (!this.source) throw new Error(`grounding: hierarchy "${hierarchy}" is live (${h.resolver}) but no data source is wired — construct GroundingStore({ source }) or call withSource()`)
    const spec = JSON.parse(h.spec_json || '{}')
    let sql: string
    if (h.resolver === 'column') {
      // The child row carries a parent-key column. Descendants = rows whose parentCol = @id; ancestors = @id's parentCol.
      const { table, idCol, parentCol } = spec
      if (!table || !idCol || !parentCol) throw new Error(`grounding: column hierarchy "${hierarchy}" needs spec { table, idCol, parentCol }`)
      sql = dir === 'descendants'
        ? `SELECT ${idCol} AS id FROM ${table} WHERE ${parentCol} = @id`
        : `SELECT ${parentCol} AS id FROM ${table} WHERE ${idCol} = @id`
    } else {
      // derived-query / cross-source: the agent supplied SQL templates that bind @id.
      sql = dir === 'descendants' ? spec.descendantsSql : (spec.ancestorsSql ?? spec.descendantsSql)
      if (!sql) throw new Error(`grounding: ${h.resolver} hierarchy "${hierarchy}" needs spec.${dir === 'descendants' ? 'descendantsSql' : 'ancestorsSql'}`)
    }
    const rows = await this.source(sql, h.source ?? undefined, { id: node.id })
    return wrap(rows.map((r: any) => ({ id: r.id ?? r.ID ?? Object.values(r)[0] })))
  }

  // JOIN-MODE: return the hierarchy's KNOWLEDGE (not its data) so a program can compose the relationship as a
  // JOIN/WHERE inside its OWN query — the database does the join across a whole result set in one shot, instead
  // of resolveHierarchy()-ing per row (which is N+1 and terrible for a set). Use this when you're filtering or
  // joining MANY rows through the hierarchy; use resolveHierarchy when you just need one reference's members.
  // For a `column` hierarchy the spec IS the join key: child rows in `spec.table` link to a parent via
  // `spec.parentCol` (child id = `spec.idCol`). For derived-query/cross-source it hands back the SQL templates.
  getHierarchy(name: string): (HierarchySpec & { childType: string }) | null {
    const h = this.db.prepare(`SELECT name, entity_type, child_type, resolver, spec_json, source, one_to_many, note FROM hierarchy WHERE name = ?`).get(name) as any
    if (!h) return null
    return {
      name: h.name, entityType: h.entity_type, childType: h.child_type, resolver: h.resolver,
      spec: JSON.parse(h.spec_json || '{}'), source: h.source ?? undefined,
      oneToMany: !!h.one_to_many, note: h.note ?? undefined,
    }
  }

  // The ONE structural reader of a grounding store — what was grounded, for verification (the seam) and the
  // admin inspector. Both call this; neither re-queries the tables itself (single source of truth).
  stats(): GroundingStats {
    const d = this.db
    return {
      entityTypes: d.prepare(`SELECT entity_type AS type, COUNT(*) AS "values", COUNT(DISTINCT entity_id) AS entities FROM entity_value GROUP BY entity_type ORDER BY "values" DESC`).all() as any[],
      hierarchies: (d.prepare(`SELECT name, entity_type, child_type, resolver, spec_json, source, one_to_many, note FROM hierarchy`).all() as any[]).map((h) => ({
        name: h.name, parentType: h.entity_type, childType: h.child_type, resolver: h.resolver,
        live: h.resolver !== 'materialized', spec: JSON.parse(h.spec_json || '{}'),
        source: h.source ?? null, oneToMany: !!h.one_to_many, note: h.note ?? null,
      })),
      edges: d.prepare(`SELECT hierarchy, COUNT(*) AS n FROM hierarchy_edge GROUP BY hierarchy`).all() as any[],
      patterns: d.prepare(`SELECT name, entity_type AS entityType, location, regex, confidence FROM value_pattern`).all() as any[],
      aliases: (d.prepare(`SELECT COUNT(*) AS n FROM alias`).get() as any).n,
    }
  }

  resolveValueByPattern(value: string): Candidate[] {
    // TODO(piece 4): match against learned patterns + verify the value exists in that column.
    const pats = this.db.prepare(`SELECT * FROM value_pattern`).all() as any[]
    const out: Candidate[] = []
    for (const p of pats) {
      try { if (new RegExp(p.regex).test(value)) out.push({ ref: { type: p.entity_type, id: value, source: p.location }, score: p.confidence, via: 'pattern', evidence: p.name }) } catch { /* bad regex */ }
    }
    return out
  }
}
