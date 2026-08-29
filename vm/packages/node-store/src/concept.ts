// CONCEPTS — the single knowledge kind (kind='concept') on the node-store. A concept is a GENERAL, atomic,
// intent-dependent idea of COMPUTATION — NOT a semantic-model entity. It can be anything reusable: where to
// FIND some data, how to COMPUTE something, how to PRESENT/explain it to the user, or (rarely) a full data
// model with measures + dimensions. Most concepts are lean — a `value` plus one or two of the general facets.
// Do not force a concept into the semantic-model shape; the measures/dimensions block is an OPTIONAL
// specialization for the subset that genuinely are entities/measures.
//
// Concepts are TIME-VERSIONED with the SAME bitemporal pattern units/programs use (valid_from/valid_to), so a
// single "as of T" query over `nodes` reconstructs the whole graph at any past instant (full-system time
// travel). The LIVE version keeps a STABLE id (`concept:<name>`) so "now" is a fast getNode; each change
// ARCHIVES the prior version as a time-windowed row (`concept:<name>@v<n>`, valid_to closed) and overwrites the
// live row. Only the live row is ever indexed/searched (retrieval filters valid_to IS NULL), so a superseded
// belief never surfaces. getConcept(name) is "now"; getConcept(name, asOf) rewinds. No direct revert — to
// revert, read an old version and upsert it again (a new version on top).

import type { NodeStore, Node } from './store.js'

export type ConceptStatus = 'unverified' | 'corroborated' | 'verified'
export type TimeSemantics  = 'snapshot' | 'during' | 'trailing'
// The optional data-model block — kept from the old semantic model because it earns its keep, but rare.
export type Measure    = { name: string; additive?: boolean; stock?: boolean; compute?: string; note?: string }
// A drill-down axis. `name` is ideally itself a concept name (so drill-down recurses); `via` = concise join
// path to reach it; `coverage` = 0..1 join reliability. Values live in grounding, not here.
export type Dimension  = { name: string; via?: string; coverage?: number; note?: string }
export type Parameter  = { name: string; default?: unknown; learned?: boolean; note?: string }
export type Provenance = { question: string; program?: string }

export type ConceptProps = {
  // — identity & lifecycle (always present) —
  value: string                 // what this concept IS — the general idea, in prose
  aliases?: string[]            // other surface forms, harvested from use
  status: ConceptStatus
  scope?: string                // 'global' (group:/user: is a later seam); defaults to 'global'
  requires?: string[]           // learned implication → concept names (spec §6)
  supersedes?: string[]         // explicit versioning → concept names
  provenance?: Provenance[]     // (question, program) pairs it emerged from
  rules?: string[]              // corrections / constraints — what to get right

  // — the general facets (all optional; a concept uses whichever apply) —
  find?: string                 // where the data lives / how to locate it
  compute?: string              // how to compute it (a recipe)
  present?: string              // how to represent + explain it to the user (UI guidance)

  // — data-model block (OPTIONAL — ONLY when the concept genuinely is an entity/measure) —
  source?: string               // datasource id (e.g. 'netsuite')
  grain?: string                // "one row per ISO currency code" — anti-double-count guard
  keying?: string               // "id = internal id; name = ISO code" — feeds name→id resolution
  time?: TimeSemantics          // how it binds to time
  measures?: Measure[]          // computable views (compute recipe + additive/stock + note)
  dimensions?: Dimension[]      // drill-down axes
  parameters?: Parameter[]      // free / learned values (defaults drift → the timeline records it)

  // — verification & versioning —
  verifiedAt?: string           // ISO date of last verification
  evidence?: string             // how it was verified (the query that proved it)
  _v?: { version: number; changedBy: string; reason?: string }   // set by upsertConcept, NOT authored
}

// changedBy: 'human:<userId>' | 'consolidator' | 'grounding-agent' | 'connector-agent' | 'analyst' | …
export type ChangeMeta = { changedBy: string; reason?: string }

