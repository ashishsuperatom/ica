// ── COMPARISON: THIS AGAINST THEN ──────────────────────────────────────────────────────────────────────────
//
// Any question asked of a relation can be asked twice — now, and at a time to compare against — with the rows
// aligned and the change beside each. It is the comparison of Rill and Looker and MetricFlow's offset window,
// and it belongs in the vocabulary rather than in each program because the parts that go wrong are the same
// every time:
//
//   ALIGNMENT      July is compared with the July a year before, or with the April a quarter before: periods are
//                  matched by their place in each span, not by label.
//   LIKE FOR LIKE  a span still running is compared with the same number of days of the earlier span, not with
//                  the whole of it — otherwise every current period looks like a fall.
//   MONTH ENDS     31 August less six months is the last day of February, not 3 March.
//   MEMBERSHIP     a member in only one of the two — a pillar that did not exist, a customer who stopped — is a
//                  row with the other side empty: zero for an amount that adds up, unknown for anything else.

import { addDays } from './calendar.js'
import type { Coordinates, Grain } from './coordinates.js'
import { CoordinateError } from './coordinates.js'
import { arrange, type Column, type Result } from './execute.js'
import { additivity, type Shape } from './shape.js'

export type Offset = { years?: number; quarters?: number; months?: number; weeks?: number; days?: number }
/** What to compare against: the same question shifted back by an offset, or a span or instant given outright. */
export type Comparison = { offset: Offset } | { during: { from: string; to: string } } | { at: string }

const refuse = (msg: string): never => { throw new CoordinateError(msg) }

/** A date moved by an offset. Months keep the day where they can and clamp to the month's end where they cannot. */
export function shift(date: string, by: Offset, sign = -1): string {
  const months = sign * ((by.years ?? 0) * 12 + (by.quarters ?? 0) * 3 + (by.months ?? 0))
  let out = date
  if (months) {
    const [y, m, d] = date.split('-').map(Number)
    const index = y * 12 + (m - 1) + months
    const year = Math.floor(index / 12), month = index % 12 + 1
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const wasLast = d === new Date(Date.UTC(y, m, 0)).getUTCDate()
    out = `${year}-${String(month).padStart(2, '0')}-${String(wasLast ? last : Math.min(d, last)).padStart(2, '0')}`
  }
  const days = sign * ((by.weeks ?? 0) * 7 + (by.days ?? 0))
  return days ? addDays(out, days) : out
}

/** The two questions a comparison asks, and what the reader must be told about how they were matched. */
export function comparisonCoordinates(c: Coordinates & { compare: Comparison }, today: string, isFlow: boolean) {
  const { compare, having, order, limit, limitPer, ...rest } = c
  const caveats: string[] = []
  const current: Coordinates = { ...rest }
  const previous: Coordinates = { ...rest }
  if ('offset' in compare) {
    const o = compare.offset
    if (!Object.values(o).some((v) => v)) refuse('a comparison offset must move time by something')
    if (Object.values(o).some((v) => v != null && (!Number.isInteger(v) || v < 0))) refuse('offset amounts are whole numbers, counted back in time')
    if (rest.at) previous.at = shift(rest.at, o)
    if (rest.during) {
      let to = rest.during.to
      const tomorrow = addDays(today, 1)
      // Like for like: a span still running is compared with as many days of the earlier one.
      if (isFlow && to > tomorrow && rest.during.from < tomorrow) {
        to = tomorrow
        current.during = { from: rest.during.from, to }
        caveats.push(`compared like for like: ${rest.during.from} to ${today} against ${shift(rest.during.from, o)} to ${addDays(shift(to, o), -1)}`)
      }
      previous.during = { from: shift(rest.during.from, o), to: shift(to, o) }
    }
  } else if ('during' in compare) {
    if (!rest.during) refuse('compare a span with a span: ask during a span to compare against one')
    previous.during = compare.during
  } else if ('at' in compare) {
    if (!rest.at) refuse('compare an instant with an instant: ask at an instant to compare against one')
    previous.at = compare.at
  } else refuse('compare needs an offset, a during or an at')
  return { current, previous, after: { having, order, limit, limitPer }, caveats }
}

