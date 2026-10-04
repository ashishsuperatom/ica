// THE ANALYST — one agent for the project, in the shared workspace, with the data tools: a terminal a person can
// open and work in (and log in through). It answers nothing on its own; no question is handed to it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentConfig, type AgentOverride } from '../../config/index.js'
import { createSession, prepareWorkspace, type Harness, type Session } from '../../ica/index.js'

export interface AnalystOpts {
  root: string
  projectId: string
  sources: string[]
  managerUrl?: string
  projectDir?: string
  ica?: AgentOverride
}

export interface Analyst {
  session: Session
  cwd: string
}

const ROLE = `You explore the organisation's data with the person you are working with. Read it with ./sources,
./find-schema, ./get-schema and ./query; each explains itself with --help. Work only in this folder.`

export async function createAnalyst(opts: AnalystOpts): Promise<Analyst> {
  const cfg = agentConfig('analyst')
  const harness: Harness = opts.ica?.harness ?? cfg.harness
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl, projectDir: opts.projectDir, tools: 'shared' })
  const context = (() => { try { return readFileSync(join(cwd, 'CONTEXT.md'), 'utf8') } catch { return '' } })()
  const session = createSession(harness, { cwd, model: opts.ica?.model ?? cfg.model, provider: opts.ica?.provider ?? cfg.provider, thinking: cfg.thinking, baseUrl: opts.ica?.baseUrl,
                                           resumeId: opts.ica?.resumeId, systemReference: [ROLE, context].join('\n\n') })
  return { cwd, session }
}

export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(ROLE).digest('hex').slice(0, 12)
}
