// ── CONFIGURATION — how an organisation reads time, money and words ─────────────────────────────────────────────────
//
// Facts about the organisation that every domain, program, library, client and the engine read the same way (not a
// domain's settings, which are its own parameters in the composition graph). One definition here: the fields, what each
// accepts, and the neutral reading used where nothing is set. Nothing is guessed: no currency set, amounts are plain
// numbers; no locale, the language's plain form. A project keeps only what it sets; `resolveConfiguration` lays it over
// the neutral reading (docs/platform-architecture.md "Configuration").

/** The financial year: the month it starts (1–12), or its months given as their own dates (4-4-5, irregular years). */
export type FinancialYear = { startMonth: number } | { months: { name: string; from: string; to: string }[] }

export interface Configuration {
  /** The language words are written in (BCP 47: "en", "hi"). */
  language?: string
  /** How numbers and dates are written (BCP 47: "en-IN", "en-AU", "de-DE"). */
  locale?: string
  /** Where the organisation's day begins and ends (IANA: "Asia/Kolkata", "Pacific/Auckland"). */
  timeZone?: string
  /** The currency amounts are reported in (ISO 4217: "INR", "NZD"). */
  currency?: string
  /** The first day of the week: 1 Monday … 7 Sunday. */
  weekStart?: number
  financialYear?: FinancialYear
}

/** Everything resolved: what a reader uses. `currency` stays null when none is set — amounts then carry no symbol. */
export interface ResolvedConfiguration {
  language: string
  locale: string
  timeZone: string
  currency: string | null
  weekStart: number
  financialYear: FinancialYear
}

/** The neutral reading: plain English forms, UTC, weeks from Monday, the calendar year — no place assumed. */
export const NEUTRAL_CONFIGURATION: ResolvedConfiguration = { language: 'en', locale: 'en', timeZone: 'UTC', currency: null, weekStart: 1, financialYear: { startMonth: 1 } }

/** The fields, in the order a page shows them, each with what it is (for the console and `sacli config`). */
export const CONFIGURATION_FIELDS: { key: keyof Configuration; label: string; says: string; example: string }[] = [
  { key: 'language', label: 'Language', says: 'The language words are written in', example: 'en' },
  { key: 'locale', label: 'Number and date format', says: 'How numbers and dates are written', example: 'en-IN' },
  { key: 'timeZone', label: 'Time zone', says: 'Where the day begins and ends', example: 'Asia/Kolkata' },
  { key: 'currency', label: 'Currency', says: 'The currency amounts are reported in', example: 'INR' },
  { key: 'weekStart', label: 'Week starts on', says: '1 Monday … 7 Sunday', example: '1' },
  { key: 'financialYear', label: 'Financial year', says: 'The month it starts, or its months as their own dates', example: '{"startMonth":4}' },
]

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** What is wrong with a configuration, in words its writer can act on (nothing wrong: an empty list). */
export function configurationProblems(c: unknown): string[] {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['a configuration is an object of its fields']
  const v = c as Record<string, unknown>
  const out: string[] = []
  const known = new Set(CONFIGURATION_FIELDS.map((f) => f.key as string))
  for (const k of Object.keys(v)) if (!known.has(k)) out.push(`there is no "${k}" — the fields are ${[...known].join(', ')}`)
  const tag = (k: string) => {
    const x = v[k]
    if (x === undefined) return
    try { if (typeof x !== 'string' || !x.trim() || Intl.getCanonicalLocales(x).length !== 1) throw 0 } catch { out.push(`${k} is a language tag such as "en" or "en-IN", not ${JSON.stringify(x)}`) }
  }
  tag('language'); tag('locale')
  if (v.timeZone !== undefined) { try { if (typeof v.timeZone !== 'string') throw 0; new Intl.DateTimeFormat('en', { timeZone: v.timeZone }) } catch { out.push(`timeZone is a zone such as "Asia/Kolkata", not ${JSON.stringify(v.timeZone)}`) } }
  if (v.currency !== undefined) {
    const ok = typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency) && (() => { try { new Intl.NumberFormat('en', { style: 'currency', currency: v.currency as string }); return true } catch { return false } })()
    if (!ok) out.push(`currency is a three-letter code such as "INR" or "NZD", not ${JSON.stringify(v.currency)}`)
  }
  if (v.weekStart !== undefined && !(Number.isInteger(v.weekStart) && (v.weekStart as number) >= 1 && (v.weekStart as number) <= 7)) out.push('weekStart is 1 (Monday) to 7 (Sunday)')
  if (v.financialYear !== undefined) {
    const fy = v.financialYear as Record<string, unknown>
    if (fy && typeof fy === 'object' && 'startMonth' in fy) { if (!(Number.isInteger(fy.startMonth) && (fy.startMonth as number) >= 1 && (fy.startMonth as number) <= 12)) out.push('financialYear.startMonth is 1 (January) to 12 (December)') }
    else if (fy && typeof fy === 'object' && Array.isArray(fy.months)) {
      const ms = fy.months as Record<string, unknown>[]
      if (!ms.length) out.push('financialYear.months lists the year\'s months')
      ms.forEach((m, i) => { if (!m || typeof m.name !== 'string' || !m.name.trim() || typeof m.from !== 'string' || !DAY.test(m.from) || typeof m.to !== 'string' || !DAY.test(m.to) || m.from > m.to) out.push(`financialYear.months[${i}] is { "name", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }, from not after to`) })
      for (let i = 1; i < ms.length; i++) if (typeof ms[i]?.from === 'string' && typeof ms[i - 1]?.to === 'string' && (ms[i].from as string) <= (ms[i - 1].to as string)) { out.push(`financialYear.months[${i}] begins before the month before it ends`); break }
    } else out.push('financialYear is { "startMonth": 1–12 } or { "months": [{ "name", "from", "to" }] }')
  }
  return out
}

/** The configuration a reader uses: what is set, over the neutral reading. */
export function resolveConfiguration(set: { [K in keyof Configuration]?: Configuration[K] | null } | null | undefined): ResolvedConfiguration {
  const s = set ?? {}
  return {
    language: s.language ?? NEUTRAL_CONFIGURATION.language,
    locale: s.locale ?? s.language ?? NEUTRAL_CONFIGURATION.locale,
    timeZone: s.timeZone ?? NEUTRAL_CONFIGURATION.timeZone,
    currency: s.currency ?? null,
    weekStart: s.weekStart ?? NEUTRAL_CONFIGURATION.weekStart,
    financialYear: s.financialYear ?? NEUTRAL_CONFIGURATION.financialYear,
  }
}
