// ── SETTINGS AND RULES: A VALUE THAT DEPENDS ON WHO ASKS AND WHAT IS ASKED ABOUT ──────────────────────────────
//
// A setting is a named value — the currency answers are reported in, the zone a person's today is in, how surprising a
// value must be to be flagged, a threshold a program reads. It is looked up by name, from the nearest layer that has it:
//
//   caller         set on this request
//   asker          set on the person asking (their own time zone, their own currency)
//   organisation   the model's settings
//   default        what the reader of the setting falls back to
//
// A value may be given as rules — { rules: [{ when: { "who.department": "finance", "Pillar": "5" }, value: 0.7 }, …] } —
// and the most specific rule that applies to who is asking and what is being asked about gives it (the combining
// algorithms of XACML; specificity ranked as CSS ranks selectors): a rule for one person (who.id) beats a rule for a
// group they are in (any other who.*), which beats a rule about the data alone, which beats a rule with no conditions;
// within a kind, more conditions win. Two rules equally specific that disagree are refused: which one is meant is a
// decision, not a lookup. A layer whose rules do not apply passes to the next layer.
//
// What is asked about is the graph's own: the members a question keeps, by object — { Pillar: ["15"], Subsidiary: ["2"] }.
// Every value read is recorded on the answer with the layer and rule it came from.

export type Scalar = string | number | boolean
export type When = Record<string, Scalar | Scalar[]>
export type Facts = Record<string, unknown>
export interface RuledValue { rules: Array<{ when?: When; value: unknown }> }
export type Layer = 'caller' | 'asker' | 'organisation' | 'default'
export interface Assumed { name: string; value: unknown; from: Layer; rule?: When }

export const isRuled = (v: unknown): v is RuledValue =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as any).rules) && Object.keys(v as object).length === 1

/** Facts from who is asking, prefixed `who.`, and from what is asked about, as given. */
export function facts(who: Record<string, unknown> | undefined | null, about: Record<string, unknown> = {}): Facts {
  const out: Facts = { ...about }
  for (const [k, v] of Object.entries(who ?? {})) out[`who.${k}`] = v
  return out
}

/** Every condition holds. A list in a rule means any of; a list in the facts (a person's groups, a question's members)
 *  holds if any of it matches. A fact that is not known never matches. */
export function applies(when: When, known: Facts): boolean {
  return Object.entries(when).every(([key, expected]) => {
    const fact = known[key]
    if (fact === undefined || fact === null) return false
    const have = (Array.isArray(fact) ? fact : [fact]).map(String)
    const want = (Array.isArray(expected) ? expected : [expected]).map(String)
    return have.some((h) => want.includes(h))
  })
}

export class AmbiguousRules extends Error {}

/** [conditions on the person, on their groups and roles, on the data] — compared in that order. */
export function specificity(when: When): [number, number, number] {
  const keys = Object.keys(when)
  const person = keys.filter((k) => k === 'who.id').length
  const group = keys.filter((k) => k.startsWith('who.') && k !== 'who.id').length
  return [person, group, keys.length - person - group]
}
const compareRank = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** The most specific rule that applies, or null. */
export function mostSpecific<R extends { when?: When; value: unknown }>(rules: R[], known: Facts): R | null {
  const hits = rules.filter((r) => applies(r.when ?? {}, known))
  if (!hits.length) return null
  const top = hits.map((r) => specificity(r.when ?? {})).sort(compareRank).at(-1)!
  const best = hits.filter((r) => compareRank(specificity(r.when ?? {}), top) === 0)
  if (best.some((r) => JSON.stringify(r.value) !== JSON.stringify(best[0].value))) {
    throw new AmbiguousRules(`${best.length} rules apply equally (${best.map((b) => JSON.stringify(b.when ?? {})).join(' and ')}) and disagree`)
  }
  return best[0]
}

/** Every rule that applies — for restrictions, where all of them hold and a more specific one never loosens another. */
export const allThatApply = <R extends { when?: When }>(rules: R[], known: Facts): R[] => rules.filter((r) => applies(r.when ?? {}, known))

/** A setting's value from the nearest layer that gives one for these facts, or undefined; recorded into `assumed`. */
export function setting(name: string, layers: Partial<Record<Exclude<Layer, 'default'>, Record<string, unknown> | undefined | null>> & { default?: unknown },
                        known: Facts, assumed: Assumed[]): unknown {
  const order: Array<[Layer, boolean, unknown]> = [
    ['caller', !!layers.caller && name in layers.caller, layers.caller?.[name]],
    ['asker', !!layers.asker && name in layers.asker, layers.asker?.[name]],
    ['organisation', !!layers.organisation && name in layers.organisation, layers.organisation?.[name]],
    ['default', 'default' in layers && layers.default !== undefined, layers.default],
  ]
  for (const [from, present, given] of order) {
    if (!present) continue
    if (!isRuled(given)) return record(given, from)
    let rule
    try { rule = mostSpecific(given.rules, known) } catch (e) { throw e instanceof AmbiguousRules ? new AmbiguousRules(`the setting "${name}": ${e.message}`) : e }
    if (rule) return record(rule.value, from, rule.when ?? {})
  }
  return undefined

  function record(value: unknown, from: Layer, rule?: When) {
    const entry: Assumed = { name, value, from, ...(rule ? { rule } : {}) }
    if (!assumed.some((a) => JSON.stringify(a) === JSON.stringify(entry))) assumed.push(entry)
    return value
  }
}
