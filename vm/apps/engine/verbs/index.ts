// VERBS — the `word:` prefixes a user can put at the very start of a question to say what KIND of turn this is.
//
//   edit: / modify:   change the program behind the answer on screen, in place
//   explain:          say, in prose, how the answer on screen was arrived at
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

export type Verb = 'edit' | 'explain' | 'check'

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
}

/** What each verb needs and what it is allowed to leave behind. One table, so the whole set is visible at once
 *  and a new verb has to answer these questions rather than discovering them by breaking something. */
export const VERBS: Record<Verb, {
  needsCurrentProgram: boolean   // does it act on the answer already on screen?
  usesAgent: boolean             // false = deterministic, no LLM anywhere in the path
  persists: boolean              // may it write an answer row / intent node / program?
  nothingToActOn: string         // what to tell the user when there is no current program
}> = {
  edit:    { needsCurrentProgram: true, usesAgent: true,  persists: true,
             nothingToActOn: 'There is nothing on screen to edit yet — ask a question first.' },
  // Explain and check REPORT on an answer; they never become one. Persisting them would put "explain: …" into
  // the intent graph as a question in its own right, where retrieval could later match it and serve an
  // explanation to someone who asked for a number.
  explain: { needsCurrentProgram: true, usesAgent: true,  persists: false,
             nothingToActOn: 'There is no answer on screen to explain yet — ask a question first, then `explain:` it.' },
  check:   { needsCurrentProgram: true, usesAgent: false, persists: false,
             nothingToActOn: 'There is no answer on screen to check yet — ask a question first, then `check:` it.' },
}

/** A leading `verb:` if there is one. Case-insensitive, tolerates space before the colon ("edit :"). */
export function parseVerb(input: string): VerbMatch | null {
  const raw = input.replace(/^\s+/, '')
  const m = /^([a-z]+)\s*:/i.exec(raw)
  if (!m) return null
  const verb = SPELLINGS[m[1].toLowerCase()]
  if (!verb) return null
  const rest = raw.slice(m[0].length).trim()
  // "edit:" with nothing after it is not an instruction. Treat it as ordinary text rather than an empty command.
  if (!rest) return null
  return { verb, raw, rest }
}
