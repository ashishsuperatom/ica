// BASIS — the evolving, per-org intent space, on the same node-store.
//
// An intent is a POINT located by a sparse set of BASIS axes. Each axis is a typed
// pair `type:token` (e.g. `op:overdue`, `entity:customer`, `time:trailing`) — both
// sides free strings, OPEN vocabulary. The axes are NOT a fixed universal schema:
// they are DISCOVERED from the questions a given org actually asks, so each project's
// space grows and diverges. The benchmark "calculus" categories (op/entity/dim/filter/
// time/rank) are only a shared SEED handed to the extractor, never a closed set.
//
// basis = the STRUCTURE of a question (its calculus); the literal VALUES it mentions
// (a name, a date, a count) are PARAMS, not axes — so the same structure with
// different values is the same intent (the reuse win). Two questions that share basis
// are near each other in the space; consolidation later merges synonym axes.

import type { NodeStore, Node } from './store.js'

/** One axis of the space: a typed pair. `text` is the raw span it came from (provenance). */
export type BasisPair = { type: string; token: string; text?: string }

// Entry normalisation: fold a common REGULAR plural on the HEAD (last) segment so `capabilities` and
// `capability` don't split the same axis. Conservative — protects Latinate/invariant endings (analysis,
// status, series, -ss) and only touches the trailing word, so modifiers ("sales-by-region") are left alone.
// True synonym merging (beyond plurals) is a consolidation job, not an entry rule.
function singularize(w: string): string {
  if (w.length <= 3) return w
  if (/(ss|us|sis|series|species|status|data|media|news)$/.test(w)) return w
  if (/ies$/.test(w)) return w.replace(/ies$/, 'y')                     // capabilities→capability
  if (/(ches|shes|sses|xes|zes)$/.test(w)) return w.replace(/es$/, '')  // matches→match, boxes→box
  if (/s$/.test(w)) return w.replace(/s$/, '')                          // brokers→broker, trips→trip
  return w
}
const slug = (s: string) => {
  const base = s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  if (!base) return base
  const seg = base.split('-')
  seg[seg.length - 1] = singularize(seg[seg.length - 1])   // fold only the head word
  return seg.join('-')
}

/** Stable id for an axis. Same type+token anywhere in a project ⇒ the same basis node. */
export function basisId(type: string, token: string): string {
  return `basis:${slug(type)}:${slug(token)}`
}

/**
 * PURE: normalise raw pairs into canonical, de-duplicated basis axes. Accepts either
 * `{type, token, text?}` objects or `"type:token"` strings. Drops anything without both
 * a type and a token. No store, no side effects — the testable core of the space.
 */
export function basisFromPairs(pairs: Array<BasisPair | string>): Array<Required<Omit<BasisPair, 'text'>> & { id: string; text?: string }> {
  const out = new Map<string, { id: string; type: string; token: string; text?: string }>()
  for (const p of pairs) {
    let type: string, token: string, text: string | undefined
    if (typeof p === 'string') {
      const i = p.indexOf(':')
      if (i < 0) continue
      type = p.slice(0, i); token = p.slice(i + 1)
    } else {
      type = p.type; token = p.token; text = p.text
    }
    const t = slug(type), k = slug(token)
    if (!t || !k) continue
    const id = basisId(t, k)
    if (!out.has(id)) out.set(id, { id, type: t, token: k, text })   // first span wins for provenance
  }
  return [...out.values()]
}

// ── writes ──────────────────────────────────────────────────────────────────

/** Upsert one axis node (lazily created the first time this org asks something that implies it). */
export function upsertBasis(store: NodeStore, type: string, token: string): Node {
  const t = slug(type), k = slug(token)
  return store.putNode({ id: basisId(t, k), kind: 'basis', label: `${t}:${k}`, props: { type: t, token: k } })
}

/**
 * Locate an intent in the space: mint its basis axes and link `intent --has_basis--> basis`.
 * The intent node itself is created elsewhere (the miss-path); this only records its coordinate.
 * Returns the canonical axes it was linked to.
 */
export function linkBasis(store: NodeStore, intentId: string, pairs: Array<BasisPair | string>) {
  const axes = basisFromPairs(pairs)
  for (const a of axes) {
    upsertBasis(store, a.type, a.token)
    store.putEdge({ from: intentId, to: a.id, type: 'has_basis', props: a.text ? { text: a.text } : {} })
  }
  return axes
}

// ── reads ───────────────────────────────────────────────────────────────────

/** The axes an intent sits on. */
export function basisOf(store: NodeStore, intentId: string): Node[] {
  return store.neighbors(intentId, { type: 'has_basis', direction: 'out' })
}