export function conceptId(name: string): string {
  return 'concept:' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}
const archiveId = (name: string, version: number) => conceptId(name) + '@v' + version
const contentOf = (p: any) => { const { _v, ...rest } = p ?? {}; return JSON.stringify(rest) }

function nodeFromRow(r: any): Node {
  return { id: r.id, kind: r.kind, label: r.label, summary: r.summary ?? undefined,
    props: typeof r.props === 'string' ? JSON.parse(r.props || '{}') : (r.props ?? {}),
    file_path: r.file_path ?? undefined, valid_from: r.valid_from ?? undefined, valid_to: r.valid_to ?? null }
}

/**
 * Create or update a concept. Unchanged content → NO-OP (no version churn). A real change ARCHIVES the current
 * live version as a time-windowed historical row, then overwrites the live row (stable id), bumping the version
 * and recording who/why. Callers re-index the live row after this returns; the archived row is never indexed,
 * so retrieval only ever sees the current version.
 */
export function upsertConcept(store: NodeStore, name: string, props: ConceptProps, meta: ChangeMeta): Node {
  const id = conceptId(name)
  const cur = store.getNode(id)
  const curProps = (cur?.props ?? {}) as ConceptProps
  if (cur && contentOf(curProps) === contentOf(props)) return cur   // identical content → keep the live version

  const version = (curProps._v?.version ?? 0) + 1
  const at = Date.now()
  if (cur) {
    const av = curProps._v?.version ?? 1
    const aid = archiveId(name, av)
    store.putNode({ id: aid, kind: 'concept', label: name, summary: cur.summary ?? undefined, props: curProps })
    store.db.prepare(`UPDATE nodes SET valid_from=?, valid_to=? WHERE id=?`).run(cur.valid_from ?? at, at, aid)
  }
  const stamped: ConceptProps = { ...props, scope: props.scope ?? 'global', _v: { version, changedBy: meta.changedBy, reason: meta.reason } }
  const node = store.putNode({ id, kind: 'concept', label: name, summary: props.value, props: stamped })
  // putNode's ON CONFLICT(id) DO UPDATE keeps the OLD valid_from — force the live row to advance to `at`.
  store.db.prepare(`UPDATE nodes SET valid_from=?, valid_to=NULL WHERE id=?`).run(at, id)
  return { ...node, valid_from: at, valid_to: null }
}

/** "now" = the live row (stable id); `asOf` (unix ms) → the version whose validity window contained that instant. */
export function getConcept(store: NodeStore, name: string, asOf?: number): Node | undefined {
  const cur = store.getNode(conceptId(name))
  if (asOf == null) return cur
  if (cur && (cur.valid_from ?? 0) <= asOf) return cur          // asOf at/after the live version → current
  const r = store.db.prepare(
    `SELECT * FROM nodes WHERE kind='concept' AND label=? AND valid_from<=? AND (valid_to>? ) ORDER BY valid_from DESC LIMIT 1`)
    .get(name, asOf, asOf) as any
  return r ? nodeFromRow(r) : undefined
}

export type ConceptVersion = { version: number; changedBy: string; reason?: string; validFrom: number; validTo: number | null; live: boolean }
/** The full timeline for a concept: every version (live + archived), oldest-first. */
export function conceptHistory(store: NodeStore, name: string): ConceptVersion[] {
  const rows = store.db.prepare(`SELECT props, valid_from, valid_to FROM nodes WHERE kind='concept' AND label=? ORDER BY valid_from`).all(name) as any[]
  return rows.map((r) => {
    const p = (typeof r.props === 'string' ? JSON.parse(r.props || '{}') : (r.props ?? {})) as ConceptProps
    return { version: p._v?.version ?? 1, changedBy: p._v?.changedBy ?? 'unknown', reason: p._v?.reason,
      validFrom: r.valid_from, validTo: r.valid_to ?? null, live: r.valid_to == null }
  })
}
