// ── ANSWERING A QUESTION ASKED OF A RELATION ──────────────────────────────────────────────────────────────
//
// The definition and the question arrive separately. The relation's body says what it is; the coordinates say
// which part of it is wanted. Nothing in the body changes when someone drills down, compares, or asks for totals.
//
//   plan      coordinates.ts — the statements, and the refusals
//   run       execute.ts — the rows, and the checks only rows allow
//   compare   compare.ts — the same question at another time, aligned
//   totals    summaries.ts — the same question at coarser splits; shares of a total

import { calendarFor, settingFor } from './assumptions.js'
import { comparisonCoordinates, mergeComparison, type ResolvedComparison } from './compare.js'
import { attributesFor, ratesFor, statementFor } from './composition.js'
import type { Contract } from './contract.js'
import { plan, type Coordinates, type ReadBody, type ResolvedCoordinates, type ResolvedStatement } from './coordinates.js'
import { runPlan, type Result } from './execute.js'
import { createHash } from 'node:crypto'
import { LOCAL, type Runtime, type Scope, type Trail } from './runtime.js'
import { isDerived, kindOf } from './shape.js'
import { CoordinateError } from './errors.js'
import { Grains } from './calendar.js'
import { resolveRelative } from './relative.js'
import { atLevel, summaryProblem, withShares } from './summaries.js'

