// ── THE LAWS A MEASURE OBEYS ─────────────────────────────────────────────────────────────────────────────────
//
// Two facts about aggregation, stated once here and used everywhere, so a rule and a traversal can never disagree
// about the same measure.
//
//   FOLDING ALONG AN ARROW.  Aggregating is folding along a map: the fact's rows are grouped by where an arrow
//   sends them. Whether that is meaningful depends on the measure's kind and the arrow's kind, and nothing else —
//   so `foldable` answers it from those two alone, wherever the question is standing.
//
//   COMBINING PARTIAL RESULTS.  sum, count, min and max are monoids: fold in any order, combine in any order, the
//   same answer. average is the monoid on (sum, count); a weighted average is the monoid on (weighted sum, weight).
//   Associativity is what licenses computing by day and REUSING it for the month — a partial result is a value,
//   not a shortcut — and what makes an incremental update correct rather than approximately correct.
//
// A measure with no monoid (a distinct count, a median) is recomputed from the rows at each grouping. That is not
// a limitation to work around; it is what those measures MEAN.

import type { Aggregate, ArrowKind, Measure, MeasureKind } from './schema.js'

export type Fold = { ok: true } | { ok: false; reason: string }

/** May this measure be folded along an arrow of this kind? The whole law, in one place. */
export function foldable(m: { fact?: string; measure?: string; kind: MeasureKind; aggregate: Aggregate; versions?: string; overTime?: Measure['overTime'] },
  arrow: { kind: ArrowKind; role: string; toCalendar?: boolean }): Fold {
  const name = m.fact && m.measure ? `${m.fact}.${m.measure}` : 'this measure'
  // Versions are kept apart: rows of two versions are two answers, never one.
  if (arrow.kind === 'version' && !m.versions) return { ok: false, reason: `${name} is not kept in versions, so ${arrow.role} is not a way to group it` }
  if (m.versions && arrow.role === m.versions && arrow.kind !== 'version') return { ok: false, reason: `${name} is kept in ${arrow.role} versions, which are never added together` }
  // A level at an instant adds across things, but over time it must say which instant stands for the period.
  if (m.kind === 'stock' && (arrow.kind === 'rollup' || arrow.toCalendar) && !m.overTime) {
    return { ok: false, reason: `${name} is a level at an instant; over time it needs to say whether it is the last, the first or the average level` }
  }
  // A rate is not a quantity: it is combined only in the ways that keep its meaning.
  if (m.kind === 'value-per-unit' && !['min', 'max', 'median', 'weighted average'].includes(m.aggregate)) {
    return { ok: false, reason: `${name} is a value per unit; it is combined by min, max, median or a weighted average, never by ${m.aggregate}` }
  }
  return { ok: true }
}

// ── THE MONOID ───────────────────────────────────────────────────────────────────────────────────────────────

/** A partial result: what a group holds before it is combined with another. */
export type Partial =
  | { kind: 'sum'; total: number | null }
  | { kind: 'count'; n: number }
  | { kind: 'min' | 'max'; value: number | null }
  | { kind: 'average'; total: number; n: number }
  | { kind: 'weighted'; total: number; weight: number }

export interface Monoid {
  empty: Partial
  combine(a: Partial, b: Partial): Partial
  value(p: Partial): number | null
}

/** The monoid an aggregate folds by, or nothing when it has none and must be recomputed from the rows. */
export function monoidFor(aggregate: Aggregate): Monoid | undefined {
  switch (aggregate) {
    case 'sum': return {
      empty: { kind: 'sum', total: null },
      combine: (a, b) => ({ kind: 'sum', total: add((a as any).total, (b as any).total) }),
      value: (p) => (p as any).total,
    }
    case 'count': return {
      empty: { kind: 'count', n: 0 },
      combine: (a, b) => ({ kind: 'count', n: (a as any).n + (b as any).n }),
      value: (p) => (p as any).n,
    }
    case 'min': case 'max': return {
      empty: { kind: aggregate, value: null },
      combine: (a, b) => {
        const x = (a as any).value, y = (b as any).value
        if (x === null) return b
        if (y === null) return a
        return { kind: aggregate, value: aggregate === 'min' ? Math.min(x, y) : Math.max(x, y) }
      },
      value: (p) => (p as any).value,
    }
    case 'average': return {
      empty: { kind: 'average', total: 0, n: 0 },
      combine: (a, b) => ({ kind: 'average', total: (a as any).total + (b as any).total, n: (a as any).n + (b as any).n }),
      value: (p) => ((p as any).n ? (p as any).total / (p as any).n : null),
    }
    case 'weighted average': return {
      empty: { kind: 'weighted', total: 0, weight: 0 },
      combine: (a, b) => ({ kind: 'weighted', total: (a as any).total + (b as any).total, weight: (a as any).weight + (b as any).weight }),
      value: (p) => ((p as any).weight ? (p as any).total / (p as any).weight : null),
    }
    // count distinct needs the things themselves; a median needs every value. Both are recomputed, by definition.
    default: return undefined
  }
}

const add = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b)

/** Can a coarser grouping be built from finer partial results, or must the rows be read again? */
export function reusable(aggregate: Aggregate): boolean {
  return monoidFor(aggregate) !== undefined
}

/** Fold a list of partial results into one — the same answer whatever order they arrive in. */
export function combineAll(aggregate: Aggregate, parts: Partial[]): Partial | undefined {
  const m = monoidFor(aggregate)
  if (!m) return undefined
  return parts.reduce((acc, p) => m.combine(acc, p), m.empty)
}
