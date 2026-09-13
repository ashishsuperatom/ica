// ── COORDINATES: THE QUESTION ASKED OF A RELATION ─────────────────────────────────────────────────────────
//
// A fixed vocabulary — which measures, split by what, filtered how, over what time, in what order — that never
// grows per program. Drilling down is a different set of coordinates, never a different program. It is the
// vocabulary of an OLAP query (Gray et al., 1997) and of a semantic-layer request (Cube, MetricFlow): measures,
// group-by including a time grain, where, having, order, limit.
//
// This file turns a relation plus coordinates into a PLAN of statements, and refuses the requests that would
// produce a wrong number. The one it refuses most deliberately: a stock asked across a span of time with no rule
// for rolling it up. Headcount for a quarter is not the sum of three month-end headcounts, and summing them yields
// a figure three times too large that looks perfectly ordinary.
//
// WHAT RUNS WHERE. Everything that can be said in one statement is pushed to the source — filters, grouping,
// derived measures, having, order and limit — so a top ten of fifty thousand customers returns ten rows. When the
// answer needs several statements (a stock read at several instants) or work across periods (running totals,
// filling empty periods), the statements return every group and the rest happens after, in the engine.

import {
  additivity, componentsOf, GRAINS, isDerived, kindOf, tokens,
  type BaseMeasure, type Shape,
} from './shape.js'

export type Grain = typeof GRAINS[number]
export type Scalar = string | number
export type Condition = Scalar | null | Scalar[] | {
  in?: Scalar[]; notIn?: Scalar[]; eq?: Scalar; ne?: Scalar
  gt?: Scalar; gte?: Scalar; lt?: Scalar; lte?: Scalar; isNull?: boolean
}

export interface Coordinates {
  measures?: string[]
  /** Dimensions to split by, and at most one time grain: day, week, month, quarter, year. */
  by?: string[]
  /** Conditions on dimensions. A value means equal, a list means any of, null means missing. */
  where?: Record<string, Condition>
  /** Conditions on measures, after aggregation. */
  having?: Record<string, Condition>
  /** Row order. Required for a limit, so which rows are kept is never the source's choice. */
  order?: Array<{ by: string; desc?: boolean }>
  limit?: number
  /** A span: from inclusive, to exclusive, as YYYY-MM-DD. */
  during?: { from: string; to: string }
  /** An instant, as YYYY-MM-DD. Only a stock has a value at an instant. */
  at?: string
  /** How a stock is rolled over a span, when it is not asked by a grain. */
  rollup?: { time?: 'last' | 'average' }
  /** Include periods with no rows, as zero for a flow. */
  fill?: boolean
  /** Running totals along the time grain, starting again at each `reset` boundary — to-date and since-start. */
  cumulative?: { reset?: 'year' | 'quarter' | 'month' | 'never' }
}

export type Dialect = 'oracle' | 'mssql' | 'sqlite'

/** What the body is called with for one reading. */
export type When = { asAt: string; where: Coordinates['where'] } | { from: string; to: string; where: Coordinates['where'] }
export type ReadBody = (when: When) => Promise<ResolvedStatement>

/** A body's statement, with its SQL settled: rows from a non-SQL source are named as local tables. */
export interface ResolvedStatement { source: string; sql: string; params: Record<string, unknown>; tables?: Record<string, Record<string, unknown>[]> }

export interface Statement extends ResolvedStatement {
  /** The period this statement's rows belong to, for a stock read at the end of each period. */
  period?: string
  /** The same statement unsplit, to check the parts against. */
  unsplit?: ResolvedStatement
}

