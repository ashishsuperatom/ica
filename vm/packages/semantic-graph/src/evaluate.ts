// ── THE REFERENCE EVALUATOR (§4.1) ──────────────────────────────────────────────────────────────────────────
//
// Runs a plan over an instance in memory, exactly as §4.1 defines an answer: each fact filtered, each row placed in
// the one group its paths lead to, each measure folded by its aggregate, money converted row by row, stocks taken at
// an instant, facts added up separately and then joined on their targets. It is written for being obviously right,
// not fast: it is the oracle compiled queries are tested against.

import { compares, meets, type Expr, type FactPlan, type Kept, type Plan, type Step } from './algebra.js'
import { keyOf, periodOf, periodsBetween, shiftPeriods } from './calendar.js'
import { DataError, follow, followPath, period, rowDate, type Instance, type Key, type Row } from './instance.js'
import { arrow, timeArrow, type Schema } from './schema.js'

export interface Result {
  columns: Plan['columns']
  rows: Array<Array<Key | number | null>>
  totals?: Array<{ by: string[]; rows: Array<Array<Key | number | null>> }>
  /** What people call each key of a target, by the target's position: { 0: { "15": "CEC" } }. */
  labels?: Record<number, Record<string, string>>
  notes: string[]
}
export type Groups = Map<string, { key: Array<Key | null>; values: Record<string, number | null> }>

export function evaluate(s: Schema, I: Instance, plan: Plan): Result {
  return assemble(plan, new Map(plansOf(plan).map((p) => [p, p.facts.map((fp) => foldFact(s, I, fp, p))])))
}

/** Every plan whose facts are aggregated to answer this one: itself, its totals, its share's whole, its comparison. */
export function plansOf(plan: Plan): Plan[] {
  return [plan, ...(plan.totals ?? []).map((t) => t.plan), ...(plan.share ? [plan.share.plan] : []), ...(plan.compare ? [plan.compare.plan] : [])]
}

/** An answer from each plan's aggregated facts — however they were aggregated: here, or by a source's SQL. Facts are
 *  put side by side on their targets; then shares, the comparison, having, order and limit. */
