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


// ── IDENTITY: A CONCEPT IS ITS CONTENT; A NAME IS A POINTER TO ONE ──────────────────────────────────────
//
// The name used to BE the identity — `concept:customer-invoice-total` — which made three things impossible
// and one thing wrong.
//
//   IMPOSSIBLE  Two names for one concept. 37 of 44 concepts already carried `aliases`, so the need was not
//               hypothetical; a list of alternative names on the concept means the concept owns its names,
//               which supports neither re-pointing nor merging.
//   IMPOSSIBLE  Merge and split. Consolidation cannot fold two concepts into one, because "one" would have to
//               pick a name and rewrite the other. With pointers it repoints and keeps both bodies.
//   IMPOSSIBLE  A durable reference. A program recording what it was built from pointed at a name, so a
//               rename dangled it. Provenance has to outlive naming.
//   WRONG       A version was modelled as an edit. `@v4` archived `@v3` as though one became the other. It
//               usually did not — a new version is a DIFFERENT belief that replaced the old one, and the
//               honest record is "this name pointed there, then here".
//
// So: the body is content-addressed and never changes. `hash(body)` IS the id, which makes immutability
// arithmetic rather than a rule anyone has to keep — edit the body and you have a different concept, by
// construction. Names live in `index:` nodes that point at a hash, are bitemporal, and carry the history.
// Aliases become ordinary index entries; nothing is special about the "primary" name.
//
// Namespacing rides on the name with a `.` separator (`totalgroup.customer`), so an index can be scoped when
// two things share a word — the collision that broke `view.customer.canonical` across two sources.
//
// The agent never sees any of this. It searches phrases and opens by name exactly as before.

import { createHash } from 'node:crypto'

/** The id of a body: its content, hashed. Same content → same concept, always, everywhere. */
export function conceptHash(props: ConceptProps): string {
  return 'concept:' + createHash('sha256').update(contentOf(props)).digest('hex').slice(0, 16)
}

/** The id of a NAME. Namespaced segments keep their dots; everything else is slugged. */
export function indexId(name: string): string {
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return 'index:' + String(name).split('.').map(slug).filter(Boolean).join('.')
}

/** Point a name at a concept. A name that already points there is a no-op; one that points elsewhere is
 *  ARCHIVED with its window closed, so "what did this name mean in June" stays answerable. */
export function putIndex(store: NodeStore, name: string, target: string, meta: ChangeMeta): void {
  const id = indexId(name)
  const cur = store.getNode(id)
  const curTarget = (cur?.props as any)?.target
  if (curTarget === target) return
  // STRICTLY AFTER the pointing it replaces. Two writes inside one millisecond — which consolidation can
  // easily do — would otherwise close the old window at the instant it opened, giving a pointing that was
  // never true for any `at`, and leaving two rows with the same valid_from for history to order arbitrarily.
  // Clock granularity is not an invariant; this is.
  const at = Math.max(Date.now(), ((cur?.valid_from as number) ?? 0) + 1)
  if (cur) {
    const aid = `${id}@${cur.valid_from ?? at}`
    store.putNode({ id: aid, kind: 'index', label: name, props: { ...(cur.props as any), retired: true } })
    store.db.prepare('UPDATE nodes SET valid_from=?, valid_to=? WHERE id=?').run(cur.valid_from ?? at, at, aid)
  }
  store.putNode({ id, kind: 'index', label: name, summary: target,
    props: { target, changedBy: meta.changedBy, reason: meta.reason } })
  store.db.prepare('UPDATE nodes SET valid_from=?, valid_to=NULL WHERE id=?').run(at, id)
}

/** The concept a name currently points at. */
export function resolveConcept(store: NodeStore, name: string): Node | undefined {
  const idx = store.getNode(indexId(name))
  const target = (idx?.props as any)?.target
  return target ? store.getNode(target) : undefined
}

/** Every name that points at a concept — for showing a human what a hash is called. */
export function namesFor(store: NodeStore, conceptId: string): string[] {
  return (store.db.prepare(
    "SELECT label FROM nodes WHERE kind='index' AND valid_to IS NULL AND json_extract(props,'$.target')=?"
  ).all(conceptId) as any[]).map((r) => r.label).filter(Boolean)
}

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
// §9 alias guard — an alias becomes a firing SURFACE FORM, so a too-generic one mis-fires on unrelated questions
// (the "billed" alias fired the CUSTOMER concept on VENDOR questions). Enforce the spec's cheap filters: an alias
// must be ≥2 tokens and not all-generic/high-frequency. (The fuller validate-before-accept — re-fire over question
// history and reject an alias that fires where the concept wasn't needed — is a later addition; these
// deterministic checks catch the worst cases, e.g. a single generic word like "billed"/"revenue"/"year".)
const ALIAS_STOP = new Set(('a an the of on in for by per to and or is are was be do does with as at this that it its ' +
  'we our us you your they their what which who whom how many much more most all each every this year to date so far')
  .split(' ').filter(Boolean))
