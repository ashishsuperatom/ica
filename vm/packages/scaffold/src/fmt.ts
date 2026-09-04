// Display formatting — OPTIONAL, setting-driven. Programs emit RAW values ({ value, currency, unit }); use these
// only to build a display string. A locale profile picks abbreviation + grouping + symbol, so one org can show
// ₹/lakhs and another $/millions from the SAME raw number:
//   'IN' → lakh/crore, ₹, en-IN   ·   'AU' → K/M, A$, en-AU   ·   'US' → K/M/B, $, en-US
//   money(1234567,'INR') → "₹12.35 Cr"   money(1234567,'AUD') → "A$1.23M"   pct(0.1234) → "12.3%"
// The agent chooses whether to use these at all — a raw number is always fine; these just standardize display.

export type Locale = 'IN' | 'AU' | 'US'
type Profile = { locale: string; sym: Record<string, string>; tiers: [number, string][] }
// ISO CODES everywhere (no ₹/$/A$ symbols) — clean + unambiguous: "AUD 45.12M", "INR 3.81 Cr", "USD 1.23M".
// The locale still sets grouping + the abbreviation tiers (IN lakh/crore, US/AU K/M/B); only the symbol is dropped.
const PROFILES: Record<Locale, Profile> = {
  IN: { locale: 'en-IN', sym: {}, tiers: [[1e7, 'Cr'], [1e5, 'L']] },
  AU: { locale: 'en-AU', sym: {}, tiers: [[1e6, 'M'], [1e3, 'K']] },
  US: { locale: 'en-US', sym: {}, tiers: [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] },
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

// ── WHAT THE AGENT IS TOLD ABOUT THESE ──────────────────────────────────────────────────────────────────────
// A helper's usage lives WITH the helper. It used to live in a hand-written line of the workspace prompt, which
// meant the two drifted the moment either changed: add a helper and the prompt never learns it, change a
// signature and the prompt describes one that no longer exists.
//
// So the prompt is DERIVED. Adding a helper here is the whole job of teaching the agent about it — and
// fmt.test.ts fails if an exported helper has no entry, so a new one cannot be added silently.
//
// A deployment that needs its own helper (a client's own conversion, a different rounding convention) adds it
// here and it appears in the instructions, with nothing else to remember.
export interface HelperDoc { sig: string; when: string }
export const FORMAT_HELPERS: Record<string, HelperDoc> = {
  money:  { sig: 'money(value, currency?, locale?)', when: 'a currency figure inside PROSE or a headline — the table column says `unit` instead' },
  pct:    { sig: 'pct(fraction, digits?)',           when: 'a fraction as a percentage in prose: 0.1234 → "12.3%"' },
  abbrev: { sig: 'abbrev(n, locale?)',               when: 'a large number shortened per locale: 1234567 → "1.23 M", or "12.35 L" in IN' },
  num:    { sig: 'num(n, locale?)',                  when: 'a plain grouped integer: 1234567 → "1,234,567"' },
}

/** The instructions for these helpers, rendered from the helpers themselves. */
export function formatHelpText(): string {
  const lines = Object.entries(FORMAT_HELPERS).map(([name, d]) => `  ${d.sig.padEnd(34)} ${d.when}`)
  return `Display helpers — \`import { ${Object.keys(FORMAT_HELPERS).join(', ')} } from '@superatom/scaffold'\`. OPTIONAL:
a raw number is always fine, and a table column says how its own figures read. Use one when you are writing a
figure INTO prose, a headline or a label, where nothing else can format it.\n${lines.join('\n')}`
}
