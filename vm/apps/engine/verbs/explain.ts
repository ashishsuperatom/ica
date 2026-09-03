// EXPLAIN — say how the answer on screen was arrived at, in prose. No program is written and nothing is
// persisted: this turn reports on an answer, it never becomes one.
//
// GROUNDED IN THE ARTIFACTS, NOT IN MEMORY. An answer reaches the screen three ways — the composer built it,
// the analyst built it, or `reuseProgram` re-ran a saved program with no LLM involved at all. In the last case
// nobody has any recollection to draw on, and in the middle case the recollection belongs to a different
// agent. Reading the program and its recorded run is the only account that holds for all three, and the only
// one that still holds after a restart. When the composer wrote the program itself a moment ago it will
// recognise its own work, which costs nothing.
//
// The prompt stays short on purpose. These are capable agents: told what the person wants and where the
// material is, they do not need to be told how to read a file or what prose is.

import { VERBS } from './index.js'

export interface ExplainTarget {
  programDir: string
  prevQuestion?: string
  concepts?: string[]
}

/** The instruction for an explain turn. `raw` is what the user typed, `explain:` prefix and all — it stays in
 *  the prompt so the transcript records which kind of turn this was and stays searchable. */
export function explainPrompt(o: { raw: string; target: ExplainTarget }): string {
  const t = o.target
  return `${o.raw}

The person is asking how the answer already on screen was arrived at — explain it, don't rebuild it. It came from
./${t.programDir}${t.prevQuestion ? ` (which answers: "${t.prevQuestion}")` : ''}: read the program, its units and the
run it recorded in program.json${t.concepts?.length ? `, and the concepts it was built from (${t.concepts.join(', ')})` : ''}.

Answer what they actually asked, at the length that answers it — and no longer. Usually that is a few sentences
in plain language: what was counted, over what period, and the choices that decided the number. If they asked for
something particular — the query, one figure, why a row is missing — give them that instead.

Just tell them — no file, no program.`
}

/** The explanation as an answer card: markdown in a `text` section, which the UI renders. No headline — there is
 *  no number here, and a card that fakes one invites the reader to treat the explanation as a new result. */
export function explainAnswer(markdown: string, programDir: string) {
  return {
    status: 'answered',
    category: VERBS.explain.category,
    sections: [{ kind: 'text', body: markdown.trim() }],
    scope: `Explanation of ${programDir} — no data was re-queried.`,
  }
}
