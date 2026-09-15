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
const questions: Array<[string, any, string?]> = [
  ['Timesheet hours, AU, August by week', { measures: ['TimeDay.hours', 'TimeDay.people'], by: [{ to: 'Week' }], where: [AU], span: { from: '2026-08-03', through: '2026-08-30' } }],
  ['Projected revenue, AU, Sep–Oct, hard and soft', { measures: ['AllocationDay.revenue', 'AllocationDay.hours', 'AllocationDay.unpriced hours'], by: [{ to: 'Month' }, { to: 'Commitment' }], where: [AU], span: { from: '2026-09-01', through: '2026-10-31' }, currency: 'AUD' }],
]
for (const [name, q] of questions) {
  t = Date.now()
  const a = await g.ask(q, { model: MODEL, today: '2026-09-15' })
  console.log(`\n── ${name} · ${((Date.now() - t) / 1000).toFixed(1)}s`)
  if (!a.ok) { console.log('  REFUSED/FAILED:', a.rule ?? '', a.reason); const c = g.store.getCall(a.callId); for (const s of c?.statements ?? []) console.log(`  read ${s.fact} ${s.source} ${s.rows} rows ${s.ms}ms`); continue }
  console.log('  columns', a.result.columns.map((c) => c.name).join(' | '))
  for (const r of a.result.rows) console.log('  ', r.map((x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x)).join(' | '))
  for (const c of a.caveats) console.log('  note:', c)
  for (const s of g.store.getCall(a.callId)!.statements) console.log(`  read ${s.fact} from ${s.source}: ${s.rows} rows in ${s.ms} ms`)
}
process.exit(0)
