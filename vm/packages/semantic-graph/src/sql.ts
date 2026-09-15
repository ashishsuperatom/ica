// ── RUNNING A PLAN WHERE THE DATA IS (§14) ──────────────────────────────────────────────────────────────────
//
// A plan is compiled to one SQL statement per fact, run on the fact's source through a query function — the
// datasource manager's. The statement is what §4.1 says an answer is, written as SQL:
//
//     SELECT <the end of each grouping path>, <each measure folded>
//     FROM (<the fact's rows>) f
//       LEFT JOIN (<an entity's rows>) e1 ON e1.key = <the path so far>          one join per arrow walked
//       LEFT JOIN (<an arrow's history>) h1 ON h1.key = … AND <the row's date> within [from, to)   an as-of arrow
//     WHERE <the span> AND <the filters>
//     GROUP BY <the ends of the grouping paths>
//
// Each join follows an arrow, and an arrow is a function: it leads each row to at most one element, so a join never
// repeats a row and the fold is the one the reference evaluator computes. Money is multiplied by the rate on its date
// before it is added; a missing rate is reported, never read as zero. A stock taken at the last or first instant of
// each group is aggregated at the source by instant and finished here.
//
// The results are assembled by the same code as the reference evaluator (evaluate.ts `assemble`), which is also what
// the tests compare against: the same questions, the same data, in memory and in SQLite.

import type { FactPlan, Plan, Step } from './algebra.js'
import { assemble, median, plansOf, type Groups, type Result } from './evaluate.js'
import { DataError, type Key } from './instance.js'
import { arrow, baseUnits, timeArrow, walk, type Schema } from './schema.js'
import { addDays, builtIn } from './calendar.js'
import { stretches, type Stretch } from './time.js'



// ── Where each object's rows are ──

export interface FactSource {
  source: string
  /** A statement returning the fact's rows — on the source's tables, or on other objects named in {{braces}}. */
  sql?: string
  /** Or the name of a program that produces them. */
  program?: string
  /** grain arrow role → column. */
  arrows: Record<string, string>
  /** the time arrow's column: a date, the first day of the row's period — or, with timeZone, a moment. */
  time?: string
  /** The zone the time column's moments are written in. Absent: it holds calendar dates, never moved. */
  timeZone?: string
  attributes?: Record<string, string>
  measures: Record<string, string>
  /** Parameters the statement takes. */
  params?: Record<string, unknown>
}
export interface EntitySource {
  source: string
  /** A statement returning one row per element — on the source's tables, or on other objects named in {{braces}}. */
  sql?: string
  /** Or the name of a program that produces them. */
  program?: string
  key: string
  /** arrow role → column, for arrows that do not change over time. */
  arrows: Record<string, string>
  /** The column people read an element by, for filters on labels and member search. */
  label?: string
  /** as-of arrow role → a statement of its history: the element, where it led, [from, to). */
  history?: Record<string, { sql: string; key: string; value: string; from: string; to: string; params?: Record<string, unknown> }>
  params?: Record<string, unknown>
}
export interface Sources { facts: Record<string, FactSource>; entities: Record<string, EntitySource> }

/** Runs a statement on a source — the datasource manager's query. `policies` are the access restrictions of whoever asks,
 *  applied at the source. A result the source cut short says so as `notes` on the rows. */
export type Query = (source: string, sql: string, params: Record<string, unknown>, options?: { policies?: unknown[] }) => Promise<Array<Record<string, unknown>>>

/** A source stopped at its row limit: the rows are not all the rows, so no answer is made from them. */
export class CappedError extends Error {}

export { sqlite, type Dialect } from './dialects.js'
import { sqlite, type Dialect } from './dialects.js'

export class CompileError extends Error {}

/** A source statement may read only the span asked about, through @span_from and @span_to — the first day, and the day
 *  after the last. A statement that names them is given them, or refused when the question has no span. */
export function spanParams(sql: string, span?: { from: string; to: string }): Record<string, unknown> {
  if (!/@span_(from|to)\b/.test(sql)) return {}
  if (!span) throw new CompileError('a source reads only the span asked about (@span_from, @span_to), and the question has no span')
  return { span_from: span.from, span_to: span.to }
}
const withSpan = <G extends { sql: string; params?: Record<string, unknown> }>(guards: G[], span?: { from: string; to: string }) =>
  guards.map((g) => ({ ...g, params: { ...g.params, ...spanParams(g.sql, span) } }))
