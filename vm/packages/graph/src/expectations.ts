// ── EXPECTATIONS: WHAT A NUMBER USUALLY IS, AND WHEN IT IS NOT ────────────────────────────────────────────
//
// Every answer that has a time grain leaves its values in memory as series: one measure, of one member, period by
// period, for one question — the same filters, splits and assumptions. What a period is expected to be is read from
// the periods before it in the same series, so an expectation is always conditioned on the question: utilisation
// for NetSuite by month is not expected to look like utilisation for the company.
//
// The expectation is robust: the median of the recent periods and their median absolute deviation, scaled to be
// comparable with a standard deviation (Hampel's filter; Leys et al., 2013). One unusual month does not move it, as
// it would move a mean. A value more than `threshold` of those deviations from the median is a surprise.
//
// A surprise is then TRIAGED: the answer's call tree is walked, and each program it called is asked the same
// question of its own memory — was its part of this period surprising too? The deepest surprising parts are where
// to look first. That is the start of an explanation, not the explanation: whether the world changed or the data
// did is for whoever reads it, or for an analysis program to test.

import { createHash } from 'node:crypto'
import type { Result } from './execute.js'
import type { CallRecord, GraphStore, Observation } from './store.js'

export interface Expectation {
  /** How many earlier periods it is based on. Fewer than MIN_HISTORY: nothing is expected yet. */
  n: number
  known: boolean
  median?: number
  /** The robust spread: 1.4826 × the median absolute deviation, never less than a small share of the median. */
  spread?: number
  low?: number
  high?: number
  /** For a value: how many spreads from the median it lies, and whether that is outside the band. */
  value?: number | null
  z?: number | null
  surprising?: boolean
  /** The periods memory no longer keeps whole, as their distribution. */
  longRun?: { n: number; mean: number; sd: number; min: number | null; max: number | null; from: string; to: string }
}

const MIN_HISTORY = 4
const DEFAULT_WINDOW = 12
const DEFAULT_THRESHOLD = 3
/** Where every recent period is the same, any difference would be infinitely surprising. A spread of at least 5% of
 *  the median says a change smaller than that is not news. */
const SPREAD_FLOOR = 0.05

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

/** Parts of a request that choose which periods or rows are shown, not what is measured. */
const PRESENTATION = ['during', 'at', 'order', 'limit', 'limitPer', 'totals', 'share', 'detail', 'fill', 'compare']

/** The question apart from its time: the key of every series it contributes to. */
export function seriesKey(request: unknown, context: Record<string, unknown> | null, lineage: string | null): string {
  const r = Object.fromEntries(Object.entries((request ?? {}) as Record<string, unknown>).filter(([k]) => !PRESENTATION.includes(k)))
  // The lineage is part of the series: after a correction anywhere beneath, the program's memory starts again rather
  // than mixing values from the wrong version with values from the right one.
  return createHash('sha256').update(canonical({ request: r, context: context ?? {}, lineage: lineage ?? '' })).digest('hex').slice(0, 24)
}

/** The exact programs an answer came from, as one hash: its own, and every lineage beneath it. */
export function lineageOf(hash: string, beneath: Array<string | undefined | null>): string {
  return createHash('sha256').update([hash, ...[...new Set(beneath.filter(Boolean))].sort()].join('|')).digest('hex').slice(0, 16)
}

/** The observations an answer leaves in memory. Every answer leaves some:
 *    a result with a time grain   each row's measures, in the row's period
 *    a result without one         each row's measures, in the period it was answered for — its instant, or its day
 *    any other value              its numbers, by name, in the day it was answered as of
 *  so a number asked every day has a series as surely as one asked by month. */
