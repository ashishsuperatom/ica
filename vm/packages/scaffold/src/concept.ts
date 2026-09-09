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

// ── WHAT A CONCEPT DECLARES ABOUT ITSELF ──────────────────────────────────────────────────────────────────
//
// ONE DECLARATION, three uses: the type below, the check the save runs, and the shape the authoring prompt
// shows. They were three separate descriptions and they had already drifted apart — the type still named
// fields nobody stored, the check enforced a different set, and the prompt showed a third. Whichever one you
// read, two of them were lying.
//
// Each field says what it is FOR, because the reader is an agent deciding whether this concept answers its
// question, and because the same words are what the prompt shows.

export interface ConceptMetaField {
  /** Required at save time. An optional field may be absent; it may not be wrong. */
  required: boolean
  /** What to write here — this is the text the authoring prompt shows. */
  hint: string
  /** Rejects a bad value, returning why. Absent means any value of the right kind will do. */
  check?: (value: unknown, meta: any) => string | null
  /** The values this field accepts, when it accepts a fixed few. Shown instead of the hint, so a closed set
   *  is never described in prose the author then has to guess the spelling of. */
  values?: readonly string[]
}

/** How long a description may be before it stops being a description. The field exists so a reader can tell
 *  whether this is the concept they want, and a model asked for prose will write four paragraphs of reasoning
 *  that belongs in comments beside the code it explains. Three short sentences fit. */
export const MAX_DESCRIPTION = 300

/** A value is either true AS AT an instant, or accumulated OVER a span. `trailing` used to be a third: it is
 *  a window whose start is computed, not a third kind of time, and having it as a peer invited free text. */
export const TIME_VALUES = ['point', 'window'] as const
export type TimeSemantics = (typeof TIME_VALUES)[number]

/** A parameter that bounds a window. ONE is enough — a year is a window, and so is a week start. */
const BOUNDING = /from|to\b|start|end|year|month|period|cutoff|week|as[_]?of|date/i
const nonEmpty = (v: unknown) => (typeof v === 'string' && v.trim() ? null : 'must be a non-empty string')

export const CONCEPT_META: Record<string, ConceptMetaField> = {
  name: { required: true, hint: 'a name that uniquely identifies this concept', check: nonEmpty },

  description: {
    required: true,
    hint: 'ONE TO THREE SENTENCES — what this is, not how it works',
    check: (v) => {
      const s = String(v ?? '').trim()
      if (!s) return 'is empty — say in one to three sentences what this concept is'
      if (s.length > MAX_DESCRIPTION) {
        return `is ${s.length} characters and the limit is ${MAX_DESCRIPTION}. Say what this concept IS in ` +
          `one to three sentences; the reasoning, the traps and the why belong in comments inside the body, ` +
          `where they sit beside the code they explain`
      }
      return null
    },
  },

  // Declared so nothing has to parse the body to know, and so identical code against different sources is
  // never mistaken for one concept.
  sources: {
    required: true,
    hint: 'every datasource this reads',
    check: (v) => (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x.trim())
      ? null : 'must name every datasource this reads'),
  },

  params: {
    required: false,
    hint: 'name → what it means',
    check: (v) => (v == null || (typeof v === 'object' && !Array.isArray(v)) ? null : 'must be name → description'),
  },

  // ── THE FOUR THINGS THAT TURN RIGHT ROWS INTO A WRONG NUMBER ─────────────────────────────────────────────
  // Getting the rows right is half of it. Each of these corresponds to a mistake that passes every other
  // check in silence.

  /** The guard against double counting, the failure that survives everything else: a join that fans out
   *  doubles the rows, so reconciling against the ungrouped measure compares two numbers that are BOTH
   *  doubled, and agrees. */
  grain: { required: true, hint: 'what ONE row is', check: nonEmpty },

  /** A total and a distinct count look identical in a result set and behave completely differently: revenue
   *  by month adds up to revenue for the year, distinct customers by month does not. */
  additive: {
    required: true,
    hint: 'may this be summed across a dimension',
    check: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
  },

  /** A bare number carries no unit, so nothing downstream notices two of them being added that should never
   *  have met. */
  unit: { required: true, hint: 'what the number counts', check: nonEmpty },

  time: {
    required: true,
    hint: 'true AS AT an instant, or accumulated OVER a span',
    values: TIME_VALUES,
    check: (v, meta) => {
      if (!TIME_VALUES.includes(v as TimeSemantics)) {
        return `is "${v}" but the only values are ${TIME_VALUES.join(' and ')}. A value is either true AS AT ` +
          `an instant (point) or accumulated OVER a span (window)`
      }
      if (v === 'window') {
        const params = Object.keys(meta?.params ?? {})
        if (!params.some((p) => BOUNDING.test(p))) {
          return `is "window" but no parameter bounds the window` +
            `${params.length ? ` (has: ${params.join(', ')})` : ' (it takes none)'} — a total over an ` +
            `unstated span is not an answer, it is a number`
        }
      }
      return null
    },
  },

  /** The axes the RESULT can be split by, which is not what a parameter is: a parameter changes the
   *  computation, a dimension breaks down what comes out. */
  dimensions: {
    required: false,
    hint: 'the axes it can be split by',
    check: (v) => (v == null || Array.isArray(v) ? null : 'must be a list of axis names'),
  },

  render: { required: false, hint: 'a short note on how to show it to a person' },
}

export type ConceptMeta = {
  name: string
  description: string
  sources: string[]
  grain: string
  additive: boolean
  unit: string
  time: TimeSemantics
  params?: Record<string, string>
  dimensions?: string[]
  render?: string
}

/** Everything that must be true of a concept's metadata. Returns the first reason it is not, or null.
 *
 *  It REFUSES rather than repairs. A description silently truncated, or a time value quietly mapped to the
 *  nearest legal one, is a concept saying something its author did not write — and the author is right there,
 *  able to fix it, which is the only moment anyone will. */
export function validateConceptMeta(meta: any): string | null {
  for (const [field, spec] of Object.entries(CONCEPT_META)) {
    const value = meta?.[field]
    if (value === undefined || value === null) {
      if (spec.required) return `${field} is missing — ${spec.hint}`
      continue
    }
    const bad = spec.check?.(value, meta)
    if (bad) return `${field} ${bad}`
  }
  return null
}

/** The metadata skeleton, written out from the same declaration the save checks against — so what an author
 *  is shown and what is required of them cannot be two different things. */
export function conceptMetaTemplate(): string {
  const lines = Object.entries(CONCEPT_META).map(([field, spec]) => {
    const v = field === 'sources' || field === 'dimensions' ? `["${spec.hint}"]`
      : field === 'params' ? '{ "<name>": "<what it means>" }'
      : field === 'additive' ? '<true|false>'
      : spec.values ? spec.values.map((x) => `"${x}"`).join(' | ')
      : `"${spec.hint}"`
    return `  "${field}": ${v}`
  })
  return `{\n${lines.join(',\n')}\n}`
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
