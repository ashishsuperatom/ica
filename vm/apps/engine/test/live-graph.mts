// A project's semantic graph against its real sources, through a datasource manager: loaded with every definition
// check, then the questions whose answers the project knows. The questions are the project's, in its home:
// <state>/<projectId>/checks/graph-questions.json — [{ name, today, question, expect? }]. Its answers are recorded in
// <state>/<projectId>/checks/db, apart from the engine's own memory.
//
//   DATASOURCE_URL=http://127.0.0.1:4021 pnpm exec tsx apps/engine/test/live-graph.mts <projectId> [words in a question's name]

import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MODEL, openSemanticGraph } from '../graph/semantic.js'

const [projectId, ...words] = process.argv.slice(2)
if (!projectId) { console.error('usage: live-graph.mts <projectId> [words in a question\'s name]'); process.exit(1) }
const home = join(process.env.ENGINE_STATE_DIR ?? join(homedir(), '.superatom', 'state'), projectId)
const managerUrl = process.env.DATASOURCE_URL ?? 'http://127.0.0.1:4021'
const dbDir = join(home, 'checks', 'db')
mkdirSync(dbDir, { recursive: true })
const questions: Array<{ name: string; today?: string; question: any; expect?: string }> = JSON.parse(readFileSync(join(home, 'checks', 'graph-questions.json'), 'utf8'))
const chosen = words.length ? questions.filter((q) => words.every((w) => q.name.toLowerCase().includes(w.toLowerCase()))) : questions

let t = Date.now()
console.log('loading the graph and checking every source…')
const g = await openSemanticGraph({ dbDir, projectDir: home, managerUrl })
console.log(`loaded and checked in ${((Date.now() - t) / 1000).toFixed(1)}s`)

for (const { name, today, question, expect } of chosen) {
  t = Date.now()
  const a = await g.ask(question, { model: MODEL, ...(today ? { today } : {}) })
  console.log(`\n── ${name} · ${((Date.now() - t) / 1000).toFixed(1)}s`)
  if (expect) console.log(`  expected: ${expect}`)
  if (!a.ok) { console.log('  REFUSED/FAILED:', a.rule ?? '', a.reason); continue }
  console.log('  columns', a.result.columns.map((c) => c.name).join(' | '))
  const label = (i: number, x: unknown) => (a.result.labels?.[i]?.[String(x)] ?? x)
  for (const r of a.result.rows) console.log('  ', r.map((x, i) => (typeof x === 'number' ? Math.round(x * 100) / 100 : label(i, x))).join(' | '))
  for (const tot of a.result.totals ?? []) for (const r of tot.rows) console.log('   total', JSON.stringify(tot.by), r.map((x) => (typeof x === 'number' ? Math.round(x) : x)).join(' | '))
  for (const c of a.caveats) console.log('  note:', c)
}
process.exit(0)
