// A window is the time a focus is over: a parameter of the question, never a filter. Each kind knows how to say
// itself, how to check what it is given, and how to become a span for a day called today. A kind that stands on the
// organisation's financial calendar (the financial year) is given the model, which carries that calendar.

const pad = (n) => String(n).padStart(2, '0')
export const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
export const day = (s) => new Date(`${s}T00:00:00Z`)
export const addDays = (s, n) => { const d = day(s); d.setUTCDate(d.getUTCDate() + n); return iso(d) }
/** The Monday of the week a day is in. */
export const monday = (s) => { const d = day(s); const off = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - off); return iso(d) }
export const monthOf = (s) => s.slice(0, 7)
export const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}` }
export const monthWords = (ym) => day(`${ym}-01`).toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const isMonth = (s) => /^\d{4}-\d{2}$/.test(String(s))
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(day(s).getTime())
const dayWords = (s, o) => day(s).toLocaleDateString('en-AU', { timeZone: 'UTC', ...o })

/** "6–12 Apr 2026" · "28 Sep – 4 Oct 2026" · "29 Dec 2025 – 4 Jan 2026" · one day: "6 Apr 2026". */
export const rangeWords = (from, through) => {
  if (from === through) return dayWords(from, { day: 'numeric', month: 'short', year: 'numeric' })
  const a = day(from), b = day(through)
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${dayWords(from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${dayWords(through, { day: 'numeric', month: 'short', year: 'numeric' })}`
  if (a.getUTCMonth() !== b.getUTCMonth()) return `${dayWords(from, { day: 'numeric', month: 'short' })} – ${dayWords(through, { day: 'numeric', month: 'short', year: 'numeric' })}`
  return `${a.getUTCDate()}–${dayWords(through, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

/**
 * The financial calendars, from the month a financial year starts in (the setting financial-year-first-month): the
 * years around today and their months, each { label, from, to } with `to` the first day after. A year that starts in
 * January is named by that year ("FY 2026"); one that starts later by both years ("FY 2025-26").
 */
/** A financial month's name: three letters and the year ("Sep 2026"), the same in every locale. */
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const financialMonth = (ym) => `${SHORT[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`

export function financialCalendars(firstMonth, today) {
  const m0 = Number(firstMonth)
  if (!Number.isInteger(m0) || m0 < 1 || m0 > 12) throw new Error(`financial-year-first-month is a month from 1 to 12, not ${firstMonth}`)
  const y = Number(today.slice(0, 4)), years = [], months = []
  for (let start = y - 12; start <= y + 5; start++) {
    const from = `${start}-${pad(m0)}-01`, to = `${start + 1}-${pad(m0)}-01`
    years.push({ label: m0 === 1 ? `FY ${start}` : `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`, from, to })
    for (let i = 0; i < 12; i++) { const ym = addMonths(`${start}-${pad(m0)}`, i); months.push({ label: financialMonth(ym), from: `${ym}-01`, to: `${addMonths(ym, 1)}-01` }) }
  }
  return { FinancialYear: years, FinancialMonth: months }
}

/** The financial calendars the model carries: [{ label, from, to }]. */
const fiscalPeriods = (model) => model?.calendars?.FinancialYear ?? []
const fiscalMonths = (model) => model?.calendars?.FinancialMonth ?? []
// A year by its name ("FY 2025-26"), or by the calendar year it starts in ("2025") — a plain year a link or a person may give.
const fiscalOf = (model, label) => fiscalPeriods(model).find((p) => p.label === String(label)) ?? (/^\d{4}$/.test(String(label)) ? fiscalPeriods(model).find((p) => p.from.startsWith(`${label}-`)) : undefined)
const fiscalContaining = (model, today) => fiscalPeriods(model).find((p) => p.from <= today && today < p.to)

export const WINDOWS = {
  /** Whole months, named. */
  months: {
    check: (w) => (!Array.isArray(w.months) || !w.months.length || !w.months.every(isMonth)) ? 'a months window is a list of months like 2026-10' : null,
    words: (w) => w.months.length === 1 ? monthWords(w.months[0]) : `${monthWords(w.months[0])} – ${monthWords(w.months[w.months.length - 1])}`,
    span: (w) => { const ms = [...w.months].sort(); return { from: `${ms[0]}-01`, to: `${addMonths(ms[ms.length - 1], 1)}-01` } },
    default: (today) => ({ months: [0, 1, 2, 3].map((n) => addMonths(monthOf(today), n)) }),
    periods: (w) => [...w.months].sort(),
  },
  /** Whole weeks around the current one — which is excluded: a week half-lived reads as neither. */
  weeks: {
    check: (w) => (!Number.isInteger(w.past) || !Number.isInteger(w.future) || w.past < 0 || w.future < 0 || w.past + w.future === 0) ? 'a weeks window is { past, future }, whole weeks either side of this one' : null,
    words: (w) => `${w.past} past and ${w.future} future weeks`,
    span: (w, today) => { const m = monday(today); return { from: addDays(m, -7 * w.past), to: addDays(m, 7 * (w.future + 1)) } },
    default: () => ({ past: 4, future: 4 }),
    periods: (w, today) => { const m = monday(today); const out = []; for (let i = -w.past; i <= w.future; i++) if (i !== 0) out.push(addDays(m, 7 * i)); return out },
    current: (today) => monday(today),
  },
  /** The next so-many days, from today. */
  days: {
    check: (w) => (!Number.isInteger(w.days) || w.days <= 0) ? 'a days window is { days }, a positive number' : null,
    words: (w) => `next ${w.days} days`,
    span: (w, today) => ({ from: today, to: addDays(today, w.days) }),
    default: () => ({ days: 30 }),
  },
  /** The last so-many days, through today. */
  pastDays: {
    check: (w) => (!Number.isInteger(w.days) || w.days <= 0) ? 'a past-days window is { days }, a positive number' : null,
    words: (w) => `last ${w.days} days`,
    span: (w, today) => ({ from: addDays(today, -w.days), to: addDays(today, 1) }),
    default: () => ({ days: 30 }),
  },
  /** Whole days, from one through another: the week's timesheets, a fortnight, one day. */
  range: {
    check: (w) => (!isDay(w.from) || !isDay(w.through)) ? 'a range window is { from, through }, days like 2026-04-06' : w.from > w.through ? 'a range runs from an earlier day through a later one' : addDays(w.from, 366) < w.through ? 'a range is at most a year' : (w.compare !== undefined && typeof w.compare !== 'boolean') ? 'compare is on or off' : null,
    /** `compare: true` — the same span one period back comes beside each figure. */
    words: (w) => `${rangeWords(w.from, w.through)}${w.compare ? ' vs the period before' : ''}${w.said ? ` · ${w.said}` : ''}`,
    span: (w) => ({ from: w.from, to: addDays(w.through, 1) }),
    /** The last complete week, Monday through Sunday before the current one: a root never opens on days that
     * are still being lived — the current week is a preset, one click away. */
    default: (today) => ({ from: addDays(monday(today), -7), through: addDays(monday(today), -1) }),
    periods: (w) => { const out = []; for (let d = w.from; d <= w.through; d = addDays(d, 1)) out.push(d); return out },
  },
  /**
   * A financial year, by its name in the organisation's financial calendar ("FY 2025-26", or "FY 2026" for a year that
   * starts in January): its own bounds, from the setting financial-year-first-month. The periods inside it are its months.
   */
  fiscal: {
    check: (w, model) => (w.year !== undefined && !fiscalOf(model, w.year)) ? `there is no financial year called "${w.year}"${fiscalPeriods(model).length ? `: the years run from ${fiscalPeriods(model)[0].label} to ${fiscalPeriods(model)[fiscalPeriods(model).length - 1].label}` : ''}` : null,
    words: (w) => String(w.year),
    /** A year given by the calendar year it starts in, named as the calendar names it. */
    normalise: (w, model) => ({ ...w, ...(w.year !== undefined && fiscalOf(model, w.year) ? { year: fiscalOf(model, w.year).label } : {}) }),
    span: (w, today, model) => { const p = fiscalOf(model, w.year); return p ? { from: p.from, to: p.to } : { from: `${today.slice(0, 4)}-01-01`, to: `${Number(today.slice(0, 4)) + 1}-01-01` } },
    default: (today, model) => ({ year: fiscalContaining(model, today)?.label ?? `FY ${today.slice(0, 4)}` }),
    /** The financial months of the year, in period order (the calendar may list them in another order). */
    periods: (w, today, model) => { const p = fiscalOf(model, w.year); return p ? fiscalMonths(model).filter((m) => m.from >= p.from && m.to <= p.to).sort((a, b) => (a.from < b.from ? -1 : 1)).map((m) => m.label) : [] },
    /** Every financial month, in period order, for sorting rows by it. */
    order: (model) => new Map(fiscalMonths(model).slice().sort((a, b) => (a.from < b.from ? -1 : 1)).map((m, i) => [m.label, i])),
  },
}
