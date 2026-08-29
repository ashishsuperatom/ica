// Display formatting — OPTIONAL, setting-driven. Programs emit RAW values ({ value, currency, unit }); use these
// only to build a display string. A locale profile picks abbreviation + grouping + symbol, so one org can show
// ₹/lakhs and another $/millions from the SAME raw number:
//   'IN' → lakh/crore, ₹, en-IN   ·   'AU' → K/M, A$, en-AU   ·   'US' → K/M/B, $, en-US
//   money(1234567,'INR') → "₹12.35 Cr"   money(1234567,'AUD') → "A$1.23M"   pct(0.1234) → "12.3%"
// The agent chooses whether to use these at all — a raw number is always fine; these just standardize display.

export type Locale = 'IN' | 'AU' | 'US'
type Profile = { locale: string; sym: Record<string, string>; tiers: [number, string][] }
const PROFILES: Record<Locale, Profile> = {
  IN: { locale: 'en-IN', sym: { INR: '₹' },  tiers: [[1e7, 'Cr'], [1e5, 'L']] },
  AU: { locale: 'en-AU', sym: { AUD: 'A$' }, tiers: [[1e6, 'M'], [1e3, 'K']] },
  US: { locale: 'en-US', sym: { USD: '$' },  tiers: [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] },
}
const localeFor = (currency?: string): Locale => currency === 'INR' ? 'IN' : currency === 'AUD' ? 'AU' : 'US'

/** Abbreviate a number per a locale profile: 1234567 → "1.23M" (US) / "12.35 L" (IN). */
export function abbrev(n: number, loc: Locale = 'US'): string {
  const P = PROFILES[loc], a = Math.abs(n)
  for (const [t, s] of P.tiers) if (a >= t) return `${(n / t).toLocaleString(P.locale, { maximumFractionDigits: 2 })} ${s}`
  return n.toLocaleString(P.locale, { maximumFractionDigits: 0 })
}
/** Money with symbol + abbreviation. Locale defaults from the currency (INR→IN, AUD→AU, else US). */
export function money(value: number, currency = 'USD', loc: Locale = localeFor(currency)): string {
  return (PROFILES[loc].sym[currency] ?? `${currency} `) + abbrev(value, loc)
}
/** A fraction (0.1234) → "12.3%". Pass a whole percent already? divide first. */
export function pct(x: number, digits = 1): string { return `${(x * 100).toFixed(digits)}%` }
/** Grouped integer: 1234567 → "1,234,567" (US) / "12,34,567" (IN). */
export function num(n: number, loc: Locale = 'US'): string { return n.toLocaleString(PROFILES[loc].locale) }