export function assemble(plan: Plan, folded: Map<Plan, Groups[]>): Result {
  const got = (p: Plan) => folded.get(p) ?? (() => { throw new Error('a plan was not aggregated') })()
  const n = plan.targets.length
  let rows = sideBySide(plan, got(plan))
  const width = plan.outputs.length
  const additive = (name: string) => { const o = plan.outputs.find((x) => x.name === name)!; return 'ref' in o.expr && plan.additive?.includes(o.expr.ref) }

  if (plan.share) {
    const within = plan.share.within.map((w) => plan.targets.indexOf(w))
    const whole = new Map(sideBySide(plan.share.plan, got(plan.share.plan)).map((r) => [JSON.stringify(r.slice(0, within.length)), r.slice(within.length)]))
    const idx = plan.share.outputs.map((o) => plan.outputs.findIndex((x) => x.name === o))
    const wholeIdx = plan.share.outputs.map((o) => plan.share!.plan.outputs.findIndex((x) => x.name === o))
    rows = rows.map((r) => {
      const w = whole.get(JSON.stringify(within.map((i) => r[i])))
      return [...r, ...idx.map((i, j) => { const part = r[n + i] as number | null, all = w?.[wholeIdx[j]] as number | null | undefined; return part === null || !all ? null : part / all })]
    })
  }

  if (plan.runs) rows = withRuns(plan, rows)

  if (plan.compare) {
    const time = plan.compare.time
    // A group before is matched with the group now that is the same number of periods forward.
    const forward = (key: Array<Key | null>) => key.map((k, i) => (time && i === time.target && k !== null ? shiftPeriods(time.def, k, time.periods) : k))
    const before = new Map(sideBySide(plan.compare.plan, got(plan.compare.plan)).map((r) => [JSON.stringify(forward(r.slice(0, n) as Array<Key | null>)), r.slice(n)]))
    const extra = rows[0] ? rows[0].length - n - width : plan.share?.outputs.length ?? 0
    const now = new Set(rows.map((r) => JSON.stringify(r.slice(0, n))))
    for (const [k, b] of before) if (!now.has(k)) rows.push([...JSON.parse(k), ...plan.outputs.map(() => null), ...Array(extra).fill(null)])
    // A group on one side only: nothing happened on the other, which is zero for what adds up and unknown otherwise.
    rows = rows.map((r) => {
      const b = before.get(JSON.stringify(r.slice(0, n)))
      const now = plan.outputs.map((o, i) => (r[n + i] ?? (additive(o.name) ? 0 : null)) as number | null)
      return [...r.slice(0, n), ...now, ...r.slice(n + width), ...plan.outputs.flatMap((o, i) => {
        const was = (b ? b[i] ?? (additive(o.name) ? 0 : null) : additive(o.name) ? 0 : null) as number | null
        return [was, was === null || now[i] === null ? null : now[i]! - was]
      })]
    })
    sortByKey(rows, n)
  }

  for (const h of plan.having ?? []) {
    const i = n + plan.outputs.findIndex((o) => o.name === h.output)
    rows = rows.filter((r) => { const v = r[i]; return v !== null && typeof v === 'number' && compares(v, h.op, h.value!) })
  }
  if (plan.order) {
    const i = plan.columns.findIndex((c) => c.name === plan.order!.by)
    rows.sort((a, b) => { const x = a[i], y = b[i]; if (x === y) return 0; if (x === null) return 1; if (y === null) return -1; return (x < y ? -1 : 1) * (plan.order!.desc ? -1 : 1) })
  }
  if (plan.limit && plan.limitPer) {
    const seen = new Map<string, number>()
    rows = rows.filter((r) => { const k = JSON.stringify(plan.limitPer!.map((i) => r[i])); const c = (seen.get(k) ?? 0) + 1; seen.set(k, c); return c <= plan.limit! })
  } else if (plan.limit) rows = rows.slice(0, plan.limit)
  const totals = plan.totals?.map((t) => ({ by: t.by, rows: sideBySide(t.plan, got(t.plan)) }))
  return { columns: plan.columns, rows, ...(totals ? { totals } : {}), notes: plan.notes }
}

/** Each fact's groups joined on the targets — every group any fact has — then, along the calendar grouped by, empty
 *  periods filled, running totals and moving windows taken on the measures, and the outputs computed from them. */
function sideBySide(plan: Plan, perFact: Groups[]): Array<Array<Key | number | null>> {
  const keys = new Map<string, Array<Key | null>>()
  for (const r of perFact) for (const [k, g] of r) keys.set(k, g.key)
  let joined = [...keys].map(([k, key]) => {
    const values: Record<string, number | null> = {}
    plan.facts.forEach((fp, i) => { for (const m of fp.measures) values[`${fp.fact}.${m}`] = perFact[i].get(k)?.values[m] ?? null })
    return { key, values }
  })
  const scale = new Map<string, number>()
  if (plan.along) joined = along(plan, joined, scale)
  const rows = joined.map(({ key, values }) => [...key, ...plan.outputs.map((o) => { const v = calc(o.expr, values); return v !== null && 'ref' in o.expr && scale.has(o.expr.ref) ? v / scale.get(o.expr.ref)! : v })])
  return sortByKey(rows, plan.targets.length)
}

