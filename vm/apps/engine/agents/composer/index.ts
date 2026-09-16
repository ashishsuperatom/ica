// THE COMPOSER — answers a conversation's questions from the semantic graph.
//
// One composer per conversation, in the conversation's own directory. It reads the question in the graph's terms and
// answers with a program on the graph, run with ./run-program and given as the conversation's next step with ./commit — or hands the question
// to the analyst with ./escalate when the graph does not hold what it needs. The turn ends when a step has been applied
// (out/<qid>/built.json), the question has been escalated, or an explanation has been written.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentConfig, type AgentOverride } from '../../config/index.js'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { projectSettings } from '../../graph/semantic.js'

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
  /** An explain: turn wrote its explanation. */
  explained?: true
  ms: number
}

export interface Composer {
  ask(question: string, handlers: RunHandlers | undefined, opts: { qid: string; sessionId: string }): Promise<TurnResult>
  session: Session
  cwd: string
}

const ROLE = `You answer a person's questions about their organisation's data as their conversation goes on.

The data is a graph. Facts record events at a grain and carry measures; entities are things with identity, carrying
attributes; a fact's dimensions — the entities, attributes and calendar levels it reaches along links — slice and filter
its measures. A question of the graph is measures, grouped by dimensions, kept to some records or named conditions, over
a span. The graph checks each question and explains any
it cannot answer as asked.

Read the question in the graph's terms: resolve its terms, settle what is ambiguous or missing with the other finds, and
see how the measures can be grouped by its dimensions; check the questions the answer needs and try them to see the data.

Then answer with a program in this folder, program.mjs. Its data comes only from the graph questions it asks;
it shapes them into what a person deciding needs — the headline figure, the tables and charts that show it, up to five
points, each a sentence with every number cited from its cells, and what they could look at next.

The points are read first: the answer compressed, and how to read what follows. They say what the tables cannot:
a figure computed across the rows — a share, a rate, a gap, a concentration;
what changed, and where the change sits; what stands apart from the rest; an assumption or exclusion that changes how
the numbers read; what this data cannot tell. A point that repeats a row is left out.

The program answers this question now and again later, or for a variant of it. What the question varies — a period, a
record, a limit — and each judgement the answer turns on — a threshold, a cutoff — are params with the default you
chose; a window relative to today is worked out from the run date. When the question leaves one unsaid, run on the
default and say what you took with ctx.caveat. An answer stands alone: the time it holds for comes with it from the
graph questions it asks; it says its scope, how far to trust it, and the true total when a list is cut short; a slice
the data covers is given as that slice; an empty or surprising figure is looked into before it is reported. When the
data cannot answer, the program shows the gap from the data and returns status unknowable, or uncertain when it cannot
answer with confidence, with what is missing.

Run the program, read its answer against the question as asked, correct it and run it again; when it answers the
question, ./commit it as your final action. A refusal says what to change. When the graph does not hold what the
question needs, answer what it does hold and say plainly what differs, or escalate with what is missing.

You work only in this folder. Write your program here and reach the graph and the data only through its tools. Never read, list, search or run anything outside this folder.

Tools: ./resolve-terms ./find-measure ./find-dimension ./find-record ./describe ./list-dimensions ./group-paths ./overview ./complete-question ./read-question ./check-question ./try-question
./run-program ./commit ./trace-answer ./escalate — each explains itself with --help. Each question comes with today's date and its qid.`

/** The date a question is asked on, in the organisation's time zone (settings.json \`timezone\`), else UTC — never the
 *  server's. An agent is not otherwise told what day it is. */
export function todayIn(projectDir?: string): string {
  const zone = zoneOf(projectDir)
  return `${dayIn(zone)} (${zone})`
}
const zoneOf = (projectDir?: string) => (projectDir ? projectSettings(projectDir).timezone : undefined) as string | undefined ?? 'UTC'
const dayIn = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
/** The date alone, as a program's ctx.today reads it. */
export const dayOf = (projectDir?: string) => dayIn(zoneOf(projectDir))

export async function turnOutcome(dir: string): Promise<{ step?: number; escalate?: { reason: string }; explained?: true } | null> {
  try { const s = JSON.parse(await readFile(join(dir, 'built.json'), 'utf8')); if (typeof s.step === 'number') return { step: s.step } } catch { /* not yet */ }
  try { const e = JSON.parse(await readFile(join(dir, 'escalate.json'), 'utf8')); return { escalate: { reason: String(e.reason ?? 'escalated') } } } catch { /* not yet */ }
  // An explain: turn reports on an answer and is done when its explanation is written.
  try { if ((await readFile(join(dir, 'explain.md'), 'utf8')).trim()) return { explained: true } } catch { /* not yet */ }
  return null
}

export async function createComposer(opts: ComposerOpts): Promise<Composer> {
  const cfg = agentConfig('composer')
  const harness: Harness = opts.ica?.harness ?? cfg.harness
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl, projectDir: opts.projectDir, sessionId: opts.sessionId, tools: 'conversation' })
  const session = createSession(harness, { cwd, model: opts.ica?.model ?? cfg.model, provider: opts.ica?.provider ?? cfg.provider, thinking: cfg.thinking, baseUrl: opts.ica?.baseUrl,
                                           systemReference: ROLE })
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
  return createHash('sha256').update(ROLE).digest('hex').slice(0, 12)
}