const fail = (m: string): never => { throw new CompileError(m) }

export interface Statement {
  plan: Plan
  fact: string
  source: string
  sql: string
  params: Record<string, unknown>
  measures: string[]
  /** grouped by instant as well, for a stock finished here. */
  byInstant: boolean
  /** Statements that must hold before the rows are trusted: each entity joined has one row per key. */
  guards: Array<{ label: string; source: string; sql: string; params?: Record<string, unknown> }>
}

/** The statements that answer a plan: one per fact, for the plan and every plan it is assembled from. */
/** Sources for all facts, or the sources each fact's statement reads — which differ when a fact is computed here and
 *  what it joins is read here with it. */
export type SourcesFor = Sources | ((fact: string) => Sources)
const forFact = (src: SourcesFor, fact: string) => (typeof src === 'function' ? src(fact) : src)

/** One dialect for every source, or the dialect of each source. */
export type DialectFor = Dialect | ((source: string) => Dialect)
const dialectOf = (d: DialectFor, source: string) => (typeof d === 'function' ? d(source) : d)

export function compileSql(s: Schema, src: SourcesFor, plan: Plan, d: DialectFor = sqlite, options: { zone?: string; rates?: Rates } = {}): Statement[] {
  return plansOf(plan).flatMap((p) => p.facts.flatMap((fp) => {
    const stocks = fp.stockOverTime ? fp.measures.filter((m) => s.objects[fp.fact].measures![m].kind === 'stock') : []
    const others = fp.measures.filter((m) => !stocks.includes(m))
    return [
      ...(others.length ? [statement(s, forFact(src, fp.fact), p, { ...fp, measures: others }, d, false, options.zone, undefined, options.rates)] : []),
      ...(stocks.length ? [statement(s, forFact(src, fp.fact), p, { ...fp, measures: stocks }, d, true, options.zone, undefined, options.rates)] : []),
    ]
  }))
}

