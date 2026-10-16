// Values the way this organisation reads them: money in its currency at one compact scale, shares as percent, hours,
// counts. Every renderer formats through `fmt(value, unit)`, so a unit reads the same in a tile, a cell and a bar label.
// How it reads is the project's configuration (`configure`, platform-types configuration.ts); until it is given, the
// neutral reading — plain forms, no currency symbol. Nothing about a place is built in: the symbols, the scales (lakh and
// crore, thousand and million) and the separators are the locale's, through Intl.

let LOCALE = 'en'
let CURRENCY: string | null = null
let N0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })
let N1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 })
let PCT1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const compact = new Map<string, Intl.NumberFormat>()

/** Read numbers, dates and money as the project does (its configuration's locale and currency; null: none). */
export function configure({ locale, currency }: { locale?: string; currency?: string | null }) {
  if (locale) { try { new Intl.NumberFormat(locale); LOCALE = locale } catch { /* an unknown locale keeps the one before */ } }
  if (currency !== undefined) CURRENCY = currency ? currency.toUpperCase() : null
  N0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })
  N1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 })
  PCT1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  compact.clear()
}

/** A number, or null when the value is not one — "null", "NaN" and "[object Object]" never reach a reader. */
export const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Money, compact, in the project's currency (or the one named), as its locale writes it: ₹54.4L and ₹1.23Cr in en-IN,
 *  $5.44M in en-AU, A$5.44M where Australian dollars are foreign. No currency configured: the amount alone (5.44M). */
export function money(v: unknown, currency: string | null = CURRENCY): string {
  const n = asNumber(v)
  if (n === null) return '—'
  const key = `${LOCALE}|${currency ?? ''}`
  let f = compact.get(key)
  if (!f) {
    try { f = new Intl.NumberFormat(LOCALE, { ...(currency ? { style: 'currency', currency } : {}), notation: 'compact', maximumSignificantDigits: 3 }) }
    catch { f = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumSignificantDigits: 3 }) }   // an unknown currency: the amount alone
    compact.set(key, f)
  }
  return f.format(n).replace('-', '−')
}

/** Money in full — every unit, the locale's separators, the project's currency (or the one named): a unit price, an
 *  amount that must be exact (₹1,23,456 in en-IN, $123,456 in en-AU). No currency configured: the amount alone. */
export function moneyExact(v: unknown, currency: string | null = CURRENCY): string {
  const n = asNumber(v)
  if (n === null) return '—'
  try { return new Intl.NumberFormat(LOCALE, { ...(currency ? { style: 'currency', currency } : {}), maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 }).format(n).replace('-', '−') }
  catch { return N0.format(n) }
}

/** A ratio as percent, one decimal: 0.5701 → 57.0%. */
export function ratio(v: unknown): string {
  const n = asNumber(v)
  if (n === null) return '—'
  return `${PCT1.format(n * 100)}%`
}

export function date(v: unknown): string {
  if (typeof v !== 'string' || !v) return '—'
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** A day as "24 Aug" — a column header for a week. */
export function shortDate(v: string): string {
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** A month "2026-10" as "Oct 2026"; anything else as it is. */
export function month(v: string): string {
  if (!/^\d{4}-\d{2}$/.test(v)) return v
  const d = new Date(`${v}-01T00:00:00Z`)
  return d.toLocaleDateString(LOCALE, { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

const count = (v: unknown, word: string): string => {
  const n = asNumber(v)
  if (n === null) return '—'
  return `${N0.format(n)} ${word}`
}

/** Anything at all as text a reader can see; an object or an absence reads as a dash. */
export function text(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v.trim() || '—'
  if (typeof v === 'number') return Number.isFinite(v) ? N1.format(v) : '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return '—'
}

/** One value in one unit. Unknown units read as numbers or text. */
export function fmt(v: unknown, unit: string | undefined): string {
  switch (unit) {
    case 'money': return money(v)
    case 'ratio': return ratio(v)
    case 'percent': { const n = asNumber(v); return n === null ? '—' : `${n.toFixed(Math.abs(n) < 10 ? 1 : 0)}%` }   // already 0–100
    case 'count': { const n = asNumber(v); return n === null ? '—' : N0.format(n) }   // a plain count: the label says what of
    case 'h': return count(v, 'h')
    case 'people': return count(v, 'people')
    case 'projects': return count(v, 'projects')
    case 'weeks': return count(v, 'weeks')
    case 'days': return count(v, 'days')
    case 'months': return count(v, 'months')
    case 'date': return date(v)
    case 'text': return text(v)
    default: {
      // A currency's code is money in that currency.
      if (unit && /^[A-Z]{3}$/.test(unit)) return money(v, unit)
      // Any other unit is a count or a measure named by its word: 12 bookings, 3.4 t.
      const n = asNumber(v)
      return n === null ? text(v) : unit && /^[a-z ]+$/i.test(unit) ? `${N1.format(n)} ${unit}` : N1.format(n)
    }
  }
}

/** A value on an axis: the same as fmt but without a count's word, so bar labels stay short. */
export function short(v: unknown, unit: string | undefined): string {
  const n = asNumber(v)
  if (n === null) return '—'
  if (unit === 'money') return money(n)
  // a currency named by its code (INR, NZD): that currency, at the locale's own scale
  if (unit && /^[A-Z]{3}$/.test(unit)) return money(n, unit)
  if (unit === 'ratio') return `${Math.round(n * 100)}%`
  if (unit === 'percent') return `${Math.round(n)}%`
  return Math.abs(n) >= 1000 ? money(n, null) : N1.format(n)
}

/** Whether a unit is a figure (read right-aligned) rather than words. */
export const numeric = (unit: string | undefined): boolean => unit !== undefined && unit !== 'text' && unit !== 'date' && unit !== 'spark'
