// ── RELATIVE DATES: "LAST 30 DAYS", "QUARTER TO DATE", "PREVIOUS COMPLETE MONTH" ──────────────────────────────
//
// People rarely ask with dates; they ask relative to now. Each relative span is resolved against the day the call
// is answered as of — which memory records, so a replay a month later still means the same 30 days — and against
// the request's calendar, so "this quarter" is the fiscal quarter where the organisation's quarters are fiscal.
// The dates it resolved to are always stated with the answer.
//
//   { this: 'quarter' }                 the current period, whole — to its end, even if that is after today
//   { this: 'quarter', toDate: true }   the current period up to and including today
//   { previous: 'month', count: 3 }     the three whole months before the current one
//   { last: 30, unit: 'day' }           a rolling span ending today, today included
//
//   at: 'today'                         today
//   at: { endOf: 'month' }              the last day of the previous month — the most recent complete one

import { addDays, type Grains } from './calendar.js'
import { shift } from './compare.js'
import type { Coordinates, Grain, ResolvedCoordinates } from './coordinates.js'
import { CoordinateError } from './errors.js'

export type RelativeSpan =
  | { this: Grain; toDate?: boolean }
  | { previous: Grain; count?: number }
  | { last: number; unit: 'day' | 'week' | 'month' | 'quarter' | 'year' }
export type RelativeInstant = 'today' | { endOf: Grain; count?: number }

const refuse = (msg: string): never => { throw new CoordinateError(msg) }
const isExplicitSpan = (d: unknown): d is { from: string; to: string } => !!d && typeof (d as any).from === 'string'

/** The first day of the period `count` periods before the one `date` is in. */
function periodsBack(grains: Grains, grain: Grain, date: string, count: number): string {
  let start = grains.startOf(grain, date)
  for (let i = 0; i < count; i++) start = grains.startOf(grain, addDays(start, -1))
  return start
}

export function resolveSpan(span: RelativeSpan | { from: string; to: string }, today: string, grains: Grains): { from: string; to: string; said?: string } {
  if (isExplicitSpan(span)) return span
  const tomorrow = addDays(today, 1)
  const need = (g: Grain) => grains.has(g) ? g : refuse(`"${g}" is not a grain — ${grains.names().join(', ')}`)
  if ('this' in span) {
    const g = need(span.this)
    const from = grains.startOf(g, today)
    const to = span.toDate ? tomorrow : grains.nextStart(g, today)
    return { from, to, said: `this ${g}${span.toDate ? ' to date' : ''}` }
  }
  if ('previous' in span) {
    const g = need(span.previous)
    const count = span.count ?? 1
    if (!Number.isInteger(count) || count < 1) refuse('previous counts whole periods: a whole number from 1')
    return { from: periodsBack(grains, g, today, count), to: grains.startOf(g, today), said: `the previous ${count === 1 ? g : `${count} ${g}s`}` }
  }
  if ('last' in span) {
    if (!Number.isInteger(span.last) || span.last < 1) refuse('last counts units back from today: a whole number from 1')
    const by = { day: { days: span.last }, week: { weeks: span.last }, month: { months: span.last }, quarter: { quarters: span.last }, year: { years: span.last } }[span.unit]
    if (!by) refuse('last is counted in day, week, month, quarter or year')
    return { from: shift(tomorrow, by), to: tomorrow, said: `the last ${span.last} ${span.unit}${span.last === 1 ? '' : 's'}` }
  }
  return refuse('during is { from, to }, or relative: { this }, { previous }, or { last, unit }')
}

export function resolveInstant(at: RelativeInstant | string, today: string, grains: Grains): { at: string; said?: string } {
  if (typeof at === 'string' && at !== 'today') return { at }
  if (at === 'today') return { at: today, said: 'today' }
  const g = grains.has(at.endOf) ? at.endOf : refuse(`"${at.endOf}" is not a grain`)
  const count = at.count ?? 1
  return { at: addDays(periodsBack(grains, g, today, count - 1), -1), said: `the end of the previous ${count === 1 ? g : `${count} ${g}s`}` }
}

/** The coordinates with every relative date made explicit, and a line saying what each became. */
export function resolveRelative(c: Coordinates, today: string, grains: Grains): { coordinates: ResolvedCoordinates; caveats: string[] } {
  const caveats: string[] = []
  const out = { ...c } as ResolvedCoordinates
  if (c.during) {
    const r = resolveSpan(c.during as any, today, grains)
    out.during = { from: r.from, to: r.to }
    if (r.said) caveats.push(`${r.said}: ${r.from} to ${addDays(r.to, -1)}`)
  }
  if (c.at) {
    const r = resolveInstant(c.at as any, today, grains)
    out.at = r.at
    if (r.said) caveats.push(`${r.said}: ${r.at}`)
  }
  if (c.compare && 'during' in c.compare) {
    const r = resolveSpan(c.compare.during as any, today, grains)
    out.compare = { during: { from: r.from, to: r.to } }
    if (r.said) caveats.push(`compared with ${r.said}: ${r.from} to ${addDays(r.to, -1)}`)
  }
  if (c.compare && 'at' in c.compare) {
    const r = resolveInstant(c.compare.at as any, today, grains)
    out.compare = { at: r.at }
    if (r.said) caveats.push(`compared with ${r.said}: ${r.at}`)
  }
  return { coordinates: out, caveats }
}