function statement(s: Schema, src: Sources, plan: Plan, fp: FactPlan, dialects: DialectFor, byInstant: boolean, zone = 'UTC', detail?: { key: Array<Key | null>; limit: number }, rates?: Rates): Statement {
  const fs = src.facts[fp.fact] ?? fail(`${fp.fact} has no source`)
  const d = dialectOf(dialects, fs.source)
  if (!fs.sql) fail(`${fp.fact} is produced by a program, which runs before its statement is written`)
  const q = d.quote
  const col = (alias: string, c: string) => `${alias}.${q(c)}`
  const params: Record<string, unknown> = {}
  let counter = 0
  const param = (v: unknown) => { const name = `p${counter++}`; params[name] = v; return `@${name}` }
  const take = (more?: Record<string, unknown>) => { for (const [k, v] of Object.entries(more ?? {})) { if (k in params && params[k] !== v) fail(`parameter @${k} means two things in one statement`); params[k] = v } }
  take(fs.params)
  const joins: string[] = []
  // An element is joined once, however many paths go through it; a history once per arrow followed.
  const elements = new Map<string, string>()
  const guards = new Map<string, Statement['guards'][number]>()
  const reached = new Map<string, string>()
  const time = timeArrow(s, fp.fact)
  const rawTime = time ? col('f', fs.time ?? fail(`${fp.fact} has a time arrow and its source names no time column`)) : undefined
  // Moments are placed in the asker's days by the offset in force at each moment across the span.
  if (fs.timeZone && time && builtIn(s.objects[time.to]) !== 'day') fail(`${fp.fact}: moments are kept by day; its time arrow leads to ${time.to}`)
  if (fs.timeZone && !plan.span) fail(`${fp.fact} holds moments, which are placed in the asker's days over a span, and the question has none`)
  const timeCol = rawTime && fs.timeZone ? d.localDay(rawTime, stretches(plan.span!.from, plan.span!.to, fs.timeZone, zone)) : rawTime
  const rowDate = timeCol ? d.periodEnd(s.objects[time!.to], timeCol) : undefined
  const sameSource = (what: string, source: string) => { if (source !== fs.source) fail(`${what} is in ${source} and ${fp.fact} in ${fs.source}; one statement cannot read both`) }

  /** The SQL expression for where a path from the fact leads. */
  const reach = (path: string[]): string => {
    const first = arrow(s, fp.fact, path[0])!
    if (s.objects[first.to].kind === 'calendar') {
      const end = path.slice(1).reduce((o, r) => arrow(s, o, r)!.to, first.to)
      return d.key(s.objects[end], timeCol!)
    }
    let expr = col('f', fs.arrows[path[0]] ?? fail(`${fp.fact}.${path[0]} has no column`))
    let object = first.to
    for (let i = 1; i < path.length; i++) {
      const text = path.slice(0, i + 1).join('.')
      const a = arrow(s, object, path[i])!
      const es = src.entities[object] ?? fail(`${object} has no source, so ${text} cannot be followed`)
      sameSource(object, es.source)
      if (!reached.has(text)) {
        if (a.kind === 'as-of') {
          const alias = `j${joins.length}`
          const h = es.history?.[path[i]] ?? fail(`${object}.${path[i]} changes over time and its source has no history for it`)
          take(h.params)
          if (!rowDate) fail(`${object}.${path[i]} changes over time and ${fp.fact} has no date to take it on`)
          guards.set(`${object}.${path[i]}`, { label: `${object}.${path[i]} has no two values in effect at once`, source: es.source, params: h.params,
            sql: `SELECT COUNT(*) AS n, 0 AS d FROM (${h.sql}) a JOIN (${h.sql}) b ON ${col('a', h.key)} = ${col('b', h.key)} AND ${col('a', h.from)} < ${col('b', h.from)} AND (${col('a', h.to)} IS NULL OR ${col('a', h.to)} > ${col('b', h.from)})` })
          joins.push(`LEFT JOIN (${h.sql}) ${alias} ON ${col(alias, h.key)} = ${expr} AND ${col(alias, h.from)} <= ${rowDate} AND (${col(alias, h.to)} IS NULL OR ${rowDate} < ${col(alias, h.to)})`)
          reached.set(text, col(alias, h.value))
        } else {
          const at = path.slice(0, i).join('.')
          if (!elements.has(at)) {
            take(es.params)
            const alias = `j${joins.length}`
            joins.push(`LEFT JOIN (${es.sql}) ${alias} ON ${col(alias, es.key)} = ${expr}`)
            elements.set(at, alias)
            // A join repeats no row only if the entity has one row per key; that is data, so it is checked, not assumed.
            guards.set(object, { label: `${object} has one row per key`, source: es.source, params: es.params, sql: `SELECT COUNT(*) AS n, COUNT(DISTINCT g.${q(es.key)}) AS d FROM (${es.sql}) g` })
          }
          reached.set(text, col(elements.get(at)!, es.arrows[path[i]] ?? fail(`${object}.${path[i]} has no column`)))
        }
      }
      expr = reached.get(text)!
      object = a.to
    }
    return expr
  }
  /** The label of the element a path leads to, from that entity's own source. */
  const labelOf = (path: string[]): string => {
    const key = reach(path)
    const object = walk(s, fp.fact, path)!.object
    const es = src.entities[object] ?? fail(`${object} has no source, so its labels cannot be read`)
    if (!es.label) fail(`the source of ${object} names no label column, so its labels cannot be matched`)
    const text = `${path.join('.')}#label`
    if (!reached.has(text)) {
      sameSource(object, es.source)
      take(es.params)
      const alias = `j${joins.length}`
      joins.push(`LEFT JOIN (${es.sql}) ${alias} ON ${col(alias, es.key)} = ${key}`)
      reached.set(text, col(alias, es.label!))
    }
    return reached.get(text)!
  }
  const stepExpr = (x: Step) => ('attribute' in x ? col('f', fs.attributes?.[x.attribute] ?? fail(`${fp.fact}.${x.attribute} has no column`)) : reach(x.path))

  const keys = fp.by.map(stepExpr)
  const where: string[] = []
  if (plan.span && timeCol && fs.timeZone) where.push(`${rawTime} >= ${d.date(param(addDays(plan.span.from, -1)))} AND ${rawTime} < ${d.date(param(addDays(plan.span.to, 1)))}`)
  if (plan.span && timeCol) where.push(`${timeCol} >= ${d.date(param(plan.span.from))} AND ${timeCol} < ${d.date(param(plan.span.to))}`)
  for (const w of fp.where) {
    const expr = stepExpr(w)
    if ('none' in w) { where.push(`${expr} IS ${w.none ? '' : 'NOT '}NULL`); continue }
    if ('notIn' in w) { where.push(`(${expr} IS NULL OR ${expr} NOT IN (${w.notIn.map(param).join(', ')}))`); continue }
    if ('contains' in w || 'startsWith' in w) {
      const labelled = 'attribute' in w ? expr : labelOf(w.path)
      // LIKE without ESCAPE, which every source accepts: a % or _ typed in a name matches loosely.
      const pattern = ('contains' in w ? `%${w.contains}%` : `${w.startsWith}%`).toLowerCase()
      where.push(`LOWER(${labelled}) LIKE ${param(pattern)}`)
      continue
    }
    const list = w.in.map(param).join(', ')
    if (!w.under) { where.push(`${expr} IN (${list})`); continue }
    const object = (w as { path: string[] }).path.reduce((o, r) => arrow(s, o, r)!.to, fp.fact)
    const es = src.entities[object] ?? fail(`${object} has no source`)
    if (arrow(s, object, w.under)!.kind === 'as-of') fail(`everything under ${(w as { in: string[] }).in.join(', ')} along ${w.under}, which changes over time, is not compiled`)
    take(es.params)
    where.push(d.under(expr, es.sql ?? fail(`${object} is produced by a program that has not run`), es.key, es.arrows[w.under], list) ?? fail(`everything under a member along ${w.under} is not compiled for ${d.name}`))
  }

  if (detail) {
    // The rows behind one group: every column of the fact's rows, those whose paths lead to the group.
    keys.forEach((k, i) => where.push(detail.key[i] === null ? `${k} IS NULL` : `${k} = ${param(detail.key[i])}`))
    const columns = [
      ...(timeCol ? [`${timeCol} AS ${q('time')}`] : []),
      ...Object.entries(fs.arrows).map(([role, c]) => `${col('f', c)} AS ${q(role)}`),
      ...Object.entries(fs.attributes ?? {}).map(([a, c]) => `${col('f', c)} AS ${q(a)}`),
      ...Object.entries(fs.measures).map(([m, c]) => `${col('f', c)} AS ${q(m)}`),
    ]
    const sql = d.limit(`SELECT ${columns.join(', ')}\nFROM (${fs.sql}) f${joins.map((j) => `\n${j}`).join('')}${where.length ? `\nWHERE ${where.join('\n  AND ')}` : ''}\nORDER BY ${[...(timeCol ? [timeCol] : []), ...Object.values(fs.arrows).map((c) => col('f', c))].join(', ')}`, detail.limit + 1)
    return { plan, fact: fp.fact, source: fs.source, sql, params: { ...params, ...spanParams(sql, plan.span) }, measures: [], byInstant: false, guards: withSpan([...guards.values()], plan.span) }
  }
  const selects = keys.map((k, i) => `${k} AS k${i}`)
  const def = s.objects[fp.fact]
  fp.measures.forEach((name, i) => {
    const m = def.measures![name]
    const raw = col('f', fs.measures[name] ?? fail(`${fp.fact}.${name} has no column`))
    let v = raw
    if (fp.convert && m.currency && baseUnits(m.unit).money) {
      const known = rates?.get(`${plan.span?.to}|${plan.asOf ?? ''}|${fp.convert.currency}`)
      if (!known) take(src.facts[s.conversion!.fact]?.params)
      const rate = rateExpr(s, src, plan, fp, m.currency, d, param, reach, col, rowDate, known)
      v = `(${raw} * ${rate})`
      selects.push(`SUM(CASE WHEN ${raw} IS NOT NULL AND ${rate} IS NULL THEN 1 ELSE 0 END) AS x${i}`)
    }
    const w = m.weight ? col('f', fs.measures[m.weight]) : ''
    selects.push(`${
      m.aggregate === 'sum' ? `SUM(${v})` : m.aggregate === 'count' ? `COUNT(${raw})` : m.aggregate === 'min' ? `MIN(${v})` : m.aggregate === 'max' ? `MAX(${v})`
      : m.aggregate === 'average' ? `AVG(${v})` : m.aggregate === 'median' ? d.median(v).sql : m.aggregate === 'count distinct' ? `COUNT(DISTINCT ${col('f', fs.arrows[m.of!])})`
      : `SUM(CASE WHEN ${v} IS NOT NULL AND ${w} <> 0 THEN ${v} * ${w} END) / SUM(CASE WHEN ${v} IS NOT NULL AND ${w} <> 0 THEN ${w} END)`
    } AS m${i}`)
  })
  const group = [...keys, ...(byInstant ? [timeCol!] : [])]
  if (byInstant) selects.push(`${timeCol} AS instant`)
  const sql = `SELECT ${selects.join(', ')}\nFROM (${fs.sql}) f${joins.map((j) => `\n${j}`).join('')}${where.length ? `\nWHERE ${where.join('\n  AND ')}` : ''}${group.length ? `\nGROUP BY ${group.join(', ')}` : ''}`
  return { plan, fact: fp.fact, source: fs.source, sql, params: { ...params, ...spanParams(sql, plan.span) }, measures: fp.measures, byInstant, guards: withSpan([...guards.values()], plan.span) }
}

