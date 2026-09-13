// ── COORDINATES: THE QUESTION ASKED OF A RELATION ─────────────────────────────────────────────────────────
//
// A fixed vocabulary — which measures, split by what, filtered how, over what time — that never grows per
// program. Drilling down is a different set of coordinates, never a different program.
//
// This file turns a relation plus coordinates into a PLAN of SQL statements, and refuses the requests that
// would produce a wrong number. The one it refuses most deliberately: a stock asked across a span of time with
// no rule for rolling it up. Headcount for a quarter is not the sum of three month-end headcounts, and summing
// them yields a figure three times too large that looks perfectly ordinary.

import type { Measure, MeasureKind, Relation } from './relation.js'

export interface Coordinates {
  measures?: string[]
  by?: string[]
  /** Filters on a dimension's KEY. A list means any of. */
  where?: Record<string, string | number | Array<string | number>>
  /** A span: from inclusive, to exclusive, as YYYY-MM-DD. */
  during?: { from: string; to: string }
  /** An instant, as YYYY-MM-DD. Only a stock has a value at an instant. */
  at?: string
  /** How a stock is rolled over a span, when it is not asked by month. */
  rollup?: { time?: 'last' | 'average' }
}

export type Dialect = 'oracle' | 'mssql'

export interface Statement {
  sql: string
  params: Record<string, unknown>
  /** The month this statement answers, for a stock read as at each month-end. */
  month?: string
}

export interface Plan {
  statements: Statement[]
  /** The same question with no split, for checking the parts sum to the whole. Only for a single statement. */
  unsplit?: Statement
  kind: MeasureKind
  measures: string[]
  by: string[]
  /** How rows from several statements become one result. */
  combine: 'single' | 'label-month' | 'average-over-months'
  caveats: string[]
}

export class CoordinateError extends Error {}
const refuse = (msg: string): never => { throw new CoordinateError(msg) }

const dateOk = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)

function sqlFor(dialect: Dialect) {
  return dialect === 'mssql'
    ? { date: (p: string) => `CAST(@${p} AS date)`, month: (c: string) => `FORMAT(${c}, 'yyyy-MM')` }
    : { date: (p: string) => `TO_DATE(@${p}, 'YYYY-MM-DD')`, month: (c: string) => `TO_CHAR(${c}, 'YYYY-MM')` }
}

/** Month-ends inside a span, the last one clamped so a stock is never read at a date that has not happened. */
function monthEnds(from: string, to: string, today: string): string[] {
  const out: string[] = []
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7))
  for (;;) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    const firstOfMonth = `${y}-${String(m).padStart(2, '0')}-01`
    if (firstOfMonth >= to) break
    out.push(end < to ? (end > today ? today : end) : (to > today ? today : to))
    m++; if (m > 12) { m = 1; y++ }
  }
  return [...new Set(out)]
}

