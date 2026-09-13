// ── RULES: A VALUE THAT DEPENDS ON WHO IS ASKING OR WHAT IS ASKED ABOUT ────────────────────────────────────
//
// A rule says when it applies — `{ "who.department": "finance", "pillar": "5" }` — and what it gives. Facts are
// what is known at the moment of asking: who is asking (`who.*`) and what the program is reading (a pillar, a
// subsidiary). A rule applies when every condition in it holds.
//
// When several apply, how they combine is a choice that depends on what the rules are for — the distinction the
// XACML standard names combining algorithms:
//
//   most specific   the rule with the most conditions wins, as in CSS. For values: a finance-and-NetSuite target
//                   overrides a finance target, which overrides the default. Two different values equally specific
//                   is refused — which one is meant is a decision, not a lookup.
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
  const top = Math.max(...hits.map((r) => Object.keys(r.when ?? {}).length))
  const best = hits.filter((r) => Object.keys(r.when ?? {}).length === top)
  for (const r of best.slice(1)) {
    if (!same(best[0], r)) {
      throw new AmbiguousRules(`${best.length} rules apply equally (${best.map((b) => JSON.stringify(b.when ?? {})).join(' and ')}) and disagree`)
    }
  }
  return best[0]
}

/** Every rule that applies. */
export const allThatApply = <R extends { when?: When }>(rules: R[], known: Facts): R[] => rules.filter((r) => applies(r.when ?? {}, known))

/** A value given as rules rather than directly. */
export interface RuledValue { rules: Array<{ when?: When; value: unknown }> }
export const isRuled = (v: unknown): v is RuledValue =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as any).rules) && Object.keys(v as object).length === 1
