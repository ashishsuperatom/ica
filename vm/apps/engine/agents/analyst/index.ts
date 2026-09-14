// THE ANALYST — builds what the graph is missing.
//
// One analyst for the project, in the shared workspace. A question reaches it when the composer escalated: the program
// it needs does not exist, and building it takes discovery — reading the data sources, understanding what their
// tables mean, writing concepts and the programs on them. It defines what it builds, then answers the person's
// question by applying a message to their data session with ./ask, like the composer does.

import { writeFile, mkdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentConfig, type AgentOverride } from '../../config/index.js'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { GRAPH_REFERENCE } from '../shared-prompts/graph-reference.js'
import { turnOutcome, type TurnResult } from '../composer/index.js'

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

const ROLE = `You build what the organisation's graph is missing, and answer the question that needed it.

A question reaches you when the program it needs does not exist. Find what exists with ./catalog, read a program with ./program, and use it. Explore
the data with ./sources, ./find-schema, ./introspect and ./query until you know what the tables mean and which rows
count — profile every column that classifies a row (its types, statuses and flags) before deciding — then write the concepts that read them (relations, at their finest grain, with shapes that say what each column
is) and the programs on those concepts, and ./define each, checking each with ./try — at the finest split a question
will use (per person, per week, per project), where a wrong definition shows as values that cannot be true. Name a program for the idea it
computes, not for the question that asked for it, so the next question finds it. The program a question asks returns
an answer: its views, its narration, and the next steps a person could take.

Finish by answering the person: apply a message to their data session with ./ask. Work in the foreground; every tool
explains itself with --help. A question is followed by \`qid:\` and, when the composer handed it over, why.`

export async function createAnalyst(opts: AnalystOpts): Promise<Analyst> {
  const cfg = agentConfig('analyst')
  const harness: Harness = opts.ica?.harness ?? cfg.harness
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl, projectDir: opts.projectDir })
  const context = (() => { try { return readFileSync(join(cwd, 'CONTEXT.md'), 'utf8') } catch { return '' } })()
  const session = createSession(harness, { cwd, model: opts.ica?.model ?? cfg.model, provider: opts.ica?.provider ?? cfg.provider, baseUrl: opts.ica?.baseUrl,
                                           resumeId: opts.ica?.resumeId, systemReference: [ROLE, GRAPH_REFERENCE, context].join('\n\n') })

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
      const turn = `${question}\n\nqid: ${o.qid}${o.reason ? `\nhanded over because: ${o.reason}` : ''}`
      await session.run(turn, { ...handlers, doneWhen: async () => (await turnOutcome(dir)) !== null })
      const outcome = await turnOutcome(dir)
      return { ...(outcome ?? { escalate: { reason: 'the analyst applied no step' } }), ms: Date.now() - t0 }
    },
  }
}

export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(ROLE + GRAPH_REFERENCE).digest('hex').slice(0, 12)
}
