// ── CALENDARS: WHICH PERIOD A DATE BELONGS TO ─────────────────────────────────────────────────────────────
//
// Day, week, month, quarter and year are built in. Every other way of cutting time — a fiscal year starting in
// April, a retailer's 4-4-5 weeks, a country's own quarters — is a CALENDAR: data the organisation supplies, not
// code in the engine. This is the role of Kimball's date dimension; here a calendar grain is either a rule (a
// fiscal year from its first month) or the periods themselves, listed.
//
//   { "fiscal_quarter": { "fiscal": "quarter", "startMonth": 4 },
//     "retail_month":   { "periods": [{ "label": "R2026-01", "from": "2026-02-01", "to": "2026-03-01" }, ...] } }
//
// A calendar reaches a request as the assumption named `calendar` — from the caller, or the organisation, and as
// rules if it differs by who is asking — so two organisations, or two countries in one, can each have their own.
//
// Every grain is computed here, once, for both sides: the labels JavaScript gives a period are the labels SQL
// gives it. A custom grain reaches SQL as a CASE over its periods in the span asked about, which any dialect runs.

import type { SqlDialect } from './coordinates.js'

export const BUILT_IN = ['day', 'week', 'month', 'quarter', 'year'] as const
export type BuiltInGrain = typeof BUILT_IN[number]

export type CalendarGrain =
  /** A fiscal year beginning in `startMonth` (1–12). The year is named by the calendar year it ends in, unless
   *  `label` is 'start'. Labels: FY2027, FY2027-Q1, FY2027-P01. */
  | { fiscal: 'year' | 'quarter' | 'month'; startMonth: number; label?: 'end' | 'start' }
  /** The periods themselves: `from` inclusive, `to` exclusive, contiguous. */
  | { periods: Array<{ label: string; from: string; to: string }> }
export type Calendar = Record<string, CalendarGrain>

export interface Period { label: string; start: string; end: string }

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(`${s}T00:00:00Z`)
export const addDays = (s: string, n: number) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d) }
const addMonths = (s: string, n: number) => { const d = utc(s); d.setUTCMonth(d.getUTCMonth() + n); return iso(d) }
const dateOk = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)

export class Grains {
  constructor(private readonly calendar: Calendar = {}) {}

  static builtIn(name: string): name is BuiltInGrain { return (BUILT_IN as readonly string[]).includes(name) }
  has(name: string): boolean { return Grains.builtIn(name) || name in this.calendar }
  names(): string[] { return [...BUILT_IN, ...Object.keys(this.calendar)] }

  /** Why the calendar cannot be used, or null. */
  problem(): string | null {
    for (const [name, g] of Object.entries<any>(this.calendar)) {
      if (Grains.builtIn(name)) return `calendar grain "${name}" would replace a built-in grain`
      if (!/^[a-z][a-z0-9_]*$/.test(name)) return `calendar grain "${name}" must be a lower-case identifier`
      if ('fiscal' in g) {
        if (!['year', 'quarter', 'month'].includes(g.fiscal)) return `calendar grain "${name}": fiscal must be year, quarter or month`
        if (!Number.isInteger(g.startMonth) || g.startMonth < 1 || g.startMonth > 12) return `calendar grain "${name}": startMonth must be 1 to 12`
      } else if (Array.isArray(g.periods)) {
        const ps = [...g.periods].sort((a, b) => a.from.localeCompare(b.from))
        for (const [i, p] of ps.entries()) {
          if (!p.label || !dateOk(p.from) || !dateOk(p.to) || p.from >= p.to) return `calendar grain "${name}": each period needs a label, and from before to`
          if (i && ps[i - 1].to !== p.from) return `calendar grain "${name}": periods must be contiguous — ${ps[i - 1].label} ends ${ps[i - 1].to}, ${p.label} starts ${p.from}`
        }
      } else return `calendar grain "${name}" must be { fiscal, startMonth } or { periods }`
    }
    return null
  }

  /** The first day of the period a date belongs to. */
  startOf(name: string, date: string): string {
    if (Grains.builtIn(name)) return builtInStart(name, date)
    const g = this.calendar[name]
    if ('fiscal' in g) {
      const months = { month: 1, quarter: 3, year: 12 }[g.fiscal]
      const d = utc(date)
      const intoYear = (d.getUTCMonth() + 1 - g.startMonth + 12) % 12
      return addMonths(`${date.slice(0, 7)}-01`, -(intoYear % months))
    }
    const p = g.periods.find((x) => x.from <= date && date < x.to)
    if (!p) throw new Error(`${date} is outside calendar grain "${name}"`)
    return p.from
  }

