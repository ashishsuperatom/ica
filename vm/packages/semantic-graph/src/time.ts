// ── TIME AS PEOPLE ASK IT: RELATIVE SPANS, TODAY WHERE THEY ARE, MOMENTS INTO DAYS ─────────────────────────────
//
// People ask relative to now: "this quarter", "the previous three months", "the last 30 days". Each relative span is
// resolved against the day the question is answered as of — recorded with the answer, so a replay a month later means
// the same days — and against the schema's own calendars, so "this quarter" is a fiscal quarter where the organisation
// has one. The dates it resolved to are stated with the answer.
//
//   { this: 'Quarter' }                   the current period of that calendar, whole
//   { this: 'Quarter', toDate: true }     the current period up to and including today
//   { previous: 'Month', count: 3 }       the three whole periods before the current one
//   { last: 30, unit: 'Day' }             a span of that many periods ending with the current one, today included
//
// TODAY is the date where the person asking is: at 9am in Auckland it is still yesterday in London. The zone is the
// setting named `timezone`. A column of calendar dates is never moved: 14 September is that day everywhere. A column of
// MOMENTS is written in a zone (its source says which), and is moved into the asker's zone before it is placed in a day —
// by the offset in force at each moment, so a span across a daylight-saving change is exact on every dialect.

import { addDays, builtIn, keyOf, periodOf, shiftPeriods, type CalendarDef } from './calendar.js'
import type { Question } from './algebra.js'
import type { Schema } from './schema.js'

export type RelativeSpan = { this: string; toDate?: boolean } | { previous: string; count?: number } | { last: number; unit: string }
/** A span as asked: the first and last day (`through`), days with the day after the last (`to`), or relative to today. */
export type SpanAsked = { from: string; to: string } | { from: string; through: string } | RelativeSpan
export type QuestionAsked = Omit<Question, 'span'> & { span?: SpanAsked }

const isDates = (s: SpanAsked): s is { from: string; to: string } => typeof (s as any).from === 'string' && typeof (s as any).to === 'string'

export function resolveSpan(s: Schema, span: SpanAsked, today: string): { span: { from: string; to: string }; said?: string } {
  if (isDates(span)) return { span }
  if ('through' in span) return { span: { from: span.from, to: addDays(span.through, 1) } }
  const cal = (name: string): CalendarDef => {
    const o = s.objects[name]
    if (o?.kind !== 'calendar') throw new Error(`"${name}" is not a calendar of the schema — its calendars are ${Object.entries(s.objects).filter(([, x]) => x.kind === 'calendar').map(([n]) => n).join(', ')}`)
    return o
  }
  let out: { from: string; to: string }
  let said: string
  if ('this' in span) {
    const c = cal(span.this), p = periodOf(c, keyOf(c, today))
    out = { from: p.from, to: span.toDate ? addDays(today, 1) : p.to }
    said = `this ${span.this}${span.toDate ? ' to date' : ''}`
  } else if ('previous' in span) {
    const c = cal(span.previous), n = span.count ?? 1
    if (!Number.isInteger(n) || n < 1) throw new Error('the previous periods are counted from 1')
    const current = keyOf(c, today)
    out = { from: periodOf(c, shiftPeriods(c, current, -n)).from, to: periodOf(c, current).from }
    said = `the previous ${n === 1 ? span.previous : `${n} ${span.previous} periods`}`
  } else {
    const c = cal(span.unit)
    if (!Number.isInteger(span.last) || span.last < 1) throw new Error('the last periods are counted from 1')
    if (builtIn(c) === 'day') out = { from: addDays(today, 1 - span.last), to: addDays(today, 1) }
    else { const current = keyOf(c, today); out = { from: periodOf(c, shiftPeriods(c, current, 1 - span.last)).from, to: addDays(today, 1) } }
    said = `the last ${span.last} ${span.unit} periods`
  }
  return { span: out, said: `${said} is ${out.from} to ${addDays(out.to, -1)}` }
}

// ── zones ──

export function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true } catch { return false }
}

/** The date in a zone at an instant. */
export function dayIn(zone: string, instant = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** Minutes a zone is ahead of UTC at an instant. */
export function offsetMinutes(zone: string, instant: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(instant).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second))
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000)
}

/** A stretch of time over which moments written in one zone are a fixed number of minutes from the asker's zone.
 *  `until` is the first moment of the next stretch, written as local time in the source's zone; absent for the last. */
export interface Stretch { minutes: number; until?: string }

const local = (zone: string, instant: Date) => new Date(instant.getTime() + offsetMinutes(zone, instant) * 60000).toISOString().slice(0, 19).replace('T', ' ')

/** The stretches between two days (a day either side included) in which the difference between the zones is constant. */
export function stretches(from: string, to: string, sourceZone: string, askerZone: string): Stretch[] {
  const diff = (t: number) => offsetMinutes(askerZone, new Date(t)) - offsetMinutes(sourceZone, new Date(t))
  const start = Date.parse(addDays(from, -1) + 'T00:00:00Z'), end = Date.parse(addDays(to, 1) + 'T00:00:00Z')
  const out: Stretch[] = []
  let t = start, current = diff(t)
  for (let next = t + 3600_000; next <= end; t = next, next += 3600_000) {
    const d = diff(next)
    if (d === current) continue
    // The change lies within this hour; find its minute.
    let lo = t, hi = next
    while (hi - lo > 60_000) { const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000; if (diff(mid) === current) lo = mid; else hi = mid }
    out.push({ minutes: current, until: local(sourceZone, new Date(hi)) })
    current = d
  }
  out.push({ minutes: current })
  return out
}
