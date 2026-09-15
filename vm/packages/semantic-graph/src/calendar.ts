// ── CALENDARS: WHICH PERIOD A DAY BELONGS TO ────────────────────────────────────────────────────────────────
//
// A calendar object of the schema is one way of cutting time. Its elements are generated from their keys, never
// listed as data, and every function here gives the same answer JavaScript-side and — through the dialect — SQL-side.
//
//   built in   day 2026-09-14 · week 2026-09-14 (its Monday) · month 2026-09 · quarter 2026-Q3 · year 2026
//   fiscal     { fiscal: 'year' | 'quarter' | 'month', startMonth }: FY2027, FY2027-Q1, FY2027-P01 — a fiscal year is
//              named by the calendar year it ends in
//   listed     { periods: [{ label, from, to }] }: a retailer's 4-4-5 months, a country's own quarters — contiguous
//
// A rollup from one calendar to another holds only if every period of the first lies inside one period of the second:
// a week is not inside a month, so there is no arrow from Week to Month, and the schema says so.

export type BuiltIn = 'day' | 'week' | 'month' | 'quarter' | 'year'
export const BUILT_IN: BuiltIn[] = ['day', 'week', 'month', 'quarter', 'year']

export interface CalendarDef {
  level?: string
  fiscal?: { period: 'year' | 'quarter' | 'month'; startMonth: number }
  periods?: Array<{ label: string; from: string; to: string }>
}

const utc = (d: string) => new Date(d + 'T00:00:00Z')
const iso = (d: Date) => d.toISOString().slice(0, 10)
export const addDays = (d: string, n: number) => { const x = utc(d); x.setUTCDate(x.getUTCDate() + n); return iso(x) }
export const addMonths = (d: string, n: number) => { const [y, m] = d.split('-').map(Number); return iso(new Date(Date.UTC(y, m - 1 + n, 1))) }
const pad = (n: number) => String(n).padStart(2, '0')

export const builtIn = (c: CalendarDef): BuiltIn | undefined => (!c.fiscal && !c.periods && BUILT_IN.includes(c.level as BuiltIn) ? c.level as BuiltIn : undefined)

/** What is wrong with a calendar's definition, or null. */
export function calendarProblem(c: CalendarDef): string | null {
  if (c.fiscal) {
    if (!['year', 'quarter', 'month'].includes(c.fiscal.period)) return 'a fiscal calendar cuts time into years, quarters or months'
    if (!Number.isInteger(c.fiscal.startMonth) || c.fiscal.startMonth < 1 || c.fiscal.startMonth > 12) return 'a fiscal year starts in a month from 1 to 12'
    return null
  }
  if (c.periods) {
    if (!c.periods.length) return 'a listed calendar lists at least one period'
    for (const [i, p] of c.periods.entries()) {
      if (!p.label || !/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to) || p.from >= p.to) return `period ${i + 1} needs a label, and a from before its to`
      if (i && c.periods[i - 1].to !== p.from) return `periods must be contiguous: ${c.periods[i - 1].label} ends ${c.periods[i - 1].to}, ${p.label} starts ${p.from}`
    }
    if (new Set(c.periods.map((p) => p.label)).size !== c.periods.length) return 'each listed period has its own label'
    return null
  }
  return builtIn(c) ? null : `a calendar is built in (${BUILT_IN.join(', ')}), fiscal, or a list of periods`
}

/** The key of the period a day is in. */
export function keyOf(c: CalendarDef, day: string): string {
  const b = builtIn(c)
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7))
  if (b === 'day') return day.slice(0, 10)
  if (b === 'week') return addDays(day, -((utc(day).getUTCDay() + 6) % 7))
  if (b === 'month') return day.slice(0, 7)
  if (b === 'quarter') return `${y}-Q${Math.floor((m - 1) / 3) + 1}`
  if (b === 'year') return String(y)
  if (c.fiscal) {
    const into = (m - c.fiscal.startMonth + 12) % 12
    const fy = (m >= c.fiscal.startMonth ? y : y - 1) + (c.fiscal.startMonth === 1 ? 0 : 1)
    return c.fiscal.period === 'year' ? `FY${fy}` : c.fiscal.period === 'quarter' ? `FY${fy}-Q${Math.floor(into / 3) + 1}` : `FY${fy}-P${pad(into + 1)}`
  }
  const p = c.periods!.find((x) => x.from <= day && day < x.to)
  if (!p) throw new RangeError(`${day} is outside the periods the calendar lists`)
  return p.label
}

