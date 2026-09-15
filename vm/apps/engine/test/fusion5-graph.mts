// The Fusion5 semantic graph against NetSuite through the local datasource manager: loaded with every definition check,
// then the questions whose answers are known.
//
//   DATASOURCE_URL=http://127.0.0.1:4021 pnpm exec tsx apps/engine/test/fusion5-graph.mts

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MODEL, openSemanticGraph } from '../graph/semantic.js'

const managerUrl = process.env.DATASOURCE_URL ?? 'http://127.0.0.1:4021'
const projectDir = join(import.meta.dirname, '..', '..', '..', 'projects', '96b7087f-e3bb-4e8b-a96e-b3cafcea1cef')
const dbDir = join(homedir(), '.superatom', 'state', 'graph-trial', 'fusion5-semantic', 'db')
mkdirSync(dbDir, { recursive: true })

let t = Date.now()
console.log('loading the graph and checking every source at NetSuite…')
const g = await openSemanticGraph({ dbDir, projectDir, managerUrl })
console.log(`loaded and checked in ${((Date.now() - t) / 1000).toFixed(1)}s`)

const AU = { to: 'Subsidiary', in: ['AU'] }
const PMO = { condition: 'PMO project' }
const questions: Array<[string, any, string?]> = [
  ['PMO Summary: projects and estimated remaining budget by pillar and RAG', { measures: ['ProjectState.projects', 'ProjectDelivery.estimated remaining budget'], by: [{ to: 'Pillar' }, { attribute: 'rag', of: 'Project' }], where: [PMO], currency: 'AUD', totals: [['Project.rag']] }],
  ['Q1 red FO projects, managers, estimated remaining', { measures: ['ProjectDelivery.estimated remaining budget'], by: [{ to: 'Project' }, { to: 'Person', via: ['project', 'manager'] }], where: [PMO, { attribute: 'rag', of: 'Project', in: ['Red'] }, { to: 'Pillar', in: ['37'] }], currency: 'AUD', order: { by: 'ProjectDelivery.estimated remaining budget', desc: true } }],
  // ['Q4 red Milestone Fixed Price: total at risk', { measures: ['ProjectState.projects', 'ProjectDelivery.estimated remaining budget'], where: [PMO, { attribute: 'rag', of: 'Project', in: ['Red'] }, { to: 'ProjectType', via: ['project', 'type'], in: ['14'] }], currency: 'AUD' }],
  // ['Q7 senior suppliers with red and amber projects', { measures: ['ProjectState.projects', 'ProjectDelivery.estimated remaining budget'], by: [{ to: 'Person', via: ['project', 'senior supplier'] }], where: [PMO, { attribute: 'rag', of: 'Project', in: ['Red', 'Amber'] }], currency: 'AUD', order: { by: 'ProjectState.projects', desc: true }, limit: 5 }],
  // ['Q8 red, go-live in 60 days, over $100K remaining', { measures: ['ProjectDelivery.estimated remaining budget'], by: [{ to: 'Project' }], where: [PMO, { attribute: 'rag', of: 'Project', in: ['Red'] }, { attribute: 'go-live', of: 'Project', range: { from: '2026-09-15', to: '2026-11-15' } }], having: [{ output: 'ProjectDelivery.estimated remaining budget', op: '>', value: 100000 }], currency: 'AUD' }],
]
for (const [name, q] of questions) {
  t = Date.now()
  const a = await g.ask(q, { model: MODEL, today: '2026-09-15' })
  console.log(`\n── ${name} · ${((Date.now() - t) / 1000).toFixed(1)}s`)
  if (!a.ok) { console.log('  REFUSED/FAILED:', a.rule ?? '', a.reason); const c = g.store.getCall(a.callId); for (const s of c?.statements ?? []) console.log(`  read ${s.fact} ${s.source} ${s.rows} rows ${s.ms}ms`); continue }
  console.log('  columns', a.result.columns.map((c) => c.name).join(' | '))
  const label = (i: number, x: unknown) => (a.result.labels?.[i]?.[String(x)] ?? x)
  for (const r of a.result.rows) console.log('  ', r.map((x, i) => (typeof x === 'number' ? Math.round(x * 100) / 100 : label(i, x))).join(' | '))
  for (const t of a.result.totals ?? []) for (const r of t.rows) console.log('   total', JSON.stringify(t.by), r.map((x) => (typeof x === 'number' ? Math.round(x) : x)).join(' | '))
  for (const c of a.caveats) console.log('  note:', c)
  for (const s of g.store.getCall(a.callId)!.statements) console.log(`  read ${s.fact} from ${s.source}: ${s.rows} rows in ${s.ms} ms`)
}
process.exit(0)
