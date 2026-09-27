// THE READER — answers a person's typed questions in prose, from the graph, for the screen they are looking at.
//
// One reader per thread, in the thread's own directory, the way the composer has one per conversation: follow-ups
// keep their memory there. It is given what the person is looking at — the block's question and what it showed, and
// the blocks above it — and the question they typed. It asks the graph and writes markdown, nothing else: no program,
// no step, no commit, no built UI. Every figure it writes comes from an ask, and the calls it made are returned beside
// the answer so each number can be traced. The turn ends when the answer file is written.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentConfig, type AgentOverride } from '../../config/index.js'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { todayIn } from '../composer/index.js'

export interface ReaderOpts {
  root: string
  projectId: string
  managerUrl?: string
  projectDir?: string
  /** The thread this reader belongs to: its directory, and the data session its asks are recorded under. */
  sessionId: string
  ica?: AgentOverride
}

export interface Said { markdown: string | null; ms: number }

export interface Reader {
  say(text: string, context: string, handlers: RunHandlers | undefined, o: { qid: string }): Promise<Said>
  session: Session
  cwd: string
  sessionId: string
}

const ROLE = `You answer a person's questions about their organisation's data, in prose, as they look at a screen.
The data is a graph. Facts record events at a grain and carry measures; entities are things with identity, carrying
attributes; a fact's dimensions — the entities, attributes and calendar levels it reaches along links — slice and filter
its measures. A question of the graph is measures, grouped by dimensions, kept to some records or named conditions, over
a span. The graph checks each question and explains any it cannot answer as asked.
Each question comes with what the person is looking at: the question their screen is answering, what it showed, and the
screens above it. Words like "this", "those", "the second one" or "same for October" mean that screen; "all", "every"
or "overall" reach past it. Later questions in the same thread follow from the earlier ones.
Read names into the graph with ./match when they need resolving; ./look shows the graph when a reading needs
settling; ./ask evaluates a question to see what the data says. A question takes as long as it takes: wait for the
tools rather than cutting them short. Ask what the question needs and no more.
Write the answer as markdown to the path given: the figure or figures asked for, each from an ask you made, with the
context it holds for — the span, the scope, an exclusion that changes how a number reads — and what the data cannot say,
when it cannot. Short: what was asked, nothing that repeats the screen. Numbers in prose or a small table, whichever
reads better. Writing that file is the whole of your answer and ends the turn.
You work only in this folder and reach the graph only through its tools. Never read, list, search or run anything
outside this folder. Tools: ./match ./look ./ask — each explains itself with --help.`

export async function createReader(opts: ReaderOpts): Promise<Reader> {
  // A reader is a capable agent on the composer's profile — a light model loops where a strong one asks twice and writes.
  const cfg = agentConfig('composer')
  const harness: Harness = opts.ica?.harness ?? (process.env.ICA_READER_HARNESS as Harness | undefined) ?? cfg.harness
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl, projectDir: opts.projectDir, sessionId: opts.sessionId, tools: 'conversation' })
  // Only the graph's readers are in reach: what asks and looks. What runs programs, commits steps, escalates or
  // records intent is not this agent's, and is not left in its folder.
  for (const tool of ['run-program', 'commit', 'escalate', 'intent', 'trace']) await rm(join(cwd, tool), { force: true }).catch(() => {})
  const session = createSession(harness, { cwd, model: opts.ica?.model ?? process.env.ICA_READER_MODEL ?? cfg.model, provider: opts.ica?.provider ?? process.env.ICA_READER_PROVIDER ?? cfg.provider,
                                           thinking: cfg.thinking, baseUrl: opts.ica?.baseUrl, systemReference: ROLE })
  if (session.referencePlacement !== 'in-context') console.warn(`[reader] harness "${harness}" cannot put the reference in the system prompt`)
  return {
    cwd, session, sessionId: opts.sessionId,
    async say(text, context, handlers, o) {
      const t0 = Date.now()
      const dir = join(cwd, 'out', o.qid)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      await mkdir(dir, { recursive: true })
      await writeFile(join(cwd, '.turn'), o.qid)
      await writeFile(join(cwd, '.session'), opts.sessionId)
      await writeFile(join(cwd, '.agent'), 'reader')
      const answerFile = join(dir, 'said.md')
      const read = async () => { try { const t = (await readFile(answerFile, 'utf8')).trim(); return t || null } catch { return null } }
      const prompt = `What the person is looking at:\n${context}\n\nTheir question: ${text}\n\ntoday: ${todayIn(opts.projectDir)}\nqid: ${o.qid}\nWrite the answer to out/${o.qid}/said.md`
      await session.run(prompt, { ...handlers, doneWhen: async () => (await read()) !== null })
      return { markdown: await read(), ms: Date.now() - t0 }
    },
  }
}

export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(ROLE).digest('hex').slice(0, 12)
}
