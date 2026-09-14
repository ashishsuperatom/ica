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

import { addDays, Grains, type Calendar } from './calendar.js'
import { conditionSql, sqlFor, type Dialect, type SqlDialect } from './dialects.js'
import { CoordinateError } from './errors.js'
import { stretches } from './timezones.js'
import type { Comparison, ResolvedComparison } from './compare.js'
import type { RelativeInstant, RelativeSpan } from './relative.js'
export { conditionSql, sqlFor, type Dialect, type SqlDialect } from './dialects.js'
export { CoordinateError } from './errors.js'
import {
  additivity, componentsOf, isDerived, kindOf, tokens,
  type BaseMeasure, type Shape,
} from './shape.js'

/** A built-in grain, or one the calendar defines. */
export type Grain = string
export type Scalar = string | number
export type Condition = Scalar | null | Scalar[] | {
  in?: Scalar[]; notIn?: Scalar[]; eq?: Scalar; ne?: Scalar
  gt?: Scalar; gte?: Scalar; lt?: Scalar; lte?: Scalar; isNull?: boolean
  /** Text, ignoring case. */
  contains?: string; startsWith?: string
}

/** A span of days: from inclusive, to exclusive, as YYYY-MM-DD. */
export type Span = { from: string; to: string }

/** A question with every relative date made explicit — what planning and comparison work on. */
export type ResolvedCoordinates = Omit<Coordinates, 'during' | 'at' | 'compare'> & { during?: Span; at?: string; compare?: ResolvedComparison }

export interface Coordinates {
  measures?: string[]
  /** Dimensions to split by, and at most one time grain: day, week, month, quarter, year, or a calendar's. */
  by?: string[]
  /** Conditions on dimensions. A value means equal, a list means any of, null means missing. */
  where?: Record<string, Condition>
  /** Conditions on measures, after aggregation. */
  having?: Record<string, Condition>
  /** Row order. Required for a limit, so which rows are kept is never the source's choice. */
  order?: Array<{ by: string; desc?: boolean }>
  limit?: number
  /** With a limit: keep that many rows within each group of these splits — the top three customers per pillar. */
  limitPer?: string[]
  /** The currency amounts are reported in, converted at rates as at the span's end or the instant asked. */
  currency?: string
  /** Instead of aggregating: the rows themselves — every dimension, label, measure column and the time, one row per
   *  row of the relation, filtered as asked. The records behind a number. Needs an order and a limit. */
  detail?: { limit: number }
  /** Also answer at these coarser splits — each a subset of `by`, `[]` for the grand total — computed by the
   *  source for each, so a ratio or a distinct count is right at every level. Totals count every row, including
   *  rows a limit or having leaves out. */
  totals?: string[][]
  /** Each measure as a share of its total within these splits — `[]` for the whole. Additive measures only. */
  share?: { measures: string[]; within: string[] }
  /** A span: from inclusive, to exclusive, as YYYY-MM-DD. */
  during?: Span | RelativeSpan
  /** An instant, as YYYY-MM-DD. Only a stock has a value at an instant. */
  at?: string | RelativeInstant
  /** How a stock is rolled over a span, when it is not asked by a grain. */
  rollup?: { time?: 'last' | 'average' }
  /** Include periods with no rows, as zero for a flow. */
  fill?: boolean
  /** The same question at another time, aligned row by row with the change beside each. See compare.ts. */
  compare?: Comparison
  /** Running totals along the time grain, starting again at each `reset` boundary — to-date and since-start. */
  cumulative?: { reset?: Grain | 'never' }
  /** A moving window along the time grain: each period's value over it and the `window - 1` periods before it —
   *  trailing twelve months, a seven-day average. A ratio is recomputed from its parts' windows. Every period in
   *  the span appears, empty ones included, because a window has a value even where a period has none. */
  rolling?: { window: number; average?: boolean }
}


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
  /** Statements that must hold before the rows can be trusted: each entity joined has one row per member. */
  guards?: Array<{ label: string; statement: ResolvedStatement }>
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
  after: { having?: Coordinates['having']; order?: Coordinates['order']; limit?: number; limitPer?: string[]; fill?: { periods: string[] }
           cumulative?: { reset: Grain | 'never'; keep: { from: string; to: string } }
           rolling?: { window: number; average: boolean; keep: { from: string; to: string } } }
  /** The grains this plan was made with: built in, and the calendar's. */
  grains: Grains
  /** Names in `by` reached through an entity, with the SQL alias their values come back under. */
  paths: Record<string, string>
  /** Names in `by` that come with a label. */
  labelled: string[]
  /** Measures whose unit is the reporting currency rather than their declared unit. */
  units: Record<string, string>
  /** For detail: the columns of the rows, in order. */
  detail?: Array<{ name: string; role: 'dimension' | 'label' | 'measure' | 'time'; unit?: string }>
  /** A limit or having was pushed into the statement, so parts cannot be checked against the whole. */
  partial: boolean
  /** The statement already returns rows in the order asked for. */
  orderedAtSource: boolean
  caveats: string[]
}