/** A row's rate into the reporting currency: 1 in that currency, else the latest rate on or before the conversion
 *  date and never after the answer's as-of date. */
function rateExpr(s: Schema, src: Sources, plan: Plan, fp: FactPlan, currency: string[] | { attribute: string }, d: Dialect,
                  param: (v: unknown) => string, reach: (p: string[]) => string, col: (a: string, c: string) => string, rowDate?: string, known?: Record<string, number>): string {
  const c = s.conversion!
  const rs = src.facts[c.fact] ?? fail(`the exchange rates ${c.fact} have no source`)
  const cur0 = Array.isArray(currency) ? reach(currency) : col('f', src.facts[fp.fact].attributes?.[currency.attribute] ?? fail(`${fp.fact}.${currency.attribute} has no column`))
  // Rates read once for the one date every row converts on: written into the statement as values.
  if (known) return `(CASE ${cur0} WHEN ${param(fp.convert!.currency)} THEN 1 ${Object.entries(known).map(([k, v]) => `WHEN ${param(k)} THEN ${param(v)}`).join(' ')} END)`
  if (rs.source !== src.facts[fp.fact].source) fail(`the exchange rates are in ${rs.source} and ${fp.fact} in ${src.facts[fp.fact].source}; one statement cannot read both`)
  const cur = Array.isArray(currency) ? reach(currency) : col('f', src.facts[fp.fact].attributes?.[currency.attribute] ?? fail(`${fp.fact}.${currency.attribute} has no column`))
  const to = param(fp.convert!.currency)
  let on = fp.convert!.at === 'end' ? d.date(param(dayBefore(plan.span!.to))) : rowDate ?? fail(`${fp.fact} has no date to convert its money on`)
  if (plan.asOf) { const asOf = d.date(param(plan.asOf)); on = `CASE WHEN ${on} > ${asOf} THEN ${asOf} ELSE ${on} END` }
  const r = (x: string) => col('r', x)
  const found = d.first(r(rs.measures[c.rate]), `(${rs.sql}) r`, `${r(rs.arrows[c.from])} = ${cur} AND ${r(rs.arrows[c.to])} = ${to} AND ${r(rs.time!)} <= ${on}`, `${r(rs.time!)} DESC`)
  return `(CASE WHEN ${cur} = ${to} THEN 1 ELSE ${found} END)`
}
const dayBefore = (x: string) => { const t = new Date(x + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10) }