/** Fill, running totals and moving windows along the calendar target, on each group's measures. */
function along(plan: Plan, joined: Array<{ key: Array<Key | null>; values: Record<string, number | null> }>, scale: Map<string, number>) {
  const a = plan.along!
  const t = a.target
  const refs = plan.facts.flatMap((fp) => fp.measures.map((m) => `${fp.fact}.${m}`))
  const zero = (r: string) => (plan.additive?.includes(r) ? 0 : null)
  const wide = periodsBetween(a.def, plan.span!.from, plan.span!.to).map((p) => p.key)
  const shown = new Set(periodsBetween(a.def, a.keep.from, a.keep.to).map((p) => p.key))
  const groups = new Map<string, { key: Array<Key | null>; byPeriod: Map<string, Record<string, number | null>> }>()
  for (const j of joined) {
    const g = JSON.stringify(j.key.map((k, i) => (i === t ? '*' : k)))
    if (!groups.has(g)) groups.set(g, { key: j.key, byPeriod: new Map() })
    groups.get(g)!.byPeriod.set(String(j.key[t]), j.values)
  }
  const out: typeof joined = []
  for (const { key, byPeriod } of groups.values()) {
    const running: Record<string, number> = {}
    let resetAt: string | undefined
    const periods = a.fill || a.cumulative ? wide : wide.filter((p) => byPeriod.has(p))
    for (const [i, p] of periods.entries()) {
      const own = byPeriod.get(p)
      let values: Record<string, number | null> = Object.fromEntries(refs.map((r) => [r, own ? own[r] ?? zero(r) : zero(r)]))
      if (a.rolling) {
        const window = periods.slice(Math.max(0, i - a.rolling.window + 1), i + 1)
        values = Object.fromEntries(refs.map((r) => [r, window.reduce<number>((s, q) => s + (byPeriod.get(q)?.[r] ?? 0), 0)]))
      }
      if (a.cumulative) {
        const r = a.cumulative.reset ? keyOf(a.cumulative.reset, periodOf(a.def, p).from) : undefined
        if (r !== resetAt) { for (const k of Object.keys(running)) delete running[k]; resetAt = r }
        values = Object.fromEntries(refs.map((x) => [x, (running[x] = (running[x] ?? 0) + (values[x] ?? 0))]))
      }
      if (!shown.has(p) || (!own && !a.fill)) continue
      out.push({ key: key.map((k, j) => (j === t ? p : k)), values })
    }
  }
  if (a.rolling?.average) for (const r of refs) scale.set(r, a.rolling.window)
  return out
}

// Groups in key order, the "none" group last.
function sortByKey<T extends Array<Key | number | null>>(rows: T[], n: number): T[] {
  return rows.sort((a, b) => { for (let i = 0; i < n; i++) { if (a[i] === b[i]) continue; if (a[i] === null) return 1; if (b[i] === null) return -1; const c = String(a[i]).localeCompare(String(b[i])); if (c) return c } return 0 })
}

/** THE LONGEST RUN: for each group with the calendar left out, its periods in calendar order; a run continues only into
 *  the period that follows (a period missing from the answer breaks it) and only while the output meets the comparison.
 *  One number per group, carried on each of its rows as an extra column, after the outputs and shares. */
function withRuns(plan: Plan, rows: Array<Array<Key | number | null>>): Array<Array<Key | number | null>> {
  const { target: t, output, op, value, def } = plan.runs!
  const n = plan.targets.length
  const col = n + plan.outputs.findIndex((o) => o.name === output)
  const groupOf = (r: Array<Key | number | null>) => JSON.stringify(r.slice(0, n).map((k, i) => (i === t ? '*' : k)))
  const groups = new Map<string, Array<{ period: string; meets: boolean }>>()
  for (const r of rows) {
    const v = r[col]
    const g = groupOf(r)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push({ period: String(r[t]), meets: typeof v === 'number' && compares(v, op, value) })
  }
  const next = (period: string) => { try { return shiftPeriods(def, period, 1) } catch { return undefined } }
  const longest = new Map<string, number>()
  for (const [g, periods] of groups) {
    periods.sort((a, b) => periodOf(def, a.period).from.localeCompare(periodOf(def, b.period).from))
    let best = 0, run = 0, before: string | undefined
    for (const p of periods) {
      run = p.meets ? (before !== undefined && next(before) === p.period ? run + 1 : 1) : 0
      best = Math.max(best, run)
      before = p.period
    }
    longest.set(g, best)
  }
  return rows.map((r) => [...r, longest.get(groupOf(r)) ?? 0])
}

/** The rows behind one group of an answer: for each fact, its rows whose paths lead to that group. */
export function detail(s: Schema, I: Instance, plan: Plan, key: Array<Key | null>): Array<{ fact: string; rows: Row[] }> {
  return plan.facts.map((fp) => ({
    fact: fp.fact,
    rows: (I.rows[fp.fact] ?? []).filter((row) => keep(s, I, fp, plan, row) && fp.by.every((b, i) => stepValue(s, I, fp.fact, row, b) === key[i])),
  }))
}

