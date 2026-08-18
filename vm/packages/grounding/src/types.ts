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
 *  column       : parent id is a column on the row (self-ref or a lookup)
 *  derived-query: parent/children come from a query/join over transactions (e.g. branch→service-network)
 *  cross-source : the related level lives in another data source; bridge on a shared key
 *  materialized : precomputed into an edge table (for expensive/derived ones) + refreshed */
export type ResolverKind = 'column' | 'derived-query' | 'cross-source' | 'materialized'

/** A named hierarchy over one entity type. The `spec` is interpreted per `resolver` (a column name, a SQL
 *  template, a cross-source bridge, or "read the materialized edge table"). Built by the grounding agent. */
export interface HierarchySpec {
  name: string                 // e.g. "place", "branch-pickup", "org"
  entityType: string           // the type of the nodes in this hierarchy
  resolver: ResolverKind
  spec: Record<string, unknown>   // resolver-specific: { column } | { childrenSql } | { source, bridgeKey } | { materialized: true }
  oneToMany?: boolean          // is a parent → many children (e.g. branch→SN ~37) vs 1:1
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
  resolveHierarchy(node: HierarchyNode, dir?: 'descendants' | 'ancestors', hierarchy?: string): EntityRef[]
  resolveValueByPattern(value: string): Candidate[]
}