/** Rates into a currency as at a date, by the date asked (span end | as-of | currency): from-currency → rate. */
export type Rates = Map<string, Record<string, number>>

/** The rates a plan's money converts at, when every row converts on one date (at the end of the span): read once — the
 *  latest rate on or before that date for each currency — instead of looked up for every row. */
async function ratesFor(s: Schema, src: SourcesFor, plan: Plan, query: Query, d: DialectFor, options: RunOptions): Promise<Rates> {
  const out: Rates = new Map()
  const c = s.conversion
  if (!c) return out
  for (const p of plansOf(plan)) for (const fp of p.facts) {
    if (!fp.convert || fp.convert.at !== 'end' || !p.span) continue
    const key = `${p.span.to}|${p.asOf ?? ''}|${fp.convert.currency}`
    if (out.has(key)) continue
    const rs = forFact(src, fp.fact).facts[c.fact]
    if (!rs?.sql || !rs.time) continue
    const dr = dialectOf(d, rs.source), q = (x: string) => `r.${dr.quote(x)}`
    let on = dayBefore(p.span.to)
    if (p.asOf && p.asOf < on) on = p.asOf
    const params = { ...rs.params, to_currency: fp.convert.currency, on }
    const latest = await query(rs.source, `SELECT ${q(rs.arrows[c.from])} AS c, MAX(${q(rs.time)}) AS d FROM (${rs.sql}) r WHERE ${q(rs.arrows[c.to])} = @to_currency AND ${q(rs.time)} <= ${dr.date('@on')} GROUP BY ${q(rs.arrows[c.from])}`, params, { policies: options.access?.[rs.source] })
    const rates: Record<string, number> = {}
    for (const l of latest) {
      const [row] = await query(rs.source, `SELECT MAX(${q(rs.measures[c.rate])}) AS v FROM (${rs.sql}) r WHERE ${q(rs.arrows[c.from])} = @from_currency AND ${q(rs.arrows[c.to])} = @to_currency AND ${q(rs.time)} = @day`, { ...rs.params, to_currency: fp.convert.currency, from_currency: l.c, day: l.d }, { policies: options.access?.[rs.source] })
      if (row?.v != null) rates[String(l.c)] = Number(row.v)
    }
    out.set(key, rates)
  }
  return out
}

