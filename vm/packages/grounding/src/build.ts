// ── Grounding builder ─────────────────────────────────────────────────────────
// The deterministic, LLM-free half of building the grounding store: given a source query function and a
// config (which columns are entities, which hierarchies to materialize, which value patterns), it populates
// the store. The grounding AGENT's job is only to PRODUCE the config from introspection (the judgment); this
// does the mechanical work — and it's what we can test locally without an LLM. Source SQL is per-source
// (the agent writes source-appropriate SQL), so nothing here is dialect- or dataset-specific.

import type { GroundingStore } from './index.js'
import type { HierarchySpec, ValuePattern } from './types.js'

// The builder/resolver run SQL through this. `source` names WHICH data source (for cross-source projects);
// omit for single-source. `params` binds `@name` placeholders (used by LIVE hierarchy resolution). The
// grounding agent writes source-appropriate SQL, so nothing here is dialect-specific.
export type SourceQuery = (sql: string, source?: string, params?: Record<string, unknown>) => Promise<any[]> | any[]

/** An entity value source: `sql` returns rows shaped `{ id, value }` (case-insensitive). */
export interface EntitySpec { type: string; sql: string; source?: string }
/** A hierarchy to materialize: for column/derived-query/cross-source, `childrenSql` returns `{ parent_id, child_id }`. */
export interface HierarchyBuildSpec extends HierarchySpec { childrenSql?: string; source?: string }

export interface BuildConfig {
  entities?: EntitySpec[]
  hierarchies?: HierarchyBuildSpec[]
  patterns?: ValuePattern[]
  aliases?: { type: string; id: string | number; alias: string }[]
}

function pick(r: any, key: string): unknown {
  if (r[key] !== undefined) return r[key]
  const k = Object.keys(r).find((x) => x.toLowerCase() === key.toLowerCase())
  return k ? r[k] : undefined
}

export async function buildGrounding(store: GroundingStore, source: SourceQuery, cfg: BuildConfig):
  Promise<{ entities: number; edges: number; hierarchies: number; patterns: number }> {
  let entities = 0, edges = 0
  for (const e of cfg.entities ?? []) {
    const rows = await source(e.sql, e.source)
    for (const r of rows) {
      const id = pick(r, 'id'), value = pick(r, 'value')
      if (id != null && value != null && String(value).trim()) { store.upsertEntityValue({ entityType: e.type, entityId: id as any, value: String(value) }); entities++ }
    }
  }
  for (const h of cfg.hierarchies ?? []) {
    // Store the SPEC (how to resolve), not a copy of the tree. Only the `materialized` kind copies edges —
    // and only because live resolution is impractical for it. Every other kind (a parent-key column, a
    // derived join, a cross-source bridge) is resolved LIVE against the source at query time, so it is always
    // fresh and there is nothing to sync. Never duplicate a hierarchy the source already holds simply.
    store.defineHierarchy(h)
    if (h.resolver === 'materialized') {
      const csql = h.childrenSql ?? (h.spec as any).childrenSql
      if (csql) {
        const rows = await source(csql, h.source)
        for (const r of rows) {
          const p = pick(r, 'parent_id'), c = pick(r, 'child_id')
          if (p != null && c != null) { store.upsertEdge(h.name, p as any, c as any); edges++ }
        }
      }
    }
  }
  for (const p of cfg.patterns ?? []) store.upsertPattern(p)
  for (const a of cfg.aliases ?? []) store.addAlias(a.type, a.id, a.alias)
  store.reindexFts()   // build the trigram index so resolveEntity scales (candidates from an index, not a scan)
  store.checkpoint()   // fold the writes into the main file so a read-only reader (the inspector) sees them
  return { entities, edges, hierarchies: (cfg.hierarchies ?? []).length, patterns: (cfg.patterns ?? []).length }
}