export function plan(r: Relation, c: Coordinates, dialect: Dialect, today = new Date().toISOString().slice(0, 10)): Plan {
  const { dimensions, measures: defined, time, asAt } = r.shape
  const measures = c.measures?.length ? c.measures : Object.keys(defined)
  const by = c.by ?? []
  const where = c.where ?? {}

  for (const m of measures) if (!defined[m]) refuse(`there is no measure "${m}" — available: ${Object.keys(defined).join(', ')}`)
  const kinds = new Set(measures.map((m) => defined[m].kind))
  if (kinds.size > 1) refuse(`flows and stocks answer time differently, so ${measures.join(' and ')} cannot be asked together — ask for them separately`)
  const kind = [...kinds][0] as MeasureKind

  const known = [...Object.keys(dimensions), 'month']
  for (const d of by) if (!known.includes(d)) refuse(`"${d}" is not a dimension of this relation — available: ${known.join(', ')}`)
  for (const d of Object.keys(where)) {
    if (!dimensions[d]) refuse(`cannot filter on "${d}" — filterable dimensions: ${Object.keys(dimensions).join(', ')}`)
  }
  if (c.during && (!dateOk(c.during.from) || !dateOk(c.during.to) || c.during.from >= c.during.to)) {
    refuse('during must be { from, to } as YYYY-MM-DD, with from before to')
  }
  if (c.at && !dateOk(c.at)) refuse('at must be a date, YYYY-MM-DD')
  if (c.at && c.during) refuse('ask either at an instant or during a span, not both')

  const s = sqlFor(dialect)
  const caveats: string[] = [...r.shape.caveats]
  for (const d of by) if (d !== 'month' && dimensions[d].history === 'current') {
    caveats.push(`"${d}" is read as it is today, not as it was at the time`)
  }

  // ── the parts every statement shares ──────────────────────────────────────────────────────────────────
  const params: Record<string, unknown> = {}
  const filters: string[] = []
  for (const [d, v] of Object.entries(where)) {
    const values = Array.isArray(v) ? v : [v]
    const names = values.map((val, i) => { const n = `w_${d}_${i}`; params[n] = val; return `@${n}` })
    filters.push(values.length === 1 ? `${dimensions[d].key} = ${names[0]}` : `${dimensions[d].key} IN (${names.join(', ')})`)
  }
  const select = (dims: string[]) => {
    const cols: string[] = []
    const group: string[] = []
    for (const d of dims) {
      if (d === 'month') { cols.push(`${s.month(time!)} AS month`); group.push(s.month(time!)); continue }
      const dim = dimensions[d]
      cols.push(`${dim.key} AS ${d}`); group.push(dim.key)
      if (dim.label && dim.label !== dim.key) { cols.push(`${dim.label} AS ${d}_label`); group.push(dim.label) }
    }
    for (const m of measures) cols.push(`${defined[m].sql} AS ${m}`)
    return { cols, group }
  }
  const statement = (dims: string[], extraWhere: string[]): string => {
    const { cols, group } = select(dims)
    const conds = [...r.wheres, ...filters, ...extraWhere]
    return [`SELECT ${cols.join(', ')}`, `FROM ${r.from}`, ...r.joins,
            conds.length ? `WHERE ${conds.join('\n  AND ')}` : '',
            group.length ? `GROUP BY ${group.join(', ')}` : ''].filter(Boolean).join('\n')
  }
  const splits = by.filter((d) => d !== 'month')

  // ── a flow: one statement bounded by the span ─────────────────────────────────────────────────────────
  if (kind === 'flow') {
    if (c.at) refuse(`${measures.join(', ')} is a flow: it accumulates over a span and has no value at an instant — ask during a span`)
    if (!c.during) refuse(`${measures.join(', ')} is a flow: say which span it accumulates over (during)`)
    const p = { ...params, from: c.during!.from, to: c.during!.to }
    const bounds = [`${time} >= ${s.date('from')}`, `${time} < ${s.date('to')}`]
    return { statements: [{ sql: statement(by, bounds), params: p }],
             unsplit: splits.length || by.includes('month') ? { sql: statement([], bounds), params: p } : undefined,
             kind, measures, by, combine: 'single', caveats }
  }

  // ── a stock: read at instants ─────────────────────────────────────────────────────────────────────────
  const atStatement = (date: string, month?: string, dims = splits): Statement =>
    ({ sql: statement(dims, [asAt!]), params: { ...params, asAt: date }, month })
  const single = (date: string): Pick<Plan, 'statements' | 'unsplit'> =>
    ({ statements: [atStatement(date)], unsplit: splits.length ? atStatement(date, undefined, []) : undefined })

  if (c.at) {
    if (by.includes('month')) refuse('a single instant has no months to split by')
    return { ...single(c.at!), kind, measures, by, combine: 'single', caveats }
  }
  if (!c.during) refuse(`${measures.join(', ')} is a stock: say the instant it is read at (at), or a span to read it across by month (during)`)

  const ends = monthEnds(c.during!.from, c.during!.to, today)
  if (!ends.length) refuse('that span contains no month that has begun')
  if (ends[ends.length - 1] === today && today < c.during!.to) caveats.push(`the span runs past today, so its last reading is as at ${today}`)

  if (by.includes('month')) {
    return { statements: ends.map((e) => atStatement(e, e.slice(0, 7))), kind, measures, by, combine: 'label-month', caveats }
  }
  if (ends.length === 1) return { ...single(ends[0]), kind, measures, by, combine: 'single', caveats }

  const roll = c.rollup?.time
  if (roll === 'last') {
    caveats.push(`read as at ${ends[ends.length - 1]}, the end of the span`)
    return { ...single(ends[ends.length - 1]), kind, measures, by, combine: 'single', caveats }
  }
  if (roll === 'average') {
    caveats.push(`the average of ${ends.length} month-end readings`)
    return { statements: ends.map((e) => atStatement(e, e.slice(0, 7))), kind, measures, by, combine: 'average-over-months', caveats }
  }
  return refuse(`${measures.join(', ')} is a stock, true at an instant: across ${ends.length} months it cannot simply be added up. ` +
    `Say how to roll it over time — rollup: { time: 'last' } or 'average' — or ask by month`)
}

export type MeasureInfo = Pick<Measure, 'unit' | 'kind'>