export function sanitizeAliases(aliases?: string[]): string[] {
  if (!Array.isArray(aliases)) return []
  const seen = new Set<string>(); const out: string[] = []
  for (const a of aliases) {
    const s = String(a ?? '').trim()
    const toks = s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    if (toks.length < 2) continue                     // §9: minimum 2 tokens (drops "billed", "billing", "headcount")
    if (toks.every(t => ALIAS_STOP.has(t))) continue  // §9: reject all-generic / high-frequency
    const k = toks.join(' ')
    if (seen.has(k)) continue
    seen.add(k); out.push(s)
  }
  return out
}

export function upsertConcept(store: NodeStore, name: string, props: ConceptProps, meta: ChangeMeta): Node {
  props = { ...props, aliases: sanitizeAliases(props.aliases) }   // §9 alias guard — applied before anything is stored

  // NOTHING IS OVERWRITTEN. The body is written under its own hash, and the NAME is moved to point at it. Same
  // content → same hash → the write is a no-op and the name already points there. Different content → a new
  // concept exists alongside the old one, and only the pointer moves. The previous body stays exactly as it
  // was, which is what makes a program's record of what it was built from still true a month later.
  const id = conceptHash(props)
  const existing = store.getNode(id)
  const at = Date.now()

  // The version number is a courtesy for humans reading a log; it is not identity and nothing resolves by it.
  const prior = resolveConcept(store, name)
  const version = (((prior?.props as any)?._v?.version ?? 0) as number) + (prior && prior.id !== id ? 1 : 0) || 1
  const stamped: ConceptProps = { ...props, scope: props.scope ?? 'global',
    _v: { version, changedBy: meta.changedBy, reason: meta.reason } }

  const node = existing ?? store.putNode({ id, kind: 'concept', label: name, summary: props.value, props: stamped })
  if (!existing) store.db.prepare('UPDATE nodes SET valid_from=?, valid_to=NULL WHERE id=?').run(at, id)

  // The primary name, and every alias, point at this body. An alias is not a lesser kind of name — it is the
  // same pointer with a different phrase, which is what lets two wordings mean one thing.
  putIndex(store, name, id, meta)
  for (const a of props.aliases ?? []) putIndex(store, a, id, meta)

  return existing ?? { ...node, valid_from: at, valid_to: null }
}

/** "now" = the live row (stable id); `asOf` (unix ms) → the version whose validity window contained that instant. */
/** The body this name points at — now, or at an instant. Rewinding asks the INDEX what the name meant then,
 *  because bodies have no windows: the same body may be current under one name and long-retired under another. */
export function getConcept(store: NodeStore, name: string, asOf?: number): Node | undefined {
  return asOf == null ? resolveConcept(store, name) : resolveConceptAsOf(store, name, asOf)
}

// ── HISTORY BELONGS TO THE NAME, NOT THE BODY ───────────────────────────────────────────────────────────
// A body has no history: it is one immutable thing, and if it changed it would be a different body. What has
// a history is the NAME — what it meant, when, and who moved it. conceptHistory() used to walk `@vN` rows and
// report versions of a concept; there are no such rows now, and the question it was really answering is this
// one.
export type IndexPointing = {
  target: string           // the concept body this name pointed at
  changedBy: string        // who moved it — 'consolidator' | 'human:<id>' | 'migration' | …
  reason?: string
  from: number             // when this pointing took effect
  to: number | null        // when it stopped, or null while current
  live: boolean
}

/** Everything this name has ever pointed at, oldest first. Retired pointings are kept under
 *  `index:<name>@<from>`, so the timeline is a query rather than a reconstruction. */
export function indexHistory(store: NodeStore, name: string): IndexPointing[] {
  const id = indexId(name)
  const rows = store.db.prepare(
    `SELECT props, valid_from, valid_to FROM nodes
      WHERE kind='index' AND (id = ? OR id LIKE ?)
      ORDER BY valid_from, CASE WHEN valid_to IS NULL THEN 1 ELSE 0 END`
  ).all(id, id + '@%') as any[]
  return rows.map((r) => {
    const p = typeof r.props === 'string' ? JSON.parse(r.props || '{}') : (r.props ?? {})
    return { target: p.target, changedBy: p.changedBy ?? 'unknown', reason: p.reason,
             from: r.valid_from, to: r.valid_to ?? null, live: r.valid_to == null }
  })
}

/** What this name meant at an instant — the body it pointed at then, not the body it points at now. This is
 *  how a program's answer from June can be read against the concept that actually produced it. */
export function resolveConceptAsOf(store: NodeStore, name: string, at: number): Node | undefined {
  const hit = indexHistory(store, name).find((h) => h.from <= at && (h.to == null || h.to > at))
  return hit?.target ? store.getNode(hit.target) : undefined
}
