// THE CONCEPT CONTRACT — atomic, runnable org knowledge.
//
// A CONCEPT IS NOT A PROGRAM. A program answers one person's question and is disposable; a concept is a
// single idea the whole organisation shares, and it outlives every question that used it. They share this
// package's scaffolding and nothing else.
//
// One function. Parameters in, one atomic value (or one distribution) out, with the caveats and the
// invariants it checked recorded alongside. Everything a reader needs in order to trust the number is
// produced BY the run rather than asserted about it.
//
//   • WHAT it computes is the code.
//   • WHY it computes it that way is the comments — for whoever reads or adapts this next, human or agent.
//     Comments never take part in identity; two functions that differ only in their explanation are one
//     calculation.
//   • THAT it is still correct is `verify`, checked on real data every time it runs, not remembered from
//     the day it was written.
//
// FLAT, DELIBERATELY. A concept cannot call another concept — there is no `use` on its context. Composition
// belongs to the program that answers a question, where unit reuse already lives. A concept that needs
// another concept's value is either two concepts or one; making it easy to blur that is how a knowledge
// store turns into a dependency graph nobody can migrate.
//
// COPIED, NOT CALLED. A real question needs a concept's INSIDES — its filters, its join path, its sign
// convention — so an agent takes the body and adapts it. That is the whole reason the body is code: a prose
// rule ("remember this column is stored negative") does not survive being pasted into a new program, and a
// `verify` does. Restructure everything around it and the invariant still fires, on the user's own data.
//
// This is why ConceptCtx is a strict SUBSET of UnitCtx (unit.ts). Any concept body is already a valid unit
// body; adapting one cannot break on a capability the destination lacks.

import type { UnitCtx } from './unit.js'

/** Everything a concept may do. `use` is deliberately absent — see FLAT above. */
export type ConceptCtx = Omit<UnitCtx, 'use'>

/** What a concept declares about itself.
 *
 *  `params` is a description per parameter, not a type — the same shape `UnitMeta.inputs` already uses, and
 *  for the same reason: the reader is an agent deciding whether this concept fits its question, and a prose
 *  description tells it more than `string` does. The VALUES a concept has actually been run with are
 *  observed and recorded by the tool that runs it; they are not declared here, because a claim about which
 *  parameters matter is a prediction and the record of which ones were used is a fact. */
export interface ConceptMeta {
  /** What a user would call this, in their words. */
  name: string
  /** What it IS, and what distinguishes it from the concept it is most easily confused with. */
  description: string
  /** Other surface forms real questions use. These are RETRIEVAL triggers, so each must be specific enough
   *  that it cannot fire on an unrelated question — the distinctive phrase, never its most generic word. */
  aliases?: string[]
  /** Datasource ids this reads. Declared so the analysis need not parse the body to know, and so identical
   *  code against different sources is never mistaken for one concept. */
  sources: string[]
  /** name → what it means. e.g. `{ period: 'the window to measure over' }` */
  params?: Record<string, string>
  /** What the value MEANS — its unit, its grain, what one of it represents. A number with no stated unit is
   *  the most reliable way to be wrong in a spreadsheet later. */
  returns: string
}

/** What a concept returns.
 *
 *  ONE of these is required. A concept computes an atomic value (`value`), or a spread over something
 *  (`distribution`), or both — a total with the rows behind it. Both stay optional in the type and are
 *  checked at run time, because "at least one of two fields" is not expressible here and a lie in the type
 *  is worse than a check in the runner.
 *
 *  Caveats and verifications are NOT returned: they are recorded through `ctx` as the run proceeds, so they
 *  cannot be forgotten on one code path and remembered on another. */
export interface ConceptResult<V = unknown, D = unknown> {
  /** The atomic answer — the thing this concept is FOR. */
  value?: V
  /** The spread behind it: rows, buckets, a series. What makes an answer defensible rather than merely
   *  stated, and the second signal for telling two concepts apart when their structure differs. */
  distribution?: D[]
}

export type Concept<P = any, V = unknown, D = unknown> =
  (ctx: ConceptCtx, params: P) => Promise<ConceptResult<V, D>> | ConceptResult<V, D>

/** A concept module, as the runner loads it.
 *
 *  NO IMPORTS. A concept file declares `meta` and a default function and nothing else — `ctx` arrives as an
 *  argument, so there is nothing to import and therefore no import to get wrong. The tool that runs it owns
 *  the wrapper, deterministically, every time. Import paths and escaping are precisely the class of thing an
 *  agent gets wrong, and boilerplate written once by a tool cannot drift the way boilerplate written afresh
 *  on every occasion does.
 *
 *  NO `ui` FACET either, unlike a unit. A concept produces a value; how an answer looks is the job of the
 *  program that used it. */
export interface ConceptModule<P = any, V = unknown, D = unknown> {
  meta: ConceptMeta
  default: Concept<P, V, D>
}

/** The outcome of running a concept once: what it returned, and everything the run recorded about it.
 *
 *  Stored against the concept so "what did this last produce, for which parameters, and when" is answerable
 *  without re-running it — the sample that makes a structural match confirmable by execution, and the
 *  baseline that makes a later change visible as a change. */
export interface ConceptRun<V = unknown, D = unknown> {
  /** Derived from the source and the parameters, so saving cannot store something other than what ran. */
  runId: string
  concept: string
  params: unknown
  result: ConceptResult<V, D>
  caveats: string[]
  verifications: Array<{ label: string; ok: boolean; detail?: string; ms: number }>
  ms: number
  at: string
  /** Present only when the run failed. A concept that will not run cannot be saved. */
  error?: string
}
