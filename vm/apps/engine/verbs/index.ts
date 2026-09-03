// VERBS — the `word:` prefixes a user can put at the very start of a question to say what KIND of turn this is.
//
//   edit: / modify:   change the program behind the answer on screen, in place
//   explain:          say, in prose, how the answer on screen was arrived at
//   check:            re-run that program with the same parameters and report what moved
//   program:          show its source
//
// A verb is DETERMINISTIC routing: the user said which mode they want, so nothing guesses. It must be the very
// first thing typed — a word, then a colon — because anywhere else it is just prose ("the edit: was wrong").
//
// Only KNOWN verbs match. The tempting rule is "any first word followed by a colon", but that quietly hijacks
// ordinary questions — "Q1: revenue by region", "Note: exclude internal jobs", "2026: how did we do" would all
// become commands the user never issued. A closed set can only ever fail by NOT firing, which the user sees
// immediately and can correct; the open rule fails by firing on something else, which they may never notice.
//
// The raw text keeps its prefix. Downstream gets BOTH: `rest` to act on, `raw` to show. The prefix used to be
// stripped here and thrown away, which left no way — for us reading a log, or for an agent reading its own
// history — to tell an `edit:` turn from an ordinary one. Now `raw` travels into the prompt, so the literal
// `edit:` / `explain:` is in the transcript and greppable.

// The list lives in the shared protocol — the client filters verb:event on the same names the engine routes
// on, and two copies of that list would drift the first time one of us added a verb.
export type { Verb } from '../../../../clients/protocol.js'
import type { Verb } from '../../../../clients/protocol.js'

export interface VerbMatch {
  verb: Verb
  raw: string    // exactly what the user typed, prefix and all — for prompts, logs and the node
  rest: string   // the text after the prefix — what to actually act on
}

const SPELLINGS: Record<string, Verb> = {
  edit: 'edit',
  modify: 'edit',      // same thing, and people reach for both
  explain: 'explain',
  check: 'check',
  program: 'program',
}

/** What each verb needs and what it is allowed to leave behind. One table, so the whole set is visible at once
 *  and a new verb has to answer these questions rather than discovering them by breaking something. */
export const VERBS: Record<Verb, {
  needsCurrentProgram: boolean   // does it act on the answer already on screen?
  needsText: boolean             // is the text after the colon the instruction, or is the verb the whole thing?
  usesAgent: boolean             // false = deterministic, no LLM anywhere in the path
  persists: boolean              // may it write an answer row / intent node / program?
  nothingToActOn: string         // what to tell the user when there is no current program
  category: string               // what the answer card calls this kind of turn
}> = {
  edit:    { needsCurrentProgram: true, needsText: true, usesAgent: true, persists: true, category: 'analysis',
             nothingToActOn: 'There is nothing on screen to edit yet — ask a question first.' },
  // Explain and check REPORT on an answer; they never become one. Persisting them would put "explain: …" into
  // the intent graph as a question in its own right, where retrieval could later match it and serve an
  // explanation to someone who asked for a number.
  explain: { needsCurrentProgram: true, needsText: false, usesAgent: true, persists: false, category: 'explanation',
             nothingToActOn: 'There is no answer on screen to explain yet — ask a question first, then `explain:` it.' },
  // `check:` on its own is the natural way to ask it — there is nothing to say beyond the word. Requiring text
  // after the colon made the bare form fall through as an ordinary QUESTION: a full build, narrator and all,
  // for someone who typed one word expecting a re-run. `explain:` is the same; the text is optional colour.
  check:   { needsCurrentProgram: true, needsText: false, usesAgent: false, persists: false, category: 'check',
             nothingToActOn: 'There is no answer on screen to check yet — ask a question first, then `check:` it.' },
  // Reading files. Here so the program behind an answer can be seen from the chat it was asked in, rather than
  // from the admin console — the difference between a system you can inspect and one you have to go and audit.
  program: { needsCurrentProgram: true, needsText: false, usesAgent: false, persists: false, category: 'program',
             nothingToActOn: 'There is no program on screen to show yet — ask a question first, then `program:` it.' },
}

/** A leading `verb:` if there is one. Case-insensitive, tolerates space before the colon ("edit :"). */
export function parseVerb(input: string): VerbMatch | null {
  const raw = input.replace(/^\s+/, '')
  const m = /^([a-z]+)\s*:/i.exec(raw)
  if (!m) return null
  const verb = SPELLINGS[m[1].toLowerCase()]
  if (!verb) return null
  const rest = raw.slice(m[0].length).trim()
  // An `edit:` with nothing after it is not an instruction — there is no change to make. But `check:` and
  // `explain:` are complete on their own, and rejecting them sent the user's one word off to be answered as a
  // brand-new question.
  if (!rest && VERBS[verb].needsText) return null
  return { verb, raw, rest }
}
