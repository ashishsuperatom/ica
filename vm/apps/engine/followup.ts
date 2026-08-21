// ── Deterministic follow-up detector (no model, no network, ~µs) ──────────────────────────────────
// A follow-up is phrased from a small closed set of OPENERS — conjunctions ("and…"), bare-preposition
// fragments ("by month"), what/how-about ("what about…"), refinement imperatives ("break … down") — or it
// carries an anaphor referring to a prior result ("why did IT drop", "compare THAT to last year"). A NEW,
// self-contained question opens with a wh-/quantity word and names its own subject.
//
// This is the SAFETY GATE on the exact-repeat fast path: we only rerun a matched program without the reflex
// classifier when the utterance is clearly NOT a follow-up (self-contained), so an exact text match is
// unambiguous. Anything that looks like a follow-up falls through to reflex, which has the conversation.
//
// The pattern set is a hand-authored SEED. The intended path is that offline consolidation LEARNS it from the
// real (question → root|follow-up) corpus the intent graph already labels by node parentage — this file is the
// compiled target, not the final source of truth.

const CONTINUATION = /^(and|or|but|so|also|plus|then|additionally)\b/                  // conjunction-first
const WHAT_ABOUT   = /^(what|how)\s+about\b|^what\s+if\b/                              // "what about X" / "what if"
// ellipsis fragment — but NOT when the preposition starts a real question ("for how long", "in which year")
const BARE_PREP    = /^(by|for|in|with|without|per|excluding|including|vs|versus|compared|against|between)\b(?!\s+(how|which|what|when|whom|whose|long))/
const REFINE_VERB  = /^(break|split|drill|group|filter|sort|order|compare|add|remove|exclude|include|expand|change|switch|instead|now|only|just|limit|narrow|zoom|rank|show\s+me\s+the\s+same|show\s+the\s+same|same)\b/
// Strong anaphors always count. "that/those/these" are ambiguous (relative pronoun in "customers THAT churned"),
// so they count only clause-initially or right after a verb — the object-of-reference position ("compare THAT").
const ANAPHOR_STRONG = /\b(it|them|this|they|the\s+same|the\s+one|the\s+previous|above|earlier)\b/
const ANAPHOR_WEAK   = /(^|\b(did|do|does|is|are|was|were|break|compare|show|drill|split|group|explain|rank|caused|drove|down|out|to|about)\s+)(that|those|these)\b/
// A NEW question typically opens with one of these AND matches none of the follow-up cues above.
const NEW_OPENER   = /^(what\s+(is|are|was|were)|how\s+(many|much)|who|which|list|show\s+me\s+(the\s+)?(top|all|a)|give\s+me|top\s+\d|count|total|when|where|do\s+we|are\s+there|is\s+there)\b/

// Which cues fired (for logging / the eventual learned-threshold gate). Empty ⇒ treated as a new question.
// "this/that/these/those + <time noun>" ("this fiscal year", "that quarter") is a TIME reference, not an
// anaphor — strip it before the anaphor test so a root question isn't mis-flagged as a follow-up.
const TIME_DEMONSTRATIVE = /\b(this|that|these|those)\s+(fiscal\s+)?(year|quarter|month|week|day|period|fy|half|year\s+to\s+date)\b/g

export function followUpCues(question: string): string[] {
  const q = question.toLowerCase().trim().replace(/\s+/g, ' ')
  const qA = q.replace(TIME_DEMONSTRATIVE, ' ')   // anaphor test ignores time-bound demonstratives
  const hits: string[] = []
  if (CONTINUATION.test(q)) hits.push('continuation')
  if (WHAT_ABOUT.test(q)) hits.push('what-about')
  if (BARE_PREP.test(q)) hits.push('bare-prep')
  if (REFINE_VERB.test(q)) hits.push('refine-verb')
  if ((ANAPHOR_STRONG.test(qA) || ANAPHOR_WEAK.test(qA)) && !NEW_OPENER.test(q)) hits.push('anaphor')
  return hits
}

export function isFollowUp(question: string): boolean {
  return followUpCues(question).length > 0
}
