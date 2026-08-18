// ── Grounding contract ────────────────────────────────────────────────────────
// The grounding module turns a fuzzy human reference into concrete, structured ids, using indexes built
// per-project FROM that project's own data. NOTHING here is dataset-specific: entity types, hierarchies and
// value patterns are all discovered per project by the grounding agent and stored — never hard-coded.
//
// It answers three questions, each as a distinct resolver:
//   • resolveEntity(text)        — "which specific thing is this?"        value  → ranked ids, PER entity type
//   • resolveHierarchy(node)     — "what's under / over this?"           entity → descendants / ancestors
//   • resolveValueByPattern(v)   — "what kind of value is this?"         identifier → {type, where it lives}

/** A resolved reference into the data: an entity of some project-defined type, with its id. */
export interface EntityRef {
  type: string                 // project-defined entity type ("customer", "vendor", "place", "branch", …)
  id: string | number          // the id in the source (or a composite key rendered as a string)
  label?: string               // human label (the canonical name), for display
  source?: string              // which data source it came from (for cross-source setups)
}

/** One candidate for a resolution, with a score and how it was found — resolution ALWAYS returns candidates,
 *  never a single forced answer (a name can legitimately match several entities/types). */
export interface Candidate {
  ref: EntityRef
  score: number                // 0..1, higher = better
  via: 'exact' | 'fuzzy' | 'semantic' | 'pattern' | 'hierarchy' | 'alias'
  evidence?: string            // why it matched (the matched string / rule), for auditability
}

/** resolveEntity groups candidates BY entity type (top-N within each), so the caller sees options across all
 *  types and disambiguates by context — never collapse everything into one type. */
export interface ResolveResult {
  query: string
  byType: Record<string, Candidate[]>
}

/** How a hierarchy's parent/children are obtained — the general model (not always geo, not always a clean FK).
 *  The first three resolve LIVE against the source at query time (nothing copied → always fresh, nothing to
 *  sync). Materialized is the ONLY kind that keeps a copy — reserved for hierarchies where live resolution is
 *  impractical; it then carries a refresh obligation. Prefer a live kind whenever the source already holds
 *  the hierarchy simply — do not duplicate a tree the database can answer directly.
 *  column       : the child row carries a parent-key column (a self-ref tree, or a clean FK to the parent).
 *                 spec: { table, idCol, parentCol } — descendants = rows whose parentCol = @id; ancestors = @id's parentCol.
 *  derived-query: the relationship needs a join/aggregation. spec: { descendantsSql, ancestorsSql? } (each binds @id).
 *  cross-source : the related level lives in another data source; spec: { descendantsSql, ancestorsSql?, source }.
 *  materialized : precomputed into the edge table (built from childrenSql) — for expensive/derived ones; refresh it. */
export type ResolverKind = 'column' | 'derived-query' | 'cross-source' | 'materialized'

/** A named hierarchy over one entity type. The `spec` is interpreted per `resolver` (see ResolverKind).
 *  Built by the grounding agent; the store keeps the SPEC (how to resolve), not — except for materialized —
 *  a copy of the edges. */
export interface HierarchySpec {
  name: string                 // e.g. "place", "org", "location-tree"
  entityType: string           // the PARENT node type
  childType?: string           // the CHILD node type (may differ, e.g. location→service-network); defaults to entityType
  resolver: ResolverKind
  spec: Record<string, unknown>   // resolver-specific — see ResolverKind for the shape of each
  source?: string              // which data source to resolve against at query time (single-source: omit)
  oneToMany?: boolean          // is a parent → many children (vs 1:1)
  note?: string
}

export interface HierarchyNode { type: string; id: string | number; label?: string }

/** A learned value-format → column mapping, for typing an identifier the user gave without saying its type. */
export interface ValuePattern {
  name: string                 // e.g. "invoice-no"
  regex: string                // the learned format
  entityType: string           // what this value identifies
  location: string             // table.column where it lives
  howToFind: string            // a small SQL template to look it up
  confidence: number
}

/** A read-only structural summary of a grounding store — what was grounded, for inspection/verification.
 *  The ONE typed shape both the workspace seam and the admin inspector read (neither re-queries the tables). */
export interface GroundingStats {
  entityTypes: Array<{ type: string; values: number; entities: number }>   // value-spellings + distinct entities per type
  hierarchies: Array<{ name: string; parentType: string; childType: string; resolver: ResolverKind; live: boolean; spec: Record<string, unknown>; source: string | null; oneToMany: boolean; note: string | null }>
  edges: Array<{ hierarchy: string; n: number }>                            // materialized edge counts (live hierarchies have none)
  patterns: Array<{ name: string; entityType: string; location: string; regex: string; confidence: number }>
  aliases: number
}

export interface ResolveOpts {
  /** Soft type prior from context (weights ranking; never a hard filter). */
  typeHint?: string
  /** Already-resolved entities from the conversation, for context-aware disambiguation. */
  context?: EntityRef[]
  /** Max candidates per type. */
  perType?: number
}

/** The query-time interface the analyst calls. Read-only; the grounding agent populates the store. */
export interface GroundingResolver {
  resolveEntity(text: string, opts?: ResolveOpts): ResolveResult
  // Async: the live resolver kinds query the source at call time. Materialized-only stores still return a promise.
  resolveHierarchy(node: HierarchyNode, dir?: 'descendants' | 'ancestors', hierarchy?: string): Promise<EntityRef[]>
  // Join-mode: the hierarchy's knowledge (spec), so a program can compose the relationship as a JOIN in its
  // own query instead of pulling per row. Null if unknown.
  getHierarchy(name: string): (HierarchySpec & { childType: string }) | null
  resolveValueByPattern(value: string): Candidate[]
}