export interface Plan {
  statements: Statement[]
  kind: 'flow' | 'stock'
  /** What the caller asked for. */
  measures: string[]
  /** What must be fetched: the asked measures and every measure they are computed from. */
  fetched: string[]
  by: string[]
  grain: Grain | null
  /** How rows from several statements become one result. */
  combine: 'single' | 'label-period' | 'average-over-periods'
  /** Work left for after the statements run. */
  after: { having?: Coordinates['having']; order?: Coordinates['order']; limit?: number; fill?: { periods: string[] }
           cumulative?: { reset: 'year' | 'quarter' | 'month' | 'never'; keep: { from: string; to: string } } }
  /** A limit or having was pushed into the statement, so parts cannot be checked against the whole. */
  partial: boolean
  caveats: string[]
}

export class CoordinateError extends Error {}
const refuse = (msg: string): never => { throw new CoordinateError(msg) }

const dateOk = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
const MAX_READINGS = 400

/** The engine's own parameters are prefixed so they cannot collide with a body's. */
const P = 'c_'

// ── dialects ──────────────────────────────────────────────────────────────────────────────────────────────

export interface SqlDialect {
  date(param: string): string
  /** The label of the period a date falls in. Labels are the same strings in every dialect and in `periods`. */
  period(grain: Grain, column: string): string
  limit(sql: string, n: number): string
  /** An expression as text. */
  text(expr: string): string
  /** The median, where the dialect has one. */
  median?: (expr: string) => string
}

export function sqlFor(dialect: Dialect): SqlDialect {
  if (dialect === 'mssql') return {
    date: (p) => `CAST(@${p} AS date)`,
    period: (g, c) => ({
      day: `CONVERT(char(10), ${c}, 23)`,
      // 1900-01-01 was a Monday, so days since then modulo 7 is days since Monday — independent of DATEFIRST.
      week: `CONVERT(char(10), DATEADD(day, -(DATEDIFF(day, '19000101', ${c}) % 7), CAST(${c} AS date)), 23)`,
      month: `CONVERT(char(7), ${c}, 23)`,
      quarter: `CONCAT(DATEPART(year, ${c}), '-Q', DATEPART(quarter, ${c}))`,
      year: `CAST(DATEPART(year, ${c}) AS varchar(4))`,
    })[g],
    limit: (sql, n) => sql.replace(/^SELECT /, `SELECT TOP ${n} `),
    text: (e) => `CAST(${e} AS nvarchar(4000))`,
  }
  if (dialect === 'sqlite') return {
    date: (p) => `@${p}`,
    period: (g, c) => ({
      day: `date(${c})`,
      week: `date(${c}, '-' || ((CAST(strftime('%w', ${c}) AS INTEGER) + 6) % 7) || ' days')`,
      month: `strftime('%Y-%m', ${c})`,
      quarter: `strftime('%Y', ${c}) || '-Q' || ((CAST(strftime('%m', ${c}) AS INTEGER) + 2) / 3)`,
      year: `strftime('%Y', ${c})`,
    })[g],
    limit: (sql, n) => `${sql}\nLIMIT ${n}`,
    text: (e) => `CAST(${e} AS TEXT)`,
  }
  return {
    date: (p) => `TO_DATE(@${p}, 'YYYY-MM-DD')`,
    period: (g, c) => ({
      day: `TO_CHAR(${c}, 'YYYY-MM-DD')`,
      week: `TO_CHAR(TRUNC(${c}, 'IW'), 'YYYY-MM-DD')`,
      month: `TO_CHAR(${c}, 'YYYY-MM')`,
      quarter: `TO_CHAR(${c}, 'YYYY') || '-Q' || TO_CHAR(${c}, 'Q')`,
      year: `TO_CHAR(${c}, 'YYYY')`,
    })[g],
    limit: (sql, n) => `${sql}\nFETCH FIRST ${n} ROWS ONLY`,
    median: (e) => `MEDIAN(${e})`,
    text: (e) => `TO_CHAR(${e})`,
  }
}

// ── periods, computed the same way the SQL labels them ─────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(`${s}T00:00:00Z`)
const addDays = (s: string, n: number) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d) }

