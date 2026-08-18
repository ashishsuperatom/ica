// ── Grounding store (isolated) ────────────────────────────────────────────────
// A per-project store, separate from the semantic model's project.sqlite, holding ONLY resolution indexes:
// entity values (for fuzzy/semantic name→id), hierarchy specs (+ optional materialized edges), and learned
// value patterns. The grounding AGENT writes it (build-time); the analyst reads it (query-time) through the
// GroundingResolver interface. Skeleton: schema + builder/reader shells — the real resolvers (FTS/vec, edge
// execution, pattern learning) land in the next pieces.

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  Candidate, EntityRef, GroundingResolver, HierarchyNode, HierarchySpec, ResolveOpts, ResolveResult, ValuePattern,
} from './types.js'

export * from './types.js'

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

CREATE TABLE IF NOT EXISTS hierarchy (      -- a named hierarchy over one entity type
  name        TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  resolver    TEXT NOT NULL,                -- column | derived-query | cross-source | materialized
  spec_json   TEXT NOT NULL,
  one_to_many INTEGER,
  note        TEXT
);
CREATE TABLE IF NOT EXISTS hierarchy_edge ( -- materialized parent→child edges (for materialized resolvers)
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

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }
  close() { this.db.close() }

  // ── Build-time (the grounding agent writes these) ───────────────────────────
  upsertEntityValue(v: { entityType: string; entityId: string | number; value: string; source?: string }): void {
    const norm = v.value.trim().toLowerCase()
    this.db.prepare(`INSERT OR REPLACE INTO entity_value (entity_type, entity_id, value, norm, source) VALUES (?,?,?,?,?)`)
      .run(v.entityType, String(v.entityId), v.value, norm, v.source ?? null)
  }
  defineHierarchy(h: HierarchySpec): void {
    this.db.prepare(`INSERT OR REPLACE INTO hierarchy (name, entity_type, resolver, spec_json, one_to_many, note) VALUES (?,?,?,?,?,?)`)
      .run(h.name, h.entityType, h.resolver, JSON.stringify(h.spec), h.oneToMany ? 1 : 0, h.note ?? null)
  }
  upsertPattern(p: ValuePattern): void {
    this.db.prepare(`INSERT OR REPLACE INTO value_pattern (name, regex, entity_type, location, how_to_find, confidence) VALUES (?,?,?,?,?,?)`)
      .run(p.name, p.regex, p.entityType, p.location, p.howToFind, p.confidence)
  }

  // ── Query-time (the analyst reads these) — SKELETON, real resolvers next ─────
  resolveEntity(text: string, _opts?: ResolveOpts): ResolveResult {
    // TODO(piece 3): per-type fuzzy (FTS5/trigram/spellfix1) + optional sqlite-vec semantic, verified.
    // Skeleton: exact/normalised match only, grouped by type.
    const norm = text.trim().toLowerCase()
    const rows = this.db.prepare(`SELECT entity_type, entity_id, value, source FROM entity_value WHERE norm = ? LIMIT 50`).all(norm) as any[]
    const byType: Record<string, Candidate[]> = {}
    for (const r of rows) {
      (byType[r.entity_type] ??= []).push({ ref: { type: r.entity_type, id: r.entity_id, label: r.value, source: r.source ?? undefined }, score: 1, via: 'exact', evidence: r.value })
    }
    return { query: text, byType }
  }

  resolveHierarchy(node: HierarchyNode, _dir: 'descendants' | 'ancestors' = 'descendants', hierarchy?: string): EntityRef[] {
    // TODO(piece 2): execute the resolver (column | derived-query | cross-source | materialized).
    // Skeleton: read materialized edges only.
    if (!hierarchy) return []
    const rows = this.db.prepare(`SELECT child_id FROM hierarchy_edge WHERE hierarchy = ? AND parent_id = ?`).all(hierarchy, String(node.id)) as any[]
    return rows.map((r) => ({ type: node.type, id: r.child_id }))
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
