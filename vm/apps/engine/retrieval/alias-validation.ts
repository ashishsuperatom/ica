// Alias validation — the DETERMINISTIC §9 "validate-before-accept". The LLM (the modeller) PROPOSES an alias;
// this decides whether to KEEP it, with no LLM.
//
// An alias becomes a firing surface form, so it must not make its concept fire on questions that actually
// produced a DIFFERENT concept. For each candidate alias on concept C:
//   for each labeled question Q whose correct set does NOT contain C:
//     fire Q normally, and fire Q WITH the candidate alias (as a hypothetical extra form) — both against the
//     SAME frozen mu. If C does not fire without the alias but DOES fire with it → the alias caused a false
//     fire → REJECT. Keep the alias only if it never causes a new false fire.
//
// Convergence (not chaos) rests on the frozen mu: a fixed reference frame means each accept/reject decision
// stays valid as more aliases are added — the concept's basin only ever widens where it does not collide with
// another concept's basin. REPLACEABLE segment: the acceptance rule (here: zero tolerance for a new false fire)
// can be swapped for a softer one without touching firing or history.
import type { SpanFirer, ExtraForm } from './span-firing.js'
import type { LabeledQuestion } from './history.js'

export type AliasVerdict = { alias: string; keep: boolean; firesOn: string[] }

export async function validateAliases(
  firer: SpanFirer,
  history: LabeledQuestion[],
  conceptName: string,
  candidates: string[],
): Promise<AliasVerdict[]> {
  const negatives = history.filter(h => !h.correct.has(conceptName))   // past questions where C is NOT the answer
  const verdicts: AliasVerdict[] = []
  for (const alias of candidates) {
    const extraForms: ExtraForm[] = [{ name: conceptName, form: alias }]
    const firesOn: string[] = []
    for (const q of negatives) {
      const without = await firer.fire(q.question)
      if (without.concepts.includes(conceptName)) continue                    // already fires without the alias — not its fault
      const withAlias = await firer.fire(q.question, { extraForms })
      if (withAlias.concepts.includes(conceptName)) firesOn.push(q.question)  // the alias CAUSED a false fire
    }
    verdicts.push({ alias, keep: firesOn.length === 0, firesOn })
  }
  return verdicts
}

/** Convenience: the subset of `candidates` that pass. */
export async function acceptableAliases(
  firer: SpanFirer, history: LabeledQuestion[], conceptName: string, candidates: string[],
): Promise<{ keep: string[]; rejected: AliasVerdict[] }> {
  const verdicts = await validateAliases(firer, history, conceptName, candidates)
  return { keep: verdicts.filter(v => v.keep).map(v => v.alias), rejected: verdicts.filter(v => !v.keep) }
}
