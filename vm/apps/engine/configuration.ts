// THE PROJECT'S CONFIGURATION, as this engine has it: how the organisation reads time, money and words (platform-types
// configuration.ts). The platform gives it with the welcome and pushes each change (configuration:update); until then
// the neutral reading. Adopting it sets the shared formatter (the answers' text tables: sacli, Teams, iOS), and programs
// read it through ctx.services.config().
import { configure } from '@superatom/ui/format'
import { NEUTRAL_CONFIGURATION, resolveConfiguration, type ResolvedConfiguration } from '@superatom/platform-types'

let current: ResolvedConfiguration = NEUTRAL_CONFIGURATION

/** The configuration in force (the neutral reading until the platform's arrives). */
export const configuration = (): ResolvedConfiguration => current

/** Adopt what the platform gave (resolved there; resolved again here, so a missing field never leaves a hole). */
export function adoptConfiguration(given: unknown): ResolvedConfiguration {
  current = resolveConfiguration(given && typeof given === 'object' ? given as Partial<ResolvedConfiguration> : null)
  configure({ locale: current.locale, currency: current.currency })
  return current
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** The configuration as words a concept's {{variables}} take ({{currency}}, {{financialYear}}, …): the agent reads the
 *  organisation's facts where a concept names them, and nowhere else (the prompt is concepts only). */
export function configurationWords(c: ResolvedConfiguration = current): Record<string, string> {
  const fy = 'startMonth' in c.financialYear
    ? `starts in ${new Date(Date.UTC(2000, c.financialYear.startMonth - 1, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' })}`
    : `is its own months: ${c.financialYear.months.map((m) => `${m.name} ${m.from} – ${m.to}`).join('; ')}`
  return { language: c.language, locale: c.locale, timeZone: c.timeZone, currency: c.currency ?? 'no currency set (amounts are plain numbers)', weekStart: DAYS[c.weekStart - 1] ?? 'Monday', financialYear: fy }
}
