// THE COMPOSER — answers a conversation's questions: from the semantic graph first, and from the data behind it when
// the graph does not hold what a question needs.
//
// One composer per conversation, in the conversation's own directory, so follow-ups keep their memory there. Asked in
// a chat, it answers with a program on the graph, run with ./run-program and given as the conversation's next step
// with ./commit. Asked from a screen of the project's application, it answers in prose, written to out/<qid>/said.md.
// It is a coding agent: what the graph gives it, it composes on in its own folder; what the graph refuses, it reaches
// through the datasource index and the query tool, and the answer says which parts stood on the model. Nothing is
// handed to another agent. The turn ends when a step has been applied (out/<qid>/built.json), an explanation has been
// written, or the prose answer is on disk.

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
  /** Why no step was applied, when none was. */
  unanswered?: { reason: string }
  /** An explain: turn wrote its explanation. */
  explained?: true
  ms: number
}

export interface Said { markdown: string | null; queries: QueryRecord[]; ms: number }
/** A query the composer sent to a source itself, outside the graph: recorded with the turn, so the modeller can read
 *  what the graph did not hold and the answer can say which parts did not stand on the model. */
export interface QueryRecord { source: string; query: string; rows: number; ms: number; at: number; error?: string }

export interface Composer {
  ask(question: string, handlers: RunHandlers | undefined, opts: { qid: string; sessionId: string }): Promise<TurnResult>
  /** A question in prose, asked from a screen: the answer is markdown at out/<qid>/said.md. */
  say(text: string, context: string, handlers: RunHandlers | undefined, opts: { qid: string }): Promise<Said>
  session: Session
  cwd: string
  sessionId: string
}

const ROLE = `You answer a person's questions about their organisation's data as their conversation goes on.

The data is a graph. Facts record events at a grain and carry measures; entities are things with identity, carrying
attributes; a fact's dimensions — the entities, attributes and calendar levels it reaches along links — slice and filter
its measures. A question of the graph is measures, grouped by dimensions, kept to some records or named conditions, over
a span. The graph checks each question and explains any
it cannot answer as asked.

A question takes as long as it takes: the tools that read run to the end, and asking the same thing again in this
turn costs nothing, so wait for them rather than cutting them short.

Read the question into the graph with ./match: it resolves the words, finds every subgraph the question could be,
says each back in the graph's own words and tries the best few against the data. ./look shows the graph itself when
a reading needs settling, and ./ask evaluates a question to see what the data says.

The graph comes first: what it holds is defined once, checked, and kept to the organisation's rules. When it refuses
or does not hold what the question needs, ./ask --raw shows what the nearest ask sent to each source; take that as
the base, and compose your own query for the remainder with ./find-schema, ./sources and ./query. Say in the answer
which parts stood on the model and which did not.

./intent says what a person in this situation is deciding, what an answer must carry to serve that, and what was
learned the last time this ground was covered. Point each requirement it names at the figure in your answer that
meets it, and run ./intent judge before you commit: what it calls unmet is not yet answered. What it holds is what is WANTED; the graph holds what is TRUE. Read
it before choosing what to compute, and check your answer against it before you commit. What either graph lacks is
suggested there, never assumed: answer with what is held today and say plainly what differs.

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
question needs, answer what it does hold and say plainly what differs; there is nobody to hand it to.

A question asked from a screen of the application comes with what the person is looking at: the question their
screen is answering, what it showed, and the screens above it. Words like "this", "those", "the second one" or "same
for October" mean that screen; "all", "every" or "overall" reach past it. Answer it in prose, as markdown written to
the path given: the figures asked for, with the context they hold for — the span, the scope, an exclusion that
changes how a number reads — and what the data cannot say, when it cannot. Short: what was asked, nothing that
repeats the screen. Writing that file is the whole of the answer and ends the turn.

You work in this folder: your programs and scripts live here, and you reach the graph and the data through its tools.

Tools: ./match ./look ./ask ./intent ./find-schema ./sources ./query ./introspect ./resolve ./run-program ./commit
./trace — each explains itself with --help.
Each question comes with today's date and its qid.`

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

export async function turnOutcome(dir: string): Promise<{ step?: number; unanswered?: { reason: string }; explained?: true } | null> {
  try { const s = JSON.parse(await readFile(join(dir, 'built.json'), 'utf8')); if (typeof s.step === 'number') return { step: s.step } } catch { /* not yet */ }
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

  const queriesOf = async (qid: string): Promise<QueryRecord[]> => {
    try { return (await readFile(join(cwd, 'out', qid, 'queries.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
  }
  return {
    cwd, session, sessionId: opts.sessionId ?? '',
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
      return { ...(outcome ?? { unanswered: { reason: 'the composer applied no step' } }), ms: Date.now() - t0 }
    },
    async say(text, context, handlers, o) {
      const t0 = Date.now()
      const dir = join(cwd, 'out', o.qid)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      await mkdir(dir, { recursive: true })
      await writeFile(join(cwd, '.turn'), o.qid)
      await writeFile(join(cwd, '.session'), opts.sessionId ?? '')
      await writeFile(join(cwd, '.agent'), 'composer')
      const answerFile = join(dir, 'said.md')
      const read = async () => { try { const t = (await readFile(answerFile, 'utf8')).trim(); return t || null } catch { return null } }
      const prompt = `What the person is looking at:\n${context}\n\nTheir question: ${text}\n\ntoday: ${todayIn(opts.projectDir)}\nqid: ${o.qid}\nWrite the answer to out/${o.qid}/said.md`
      await session.run(prompt, { ...handlers, doneWhen: async () => (await read()) !== null })
      return { markdown: await read(), queries: await queriesOf(o.qid), ms: Date.now() - t0 }
    },
  }
}

export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(ROLE).digest('hex').slice(0, 12)
}