export function calc(e: Expr, v: Record<string, number | null>): number | null {
  if ('ref' in e) return v[e.ref] ?? null
  if ('num' in e) return e.num
  const a = calc(e.args[0], v), b = calc(e.args[1], v)
  if (a === null || b === null) return null
  if ('fn' in e) return e.fn === 'max' ? Math.max(a, b) : Math.min(a, b)
  if (e.op === '+') return a + b
  if (e.op === '-') return a - b
  if (e.op === '*') return a * b
  return b === 0 ? null : a / b
}

function foldFact(s: Schema, I: Instance, fp: FactPlan, plan: Plan): Groups {
  const def = s.objects[fp.fact]
  const time = timeArrow(s, fp.fact)
  const rows = (I.rows[fp.fact] ?? []).filter((row) => keep(s, I, fp, plan, row))
  const keyOf = (row: Row) => fp.by.map((b) => stepValue(s, I, fp.fact, row, b))
  const groups = new Map<string, { key: Key[]; rows: Row[] }>()
  for (const row of rows) {
    const key = keyOf(row) as Key[]
    const k = JSON.stringify(key)
    if (!groups.has(k)) groups.set(k, { key, rows: [] })
    groups.get(k)!.rows.push(row)
  }
  const out: Groups = new Map()
  for (const [k, g] of groups) {
    const values: Record<string, number | null> = {}
    for (const name of fp.measures) {
      const m = def.measures![name]
      // A measure worked out per row is its expression over the row's columns; a part that is missing makes it missing.
      const perRow = fp.perRow?.[name]
      const raw = (row: Row): number | null => (perRow ? calc(perRow, row.measures) : row.measures[name] ?? null)
      const value = (row: Row) => { const v = raw(row); return v === null ? null : fp.convert && m.currency ? v * rate(s, I, fp, plan, row, m.currency) : v }
      // A measure kept to a condition of its own is folded from the rows where it holds; the others are as if absent.
      const held = fp.kept?.[name]
      const own = held ? g.rows.filter((row) => held.every((w) => holds(s, I, fp, row, w))) : g.rows
      if (m.kind === 'stock' && fp.stockOverTime && time) {
        // The level at each instant is folded across everything else; then one instant, or the average of all, per group.
        const allInstants = [...new Set(rows.filter((r) => JSON.stringify(keyOfTimeBucket(fp, r, keyOf)) === JSON.stringify(keyOfTimeBucket(fp, g.rows[0], keyOf))).map((r) => r.arrows[time.role]))].sort()
        const at = (instant: Key) => fold(m.aggregate, own.filter((r) => r.arrows[time.role] === instant), value, raw)
        values[name] = m.overTime === 'last' ? at(allInstants[allInstants.length - 1]) ?? (m.aggregate === 'sum' || m.aggregate === 'count' ? 0 : null)
          : m.overTime === 'first' ? at(allInstants[0]) ?? (m.aggregate === 'sum' || m.aggregate === 'count' ? 0 : null)
          : mean(allInstants.map((i) => at(i) ?? (m.aggregate === 'sum' || m.aggregate === 'count' ? 0 : null)))
      } else if (m.aggregate === 'count distinct') {
        values[name] = new Set(own.map((r) => r.arrows[m.of!])).size
      } else if (m.aggregate === 'weighted average') {
        let num = 0, den = 0
        for (const r of own) { const v = value(r), w = r.measures[m.weight!]; if (v !== null && w) { num += v * w; den += w } }
        values[name] = den ? num / den : null
      } else {
        values[name] = fold(m.aggregate, own, value, raw)
        // A kept sum over no qualifying rows is nothing added up: zero, as the compiler answers it.
        if (held && m.aggregate === 'sum' && values[name] === null) values[name] = 0
      }
    }
    out.set(k, { key: g.key, values })
  }
  return out
}

/** For a stock, the instants that count for a group are those in its time bucket — the group's key with every
 *  non-time target left out — so a pillar with no row in the last month has level 0 then, not its earlier level. */
function keyOfTimeBucket(fp: FactPlan, row: Row, keyOf: (r: Row) => Array<Key | null>) {
  const key = keyOf(row)
  return fp.by.map((b, i) => ('path' in b && b.path[0] === fp.time?.role ? key[i] : '*'))
}

