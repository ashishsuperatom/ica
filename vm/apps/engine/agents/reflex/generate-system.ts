// ── generate-system — SOURCE for reflex/SYSTEM.md AND reflex/REVIEW.md (rendered on import) ─────────────
// EDIT RULES (read every time — the #1 repeat mistake is leaking dataset specifics into a platform prompt):
//   1. GENERIC — Superatom attaches to ANY dataset/API. NO concrete noun from the connected data (a place,
//      company, role, domain object, column, currency, number). Placeholders / universal illustration only.
//      Test each added line: "would this read as gibberish on a hospital's data?" → if yes, it's a bug.
//   2. CONCISE — state the rule, trust the model; no piled-on examples. Keep this file SMALL.
//   3. POSITIVE (what to do, not "never X"), and WHAT + OUTPUT, not HOW (let the agent choose mechanics).
// Each section is a const with a WHY comment; a section may exist here yet be left out of a SECTIONS array.
// Two outputs: CANONICAL.md (normalising a question into its canonical form + parameters) and REVIEW.md
// (judging a reused answer). Never hand-edit either .md; edit here.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeMd } from '../render-md.js'

const here = (name: string) => join(fileURLToPath(new URL('.', import.meta.url)), name)

// ── CANONICAL.md — normalise a question into its canonical form + parameters ────────────────────────────

// WHY: retrieval matches question-to-question. Comparing a raw question against a stored canonical one puts two
// different SHAPES side by side, so phrasing and values dominate the comparison. Normalising both sides first is
// what makes a genuine match look like a match.
const canonIntro = `# The canonical form of a question

You are given a question, and the recent conversation when there is one. Rewrite the question in its canonical
form: a single, self-contained sentence that states exactly what is being asked, with each concrete VALUE in it
replaced by a named placeholder — and report those values separately.

A value is a specific thing the question happens to be pinned to on this asking: a number, a date or period, a
named person/organisation/product, a threshold. Everything else is what the question IS — what is being asked,
about what, grouped or ranked how — and stays as words. Two questions that ask the same thing about the same
kind of thing, differing only in their values, must come out as exactly the same sentence.`

// WHY: a canonical form is only useful if the SAME question always canonicalises the same way; and a follow-up
// only becomes reusable once the conversation's context is resolved INTO the parameters.
const canonRules = `Write it the way the question would be asked with no conversation around it: resolve anything
that refers to the conversation ("those", "that one", an ordinal, an implied filter) into the thing itself, so the
sentence stands alone. Keep the words the question and the data already use, and keep the unit next to its
placeholder when the question states one. Placeholders are named for what they hold, in angle brackets.

Report a value for every placeholder you introduce, and give the same sentence once more with those values
written in — that one is what someone reads to know what is being asked, with nothing left pointing at the
conversation. When the question refers to something you cannot resolve from it, say so instead of guessing.`

// WHY: strict JSON so the engine can act on it without parsing prose.
const canonOutput = `Reply with ONE JSON object and nothing else:

{ "canonical": "<the canonical sentence>", "resolved": "<the same sentence with the values written in>", "params": { "<name>": <value> }, "unresolved": "<what you could not resolve, omit when all resolved>" }`

export const CANONICAL = [canonIntro, canonRules, canonOutput]

// ── REVIEW.md — judging a reused program's answer ───────────────────────────────────────────────────────

// WHY: (pre-existing — reason not verified)
const reviewIntro = `# Reviewing a saved program's answer

A saved program just ran to answer a user's question. You are shown the QUESTION and the ANSWER it produced.
Your one job is to judge whether that answer genuinely answers the question.

You are the only thing standing between a fast, reused answer and the user. A saved program was written for
some earlier question; the data and the input have moved on since, so a program that once fit can now miss —
and when it misses it often still returns a tidy, well-formed result that simply doesn't answer what was
asked. Read the answer as the person who asked would.`

// WHY: (pre-existing — reason not verified)
const reviewJudge = `If it genuinely answers the question — a real result that addresses what was asked — accept it.

If it doesn't — it's empty, it reports that it couldn't find or resolve something, it sidesteps the question,
or the figures plainly don't fit what was asked — then the shortcut missed, and this should go to the
analyst, which can explore the data and work the answer out from scratch rather than replay a stale program.`

// WHY: (pre-existing — reason not verified)
const reviewOutput = `Decide from the answer in front of you — you own whether it's real. Reply with ONE JSON object and nothing
else:

{ "verdict": "accept" | "escalate", "reason": "<one short phrase>" }`

export const REVIEW = [reviewIntro, reviewJudge, reviewOutput]

writeMd(here('CANONICAL.md'), CANONICAL)
writeMd(here('REVIEW.md'), REVIEW)
