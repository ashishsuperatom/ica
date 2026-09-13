// ── RULES: A VALUE THAT DEPENDS ON WHO IS ASKING OR WHAT IS ASKED ABOUT ────────────────────────────────────
//
// A rule says when it applies — `{ "who.department": "finance", "pillar": "5" }` — and what it gives. Facts are
// what is known at the moment of asking: who is asking (`who.*`) and what the program is reading (a pillar, a
// subsidiary). A rule applies when every condition in it holds.
//
// When several apply, how they combine is a choice that depends on what the rules are for — the distinction the
// XACML standard names combining algorithms:
//
//   most specific   ranked as CSS ranks selectors — by the kind of condition first, then how many: a rule for
//                   one PERSON (`who.id`) beats any rule for a GROUP they belong to (any other `who.*`), which
//                   beats a rule about the data alone, which beats the GLOBAL rule with no conditions. Within a
//                   kind, more conditions win: finance-and-NetSuite beats finance. Two different values equally
//                   specific is refused — which one is meant is a decision, not a lookup.
//   all             every rule that applies, applies. For restrictions: two row filters both hold, and a denial
//                   anywhere is a denial. A more specific rule must never loosen access.

export type Scalar = string | number | boolean
export type When = Record<string, Scalar | Scalar[]>
export type Facts = Record<string, unknown>

/** Facts from who is asking, prefixed `who.`, and from the data, as given. */
export function facts(who: Record<string, unknown> | undefined, data: Record<string, unknown> = {}): Facts {
  const out: Facts = { ...data }
  for (const [k, v] of Object.entries(who ?? {})) out[`who.${k}`] = v
  return out
}

/** Every condition holds. A list in the rule means any of; a list in the facts (a person's groups) means it
 *  holds if any member matches. A fact that is not known never matches. */
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

/** The most specific rule that applies, or null when none does. */
export function mostSpecific<R extends { when?: When }>(rules: R[], known: Facts, same: (a: R, b: R) => boolean): R | null {
  const hits = rules.filter((r) => applies(r.when ?? {}, known))
  if (!hits.length) return null
  const rank = (r: R) => specificity(r.when ?? {})
  const top = hits.map(rank).sort(compareRank).at(-1)!
  const best = hits.filter((r) => compareRank(rank(r), top) === 0)
  for (const r of best.slice(1)) {
    if (!same(best[0], r)) {
      throw new AmbiguousRules(`${best.length} rules apply equally (${best.map((b) => JSON.stringify(b.when ?? {})).join(' and ')}) and disagree`)
    }
  }
  return best[0]
}

/** [conditions on the person, on their groups and roles, on the data] — compared in that order. */
export function specificity(when: When): [number, number, number] {
  const keys = Object.keys(when)
  const person = keys.filter((k) => k === 'who.id').length
  const group = keys.filter((k) => k.startsWith('who.') && k !== 'who.id').length
  return [person, group, keys.length - person - group]
}
const compareRank = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Every rule that applies. */
export const allThatApply = <R extends { when?: When }>(rules: R[], known: Facts): R[] => rules.filter((r) => applies(r.when ?? {}, known))

/** A value given as rules rather than directly. */
export interface RuledValue { rules: Array<{ when?: When; value: unknown }> }
export const isRuled = (v: unknown): v is RuledValue =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as any).rules) && Object.keys(v as object).length === 1