/** A period's first day and the day after its last. */
export function periodOf(c: CalendarDef, key: string): { from: string; to: string } {
  const b = builtIn(c)
  if (b === 'day') return { from: key, to: addDays(key, 1) }
  if (b === 'week') return { from: key, to: addDays(key, 7) }
  if (b === 'month') { const from = `${key}-01`; return { from, to: addMonths(from, 1) } }
  if (b === 'quarter') { const from = `${key.slice(0, 4)}-${pad(3 * Number(key.slice(6)) - 2)}-01`; return { from, to: addMonths(from, 3) } }
  if (b === 'year') return { from: `${key}-01-01`, to: `${Number(key) + 1}-01-01` }
  if (c.fiscal) {
    const fy = Number(key.slice(2, 6))
    const yearStart = `${fy - (c.fiscal.startMonth === 1 ? 0 : 1)}-${pad(c.fiscal.startMonth)}-01`
    if (c.fiscal.period === 'year') return { from: yearStart, to: addMonths(yearStart, 12) }
    const index = Number(key.slice(8)) - 1
    const size = c.fiscal.period === 'quarter' ? 3 : 1
    const from = addMonths(yearStart, index * size)
    return { from, to: addMonths(from, size) }
  }
  const p = c.periods!.find((x) => x.label === key)
  if (!p) throw new RangeError(`the calendar lists no period ${key}`)
  return { from: p.from, to: p.to }
}

/** Whether a day is the first day of a period. */
export const startsPeriod = (c: CalendarDef, day: string) => { try { return periodOf(c, keyOf(c, day)).from === day } catch { return false } }

/** Whether a day is the day after a period's last — where a span may end. */
export const endsPeriod = (c: CalendarDef, day: string) => { try { return periodOf(c, keyOf(c, addDays(day, -1))).to === day } catch { return false } }

/** The key `n` periods after (or before, negative) a key. */
export function shiftPeriods(c: CalendarDef, key: string, n: number): string {
  if (c.periods) {
    const i = c.periods.findIndex((p) => p.label === key) + n
    if (i < 0 || i >= c.periods.length) throw new RangeError(`${n} periods from ${key} is outside the periods the calendar lists`)
    return c.periods[i].label
  }
  const b = builtIn(c)
  const from = periodOf(c, key).from
  if (b === 'day') return keyOf(c, addDays(from, n))
  if (b === 'week') return keyOf(c, addDays(from, 7 * n))
  return keyOf(c, addMonths(from, n * monthsIn(c)!))
}

/** How many months one period is, when every period is a whole number of months. */
export function monthsIn(c: CalendarDef): number | undefined {
  const size = { month: 1, quarter: 3, year: 12 } as Record<string, number>
  return c.fiscal ? size[c.fiscal.period] : size[builtIn(c) ?? '']
}

/** The periods that meet [from, to). */
export function periodsBetween(c: CalendarDef, from: string, to: string): Array<{ key: string; from: string; to: string }> {
  if (c.periods) return c.periods.filter((p) => p.from < to && p.to > from).map((p) => ({ key: p.label, from: p.from, to: p.to }))
  const out: Array<{ key: string; from: string; to: string }> = []
  for (let key = keyOf(c, from); ; key = shiftPeriods(c, key, 1)) {
    const p = periodOf(c, key)
    if (p.from >= to) break
    out.push({ key, ...p })
  }
  return out
}

/** Whether every period of `fine` lies inside one period of `coarse` — the condition for a rollup arrow between them. */
export function nests(fine: CalendarDef, coarse: CalendarDef): boolean {
  if (builtIn(fine) === 'day') return true
  const [from, to] = fine.periods ? [fine.periods[0].from, fine.periods.at(-1)!.to] : coarse.periods ? [coarse.periods[0].from, coarse.periods.at(-1)!.to] : ['2000-01-01', '2041-01-01']
  return periodsBetween(fine, from, to).every((p) => {
    try { const k = keyOf(coarse, p.from); return keyOf(coarse, addDays(p.to, -1)) === k } catch { return false }
  })
}