/** Run a plan's statements and assemble the answer. */
export interface RunOptions {
  /** Access policies of whoever asks, by source, passed with every statement. */
  access?: Record<string, unknown[]>
  /** The zone of whoever asks, for moments written in another. */
  zone?: string
  /** thorough: run the guards before trusting rows. light: skip them, and say so. */
  checks?: 'thorough' | 'light'
  /** Each statement as it ran. */
  onStatement?: (record: { fact: string; source: string; sql: string; params: Record<string, unknown>; rows: number; ms: number; capped: boolean }) => void
}

export async function runSql(s: Schema, src: SourcesFor, plan: Plan, query: Query, d: DialectFor = sqlite, options: RunOptions = {}): Promise<Result & { statements: Statement[]; caveats: string[] }> {
  const statements = compileSql(s, src, plan, d, { zone: options.zone, rates: await ratesFor(s, src, plan, query, d, options) })
  const caveats: string[] = []
  const run = async (fact: string, source: string, sql: string, params: Record<string, unknown>) => {
    const t = Date.now()
    const rows = await query(source, sql, params, { policies: options.access?.[source] })
    const capped = Array.isArray((rows as any).notes) && (rows as any).notes.length > 0
    options.onStatement?.({ fact, source, sql, params, rows: rows.length, ms: Date.now() - t, capped })
    if (capped) throw new CappedError(`${fact}: ${source} stopped at ${rows.length} rows, so these are not all the rows and no answer is made from them — group more coarsely or filter`)
    return rows
  }
  const guards = new Map(statements.flatMap((st) => st.guards.map((g) => [g.label, { ...g, fact: st.fact }] as const)))
  if ((options.checks ?? 'thorough') === 'thorough') {
    await Promise.all([...guards.values()].map(async (g) => {
      const [r] = await run(g.fact, g.source, g.sql, g.params ?? {})
      const n = Number(r?.n ?? 0), distinct = Number(r?.d ?? 0)
      if (g.label.endsWith('one row per key') ? n !== distinct : n > 0) throw new DataError(`${g.label} does not hold, so joining it would repeat rows`)
    }))
  } else if (guards.size) caveats.push(`not checked: ${[...guards.keys()].join('; ')}`)
  const results = await Promise.all(statements.map((st) => run(st.fact, st.source, st.sql, st.params)))
  const folded = new Map<Plan, Groups[]>()
  for (const p of plansOf(plan)) {
    folded.set(p, p.facts.map((fp) => {
      const groups: Groups = new Map()
      statements.forEach((st, i) => {
        if (st.plan !== p || st.fact !== fp.fact) return
        const rows = st.byInstant ? finishStocks(s, fp, st, results[i]) : results[i]
        for (const row of rows) {
          st.measures.forEach((_, j) => { if (Number(row[`x${j}`] ?? 0) > 0) throw new DataError(`${fp.fact}: some rows have no rate into ${fp.convert!.currency} on or before their conversion date`) })
          const key = fp.by.map((_, j) => keyOf(row[`k${j}`]))
          const k = JSON.stringify(key)
          const g = groups.get(k) ?? { key, values: {} }
          st.measures.forEach((m, j) => {
            const v = row[`m${j}`]
            const collected = s.objects[fp.fact].measures![m].aggregate === 'median' && dialectOf(d, st.source).median('x').collected
            g.values[m] = collected ? median((JSON.parse(String(v ?? '[]')) as Array<number | null>).filter((x): x is number => x !== null).map(Number)) : v === null || v === undefined ? null : Number(v)
          })
          groups.set(k, g)
        }
      })
      return groups
    }))
  }
  return { ...assemble(plan, folded), statements, caveats }
}
const keyOf = (v: unknown): Key | null => (v === null || v === undefined ? null : String(v))

