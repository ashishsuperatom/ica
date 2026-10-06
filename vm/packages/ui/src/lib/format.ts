// Values the way this organisation reads them: money in its currency at one compact scale, shares as percent, hours,
// counts. Every renderer formats through `fmt(value, unit)`, so a unit reads the same in a tile, a cell and a bar label.
// The locale and currency are the project's, from its catalog (`configure`); until it arrives, plain defaults.

let LOCALE = 'en-AU'
let CURRENCY = 'AUD'
let N0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })
let N1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 })
let PCT1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** Read numbers, dates and money as the project does. */
export function configure({ locale, currency }: { locale?: string; currency?: string }) {
  if (locale) { try { new Intl.NumberFormat(locale); LOCALE = locale } catch { /* an unknown locale keeps the default */ } }
  if (currency) CURRENCY = currency.toUpperCase()
  N0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })
  N1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 })
  PCT1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** A number, or null when the value is not one — "null", "NaN" and "[object Object]" never reach a reader. */
export const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Money, compact, in the project's currency (or the one named): rupees in crore and lakh (₹1.2 Cr, ₹34.5 L, ₹9,800);
 *  other currencies in thousands, millions and billions (A$1.2M, A$340K). Negative keeps its sign. */
export function money(v: unknown, currency: string = CURRENCY): string {
  const n = asNumber(v)
  if (n === null) return '—'
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  const CURRENCY = currency
  if (CURRENCY === 'INR') {
    if (a >= 1e7) return `${sign}₹${N1.format(a / 1e7)} Cr`
    if (a >= 1e5) return `${sign}₹${N1.format(a / 1e5)} L`
    return `${sign}₹${N0.format(a)}`
  }
  const sym = CURRENCY === 'AUD' ? 'A$' : CURRENCY === 'USD' ? '$' : CURRENCY === 'NZD' ? 'NZ$' : `${CURRENCY} `
  if (a >= 1e9) return `${sign}${sym}${N1.format(a / 1e9)}B`
  if (a >= 1e6) return `${sign}${sym}${N1.format(a / 1e6)}M`
  if (a >= 1e3) return `${sign}${sym}${N0.format(a / 1e3)}K`
  return `${sign}${sym}${N0.format(a)}`
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
  if (unit === 'money') return money(n).replace('A$', '$')
  if (CURRENCY === 'INR' && Math.abs(n) >= 1e5) return Math.abs(n) >= 1e7 ? `${N1.format(n / 1e7)} Cr` : `${N1.format(n / 1e5)} L`
  if (unit === 'ratio') return `${Math.round(n * 100)}%`
  return Math.abs(n) >= 1000 ? `${N1.format(n / 1000)}K` : N1.format(n)
}

/** Whether a unit is a figure (read right-aligned) rather than words. */
export const numeric = (unit: string | undefined): boolean => unit !== undefined && unit !== 'text' && unit !== 'date'
