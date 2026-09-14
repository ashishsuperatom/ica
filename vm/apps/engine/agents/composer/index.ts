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
import { projectSettings } from '../../graph/project.js'

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

A NEW QUESTION IS READ BEFORE IT IS ANSWERED. Turn the person's words into a structured request, then ask it once:
1. Find the program whose measures and dimensions fit the question: ./catalog lists programs, ./program shows one.
2. Say what each part of the question means for that program — the measure, each word it filters on as the person
   typed it, the period as dates (today's date comes with the question), the splits — and check it with ./interpret.
   It resolves each word to the member it means ("AU" to a subsidiary) and returns the request, or says what the
   program cannot take and which words match no member or several.
3. Ask the request it returns with ./ask. Check other readings with ./try; ./ask applies only the answer.
When the program cannot take a part of the question, read it against another program, or ./escalate "<what is
missing>" — writing concepts and deciding what the data means is the analyst's work. When a word matches several
members, pick the one the question clearly means or escalate saying which.

A follow-up changes the current state with a message — a filter, a split, another span. When "that one" or "the third
customer" points at something already shown, ./find it rather than guess. Answer the question that was asked; a nearby
question's answer reads as this one's.

A question is followed by \`today:\` and \`qid:\` — the date it is asked on, and which turn this is. Every tool explains
itself with --help.`

/** The date a question is asked on, in the organisation's time zone (settings.json \`timezone\`), else UTC — never the
 *  server's. An agent is not otherwise told what day it is. */
export function todayIn(projectDir?: string): string {
  const zone = (projectDir ? projectSettings(projectDir).timezone : undefined) as string | undefined ?? 'UTC'
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return `${day} (${zone})`
}

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
      await session.run(`${question}\n\ntoday: ${todayIn(opts.projectDir)}\nqid: ${o.qid}`, { ...handlers, doneWhen: async () => (await turnOutcome(dir)) !== null })
      const outcome = await turnOutcome(dir)
      return { ...(outcome ?? { escalate: { reason: 'the composer applied no step and did not escalate' } }), ms: Date.now() - t0 }
    },
  }
}

export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(ROLE + GRAPH_REFERENCE).digest('hex').slice(0, 12)
}