export function periodOf(grain: Grain, date: string): string {
  const d = utc(date)
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1
  if (grain === 'day') return date
  if (grain === 'week') return addDays(date, -((d.getUTCDay() + 6) % 7))
  if (grain === 'month') return `${y}-${String(m).padStart(2, '0')}`
  if (grain === 'quarter') return `${y}-Q${Math.floor((m + 2) / 3)}`
  return String(y)
}

/** The first day of the period a date falls in. */
export function periodStart(grain: Grain, date: string): string {
  const label = periodOf(grain, date)
  if (grain === 'day' || grain === 'week') return label
  if (grain === 'month') return `${label}-01`
  if (grain === 'quarter') return `${label.slice(0, 4)}-${String((Number(label.slice(-1)) - 1) * 3 + 1).padStart(2, '0')}-01`
  return `${label}-01-01`
}

/** The first day of the next period. */
function nextStart(grain: Grain, date: string): string {
  const start = periodStart(grain, date)
  if (grain === 'day') return addDays(start, 1)
  if (grain === 'week') return addDays(start, 7)
  const d = utc(start)
  d.setUTCMonth(d.getUTCMonth() + (grain === 'month' ? 1 : grain === 'quarter' ? 3 : 12))
  return iso(d)
}

/** Every period that begins before `to` and ends after `from`, each with its last day inside the span. */
export function periods(grain: Grain, from: string, to: string): Array<{ label: string; start: string; end: string }> {
  const out: Array<{ label: string; start: string; end: string }> = []
  for (let s = periodStart(grain, from); s < to; s = nextStart(grain, s)) {
    const last = addDays(nextStart(grain, s), -1)
    out.push({ label: periodOf(grain, s), start: s, end: last < to ? last : addDays(to, -1) })
  }
  return out
}

