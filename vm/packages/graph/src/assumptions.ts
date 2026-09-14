// ── ASSUMPTIONS: LOOKED UP BY NAME, NEVER PASSED POSITION BY POSITION ─────────────────────────────────────
//
// A program declares the assumptions it reads. The value comes from the nearest caller that set it, else the
// organisation, else the program's own default. A program that needs a new assumption declares it; every caller
// keeps passing the same context, and programs that do not read it never see it.
//
// A value may be given as rules — `{ rules: [{ when: { "who.department": "finance" }, value: 0.7 }, ...] }` — and
// then the most specific rule that applies to who is asking and what is being read gives it. A layer whose rules do
// not apply passes to the next layer.

import type { Calendar } from './calendar.js'
import type { Contract } from './contract.js'
import { AmbiguousRules, facts, isRuled, mostSpecific } from './rules.js'
import type { Scope, Trail } from './runtime.js'

type From = Trail['assumed'][number]['from']
const sameValue = (a: { value: unknown }, b: { value: unknown }) => JSON.stringify(a.value) === JSON.stringify(b.value)

export function assume<T>(organisation: Record<string, unknown> | undefined, contract: Contract, scope: Scope, name: string,
                          trail: Trail, about?: Record<string, unknown>): T {
  const declared = contract.assumes?.[name]
  if (!declared) throw new Error(`"${contract.name}" read the assumption "${name}", which its contract does not declare`)
  const known = facts(scope.who, about)
  const layers: Array<[From, boolean, unknown]> = [
    ['caller', name in scope.context, scope.context[name]],
    ['organisation', !!organisation && name in organisation, organisation?.[name]],
    ['default', 'default' in declared, declared.default],
  ]
  for (const [from, present, given] of layers) {
    if (!present) continue
    if (!isRuled(given)) return record(given, from)
    try {
      const rule = mostSpecific(given.rules, known, sameValue)
      if (rule) return record(rule.value, from, rule.when ?? {})
    } catch (e) {
      if (e instanceof AmbiguousRules) throw new Error(`"${name}" for ${JSON.stringify(known)}: ${e.message}`)
      throw e
    }
  }
  throw new Error(`"${contract.name}" needs the assumption "${name}" (${declared.description}) and nobody gave it${about ? ` for ${JSON.stringify(about)}` : ''}`)

  function record(value: unknown, from: From, rule?: Record<string, unknown>): T {
    const entry = { name, value, from, ...(about ? { about } : {}), ...(rule ? { rule } : {}) }
    if (!trail.assumed.some((a) => JSON.stringify(a) === JSON.stringify(entry))) trail.assumed.push(entry)
    return value as T
  }
}

/** The calendar a request uses: the assumption named `calendar`, from the caller or the organisation, chosen by
 *  rules when it differs by who is asking. No calendar means the built-in grains only. */
export function calendarFor(organisation: Record<string, unknown> | undefined, scope: Scope, trail: Trail): Calendar {
  const [given, from]: [unknown, From | null] = 'calendar' in scope.context ? [scope.context.calendar, 'caller']
    : organisation && 'calendar' in organisation ? [organisation.calendar, 'organisation'] : [undefined, null]
  if (from === null) return {}
  let value = given
  if (isRuled(given)) {
    const rule = mostSpecific(given.rules, facts(scope.who), sameValue)
    if (!rule) return {}
    value = rule.value
  }
  if (!trail.assumed.some((a) => a.name === 'calendar')) trail.assumed.push({ name: 'calendar', value, from })
  return (value ?? {}) as Calendar
}