/** One result from two: each row now, the row it is compared with, and the change. */
export function mergeComparison(shape: Shape, now: Result, then: Result, by: string[], grain: Grain | null,
                                after: { having?: Coordinates['having']; order?: Coordinates['order']; limit?: number; limitPer?: string[] }): Result {
  const measures = now.columns.filter((c) => c.role === 'measure').map((c) => c.name)
  const splits = by.filter((d) => d !== grain)
  // Periods are matched by their place in each span.
  const place = (rows: Record<string, any>[]) => {
    const labels = grain ? [...new Set(rows.map((r) => String(r[grain])))].sort() : []
    return (r: Record<string, any>) => JSON.stringify([...splits.map((d) => r[d] ?? null), grain ? labels.indexOf(String(r[grain])) : 0])
  }
  const keyNow = place(now.rows), keyThen = place(then.rows)
  const thenByKey = new Map(then.rows.map((r) => [keyThen(r), r]))
  const seen = new Set<string>()
  const empty = (m: string) => (additivity(shape, m) === 'additive' ? 0 : null)
  const rows: Record<string, any>[] = []
  const combine = (cur: Record<string, any> | undefined, prev: Record<string, any> | undefined) => {
    const base = { ...(cur ?? prev)! }
    for (const m of measures) delete base[m]
    if (grain) { base[grain] = cur ? cur[grain] : null; base[`${grain}_compare`] = prev ? prev[grain] : null }
    const row: Record<string, any> = base
    for (const m of measures) {
      const a = cur ? cur[m] : empty(m)
      const b = prev ? prev[m] : empty(m)
      row[m] = a
      row[`${m}_compare`] = b
      row[`${m}_change`] = a == null || b == null ? null : a - b
      const ratio = shape.measures[m].kind === 'ratio'
      row[`${m}_change_ratio`] = ratio || a == null || b == null || b === 0 ? null : (a - b) / Math.abs(b)
    }
    rows.push(row)
  }
  for (const r of now.rows) { const k = keyNow(r); seen.add(k); combine(r, thenByKey.get(k)) }
  for (const r of then.rows) if (!seen.has(keyThen(r))) combine(undefined, r)

  const columns: Column[] = []
  for (const c of now.columns) {
    if (c.role !== 'measure') { columns.push(c); if (c.name === grain) columns.push({ name: `${grain}_compare`, role: 'label' }); continue }
    columns.push(c, { ...c, name: `${c.name}_compare` }, { ...c, name: `${c.name}_change`, kind: c.kind === 'ratio' ? 'ratio' : 'flow' },
                 { name: `${c.name}_change_ratio`, role: 'measure', unit: 'ratio', kind: 'ratio' })
  }
  const names = new Set(columns.map((c) => c.name))
  for (const o of after.order ?? []) if (!names.has(o.by)) refuse(`cannot order by "${o.by}" — the result has ${[...names].join(', ')}`)
  for (const m of Object.keys(after.having ?? {})) if (!names.has(m)) refuse(`cannot filter on "${m}" — the result has ${[...names].join(', ')}`)
  if (after.limit != null && !after.order?.length) refuse('a limit needs an order')
  return { columns, rows: arrange(rows, after, by), caveats: [...new Set([...now.caveats, ...then.caveats])] }
}

// ── COUNTERFACTUAL DIFFERENCE ─────────────────────────────────────────────────────────────────────────────

/** How an answer changed under a counterfactual: row by row for a dimensioned result, key by key for totals,
 *  and plainly for a number. Rows are matched on every column that is not a measure. */
export function difference(factual: any, counterfactual: any): any {
  if (typeof factual === 'number' && typeof counterfactual === 'number') {
    return { factual, counterfactual, change: counterfactual - factual }
  }
  if (factual?.columns && counterfactual?.columns) {
    const measures = factual.columns.filter((c: Column) => c.role === 'measure').map((c: Column) => c.name)
    const keys = factual.columns.filter((c: Column) => c.role !== 'measure').map((c: Column) => c.name)
    const key = (r: any) => JSON.stringify(keys.map((k: string) => r[k] ?? null))
    const after = new Map(counterfactual.rows.map((r: any) => [key(r), r]))
    const seen = new Set<string>()
    const rows: any[] = []
    const merge = (a: any, b: any) => {
      const row: any = Object.fromEntries(keys.map((k: string) => [k, (a ?? b)[k]]))
      for (const m of measures) {
        const x = a ? a[m] : null, y = b ? b[m] : null
        row[m] = x
        row[`${m}_counterfactual`] = y
        row[`${m}_change`] = typeof x === 'number' && typeof y === 'number' ? y - x : null
      }
      rows.push(row)
    }
    for (const r of factual.rows) { const k = key(r); seen.add(k); merge(r, after.get(k)) }
    for (const r of counterfactual.rows) if (!seen.has(key(r))) merge(undefined, r)
    const out: any = { columns: factual.columns, rows }
    if (factual.total && counterfactual.total) out.total = difference(factual.total, counterfactual.total)
    return out
  }
  if (factual && counterfactual && typeof factual === 'object' && typeof counterfactual === 'object') {
    const out: any = {}
    for (const k of new Set([...Object.keys(factual), ...Object.keys(counterfactual)])) {
      const a = factual[k], b = counterfactual[k]
      out[k] = typeof a === 'number' && typeof b === 'number' ? { factual: a, counterfactual: b, change: b - a }
        : JSON.stringify(a) === JSON.stringify(b) ? a : { factual: a, counterfactual: b }
    }
    return out
  }
  return JSON.stringify(factual) === JSON.stringify(counterfactual) ? factual : { factual, counterfactual }
}