/** A stock aggregated at the source by instant, taken per group at the last or first instant of its time bucket, or
 *  averaged over the bucket's instants — the instants any group of the fact has, as §5 D5 says. */
function finishStocks(s: Schema, fp: FactPlan, st: Statement, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const timeTargets = fp.by.map((b) => 'path' in b && b.path[0] === fp.time?.role)
  const bucketOf = (row: Record<string, unknown>) => JSON.stringify(fp.by.map((_, j) => (timeTargets[j] ? row[`k${j}`] : '*')))
  const instants = new Map<string, string[]>()
  for (const row of rows) { const b = bucketOf(row); instants.set(b, [...new Set([...(instants.get(b) ?? []), String(row.instant)])].sort()) }
  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows) { const k = JSON.stringify(fp.by.map((_, j) => row[`k${j}`])); groups.set(k, [...(groups.get(k) ?? []), row]) }
  return [...groups.values()].map((g) => {
    const all = instants.get(bucketOf(g[0]))!
    const out: Record<string, unknown> = Object.fromEntries(fp.by.map((_, j) => [`k${j}`, g[0][`k${j}`]]))
    st.measures.forEach((name, j) => {
      const m = s.objects[fp.fact].measures![name]
      const absent = m.aggregate === 'sum' || m.aggregate === 'count' ? 0 : null
      const at = (instant: string) => { const r = g.find((x) => String(x.instant) === instant); const v = r?.[`m${j}`]; return v === null || v === undefined ? absent : Number(v) }
      if (m.overTime === 'last') out[`m${j}`] = at(all[all.length - 1])
      else if (m.overTime === 'first') out[`m${j}`] = at(all[0])
      else { const vs = all.map(at).filter((v): v is number => v !== null); out[`m${j}`] = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null }
    })
    return out
  })
}

/** The most rows drill-through gives at once. */
export const MAX_DETAIL = 1000

/** The rows behind one group of an answer, read at their sources: for each fact, its rows whose paths lead to the
 *  group, filtered as the question is, in time order. More rows than the limit is said, never cut silently. */
export async function detailSql(s: Schema, src: SourcesFor, plan: Plan, key: Array<Key | null>, query: Query, options: RunOptions & { limit?: number } = {}, d: DialectFor = sqlite) {
  const limit = Math.min(options.limit ?? 100, MAX_DETAIL)
  if (key.length !== plan.targets.length) throw new CompileError(`a group of this answer has ${plan.targets.length} keys, and ${key.length} were given`)
  return Promise.all(plan.facts.map(async (fp) => {
    const st = statement(s, forFact(src, fp.fact), plan, fp, d, false, options.zone, { key, limit })
    const t = Date.now()
    const rows = await query(st.source, st.sql, st.params, { policies: options.access?.[st.source] })
    options.onStatement?.({ fact: st.fact, source: st.source, sql: st.sql, params: st.params, rows: rows.length, ms: Date.now() - t, capped: Array.isArray((rows as any).notes) && (rows as any).notes.length > 0 })
    if (Array.isArray((rows as any).notes) && (rows as any).notes.length) throw new CappedError(`${fp.fact}: ${st.source} stopped at ${rows.length} rows`)
    return { fact: fp.fact, rows: rows.slice(0, limit), more: rows.length > limit }
  }))
}