const refuse = (msg: string): never => { throw new CoordinateError(msg) }

const dateOk = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
const MAX_READINGS = 400
const MAX_DETAIL = 1000

/** The engine's own parameters are prefixed so they cannot collide with a body's. */
const P = 'c_'

/** The relation whose rows are the members of an entity — found by the engine, so a question can reach an
 *  attribute through a key without the relation it is asking naming that relation. */
export type AttributeSource = (entity: string) => Promise<{ name: string; shape: Shape; read: ReadBody }>

/** The relation of exchange rates the request converts with: dimensions `from` and `to`, currency codes, and the
 *  stock `rate` — how many of `to` one `from` buys, as at an instant. */
export type RatesSource = () => Promise<{ name: string; shape: Shape; read: ReadBody }>

/** What a plan is made in: the calendar, how to reach entities and rates, and the zone the question is asked from. */
export interface PlanEnvironment {
  calendar?: Calendar
  attributes?: AttributeSource
  rates?: RatesSource
  zone?: string
}

export async function plan(shape: Shape, read: ReadBody, c: ResolvedCoordinates, dialects: Record<string, Dialect>,
                           today: string, env: PlanEnvironment = {}): Promise<Plan> {
  const { calendar = {}, attributes, rates, zone } = env
  const caveats: string[] = []
  const grainSet = new Grains(calendar)
  const calendarProblem = grainSet.problem()
  if (calendarProblem) refuse(calendarProblem)
  const { dimensions, measures: defined, time } = shape
  const kind = kindOf(shape)
  const measures = c.measures?.length ? c.measures : Object.keys(defined)
  const by = c.by ?? []
  const where = c.where ?? {}
  const having = c.having ?? {}

  for (const m of measures) if (!defined[m]) refuse(`there is no measure "${m}" — available: ${Object.keys(defined).join(', ')}`)
  const fetched = [...new Set([...measures, ...measures.flatMap((m) => componentsOf(shape, m))])]

  for (const name of Object.keys(calendar)) if (dimensions[name]) refuse(`"${name}" is both a dimension and a calendar grain`)
  const grains = by.filter((d) => grainSet.has(d))
  if (grains.length > 1) refuse(`split by one time grain at a time, not ${grains.join(' and ')}`)
  const grain = grains[0] ?? null
  const splits = by.filter((d) => d !== grain)
  const known = [...Object.keys(dimensions), ...grainSet.names()]

  // ── ATTRIBUTES THROUGH AN ENTITY ─────────────────────────────────────────────────────────────────────────
  // `employee.manager` is the manager of the employee each row is about. `employee` is this relation's dimension,
  // declared to identify the entity employee; `manager` is a dimension of the relation whose grain is employee —
  // one row per employee. The two are joined on the key, which can repeat no row because the grain is checked to
  // be unique every time it is read. So an attribute can be asked for, split by or filtered on, and nothing that
  // was already defined has to change. (Cube and Malloy write the same path with a dot; MetricFlow writes
  // employee__manager. Here it is always a dot.)
  const isPath = (d: string) => d.includes('.')
  const providers = new Map<string, { name: string; shape: Shape; read: ReadBody; entity: string }>()
  const paths = new Map<string, { via: string; column: string; label?: string; alias: string }>()
  // A filter may name a dimension's label — `pillar_label` — to filter by what people read rather than the key.
  const known_ = (d: string) => isPath(d) || !!dimensions[d]
  const baseOf = (d: string) => (d.endsWith('_label') && known_(d.slice(0, -6)) ? d.slice(0, -6) : d)
  for (const d of [...splits, ...Object.keys(where).map(baseOf)]) {
    if (!isPath(d) || paths.has(d)) continue
    const [via, attr, ...more] = d.split('.')
    if (more.length) refuse(`"${d}" goes through more than one entity; reach one step at a time`)
    const dim = dimensions[via] ?? refuse(`"${d}": "${via}" is not a dimension of this relation`)
    if (!dim.entity) refuse(`"${d}": dimension "${via}" does not declare the entity it identifies, so nothing can be reached through it`)
    if (!attributes) refuse(`"${d}": attributes of ${dim.entity} cannot be reached here`)
    if (!providers.has(via)) providers.set(via, { ...(await attributes!(dim.entity!)), entity: dim.entity! })
    const p = providers.get(via)!
    const a = p.shape.dimensions[attr] ?? refuse(`"${d}": "${p.name}", the relation of ${dim.entity}, has no dimension "${attr}" — it has ${Object.keys(p.shape.dimensions).join(', ')}`)
    paths.set(d, { via, column: a.column, label: a.label, alias: `${via}__${attr}` })
    if (a.history === 'current') caveats.push(`"${d}" is read as it is today, not as it was at the time`)
  }
  for (const d of splits) if (!isPath(d) && !dimensions[d]) refuse(`"${d}" is not a dimension of this relation — available: ${known.join(', ')}`)
  for (const d of Object.keys(where).map(baseOf)) {
    if (!isPath(d) && !dimensions[d]) refuse(`cannot filter on "${d}" — filterable dimensions: ${Object.keys(dimensions).join(', ')}`)
  }
  const hasLabel = (d: string) => (isPath(d) ? !!paths.get(d)!.label : !!dimensions[d]?.label)

  // ── MONEY IN MORE THAN ONE CURRENCY ───────────────────────────────────────────────────────────────────────
  // An amount declares the dimension holding its currency. Added across currencies it means nothing, so a question
  // either converts — every amount to one currency, at rates as at the end of what is asked — or keeps currencies
  // apart, by splitting on the currency or filtering to one.
  const moneyMeasures = fetched.filter((m) => !isDerived(defined[m]) && (defined[m] as BaseMeasure).currency)
  const converting = !!c.currency && moneyMeasures.length > 0
  let rateSource: Awaited<ReturnType<RatesSource>> | null = null
  if (c.currency && !/^[A-Z]{3}$/.test(c.currency)) refuse(`currency "${c.currency}" must be a three-letter code, like NZD`)
  for (const m of moneyMeasures) {
    const d = (defined[m] as BaseMeasure).currency!
    const single = where[d] != null && (typeof where[d] !== 'object' || (!Array.isArray(where[d]) && (where[d] as any).eq != null && Object.keys(where[d] as object).length === 1))
    if (!converting && !by.includes(d) && !single) {
      refuse(`"${m}" is money in the currency of each row's "${d}": say the currency to report in, split by "${d}", or filter to one "${d}"`)
    }
  }
  if (converting) {
    if (!rates) refuse('no exchange rates are named for this request, so amounts cannot be converted — set the assumption "exchange rates" to a relation of rates')
    rateSource = await rates!()
    const rs = rateSource.shape
    if (!rs.dimensions.from || !rs.dimensions.to || !rs.measures.rate || isDerived(rs.measures.rate) || rs.measures.rate.kind !== 'stock') {
      refuse(`"${rateSource.name}" is not a relation of exchange rates: it needs dimensions "from" and "to" and a stock measure "rate"`)
    }
  }
  const units: Record<string, string> = converting ? Object.fromEntries(moneyMeasures.map((m) => [m, c.currency!])) : {}
  for (const m of Object.keys(having)) if (!measures.includes(m)) refuse(`having on "${m}" needs it among the measures asked for`)
  const orderable = [...by, ...splits.filter(hasLabel).map((d) => `${d}_label`), ...measures]
  if (!c.detail) for (const o of c.order ?? []) if (!orderable.includes(o.by)) refuse(`cannot order by "${o.by}" — it is not in the result: ${orderable.join(', ')}`)
  if (c.limitPer) {
    if (c.limit == null) refuse('limitPer says how many rows to keep per group; it needs a limit')
    for (const d of c.limitPer) if (!by.includes(d)) refuse(`limitPer "${d}" must be one of the splits: ${by.join(', ')}`)
  }
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
  if (c.cumulative?.reset && c.cumulative.reset !== 'never' && !grainSet.has(c.cumulative.reset)) refuse(`cumulative reset "${c.cumulative.reset}" is not a grain`)
  if (c.rolling) {
    if (kind !== 'flow') refuse('a moving window adds a flow up over periods; read a stock at each period instead')
    if (!grain) refuse('a moving window moves along a time grain, so it needs one in by')
    if (!Number.isInteger(c.rolling.window) || c.rolling.window < 1) refuse('rolling window is a whole number of periods, from 1')
    if (c.cumulative) refuse('ask for a running total or a moving window, not both')
    for (const m of fetched) if (!isDerived(defined[m]) && additivity(shape, m) !== 'additive') {
      refuse(`"${m}" does not add up across periods, so its value over a window cannot be made from each period's`)
    }
  }
  if (c.cumulative) {
    if (kind !== 'flow') refuse('a running total adds a flow up over time; a stock is already a running total')
    if (!grain) refuse('a running total runs along a time grain, so it needs one in by')
    for (const m of measures) if (additivity(shape, m) !== 'additive') refuse(`"${m}" does not add up over time, so it has no running total`)
  }

  for (const d of splits) if (!isPath(d) && dimensions[d].history === 'current') caveats.push(`"${d}" is read as it is today, not as it was at the time`)

  // ── the wrapper every statement shares ────────────────────────────────────────────────────────────────
  const filterParams: Record<string, unknown> = {}
  let n = 0
  const bind = (v: unknown) => { const name = `${P}${n++}`; filterParams[name] = v; return `@${name}` }
  const condition = (expr: string, cond: Condition, what: string) => conditionSql(expr, cond, what, bind)
  const columnOf = (d: string) => {
    const base = baseOf(d)
    if (base !== d) {
      const label = isPath(base) ? paths.get(base)!.label : dimensions[base].label
      if (!label) refuse(`"${base}" has no label to filter on`)
      return isPath(base) ? `a_${paths.get(base)!.via}.${label}` : `t.${label}`
    }
    return isPath(d) ? `a_${paths.get(d)!.via}.${paths.get(d)!.column}` : `t.${dimensions[d].column}`
  }
  const filters = Object.entries(where).flatMap(([d, cond]) => condition(columnOf(d), cond, d))
  /** A name in the result as a SQL alias: a path's dot cannot be one. */
  const aliasOf = (name: string) => {
    const label = name.endsWith('_label') && paths.has(name.slice(0, -6))
    const path = paths.get(label ? name.slice(0, -6) : name)
    return path ? `${path.alias}${label ? '_label' : ''}` : name
  }

  const aggregateSql = (m: string, s: SqlDialect): string => {
    const base = defined[m] as BaseMeasure
    // A converted amount is multiplied by its row's rate; one already in the reporting currency by one.
    const col = converting && base.currency
      ? `(t.${base.column} * CASE WHEN t.${dimensions[base.currency].column} = @${P}currency THEN 1 ELSE fx.${(rateSource!.shape.measures.rate as BaseMeasure).column} END)`
      : `t.${base.column}`
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

  // The time column as the question sees it: moved into the question's zone when it holds moments written in another.
  const moves = !!(shape.timeZone && zone && zone !== shape.timeZone)
  if (moves) caveats.push(`times are moved from ${shape.timeZone} to ${zone} before they are counted by day`)
  const moment = (s: SqlDialect, span: Span) => {
    const column = `t.${time}`
    if (!moves) return column
    const parts = stretches(shape.timeZone!, zone!, span)
    if (parts.length === 1) return s.addMinutes(column, parts[0].minutes)
    return `CASE ${parts.map((p) => p.until ? `WHEN ${column} < ${s.timestampLiteral(p.until)} THEN ${s.addMinutes(column, p.minutes)}` : `ELSE ${s.addMinutes(column, p.minutes)}`).join(' ')} END`
  }

  // One statement: pushdown of having, order and limit is possible — unless work across periods follows.
  const acrossPeriods = Boolean(c.fill || c.cumulative || c.rolling)
  const wrap = async (when: When, dims: string[], bounds: (s: SqlDialect) => string[], extra: Record<string, unknown>,
                      opts: { period?: string; pushdown: boolean; span?: { from: string; to: string }; detail?: boolean }): Promise<Statement> => {
    const body = await read(when)
    for (const k of Object.keys(body.params)) if (k.startsWith(P)) refuse(`the relation's parameter "${k}" uses the engine's prefix ${P}`)
    const s = sqlFor(dialects[body.source] ?? refuse(`no dialect is known for ${body.source}`))

    // Each entity reached is read as at the same instant as a stock, or the last day of a flow's span.
    const joinParams: Record<string, unknown> = { ...body.params }
    const tables = { ...(body.tables ?? {}) }
    const joins: string[] = []
    const guards: Statement['guards'] = []
    let convertedColumn = ''
    const asAt = 'asAt' in when ? when.asAt : (addDays(when.to, -1) < today ? addDays(when.to, -1) : today)
    for (const [via, p] of providers) {
      const st = await p.read({ asAt, where: {} })
      if (st.source !== body.source) refuse(`"${p.name}" is read from ${st.source}, and this relation from ${body.source}; one statement cannot join them`)
      for (const [k, v] of Object.entries(st.params)) {
        if (k in joinParams && joinParams[k] !== v) refuse(`parameter @${k} means different things in this relation and in "${p.name}"`)
        joinParams[k] = v
      }
      Object.assign(tables, st.tables ?? {})
      const key = p.shape.dimensions[p.shape.grain!].column
      joins.push(`LEFT JOIN (\n${st.sql.trim()}\n) a_${via} ON a_${via}.${key} = t.${dimensions[via].column}`)
      guards.push({ label: `"${p.name}" has one row per ${p.entity} as at ${asAt}`,
                    statement: { source: st.source, tables: st.tables, params: st.params, sql: `SELECT COUNT(*) AS n, COUNT(DISTINCT g.${key}) AS d FROM (\n${st.sql.trim()}\n) g` } })
      if ('from' in when) caveats.push(`attributes of ${p.entity} are as at ${asAt}`)
    }
    if (converting) {
      const st = await rateSource!.read({ asAt, where: {} })
      if (st.source !== body.source) refuse(`"${rateSource!.name}" is read from ${st.source}, and this relation from ${body.source}; one statement cannot join them`)
      for (const [k, v] of Object.entries(st.params)) {
        if (k in joinParams && joinParams[k] !== v) refuse(`parameter @${k} means different things in this relation and in "${rateSource!.name}"`)
        joinParams[k] = v
      }
      Object.assign(tables, st.tables ?? {})
      const rd = rateSource!.shape.dimensions
      const from = rd.from.column, to = rd.to.column
      const currencyColumns = [...new Set(moneyMeasures.map((m) => dimensions[(defined[m] as BaseMeasure).currency!].column))]
      if (currencyColumns.length > 1) refuse('the money measures asked for keep their currency in different columns; ask for them separately')
      joins.push(`LEFT JOIN (\n${st.sql.trim()}\n) fx ON fx.${from} = t.${currencyColumns[0]} AND fx.${to} = @${P}currency`)
      guards.push({ label: `"${rateSource!.name}" has one rate per pair of currencies as at ${asAt}`,
                    statement: { source: st.source, tables: st.tables, params: st.params,
                                 sql: `SELECT COUNT(*) AS n, 0 AS d FROM (SELECT g.${from}, g.${to} FROM (\n${st.sql.trim()}\n) g GROUP BY g.${from}, g.${to} HAVING COUNT(*) > 1) x` } })
      caveats.push(`amounts are converted to ${c.currency} at rates as at ${asAt}`)
      convertedColumn = currencyColumns[0]
    }
    const render = (dimsHere: string[], pushdown: boolean) => {
      if (opts.detail) return renderDetail()
      const cols: string[] = []
      const group: string[] = []
      for (const d of dimsHere) {
        if (grainSet.has(d)) {
          const e = grainSet.sql(d, moment(s, opts.span!), s, opts.span!)
          cols.push(`${e} AS ${d}`); group.push(e); continue
        }
        const path = paths.get(d)
        const column = columnOf(d)
        const label = path ? (path.label ? `a_${path.via}.${path.label}` : null) : (dimensions[d].label ? `t.${dimensions[d].label}` : null)
        cols.push(`${column} AS ${aliasOf(d)}`); group.push(column)
        if (label) { cols.push(`${label} AS ${aliasOf(d)}_label`); group.push(label) }
      }
      for (const m of fetched) cols.push(`${measureSql(m, s)} AS ${m}`)
      // Rows that could not be converted are counted in the same statement, so none is silently left out of a sum.
      if (converting) cols.push(`SUM(CASE WHEN t.${convertedColumn} IS NOT NULL AND t.${convertedColumn} <> @${P}currency AND fx.${(rateSource!.shape.measures.rate as BaseMeasure).column} IS NULL THEN 1 ELSE 0 END) AS ${P}unconverted`)
      const conds = [...filters, ...bounds(s)]
      const havingSql = pushdown ? Object.entries(having).flatMap(([m, cond]) => condition(measureSql(m, s), cond, m)) : []
      let sql = [`SELECT ${cols.join(', ')}`, `FROM (\n${body.sql.trim()}\n) t`, ...joins,
                 conds.length ? `WHERE ${conds.join('\n  AND ')}` : '',
                 group.length ? `GROUP BY ${group.join(', ')}` : '',
                 havingSql.length ? `HAVING ${havingSql.join('\n  AND ')}` : ''].filter(Boolean).join('\n')
      if (pushdown && c.order?.length) {
        // Ties are broken by every split, so the same question returns the same rows in the same order.
        const keys = [...c.order.map((o) => `${aliasOf(o.by)}${o.desc ? ' DESC' : ''}`), ...dimsHere.filter((d) => !c.order!.some((o) => o.by === d)).map(aliasOf)]
        sql += `\nORDER BY ${keys.join(', ')}`
        if (c.limit != null) sql = s.limit(sql, c.limit)
      }
      return sql
    }
    function renderDetail(): string {
      const cols: string[] = []
      for (const [name, d] of Object.entries(dimensions)) {
        cols.push(`t.${d.column} AS ${name}`)
        if (d.label) cols.push(`t.${d.label} AS ${name}_label`)
      }
      for (const d of splits.filter(isPath)) {
        cols.push(`${columnOf(d)} AS ${aliasOf(d)}`)
        if (paths.get(d)!.label) cols.push(`a_${paths.get(d)!.via}.${paths.get(d)!.label} AS ${aliasOf(d)}_label`)
      }
      for (const [name, m] of Object.entries(defined)) if (!isDerived(m) && m.column) cols.push(`t.${m.column} AS ${name}`)
      if (time) cols.push(`${moment(s, opts.span ?? { from: today, to: today })} AS ${time}`)
      const conds = [...filters, ...bounds(s)]
      const keys = [...c.order!.map((o) => `${aliasOf(o.by)}${o.desc ? ' DESC' : ''}`)]
      return s.limit([`SELECT ${cols.join(', ')}`, `FROM (\n${body.sql.trim()}\n) t`, ...joins,
                      conds.length ? `WHERE ${conds.join('\n  AND ')}` : '', `ORDER BY ${keys.join(', ')}`].filter(Boolean).join('\n'), c.detail!.limit)
    }

    // Rendered before the parameters are gathered: rendering is what binds the having conditions' values.
    const sql = render(dims, opts.pushdown)
    const unsplitSql = dims.length && !opts.detail ? render([], false) : null
    const params = { ...joinParams, ...filterParams, ...extra, ...(converting ? { [`${P}currency`]: c.currency } : {}) }
    const t = Object.keys(tables).length ? tables : undefined
    return {
      source: body.source, tables: t, params, period: opts.period, sql, guards,
      unsplit: unsplitSql ? { source: body.source, tables: t, params, sql: unsplitSql } : undefined,
    }
  }
  /** What every plan carries, whichever way it was made. */
  const common = () => ({ caveats, grains: grainSet, units, paths: Object.fromEntries([...paths].map(([k, v]) => [k, v.alias])),
                          labelled: by.filter((d) => !grainSet.has(d) && hasLabel(d)) })

  // ── the rows themselves ───────────────────────────────────────────────────────────────────────────────
  if (c.detail) {
    if (!Number.isInteger(c.detail.limit) || c.detail.limit < 1 || c.detail.limit > MAX_DETAIL) refuse(`detail needs a limit from 1 to ${MAX_DETAIL}`)
    if (!c.order?.length) refuse('detail needs an order — which rows are shown is the question\'s choice, not the source\'s')
    if (grain) refuse('detail rows are not grouped, so they take no time grain; filter by the span instead')
    const detailColumns: NonNullable<Plan['detail']> = []
    for (const [name, d] of Object.entries(dimensions)) { detailColumns.push({ name, role: 'dimension' }); if (d.label) detailColumns.push({ name: `${name}_label`, role: 'label' }) }
    for (const d of splits.filter(isPath)) { detailColumns.push({ name: d, role: 'dimension' }); if (paths.get(d)!.label) detailColumns.push({ name: `${d}_label`, role: 'label' }) }
    for (const [name, m] of Object.entries(defined)) if (!isDerived(m) && m.column) detailColumns.push({ name, role: 'measure', unit: m.unit })
    if (time) detailColumns.push({ name: time, role: 'time' })
    const names = new Set(detailColumns.map((x) => x.name))
    for (const o of c.order!) if (!names.has(o.by)) refuse(`cannot order detail by "${o.by}" — its columns are ${[...names].join(', ')}`)
    let statement: Statement
    if (kind === 'flow') {
      if (!c.during) refuse('detail of a flow needs the span its rows fall in (during)')
      const { from, to } = c.during!
      statement = await wrap({ from, to, where }, [], (s) => [`${moment(s, { from, to })} >= ${s.date(`${P}from`)}`, `${moment(s, { from, to })} < ${s.date(`${P}to`)}`],
                             { [`${P}from`]: from, [`${P}to`]: to }, { pushdown: false, span: { from, to }, detail: true })
    } else {
      if (!c.at) refuse('detail of a stock needs the instant its rows are read at (at)')
      statement = await wrap({ asAt: c.at!, where }, [], () => [], {}, { pushdown: false, detail: true })
    }
    return { statements: [statement], kind, measures: [], fetched: [], by: splits.filter(isPath), grain: null, combine: 'single', partial: true,
             orderedAtSource: true, ...common(), labelled: [], after: {},
             detail: detailColumns }
  }

  const pushable = (statements: number) => statements === 1 && !acrossPeriods && !c.limitPer
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
      if (reset !== 'never') from = grainSet.startOf(reset, from)
      if (from < keep.from) caveats.push(`running totals start at ${from}, the start of the ${reset}`)
    }
    if (c.rolling && grain) {
      // The first period's window reaches back before the span.
      for (let i = 1; i < c.rolling.window; i++) from = grainSet.startOf(grain, addDays(grainSet.startOf(grain, from), -1))
      from = grainSet.startOf(grain, from)
      caveats.push(`each ${grain} is ${c.rolling.average ? 'the average' : 'the total'} of it and the ${c.rolling.window - 1} before it`)
    }
    const bounds = (s: SqlDialect) => [`${moment(s, { from, to })} >= ${s.date(`${P}from`)}`, `${moment(s, { from, to })} < ${s.date(`${P}to`)}`]
    const pushed = pushable(1)
    if (grain && !grainSet.covers(grain, from)) refuse(`the span starts before calendar grain "${grain}" has periods`)
    if (grain && !grainSet.covers(grain, addDays(to, -1))) refuse(`the span ends after calendar grain "${grain}" has periods`)
    const statement = await wrap({ from, to, where }, by, bounds, { [`${P}from`]: from, [`${P}to`]: to }, { pushdown: pushed, span: { from, to } })
    return {
      statements: [statement], kind, measures, fetched, by, grain, combine: 'single', partial: partialIf(pushed), orderedAtSource: pushed && !!c.order?.length, ...common(),
      after: {
        ...(pushed ? {} : { having: c.having, order: c.order, limit: c.limit, limitPer: c.limitPer }),
        fill: c.rolling && grain ? { periods: grainSet.periods(grain, from, keep.to).map((p) => p.label) }
          : c.fill && grain ? { periods: grainSet.periods(grain, keep.from, keep.to).map((p) => p.label) } : undefined,
        rolling: c.rolling ? { window: c.rolling.window, average: !!c.rolling.average, keep } : undefined,
        cumulative: c.cumulative ? { reset: c.cumulative.reset ?? 'never', keep } : undefined,
      },
    }
  }

  // ── a stock: read at instants ─────────────────────────────────────────────────────────────────────────
  const at = (date: string, pushdown: boolean, period?: string) =>
    wrap({ asAt: date, where }, splits, () => [], {}, { period, pushdown })
  const finish = (statements: Statement[], combine: Plan['combine'], pushed: boolean): Plan => ({
    statements, kind, measures, fetched, by, grain, combine, partial: partialIf(pushed), orderedAtSource: pushed && !!c.order?.length, ...common(),
    after: pushed ? {} : { having: c.having, order: c.order, limit: c.limit, limitPer: c.limitPer },
  })

  if (c.at) {
    if (grain) refuse('a single instant has no periods to split by')
    return finish([await at(c.at!, true)], 'single', true)
  }
  if (!c.during) refuse(`${measures.join(', ')} is a stock: say the instant it is read at (at), or a span to read it across by period (during)`)

  // A stock over a span is read at the end of each period, and never at a date that has not happened.
  const readingGrain: Grain = grain ?? 'month'
  const ends = grainSet.periods(readingGrain, c.during!.from, c.during!.to)
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
