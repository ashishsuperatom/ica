// {{NAME}}'s knowledge as the composition graph imports it (`composition-graph import knowledge/index.mts`): the
// organisation's settings, and the domains — each an agent's whole system prompt, with the programs it runs. The rules
// are programs (the source runs them, through shared/sql-rows.mjs or shared/js-rows.mjs: totals and pages of 100); the
// concepts say what they mean.
import type { ConceptBody } from '@superatom/composition-graph'

type Concept = ConceptBody & { name?: string }

/** The organisation's decisions, by name: a program reads them from settings.json, a view with settingOf(name). */
export const settings = [
  { name: 'reporting-currency-code', value: '{{CURRENCY}}', description: 'the currency every amount is reported in' },
  { name: 'financial-year-first-month', value: 1, description: 'the calendar month a financial year starts in (1 = January)' },
]

/** One domain per area a person asks about: `capabilities` are the dashboard views it answers with (app/server/capabilities),
 *  `files` the programs and helpers placed in its folder (paths under knowledge/), `settings` the ones its programs read. */
export const domains: { name: string; description: string; intents: string[]; capabilities: string[]; concepts: Concept[]; files: string[]; tools: string[]; settings: string[] }[] = [
]