// ── SEED vocabulary ───────────────────────────────────────────────────────────
// The grounded starting basis, synthesised from the analytic-task (Amar/Stasko), question (Lehnert/Graesser/
// Bloom), NL-BI (Spider/Analyza/MEDLEY), and analytics-maturity (Gartner × Pearl) literatures. Organised into
// three orthogonal PLANES. Facets (the `type`s) are the governed, near-closed set; tokens are the OPEN long
// tail that grows from usage. `entity` deliberately seeds NO tokens — its tokens are domain nouns, discovered
// per project, never predefined. This is a SEED handed to the reflex, not a cage: the reflex may mint new
// tokens freely and new facets when nothing fits (see SYSTEM.md); consolidation later canonicalises + promotes.
export const BASIS_SEED: Array<{ plane: 'subject' | 'operation' | 'mode'; type: string; scope: string; tokens: string[] }> = [
  // Plane 1 — SUBJECT (what data)
  { plane: 'subject', type: 'entity', scope: 'the subject the question is about (a measure or a thing) — tokens are domain nouns, discovered', tokens: [] },
  { plane: 'subject', type: 'dim',    scope: 'a group-by / breakdown axis', tokens: ['by-category', 'by-time', 'by-geo', 'by-hierarchy'] },
  { plane: 'subject', type: 'filter', scope: 'a qualifying condition (incl. negation)', tokens: ['threshold', 'membership', 'status', 'time-window', 'negation'] },
  { plane: 'subject', type: 'time',   scope: 'the time WINDOW/anchor only (not a comparison)', tokens: ['point', 'trailing', 'range', 'ytd', 'qtd', 'mtd'] },
  // Plane 2 — OPERATION (what calculus)
  { plane: 'operation', type: 'op',      scope: 'the analytic verb / calculus', tokens: ['retrieve', 'count', 'sum', 'avg', 'min', 'max', 'distinct-count', 'derive', 'distribution', 'range', 'correlate', 'anomaly', 'cluster'] },
  { plane: 'operation', type: 'rank',    scope: 'extremum + ordering', tokens: ['top-n', 'bottom-n', 'sort-asc', 'sort-desc'] },
  { plane: 'operation', type: 'compare', scope: 'a relational contrast (NOT a rank)', tokens: ['vs-baseline', 'vs-target', 'vs-peer', 'share-of-total', 'difference'] },
  { plane: 'operation', type: 'timeop',  scope: 'a time-intelligence operation', tokens: ['yoy', 'mom', 'pop', 'ytd-to-date', 'running-total', 'moving-avg', 'growth-rate'] },
  { plane: 'operation', type: 'set',     scope: 'set / nesting composition', tokens: ['intersect', 'union', 'except', 'nested', 'multi-hop'] },
  // Plane 3 — MODE (what kind of question)
  { plane: 'mode', type: 'mode',     scope: 'the analytic maturity of the question — ALWAYS emit exactly one', tokens: ['descriptive', 'diagnostic', 'predictive', 'prescriptive'] },
  { plane: 'mode', type: 'evaluate', scope: 'a normative judgment against a standard (the "could fix" / worth-it verb)', tokens: ['opportunity', 'risk', 'gap', 'feasibility', 'health'] },
  { plane: 'mode', type: 'cause',    scope: 'diagnostic — why / what drove it', tokens: ['driver', 'attribution', 'root-cause', 'sensitivity'] },
  { plane: 'mode', type: 'lever',    scope: 'prescriptive — a decision variable the actor can set', tokens: ['action', 'parameter', 'optimize', 'constraint'] },
  { plane: 'mode', type: 'scenario', scope: 'prescriptive — a hypothetical / counterfactual world', tokens: ['whatif', 'counterfactual', 'goal-seek', 'range'] },
  { plane: 'mode', type: 'forecast', scope: 'predictive', tokens: ['project', 'trend', 'risk'] },
  { plane: 'mode', type: 'horizon',  scope: 'predictive — the forward window', tokens: ['next-period', 'eoy', 'n-months'] },
  { plane: 'mode', type: 'verify',   scope: 'a polar / alternative (yes-no / X-or-Y) question', tokens: ['truth', 'existence', 'disjunctive'] },
]

/** Idempotently plant the seed vocabulary as basis nodes (so the space is populated for reuse from day one). */
export function ensureBasisSeed(store: NodeStore): void {
  for (const facet of BASIS_SEED) {
    for (const tok of facet.tokens) {
      const t = slug(facet.type), k = slug(tok)
      store.putNode({ id: basisId(t, k), kind: 'basis', label: `${t}:${k}`, props: { type: t, token: k, plane: facet.plane, seed: true } })
    }
  }
}

/** The live axis vocabulary (every basis token that currently exists), grouped by facet — fed to the reflex
 *  each turn so it PREFERS existing tokens over minting near-duplicates. Grows as the space evolves. */
export function renderVocab(store: NodeStore): string {
  const byType = new Map<string, Set<string>>()
  for (const n of store.nodesByKind('basis', 5000)) {
    const p = n.props as any
    if (!p?.type || !p?.token) continue
    let set = byType.get(p.type); if (!set) byType.set(p.type, set = new Set())
    set.add(p.token)
  }
  if (!byType.size) return ''
  return [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, toks]) => `  ${t}: ${[...toks].sort().join(', ')}`).join('\n')
}

/**
 * Rank existing intents by how much of the query's basis they share (raw overlap count).
 * The seed of the fast match-path — deliberately simple (symbolic overlap), no vectors yet.
 */
export function intentsByBasis(store: NodeStore, pairs: Array<BasisPair | string>): Array<{ intentId: string; shared: number }> {
  const axes = basisFromPairs(pairs)
  const tally = new Map<string, number>()
  for (const a of axes) {
    if (!store.getNode(a.id)) continue
    for (const intent of store.neighbors(a.id, { type: 'has_basis', direction: 'in' }))
      tally.set(intent.id, (tally.get(intent.id) ?? 0) + 1)
  }
  return [...tally.entries()].map(([intentId, shared]) => ({ intentId, shared })).sort((a, b) => b.shared - a.shared)
}
