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
import { plan, type Coordinates, type ReadBody, type ResolvedCoordinates } from './coordinates.js'
import { runPlan, type Result } from './execute.js'
import type { Runtime, Scope, Trail } from './runtime.js'
import { kindOf } from './shape.js'
import { Grains } from './calendar.js'
import { resolveRelative } from './relative.js'
import { convertUnits } from './units.js'
import { atLevel, summaryProblem, withShares } from './summaries.js'

export async function answerRelation(rt: Runtime, program: { name: string; hash: string; contract: Contract; body: string },
                                     asked: Coordinates, scope: Scope, trail: Trail, path: string[]): Promise<Result> {
  const { name, hash, contract, body } = program
  const shape = contract.shape!
  const read: ReadBody = (when) => statementFor(rt, name, contract, hash, body, when, scope, trail, path)
  const calendar = calendarFor(rt.o.assumptions, scope, trail)
  const attributes = attributesFor(rt, scope, trail, path)
  const ratesName = settingFor(rt.o.assumptions, scope, 'exchange rates', trail)
  const rates = typeof ratesName === 'string' ? ratesFor(rt, scope, trail, path, ratesName) : undefined
  // "Last 30 days" becomes dates first, against the day this call is answered as of and the request's calendar.
  // A reporting currency set for the organisation or the person applies when the question does not name one.
  const currency = asked.currency ?? (Object.values(shape.measures).some((m) => (m as any).currency) ? settingFor(rt.o.assumptions, scope, 'currency', trail) as string | undefined : undefined)
  const { coordinates, caveats: resolved } = resolveRelative(currency ? { ...asked, currency } : asked, scope.today, new Grains(calendar))
  trail.caveats.push(...resolved)

  const ask = async (c: ResolvedCoordinates, side?: string) => {
    const p = await plan(shape, read, c, rt.dialects, scope.today, { calendar, attributes, rates, zone: scope.zone?.zone })
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
  if (coordinates.units) {
    const table = settingFor(rt.o.assumptions, scope, 'units', trail) as Record<string, Record<string, number>> | undefined
    value = convertUnits(shape, value, coordinates.units, table, trail.caveats)
  }
  trail.caveats.push(...value.caveats)
  return value
}
