// THE ANALYST — takes the questions a conversation could not answer from the semantic graph.
//
// One analyst for the project, in the shared workspace, with the semantic graph's tools and the data sources'. A
// question reaches it when the composer escalated. It answers with a program on the graph when the graph holds what the
// question needs in a way the composer did not find; otherwise it says what the graph is missing and where that is in
// the data, so it can be added. Programs read only the graph; the data tools are for understanding.

import { writeFile, mkdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentConfig, type AgentOverride } from '../../config/index.js'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { todayIn, turnOutcome, type TurnResult } from '../composer/index.js'

export interface AnalystOpts {
  root: string
  projectId: string
  sources: string[]
  managerUrl?: string
  projectDir?: string
  ica?: AgentOverride
}

export interface Analyst {
  ask(question: string, handlers: RunHandlers | undefined, opts: { qid: string; sessionId: string; reason?: string }): Promise<TurnResult>
  session: Session
  cwd: string
}

const ROLE = `You take the questions a conversation could not answer from the organisation's semantic graph.

Read the question in the graph's terms with ./resolve-terms, ./overview, ./describe, ./list-dimensions and the finds, and look into the data
with ./sources, ./find-schema, ./introspect and ./query to understand what the question needs and whether the graph
holds it in a way that was missed. When it does, answer with a program on the graph, program.mjs, run with ./run-program and given with ./commit:
its data comes only from the graph questions it asks. When it does not, ./escalate with what the graph is missing and
where it is in the data, which the person is told.

Each question comes with today's date, its qid and why it was handed over; every tool explains itself with --help.`

export async function createAnalyst(opts: AnalystOpts): Promise<Analyst> {
  const cfg = agentConfig('analyst')
  const harness: Harness = opts.ica?.harness ?? cfg.harness
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl, projectDir: opts.projectDir, tools: 'shared' })
  const context = (() => { try { return readFileSync(join(cwd, 'CONTEXT.md'), 'utf8') } catch { return '' } })()
  const session = createSession(harness, { cwd, model: opts.ica?.model ?? cfg.model, provider: opts.ica?.provider ?? cfg.provider, baseUrl: opts.ica?.baseUrl,
                                           resumeId: opts.ica?.resumeId, systemReference: [ROLE, context].join('\n\n') })

  return {
    cwd, session,
    async ask(question, handlers, o) {
      const t0 = Date.now()
      const dir = join(cwd, 'out', o.qid)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      await mkdir(dir, { recursive: true })
      await writeFile(join(cwd, '.turn'), o.qid)
      await writeFile(join(cwd, '.session'), o.sessionId)
      await writeFile(join(cwd, '.agent'), 'analyst')
      const turn = `${question}\n\ntoday: ${todayIn(opts.projectDir)}\nqid: ${o.qid}${o.reason ? `\nhanded over because: ${o.reason}` : ''}`
      await session.run(turn, { ...handlers, doneWhen: async () => (await turnOutcome(dir)) !== null })
      const outcome = await turnOutcome(dir)
      return { ...(outcome ?? { escalate: { reason: 'the analyst applied no step' } }), ms: Date.now() - t0 }
    },
  }
}

export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(ROLE).digest('hex').slice(0, 12)
}
