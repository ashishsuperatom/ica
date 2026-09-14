// THE COMPOSER — answers a conversation's questions from the graph.
//
// One composer per conversation, in the conversation's own directory. It turns what the person said into a message
// for their data session and applies it with ./ask. When the message needs a program that does not exist, it writes
// and defines it — or, when that is more than a turn's work, hands the question to the analyst with ./escalate.
// The turn ends when a step has been applied (out/<qid>/step.json) or the question has been escalated.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentConfig, type AgentOverride } from '../../config/index.js'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { GRAPH_REFERENCE } from '../shared-prompts/graph-reference.js'

export interface ComposerOpts {
  root: string
  projectId: string
  managerUrl?: string
  projectDir?: string
  /** The conversation this composer belongs to: its directory, and its data session. */
  sessionId?: string
  ica?: AgentOverride
}

export interface TurnResult {
  /** The data-session step the turn applied. */
  step?: number
  escalate?: { reason: string }
  ms: number
}

export interface Composer {
  ask(question: string, handlers: RunHandlers | undefined, opts: { qid: string; sessionId: string }): Promise<TurnResult>
  session: Session
  cwd: string
}

const ROLE = `You answer a person's questions about their organisation's data, one conversation at a time. The people
asking make decisions; an answer tells them what the numbers are, what they mean, and what they could look at next.

Each question is a step in the person's data session. A new question is {"ask": "<program>", "request": {…}}, where the
program returns an answer; a follow-up changes the current state — a filter, a split, another span. When "that one" or
"the third customer" points at something already shown, ./find it rather than guess.

Read what exists with ./catalog, and the program you will use with ./program, before writing anything. A program the question needs and the graph lacks: write it in
programs/<name>/, ./define it, ./try it, then ./ask. Build on the relations that exist. When there is no concept for
what the question measures — deciding which rows count as utilised, what capacity is — that is discovering what the data
means: ./escalate "<why>" and stop; the analyst does that.

Answer the question that was asked. When a message is refused, or the program cannot take what the question needs (a
comparison, a split, a filter), make the program able to — \`--replace\` it with the parameter it lacks — or escalate;
an answer to a nearby question reads as an answer to this one.

A question is followed by \`qid:\` — which turn this is, and nothing else. Every tool explains itself with --help.`

export async function turnOutcome(dir: string): Promise<{ step?: number; escalate?: { reason: string } } | null> {
  try { const s = JSON.parse(await readFile(join(dir, 'step.json'), 'utf8')); if (typeof s.step === 'number') return { step: s.step } } catch { /* not yet */ }
  try { const e = JSON.parse(await readFile(join(dir, 'escalate.json'), 'utf8')); return { escalate: { reason: String(e.reason ?? 'escalated') } } } catch { /* not yet */ }
  return null
}

export async function createComposer(opts: ComposerOpts): Promise<Composer> {
  const cfg = agentConfig('composer')
  const harness: Harness = opts.ica?.harness ?? cfg.harness
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl, projectDir: opts.projectDir, sessionId: opts.sessionId })
  const context = (() => { try { return readFileSync(join(cwd, 'CONTEXT.md'), 'utf8') } catch { return '' } })()
  const session = createSession(harness, { cwd, model: opts.ica?.model ?? cfg.model, provider: opts.ica?.provider ?? cfg.provider, baseUrl: opts.ica?.baseUrl,
                                           systemReference: [ROLE, GRAPH_REFERENCE, context].join('\n\n') })
  if (session.referencePlacement !== 'in-context') console.warn(`[composer] harness "${harness}" cannot put the reference in the system prompt — use opencode/claude/codex`)

  return {
    cwd, session,
    async ask(question, handlers, o) {
      const t0 = Date.now()
      const dir = join(cwd, 'out', o.qid)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      await mkdir(dir, { recursive: true })
      await writeFile(join(cwd, '.turn'), o.qid)
      await writeFile(join(cwd, '.session'), o.sessionId)
      await writeFile(join(cwd, '.agent'), 'composer')
      await session.run(`${question}\n\nqid: ${o.qid}`, { ...handlers, doneWhen: async () => (await turnOutcome(dir)) !== null })
      const outcome = await turnOutcome(dir)
      return { ...(outcome ?? { escalate: { reason: 'the composer applied no step and did not escalate' } }), ms: Date.now() - t0 }
    },
  }
}

export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(ROLE + GRAPH_REFERENCE).digest('hex').slice(0, 12)
}