function fold(aggregate: string, rows: Row[], value: (r: Row) => number | null, raw: (r: Row) => number | null): number | null {
  const vs = rows.map(value).filter((v): v is number => v !== null)
  if (aggregate === 'count') return rows.filter((r) => raw(r) !== null).length
  if (!vs.length) return null
  if (aggregate === 'sum') return vs.reduce((a, b) => a + b, 0)
  if (aggregate === 'min') return Math.min(...vs)
  if (aggregate === 'max') return Math.max(...vs)
  if (aggregate === 'average') return vs.reduce((a, b) => a + b, 0) / vs.length
  if (aggregate === 'median') return median(vs)
  throw new Error(`no fold for ${aggregate}`)
}
const mean = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }

function keep(s: Schema, I: Instance, fp: FactPlan, plan: Plan, row: Row): boolean {
  if (plan.span && fp.time) {
    const p = period(s, fp.time.calendar, row.arrows[fp.time.role])
    if (p.from < plan.span.from || p.from >= plan.span.to) return false
  }
  return fp.where.every((w) => holds(s, I, fp, row, w))
}

/** Whether one filter holds for a row — the question's, or a measure's own; a row's missing measure meets no comparison. */
function holds(s: Schema, I: Instance, fp: FactPlan, row: Row, w: Kept): boolean {
  if ('measure' in w) { const v = row.measures[w.measure]; return v !== null && v !== undefined && compares(v, w.op, w.value) }
  if ('attribute' in w) { const v = stepValue(s, I, fp.fact, row, w); return meets(w, v, v === null ? null : String(v)) }
  let v = followPath(s, I, fp.fact, row, w.path)
  if (!w.under) return meets(w, v, v === null ? null : I.elements[pathEnd(s, fp.fact, w.path)]?.[v]?.label ?? s.objects[pathEnd(s, fp.fact, w.path)].members?.[v] ?? v)
  // Under: the element itself or anything it reaches along the self arrow.
  const object = pathEnd(s, fp.fact, w.path)
  const date = rowDate(s, fp.fact, row)
  let found = false
  while (v !== null && !found) { found = meets(w, v, null); v = follow(s, I, object, v, w.under, date) }
  return found
}
const pathEnd = (s: Schema, from: string, path: string[]) => path.reduce((o, role) => arrow(s, o, role)!.to, from)

/** What a step gives for a row: where its path leads, its own attribute, or an attribute of the element a path leads to. */
function stepValue(s: Schema, I: Instance, fact: string, row: Row, step: Step): Key | null {
  if ('path' in step) return followPath(s, I, fact, row, step.path)
  if (!step.at?.length) return row.attributes?.[step.attribute] ?? null
  const key = followPath(s, I, fact, row, step.at)
  if (key === null) return null
  const v = I.elements[pathEnd(s, fact, step.at)]?.[key]?.attributes?.[step.attribute]
  return v === undefined || v === null ? null : String(v)
}

/** 1 of a row's currency in the plan's currency, from the conversion fact: the latest rate on or before the date. */
function rate(s: Schema, I: Instance, fp: FactPlan, plan: Plan, row: Row, currency: string[] | { attribute: string }): number {
  const from = Array.isArray(currency) ? followPath(s, I, fp.fact, row, currency) : row.attributes![currency.attribute]
  const to = fp.convert!.currency
  if (from === to) return 1
  const c = s.conversion!
  const on = fp.convert!.on ?? (fp.convert!.at === 'end' ? dayBefore(plan.span!.to) : rowDate(s, fp.fact, row)!)
  // A rate is measured, so none dated after the day the answer is given as of is known.
  const date = plan.asOf && plan.asOf < on ? plan.asOf : on
  const best = (I.rows[c.fact] ?? []).filter((r) => r.arrows[c.from] === from && r.arrows[c.to] === to && r.arrows[c.day] <= date).sort((a, b) => b.arrows[c.day].localeCompare(a.arrows[c.day]))[0]
  if (!best || best.measures[c.rate] === null) throw new DataError(`no rate from ${from} to ${to} on or before ${date}`)
  return best.measures[c.rate]!
}
const dayBefore = (d: string) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10) }

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