export async function answerRelation(rt: Runtime, program: { name: string; hash: string; contract: Contract; body: string },
                                     asked: Coordinates, scope: Scope, trail: Trail, path: string[]): Promise<Result> {
  const { name, hash, contract, body } = program
  const shape = contract.shape!
  const read: ReadBody = (when) => statementFor(rt, name, contract, hash, body, when, scope, trail, path)
  const calendar = calendarFor(rt.o.assumptions, scope, trail)
  const attributes = attributesFor(rt, scope, trail, path)
  const ratesSetting = settingFor(rt.o.assumptions, scope, 'exchange rates', trail)
  const rates = ratesSetting !== undefined ? ratesFor(rt, scope, trail, path, ratesSetting) : undefined
  // "Last 30 days" becomes dates first, against the day this call is answered as of and the request's calendar.
  // A reporting currency set for the organisation or the person applies when the question does not name one.
  const currency = asked.currency ?? (Object.values(shape.measures).some((m) => (m as any).currency) ? settingFor(rt.o.assumptions, scope, 'currency', trail) as string | undefined : undefined)
  const { coordinates: relative, caveats: resolved } = resolveRelative(currency ? { ...asked, currency } : asked, scope.today, new Grains(calendar))
  trail.caveats.push(...resolved)
  const coordinates = withNames(shape, relative, trail)

  // A relation joined to this one from another place is read in whole; a source that holds back rows cannot be joined.
  const materialise = async (st: ResolvedStatement, columns: string[], of: string): Promise<ResolvedStatement> => {
    const t = Date.now()
    const rows = await rt.o.query(st.source, st.sql, st.params, { policies: scope.access?.[st.source] })
    const capped = Array.isArray((rows as any).notes) && (rows as any).notes.length > 0
    trail.queries.push({ source: st.source, sql: st.sql, params: st.params, rows: rows.length, ms: Date.now() - t, capped })
    if (capped) throw new Error(`"${of}" has more rows than ${st.source} returns at once, so it cannot be read here to join to "${name}"`)
    const table = `m_${createHash('sha256').update(st.source + st.sql + JSON.stringify(st.params)).digest('hex').slice(0, 12)}`
    return { source: LOCAL, sql: `SELECT * FROM ${table}`, params: {}, tables: { [table]: { columns, rows } } }
  }

  const ask = async (c: ResolvedCoordinates, side?: string) => {
    const p = await plan(shape, read, c, rt.dialects, scope.today, { calendar, attributes, rates, zone: scope.zone?.zone, materialise })
    const result = await runPlan(shape, p, (src, sql, params) => rt.o.query(src, sql, params, { policies: scope.access?.[src] }),
      (q) => trail.queries.push(q),
      (label, held, detail) => {
        const tagged = side ? `${side}: ${label}` : label
        trail.verifications.push({ label: tagged, held, detail })
        if (!held) throw new Error(`invariant failed: ${tagged} — ${detail}`)
      },
      (text) => trail.caveats.push(text),
      scope.checks)
    return { p, result }
  }

  const answer = async (c: ResolvedCoordinates, side?: string): Promise<Result> => {
    if (!c.compare) return (await ask(c, side)).result
    const both = comparisonCoordinates(c as ResolvedCoordinates & { compare: ResolvedComparison }, scope.today, kindOf(shape) === 'flow')
    const [now, then] = await Promise.all([ask(both.current, side ? `${side}, now` : 'now'), ask(both.previous, side ? `${side}, compared with` : 'compared with')])
    trail.caveats.push(...both.caveats)
    return mergeComparison(shape, now.result, then.result, now.p.by, now.p.grain, both.after)
  }

  summaryProblem(shape, coordinates)
  let value = await answer(coordinates.totals || coordinates.share ? { ...coordinates, totals: undefined, share: undefined } : coordinates)
  const measuresAsked = coordinates.measures?.length ? coordinates.measures : Object.keys(shape.measures)
  if (value.rows.every((r) => measuresAsked.every((m) => r[m] == null))) await noSuchMember(coordinates)
  if (coordinates.share) {
    const { measures, within } = coordinates.share
    value = withShares(value, await answer(atLevel(coordinates, within, measures), `share within ${within.join(', ') || 'the whole'}`), measures, within)
  }
  if (coordinates.totals?.length) {
    const levels = await Promise.all(coordinates.totals.map(async (level) =>
      ({ by: level, ...(await answer(atLevel(coordinates, level), `total by ${level.join(', ') || 'everything'}`)) })))
    value = { ...value, totals: levels.map(({ by, columns, rows }) => ({ by, columns, rows })) }
    if (coordinates.limit != null || coordinates.having) trail.caveats.push('totals count every row, including rows the limit or having leaves out')
  }
  trail.caveats.push(...value.caveats)
  return value

  // AN EMPTY ANSWER BECAUSE A FILTER NAMES NOTHING THAT EXISTS is not an answer: "no rows" reads as "none happened".
  // When a question comes back empty, each member it filters on is looked for among the members the same span holds.
  // If the span holds members and the one asked for is not among them, the question is refused, with those members.
  // A span that holds none is simply empty.
  async function noSuchMember(c: ResolvedCoordinates) {
    const base = Object.entries(shape.measures).filter(([, m]) => !isDerived(m))
    const measure = (base.find(([, m]) => !(m as any).currency) ?? base[0])[0]
    for (const [key, condition] of Object.entries(c.where ?? {})) {
      const values = Array.isArray(condition) ? condition : (typeof condition === 'string' || typeof condition === 'number') ? [condition] : null
      const dim = shape.dimensions[key] ? key : key.endsWith('_label') && shape.dimensions[key.slice(0, -6)] ? key.slice(0, -6) : null
      if (!values?.length || !dim) continue
      const d = shape.dimensions[dim]
      const { result } = await ask({ measures: [measure], by: [dim], ...(c.during ? { during: c.during } : {}), ...(c.at ? { at: c.at } : {}), ...(c.currency ? { currency: c.currency } : {}) })
      // A filter on the dimension matches ids; a filter on its label matches names.
      const has = (v: unknown) => result.rows.some((r) => key === dim ? same(r[dim], v) : same(r[`${dim}_label`], v))
      const missing = values.filter((v) => !has(v))
      if (!missing.length || !result.rows.length) continue
      const members = result.rows.slice(0, 20).map((r) => d.label ? `${r[`${dim}_label`]} (${r[dim]})` : String(r[dim]))
      const names = d.names ? ` — names people use: ${Object.entries(d.names).map(([n, v]) => `${n} = ${v}`).join(', ')}` : ''
      throw new CoordinateError(`no ${dim} ${key === dim ? 'is' : 'is named'} ${missing.map((v) => JSON.stringify(v)).join(' or ')} in the span asked — its members there are ${members.join(', ')}${result.rows.length > 20 ? `, and ${result.rows.length - 20} more` : ''}${names}${d.label && key === dim ? ` — to filter by name, use ${dim}_label` : ''}`)
    }
  }
}

const same = (a: unknown, b: unknown) => a != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()

/** A filter on a name people use for a member — a dimension's names — is read as that member, and says so. */
function withNames(shape: Contract['shape'] & object, c: ResolvedCoordinates, trail: Trail): ResolvedCoordinates {
  if (!c.where) return c
  const where: Record<string, any> = { ...c.where }
  for (const [dim, d] of Object.entries(shape.dimensions)) {
    if (!d.names) continue
    const names = Object.entries(d.names)
    const meant = (v: unknown) => names.find(([n]) => same(n, v))
    for (const key of [dim, `${dim}_label`]) {
      const condition = where[key]
      const values = Array.isArray(condition) ? condition : (typeof condition === 'string' || typeof condition === 'number') ? [condition] : null
      if (!values?.length || !values.every(meant)) continue
      const members = values.map((v) => meant(v)![1])
      delete where[key]
      where[dim] = Array.isArray(condition) ? members : members[0]
      trail.caveats.push(`${values.map((v, i) => `"${v}" is read as ${dim} ${members[i]}`).join('; ')}`)
    }
  }
  return { ...c, where }
}
