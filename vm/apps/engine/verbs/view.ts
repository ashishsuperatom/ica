// VIEW — look at one thing: `view: customer 431`, or through a lens: `view: customer 431 projects`.
//
// Not a question. A question is a sentence, matched to past questions by meaning, and the match is a
// judgement. A view is a KEY — a kind of thing and a way of looking at it — so finding one is a lookup:
//
//     (type, lens) → programs/view.<type>.<lens>/        existsSync, and that is the entire search
//
// The id is the ONLY parameter, always. One program serves every customer. That constraint is what keeps the
// set of programs bounded — roughly (kinds × lenses), a few dozen ever — and it is why this reuses where
// question-matching cannot: after the first asking, the answer is a program run with no model involved.
//
// The lens is a PHRASE, never a sentence. "projects", "invoices", "contacts". A sentence is a question and
// belongs in the box as one; keeping the lens small is what keeps the space small.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProgramTarget } from './index.js'

export interface ViewRef { type: string; id: string; lens: string }

/** `<type> <id> [lens…]`. Positional because the caller is usually a click, not a person typing — but a person
 *  typing it gets the same thing. The lens defaults to the plain look at the thing itself. */
export function parseView(rest: string): ViewRef | null {
  const parts = rest.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return null                       // a kind with no id names nothing to look at
  const [type, id, ...lens] = parts
  return { type: slug(type), id, lens: lens.length ? slug(lens.join(' ')) : 'canonical' }
}

/** Filesystem-safe and stable: the same view asked for twice must resolve to the same directory, however it
 *  was typed. Lower-cased and hyphenated, so "Projects" and "projects" are one program, not two. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export const viewDir = (v: ViewRef) => `programs/view.${v.type}.${v.lens}`
export const viewLabel = (v: ViewRef) =>
  `${v.type} ${v.id}${v.lens === 'canonical' ? '' : ` (${v.lens})`}`

/** The program for this view, if it has been built. */
export function findView(workspace: string, v: ViewRef): string | null {
  const dir = viewDir(v)
  return existsSync(join(workspace, dir, 'program.ts')) ? dir : null
}

/** The instruction to BUILD one. Reached only the first time a (kind, lens) pair is asked for; every asking
 *  after that runs the program. */
export function viewPrompt(o: { v: ViewRef; dir: string; builtRel: string }): string {
  const { v } = o
  return `Build a reusable VIEW of one ${v.type}${v.lens === 'canonical' ? '' : `, through the lens "${v.lens}"`}.

A view answers "show me this ${v.type}" at a glance — the handful of things someone would want to know on
opening it${v.lens === 'canonical' ? '' : `, weighted towards ${v.lens}`}. Not an analysis; an orientation.

Two things make it a view rather than an answer to one question:

- **\`id\` is the only parameter.** Everything else is computed inside. The same program serves every ${v.type};
  ${v.id} is just the one being looked at now.
- **The same shape every time.** The same fields for every ${v.type}, so it reads as a familiar page rather
  than a different report each time. Where there is no data for one of them, say so rather than dropping it.

Build it at \`${o.dir}\`, run it with \`{"id": "${v.id}"}\` to check it, and commit as usual:
${o.builtRel} = {"programDir":"${o.dir}","params":{"id":"${v.id}"},"canonicalQuestions":["${viewLabel(v)}"]}`
}

/** What the engine hands the other verbs after a view has been shown. */
export const viewTarget = (dir: string, v: ViewRef, concepts?: string[]): ProgramTarget =>
  ({ programDir: dir, question: viewLabel(v), params: { id: v.id }, concepts })