  /** The first day of the period after the one a date belongs to. */
  nextStart(name: string, date: string): string {
    const start = this.startOf(name, date)
    if (Grains.builtIn(name)) {
      if (name === 'day') return addDays(start, 1)
      if (name === 'week') return addDays(start, 7)
      return addMonths(start, name === 'month' ? 1 : name === 'quarter' ? 3 : 12)
    }
    const g = this.calendar[name]
    if ('fiscal' in g) return addMonths(start, { month: 1, quarter: 3, year: 12 }[g.fiscal])
    return g.periods.find((x) => x.from === start)!.to
  }

  labelOf(name: string, date: string): string {
    if (Grains.builtIn(name)) return builtInLabel(name, date)
    const g = this.calendar[name]
    if ('fiscal' in g) {
      const d = utc(date)
      const month = d.getUTCMonth() + 1, year = d.getUTCFullYear()
      const intoYear = (month - g.startMonth + 12) % 12
      const startsYear = month >= g.startMonth ? year : year - 1
      const fy = g.label === 'start' || g.startMonth === 1 ? startsYear : startsYear + 1
      if (g.fiscal === 'year') return `FY${fy}`
      if (g.fiscal === 'quarter') return `FY${fy}-Q${Math.floor(intoYear / 3) + 1}`
      return `FY${fy}-P${String(intoYear + 1).padStart(2, '0')}`
    }
    const p = g.periods.find((x) => x.from <= date && date < x.to)
    if (!p) throw new Error(`${date} is outside calendar grain "${name}"`)
    return p.label
  }

  /** The first day of the period with this label. */
  startOfLabel(name: string, label: string, near: { from: string; to: string }): string {
    const found = this.periods(name, addDays(near.from, -400), addDays(near.to, 400)).find((p) => p.label === label)
    if (!found) throw new Error(`no ${name} period labelled ${label}`)
    return found.start
  }

  /** Every period that begins before `to` and ends after `from`, each with its last day inside the span. */
  periods(name: string, from: string, to: string): Period[] {
    const out: Period[] = []
    let s = this.covers(name, from) ? this.startOf(name, from) : null
    if (s === null) {
      const g = this.calendar[name] as { periods: Array<{ from: string }> }
      s = g.periods.map((p) => p.from).sort().find((f) => f > from && f < to) ?? null
      if (s === null) return out
    }
    for (; s < to; ) {
      if (!this.covers(name, s)) break
      const next = this.nextStart(name, s)
      const last = addDays(next, -1)
      out.push({ label: this.labelOf(name, s), start: s, end: last < to ? last : addDays(to, -1) })
      s = next
    }
    return out
  }

  /** Whether the grain says which period a date belongs to. Built-in and fiscal grains always do. */
  covers(name: string, date: string): boolean {
    const g = this.calendar[name]
    return !g || !('periods' in g) || g.periods.some((x) => x.from <= date && date < x.to)
  }

  /** The label of a date column's period, in SQL. */
  sql(name: string, column: string, s: SqlDialect, span: { from: string; to: string }): string {
    if (Grains.builtIn(name)) return s.period(name, column)
    const ps = this.periods(name, span.from, span.to)
    const quote = (x: string) => `'${x.replace(/'/g, "''")}'`
    const cases = ps.map((p) => `WHEN ${column} >= ${s.dateLiteral(p.start)} AND ${column} < ${s.dateLiteral(this.nextStart(name, p.start))} THEN ${quote(p.label)}`)
    return `CASE ${cases.join(' ')} END`
  }
}

function builtInLabel(grain: BuiltInGrain, date: string): string {
  const d = utc(date)
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1
  if (grain === 'day') return date
  if (grain === 'week') return addDays(date, -((d.getUTCDay() + 6) % 7))
  if (grain === 'month') return `${y}-${String(m).padStart(2, '0')}`
  if (grain === 'quarter') return `${y}-Q${Math.floor((m + 2) / 3)}`
  return String(y)
}

function builtInStart(grain: BuiltInGrain, date: string): string {
  const label = builtInLabel(grain, date)
  if (grain === 'day' || grain === 'week') return label
  if (grain === 'month') return `${label}-01`
  if (grain === 'quarter') return `${label.slice(0, 4)}-${String((Number(label.slice(-1)) - 1) * 3 + 1).padStart(2, '0')}-01`
  return `${label}-01-01`
}

/** The built-in periods of a span — the calendar every organisation shares. */
export const periods = (grain: BuiltInGrain, from: string, to: string) => new Grains().periods(grain, from, to)
