// ── EXPECTATIONS: WHAT A NUMBER USUALLY IS, AND WHEN IT IS NOT ────────────────────────────────────────────
//
// Every answer grouped by a calendar level leaves its values in memory as series: one output, of one group, period
// by period, for one question apart from its span. What a period is expected to be is read from the periods before
// it in the same series — so an expectation is conditioned on the question: hours for Sydney by month are not
// expected to look like hours for the company.
//
// The expectation is robust: the median of recent periods and their median absolute deviation, scaled to compare
// with a standard deviation (Hampel's filter; Leys et al., 2013). One unusual month does not move it as it would move a
// mean. A value more than `threshold` of those deviations from the median is a surprise. Where every recent period is
// the same, a spread of at least 5% of the median says a change smaller than that is not news.

export interface Expectation {
  /** How many earlier periods it rests on; fewer than MIN_HISTORY and nothing is expected yet. */
  n: number
  known: boolean
  median?: number
  spread?: number
  low?: number
  high?: number
  value?: number | null
  z?: number | null
  surprising?: boolean
  /** The periods memory no longer keeps whole, as their distribution. */
  longRun?: { n: number; mean: number; sd: number; min: number | null; max: number | null; from: string; to: string }
}

export const MIN_HISTORY = 4
export const WINDOW = 12
export const THRESHOLD = 3
const SPREAD_FLOOR = 0.05

/** What the next value is expected to be from the values before it (oldest first), and how far `value` is from that. */
export function expectation(before: Array<number | null>, value?: number | null, options: { window?: number; threshold?: number } = {}): Expectation {
  const history = before.slice(-(options.window ?? WINDOW)).filter((v): v is number => v != null && Number.isFinite(v))
  if (history.length < MIN_HISTORY) return { n: history.length, known: false }
  const median = middle(history)
  const spread = Math.max(1.4826 * middle(history.map((v) => Math.abs(v - median))), Math.abs(median) * SPREAD_FLOOR, 1e-9)
  const k = options.threshold ?? THRESHOLD
  const out: Expectation = { n: history.length, known: true, median, spread, low: median - k * spread, high: median + k * spread }
  if (value !== undefined) {
    out.value = value
    out.z = value == null ? null : (value - median) / spread
    out.surprising = out.z != null && Math.abs(out.z) > k
  }
  return out
}

function middle(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