/** A condition as SQL, binding each value through `bind`, which returns the placeholder to write. */
export function conditionSql(expr: string, cond: Condition, what: string, bind: (v: unknown) => string): string[] {
  if (cond === null) return [`${expr} IS NULL`]
  if (Array.isArray(cond)) return [cond.length ? `${expr} IN (${cond.map(bind).join(', ')})` : '1 = 0']
  if (typeof cond !== 'object') return [`${expr} = ${bind(cond)}`]
  const out: string[] = []
  for (const [op, v] of Object.entries(cond)) {
    if (op === 'isNull') out.push(v ? `${expr} IS NULL` : `${expr} IS NOT NULL`)
    else if (op === 'in' || op === 'notIn') {
      const list = v as Scalar[]
      out.push(list.length ? `${expr} ${op === 'in' ? 'IN' : 'NOT IN'} (${list.map(bind).join(', ')})` : op === 'in' ? '1 = 0' : '1 = 1')
    } else {
      const sqlOp = ({ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[op]
      if (!sqlOp) refuse(`unknown condition "${op}" on ${what} — use in, notIn, eq, ne, gt, gte, lt, lte or isNull`)
      out.push(`${expr} ${sqlOp} ${bind(v)}`)
    }
  }
  return out
}

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────────────

export async function plan(shape: Shape, read: ReadBody, c: Coordinates, dialects: Record<string, Dialect>,
                           today: string): Promise<Plan> {
  const { dimensions, measures: defined, time } = shape
  const kind = kindOf(shape)
  const measures = c.measures?.length ? c.measures : Object.keys(defined)
  const by = c.by ?? []
  const where = c.where ?? {}
  const having = c.having ?? {}

  for (const m of measures) if (!defined[m]) refuse(`there is no measure "${m}" — available: ${Object.keys(defined).join(', ')}`)
  const fetched = [...new Set([...measures, ...measures.flatMap((m) => componentsOf(shape, m))])]

  const grains = by.filter((d) => (GRAINS as readonly string[]).includes(d)) as Grain[]
  if (grains.length > 1) refuse(`split by one time grain at a time, not ${grains.join(' and ')}`)
  const grain = grains[0] ?? null
  const splits = by.filter((d) => d !== grain)
  const known = [...Object.keys(dimensions), ...GRAINS]
  for (const d of splits) if (!dimensions[d]) refuse(`"${d}" is not a dimension of this relation — available: ${known.join(', ')}`)
  for (const d of Object.keys(where)) {
    if (!dimensions[d]) refuse(`cannot filter on "${d}" — filterable dimensions: ${Object.keys(dimensions).join(', ')}`)
  }
  for (const m of Object.keys(having)) if (!measures.includes(m)) refuse(`having on "${m}" needs it among the measures asked for`)
  const orderable = [...by, ...splits.filter((d) => dimensions[d].label).map((d) => `${d}_label`), ...measures]
  for (const o of c.order ?? []) if (!orderable.includes(o.by)) refuse(`cannot order by "${o.by}" — it is not in the result: ${orderable.join(', ')}`)
  if (c.limit != null) {
    if (!Number.isInteger(c.limit) || c.limit < 1) refuse('limit must be a whole number above zero')
    if (!c.order?.length) refuse('a limit needs an order — otherwise which rows are kept is the source\'s choice, not the question\'s')
  }
  if (c.during && (!dateOk(c.during.from) || !dateOk(c.during.to) || c.during.from >= c.during.to)) {
    refuse('during must be { from, to } as YYYY-MM-DD, with from before to')
  }
  if (c.at && !dateOk(c.at)) refuse('at must be a date, YYYY-MM-DD')
  if (c.at && c.during) refuse('ask either at an instant or during a span, not both')
  if (c.fill && !grain) refuse('fill adds the empty periods of a time grain, so it needs one in by')
  if (c.cumulative) {
    if (kind !== 'flow') refuse('a running total adds a flow up over time; a stock is already a running total')
    if (!grain) refuse('a running total runs along a time grain, so it needs one in by')
    for (const m of measures) if (additivity(shape, m) !== 'additive') refuse(`"${m}" does not add up over time, so it has no running total`)
  }

  const caveats: string[] = []
  for (const d of splits) if (dimensions[d].history === 'current') caveats.push(`"${d}" is read as it is today, not as it was at the time`)

  // ── the wrapper every statement shares ────────────────────────────────────────────────────────────────
  const filterParams: Record<string, unknown> = {}
  let n = 0
  const bind = (v: unknown) => { const name = `${P}${n++}`; filterParams[name] = v; return `@${name}` }
  const condition = (expr: string, cond: Condition, what: string) => conditionSql(expr, cond, what, bind)
  const filters = Object.entries(where).flatMap(([d, cond]) => condition(`t.${dimensions[d].column}`, cond, d))

  const aggregateSql = (m: string, s: SqlDialect): string => {
    const base = defined[m] as BaseMeasure
    const col = `t.${base.column}`
    switch (base.aggregate) {
      case 'count': return 'COUNT(*)'
      case 'count distinct': return `COUNT(DISTINCT ${col})`
      case 'average': return `AVG(${col})`
      case 'median': return s.median ? s.median(col) : refuse(`"${m}" is a median, and this source has no median in SQL`)
      default: return `${base.aggregate.toUpperCase()}(${col})`
    }
  }
  /** A measure as SQL: an aggregate, or a derived expression over aggregates with division safe from zero. */
  const measureSql = (m: string, s: SqlDialect): string => {
    const def = defined[m]
    if (!isDerived(def)) return aggregateSql(m, s)
    const ts = tokens(def.expression)!
    let pos = 0
    const primary = (): string => {
      const t = ts[pos++]
      if (t.op === '(') { const v = sum(); pos++; return `(${v})` }
      if (t.op === '-') return `-${primary()}`
      if (t.number) return t.number
      return `(${measureSql(t.name!, s)})`
    }
    const product = (): string => {
      let v = primary()
      while (ts[pos]?.op === '*' || ts[pos]?.op === '/') {
        const op = ts[pos++].op
        const r = primary()
        v = op === '*' ? `${v} * ${r}` : `1.0 * ${v} / NULLIF(${r}, 0)`
      }
      return v
    }
    const sum = (): string => {
      let v = product()
      while (ts[pos]?.op === '+' || ts[pos]?.op === '-') { const op = ts[pos++].op; v = `${v} ${op} ${product()}` }
      return v
    }
    return sum()
  }

  // One statement: pushdown of having, order and limit is possible — unless work across periods follows.
  const acrossPeriods = Boolean(c.fill || c.cumulative)
  const wrap = async (when: When, dims: string[], bounds: (s: SqlDialect) => string[], extra: Record<string, unknown>,
                      opts: { period?: string; pushdown: boolean }): Promise<Statement> => {
    const body = await read(when)
    for (const k of Object.keys(body.params)) if (k.startsWith(P)) refuse(`the relation's parameter "${k}" uses the engine's prefix ${P}`)
    const s = sqlFor(dialects[body.source] ?? refuse(`no dialect is known for ${body.source}`))
    const render = (dimsHere: string[], pushdown: boolean) => {
      const cols: string[] = []
      const group: string[] = []
      for (const d of dimsHere) {
        if ((GRAINS as readonly string[]).includes(d)) {
          const e = s.period(d as Grain, `t.${time}`)
          cols.push(`${e} AS ${d}`); group.push(e); continue
        }
        const dim = dimensions[d]
        cols.push(`t.${dim.column} AS ${d}`); group.push(`t.${dim.column}`)
        if (dim.label) { cols.push(`t.${dim.label} AS ${d}_label`); group.push(`t.${dim.label}`) }
      }
      for (const m of fetched) cols.push(`${measureSql(m, s)} AS ${m}`)
      const conds = [...filters, ...bounds(s)]
      const havingSql = pushdown ? Object.entries(having).flatMap(([m, cond]) => condition(measureSql(m, s), cond, m)) : []
      let sql = [`SELECT ${cols.join(', ')}`, `FROM (\n${body.sql.trim()}\n) t`,
                 conds.length ? `WHERE ${conds.join('\n  AND ')}` : '',
                 group.length ? `GROUP BY ${group.join(', ')}` : '',
                 havingSql.length ? `HAVING ${havingSql.join('\n  AND ')}` : ''].filter(Boolean).join('\n')
      if (pushdown && c.order?.length) {
        // Ties are broken by every split, so the same question returns the same rows in the same order.
        const keys = [...c.order.map((o) => `${o.by}${o.desc ? ' DESC' : ''}`), ...dimsHere.filter((d) => !c.order!.some((o) => o.by === d))]
        sql += `\nORDER BY ${keys.join(', ')}`
        if (c.limit != null) sql = s.limit(sql, c.limit)
      }
      return sql
    }
    // Rendered before the parameters are gathered: rendering is what binds the having conditions' values.
    const sql = render(dims, opts.pushdown)
    const unsplitSql = dims.length ? render([], false) : null
    const params = { ...body.params, ...filterParams, ...extra }
    return {
      source: body.source, tables: body.tables, params, period: opts.period, sql,
      unsplit: unsplitSql ? { source: body.source, tables: body.tables, params, sql: unsplitSql } : undefined,
    }
  }
  const pushable = (statements: number) => statements === 1 && !acrossPeriods
  const partialIf = (pushed: boolean) => pushed && (c.limit != null || Object.keys(having).length > 0)

  // ── a flow: one statement bounded by the span ─────────────────────────────────────────────────────────
  if (kind === 'flow') {
    if (c.at) refuse(`${measures.join(', ')} is a flow: it accumulates over a span and has no value at an instant — ask during a span`)
    if (!c.during) refuse(`${measures.join(', ')} is a flow: say which span it accumulates over (during)`)
    let { from, to } = c.during!
    const keep = { from, to }
    if (c.cumulative) {
      const reset = c.cumulative.reset ?? 'never'
      // A to-date total needs every period since the boundary, even the ones before the span asked about.
      if (reset !== 'never') from = periodStart(reset, from)
      if (from < keep.from) caveats.push(`running totals start at ${from}, the start of the ${reset}`)
    }
    const bounds = (s: SqlDialect) => [`t.${time} >= ${s.date(`${P}from`)}`, `t.${time} < ${s.date(`${P}to`)}`]
    const pushed = pushable(1)
    const statement = await wrap({ from, to, where }, by, bounds, { [`${P}from`]: from, [`${P}to`]: to }, { pushdown: pushed })
    return {
      statements: [statement], kind, measures, fetched, by, grain, combine: 'single', partial: partialIf(pushed), caveats,
      after: {
        ...(pushed ? {} : { having: c.having, order: c.order, limit: c.limit }),
        fill: c.fill && grain ? { periods: periods(grain, keep.from, keep.to).map((p) => p.label) } : undefined,
        cumulative: c.cumulative ? { reset: c.cumulative.reset ?? 'never', keep } : undefined,
      },
    }
  }

  // ── a stock: read at instants ─────────────────────────────────────────────────────────────────────────
  const at = (date: string, pushdown: boolean, period?: string) =>
    wrap({ asAt: date, where }, splits, () => [], {}, { period, pushdown })
  const finish = (statements: Statement[], combine: Plan['combine'], pushed: boolean): Plan => ({
    statements, kind, measures, fetched, by, grain, combine, partial: partialIf(pushed), caveats,
    after: pushed ? {} : { having: c.having, order: c.order, limit: c.limit },
  })

  if (c.at) {
    if (grain) refuse('a single instant has no periods to split by')
    return finish([await at(c.at!, true)], 'single', true)
  }
  if (!c.during) refuse(`${measures.join(', ')} is a stock: say the instant it is read at (at), or a span to read it across by period (during)`)

  // A stock over a span is read at the end of each period, and never at a date that has not happened.
  const readingGrain: Grain = grain ?? 'month'
  const ends = periods(readingGrain, c.during!.from, c.during!.to)
    .filter((p) => p.start <= today)
    .map((p) => ({ label: p.label, date: p.end > today ? today : p.end }))
  if (!ends.length) refuse('that span contains no period that has begun')
  if (ends.length > MAX_READINGS) refuse(`that is ${ends.length} readings of a stock — ask by a coarser grain`)
  if (ends[ends.length - 1].date === today && today < addDays(c.during!.to, -1)) caveats.push(`the span runs past today, so its last reading is as at ${today}`)

  if (grain) {
    caveats.push(`each ${grain} is read as at its last day`)
    return finish(await Promise.all(ends.map((e) => at(e.date, false, e.label))), 'label-period', false)
  }
  if (ends.length === 1) return finish([await at(ends[0].date, true)], 'single', true)

  const roll = c.rollup?.time
  if (roll === 'last') {
    caveats.push(`read as at ${ends[ends.length - 1].date}, the end of the span`)
    return finish([await at(ends[ends.length - 1].date, true)], 'single', true)
  }
  if (roll === 'average') {
    for (const m of fetched) if (!isDerived(defined[m]) && additivity(shape, m) === 'none') {
      refuse(`"${m}" is ${(defined[m] as BaseMeasure).aggregate === 'median' ? 'a median' : 'an average'} already; averaging it over readings is not its average over the span`)
    }
    caveats.push(`the average of ${ends.length} month-end readings`)
    return finish(await Promise.all(ends.map((e) => at(e.date, false, e.label))), 'average-over-periods', false)
  }
  return refuse(`${measures.join(', ')} is a stock, true at an instant: across ${ends.length} months it cannot simply be added up. ` +
    `Say how to roll it over time — rollup: { time: 'last' } or 'average' — or ask by a time grain`)
}