export function observationsOf(call: { id: string; name: string; hash: string; request: unknown; at: number; today: string; lineage: string | null },
                               context: Record<string, unknown> | null, value: unknown, isGrain: (name: string) => boolean): Observation[] {
  const series = seriesKey(call.request, context, call.lineage)
  const base = { name: call.name, hash: call.hash, callId: call.id, series, at: call.at }
  const asked = (call.request as any)?.at
  const instant = typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : call.today
  const num = (v: unknown) => (typeof v === 'number' ? v : v == null || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
  const result = value as Result
  if (result && Array.isArray(result.columns) && Array.isArray(result.rows)) {
    const grain = result.columns.find((c) => c.role === 'dimension' && isGrain(c.name))?.name
    const members = result.columns.filter((c) => c.role === 'dimension' && c.name !== grain).map((c) => c.name)
    const measures = result.columns.filter((c) => c.role === 'measure' && !/_(compare|change|change_ratio|share|counterfactual)$/.test(c.name)).map((c) => c.name)
    return result.rows.flatMap((row) => measures.map((measure) => ({
      ...base, grain: grain ?? 'day', measure, value: num(row[measure]),
      member: canonical(Object.fromEntries(members.map((m) => [m, row[m] ?? null]))),
      period: grain ? String(row[grain]) : instant,
    })))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const leaves: Array<[string, number]> = []
    const walk = (v: any, path: string, depth: number) => {
      for (const [k, x] of Object.entries(v)) {
        const key = path ? `${path}.${k}` : k
        if (typeof x === 'number' && Number.isFinite(x)) leaves.push([key, x])
        else if (x && typeof x === 'object' && !Array.isArray(x) && depth < 2) walk(x, key, depth + 1)
      }
    }
    walk(value, '', 0)
    return leaves.map(([measure, v]) => ({ ...base, grain: 'day', measure, value: v, member: '{}', period: call.today }))
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [{ ...base, grain: 'day', measure: 'value', value, member: '{}', period: call.today }]
  return []
}

/** An answer's observations cut to what memory keeps from one answer. Whole series are kept — every period of one
 *  member's measure — never a series cut short, which would teach an expectation from whichever periods fitted. The
 *  largest members go first: they are what most questions are about. */
export function withinLimit(observations: Observation[], limit: number): { kept: Observation[]; series: number; keptSeries: number } {
  const groups = new Map<string, Observation[]>()
  for (const o of observations) {
    const k = JSON.stringify([o.member, o.measure])
    groups.set(k, [...(groups.get(k) ?? []), o])
  }
  if (observations.length <= limit) return { kept: observations, series: groups.size, keptSeries: groups.size }
  const size = (g: Observation[]) => g.reduce((a, o) => a + Math.abs(o.value ?? 0), 0)
  const kept: Observation[] = []
  let keptSeries = 0
  for (const g of [...groups.values()].sort((a, b) => size(b) - size(a))) {
    if (kept.length + g.length > limit) continue
    kept.push(...g)
    keptSeries++
  }
  return { kept, series: groups.size, keptSeries }
}

export function expect(store: GraphStore, q: { name: string; request: unknown; context?: Record<string, unknown> | null; lineage?: string | null; measure: string; grain: string
                                                 member?: Record<string, unknown>; period: string; window?: number; value?: number | null; threshold?: number }): Expectation {
  const key = { name: q.name, series: seriesKey(q.request, q.context ?? null, q.lineage ?? null), member: canonical(q.member ?? {}), measure: q.measure, grain: q.grain }
  const longRun = store.summary(key) ?? undefined
  const history = store.series({ ...key, before: q.period })
    .slice(-(q.window ?? DEFAULT_WINDOW))
    .map((h) => h.value)
    .filter((v): v is number => v != null && Number.isFinite(v))
  if (history.length < MIN_HISTORY) return { n: history.length, known: false, ...(longRun ? { longRun } : {}) }
  const median = middle(history)
  const mad = middle(history.map((v) => Math.abs(v - median)))
  const spread = Math.max(1.4826 * mad, Math.abs(median) * SPREAD_FLOOR, 1e-9)
  const k = q.threshold ?? DEFAULT_THRESHOLD
  const out: Expectation = { n: history.length, known: true, median, spread, low: median - k * spread, high: median + k * spread, ...(longRun ? { longRun } : {}) }
  if (q.value !== undefined) {
    out.value = q.value
    out.z = q.value == null ? null : (q.value - median) / spread
    out.surprising = out.z != null && Math.abs(out.z) > k
  }
  return out
}

function middle(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface Surprise { member: Record<string, unknown>; period: string; measure: string; expectation: Expectation }

/** Values outside what memory expected of them, among observations not yet recorded. */
export function surprisesAmong(store: GraphStore, observations: Observation[], request: unknown, context: Record<string, unknown> | null, lineage: string | null,
                               options: { threshold?: number; window?: number } = {}): Surprise[] {
  const out: Surprise[] = []
  for (const o of observations) {
    const member = JSON.parse(o.member)
    const e = expect(store, { name: o.name, request, context, lineage, measure: o.measure, grain: o.grain, member, period: o.period,
                              value: o.value, window: options.window, threshold: options.threshold })
    if (e.surprising) out.push({ member, period: o.period, measure: o.measure, expectation: e })
  }
  return out
}

/** Every value in a recorded answer outside what memory expected of it. */
export function surprisesIn(store: GraphStore, call: CallRecord, context: Record<string, unknown> | null, isGrain: (name: string) => boolean,
                            options: { threshold?: number; window?: number } = {}): Surprise[] {
  const obs = observationsOf({ id: call.id, name: call.name, hash: call.hash, request: call.request, at: call.at, today: call.today, lineage: call.lineage ?? null },
                             context, call.output, isGrain)
  return surprisesAmong(store, obs, call.request, context, call.lineage ?? null, options)
}

export interface TriageNode {
  name: string
  callId: string
  measure: string
  member: Record<string, unknown>
  expectation: Expectation
  parts: TriageNode[]
}

/** Walk a surprise down the call tree: for each program the answer called, its own measures for the same member and
 *  period, against its own memory. `leads` are the deepest surprising parts. */
export function triage(store: GraphStore, call: CallRecord, context: Record<string, unknown> | null, isGrain: (name: string) => boolean,
                       at: { member: Record<string, unknown>; period: string; measure: string }, options: { threshold?: number; window?: number } = {}) {
  const valueIn = (c: CallRecord, measure: string, member: Record<string, unknown>) => {
    const result = c.output as Result
    if (!result?.columns) return undefined
    const grain = result.columns.find((col) => col.role === 'dimension' && isGrain(col.name))?.name
    if (!grain || !result.columns.some((col) => col.name === measure)) return undefined
    // A part is about the same member when every dimension it splits by agrees; a part filtered to the member
    // rather than split by it has fewer dimensions, and agrees on the ones it has.
    const row = result.rows.find((r) => String(r[grain]) === at.period && Object.entries(member).every(([k, v]) => !(k in r) || String(r[k]) === String(v)))
    if (!row) return undefined
    const own = Object.fromEntries(result.columns.filter((col) => col.role === 'dimension' && col.name !== grain).map((col) => [col.name, row[col.name] ?? null]))
    return { grain, value: row[measure] as number | null, own }
  }
  const node = (c: CallRecord, measure: string, depth: number): TriageNode | null => {
    const found = valueIn(c, measure, at.member)
    if (!found) return null
    const expectation = expect(store, { name: c.name, request: c.request, context, lineage: c.lineage ?? null, measure, grain: found.grain, member: found.own, period: at.period,
                                        value: found.value, window: options.window, threshold: options.threshold })
    const parts: TriageNode[] = []
    if (depth < 8) {
      for (const child of store.children(c.id)) {
        const childResult = child.output as Result
        if (!childResult?.columns) continue
        for (const col of childResult.columns.filter((x) => x.role === 'measure')) {
          const n = node(child, col.name, depth + 1)
          if (n) parts.push(n)
        }
      }
    }
    return { name: c.name, callId: c.id, measure, member: found.own, expectation, parts }
  }
  const root = node(call, at.measure, 0)
  const leads: TriageNode[] = []
  const walk = (n: TriageNode) => {
    const surprisingParts = n.parts.filter((p) => p.expectation.surprising)
    if (n.expectation.surprising && !surprisingParts.length) leads.push(n)
    for (const p of n.parts) walk(p)
  }
  if (root) walk(root)
  return { root, leads }
}
