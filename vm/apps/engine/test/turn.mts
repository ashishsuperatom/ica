// One or more questions through the composer and analyst, without the hub: the same agents, tools and graph the engine
// uses, against the local datasource manager, in a state directory of its own.
//
//   DATASOURCE_URL=http://127.0.0.1:4021 pnpm exec tsx apps/engine/test/turn.mts <project-id> "<question>" ["<follow-up>" …]
//
// STATE (default ~/.superatom/state/graph-trial, outside the repository) keeps the graph between runs, so a second run finds what the first built.

import { copyFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createComposer } from '../agents/composer/index.js'
import { createAnalyst } from '../agents/analyst/index.js'
import { openProjectGraph } from '../graph/project.js'
import type { RunHandlers } from '../ica/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const vm = join(here, '..', '..', '..')
const [project, ...questions] = process.argv.slice(2)
if (!project || !questions.length) { console.error('usage: turn.mts <project-id> "<question>" ["<follow-up>" …]'); process.exit(1) }
const managerUrl = process.env.DATASOURCE_URL ?? 'http://127.0.0.1:4021'
const stateRoot = process.env.ENGINE_STATE_DIR ?? join(homedir(), '.superatom', 'state')
const root = process.env.STATE ?? join(stateRoot, 'graph-trial')
const projectDir = join(vm, 'projects', project)
const dbDir = join(root, project, 'db')
mkdirSync(dbDir, { recursive: true })
// The datasource index is the engine's, built from the sources; a trial borrows the project's rather than rebuild it.
const index = join(stateRoot, project, 'db', 'datasource-index.sqlite')
if (!existsSync(join(dbDir, 'datasource-index.sqlite')) && existsSync(index)) copyFileSync(index, join(dbDir, 'datasource-index.sqlite'))

const graph = await openProjectGraph({ dbDir, projectDir, managerUrl })
const sid = process.env.SESSION ?? `trial-${Date.now().toString(36)}`
graph.sessions.open({ id: sid })
const log = join(root, project, `${sid}.log`)
const handlers = (agent: string): RunHandlers => ({
  onEvent: (ev: any) => {
    appendFileSync(log, JSON.stringify({ agent, ...ev }) + '\n')
    if (ev.kind === 'command' && ev.command && !ev.done && ev.status !== 'completed') console.log(`  ${agent} $ ${String(ev.command).replace(/\s+/g, ' ').slice(0, 160)}`)
  },
})

const composer = await createComposer({ root, projectId: project, managerUrl, projectDir, sessionId: sid })
let analyst: Awaited<ReturnType<typeof createAnalyst>> | null = null
for (const [i, question] of questions.entries()) {
  const qid = `q${i + 1}-${Date.now().toString(36)}`
  const t0 = Date.now()
  console.log(`\n── ${question}`)
  let r = await composer.ask(question, handlers('composer'), { qid, sessionId: sid })
  let by = 'composer'
  if (r.escalate) {
    console.log(`  composer escalated: ${r.escalate.reason}`)
    analyst ??= await createAnalyst({ root, projectId: project, sources: [], managerUrl, projectDir })
    r = await analyst.ask(question, handlers('analyst'), { qid, sessionId: sid, reason: r.escalate.reason })
    by = 'analyst'
  }
  const step = r.step != null ? graph.sessions.history(sid).steps.find((s) => s.id === r.step) : null
  const answer: any = step?.callId ? graph.store.getCall(step.callId)?.output : null
  console.log(`  ${by} · ${((Date.now() - t0) / 1000).toFixed(0)}s · step ${step?.id ?? '—'}${step?.error ? ` · ERROR ${step.error}` : ''}`)
  if (step) console.log(`  state ${JSON.stringify(step.state)}`)
  if (answer?.narration) for (const s of answer.narration) console.log(`  » ${s.text}`)
  if (answer?.nextSteps) console.log(`  next: ${answer.nextSteps.map((n: any) => n.label).join(' · ')}`)
  if (answer?.rows) console.log(`  ${answer.rows.length} rows: ${JSON.stringify(answer.rows.slice(0, 3))}`)
}
console.log(`\nprograms: ${graph.catalog().map((e) => e.name).join(', ')}\nlog: ${log}`)
composer.session.stop?.(); analyst?.session.stop?.()
process.exit(0)
