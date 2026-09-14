// What the graph engine can do on this project's NetSuite, measured: every capability a program relies on, exercised
// once on the project's own concepts over a small window, with how long it took, what it asked NetSuite, and the
// exact refusal or error when it failed. Run before building programs on a source, and after changing the engine.
//
//   DATASOURCE_URL=http://127.0.0.1:4020 pnpm exec tsx apps/engine/test/netsuite-check.mts [<project-id>]
//
// A temporary graph is used; the project's graph is not touched. Each check stops waiting after 60 seconds (the
// query may still be running in NetSuite).

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProjectGraph } from '../graph/project.js'

const here = dirname(fileURLToPath(import.meta.url))
const project = process.argv[2] ?? '96b7087f-e3bb-4e8b-a96e-b3cafcea1cef'
const projectDir = join(here, '..', '..', '..', 'projects', project)
const managerUrl = process.env.DATASOURCE_URL ?? 'http://127.0.0.1:4020'
const LIMIT_MS = 60_000

const dbDir = mkdtempSync(join(tmpdir(), 'netsuite-check-'))
const engine = await openProjectGraph({ dbDir, projectDir, managerUrl })
const define = async (dir: string, name = dir) => {
  const base = join(projectDir, 'programs', dir)
  const contract = JSON.parse(readFileSync(join(base, 'contract.json'), 'utf8'))
  await engine.define({ contract: { ...contract, name }, body: readFileSync(join(base, 'program.mjs'), 'utf8') }, { by: 'netsuite-check' })
}
for (const d of ['exchange rates', 'people', 'projects', 'time entries', 'working days', 'allocations', 'allocation revenue', 'budget', 'base budget']) await define(d)

// Relations built on relations, to measure nesting.
const timeShape = JSON.parse(readFileSync(join(projectDir, 'programs', 'time entries', 'contract.json'), 'utf8')).shape
await engine.define({
  contract: { name: 'approved time', kind: 'program', description: 'Approved timesheet lines.', reads: { sources: [], programs: ['time entries'] }, params: {}, returns: 'relation', shape: timeShape },
  body: `export default () => ({ sql: "SELECT t.* FROM {{time entries}} t WHERE t.approval_id = 3" })`,
}, { by: 'netsuite-check' })
await engine.define({
  contract: { name: 'approved billable time', kind: 'program', description: 'Approved, billable timesheet lines.', reads: { sources: [], programs: ['approved time'] }, params: {}, returns: 'relation', shape: timeShape },
  body: `export default () => ({ sql: "SELECT t.* FROM {{approved time}} t WHERE t.billable = 'T'" })`,
}, { by: 'netsuite-check' })

const WEEK = { from: '2026-09-07', to: '2026-09-14' }
type Check = { area: string; name: string; run: () => Promise<{ callId?: string; note?: string }> }
const ask = async (program: string, request: Record<string, unknown>, expect?: (v: any) => string | null) => {
  const r = await engine.call<any>(program, request)
  const problem = expect?.(r.value)
  if (problem) throw new Error(`wrong result: ${problem}`)
  const rows = Array.isArray(r.value?.rows) ? r.value.rows : []
  return { callId: r.callId, note: `${rows.length} rows ${JSON.stringify(rows.slice(0, 2)).slice(0, 140)}` }
}
const rowsAtLeast = (n: number) => (v: any) => (v.rows.length >= n ? null : `expected at least ${n} rows, got ${v.rows.length}`)

const checks: Check[] = [
  // ── a relation in NetSuite ─────────────────────────────────────────────────────────────────────────────────────
  { area: 'sql', name: 'stock at today, split by a dimension', run: () => ask('people', { measures: ['headcount'], by: ['subsidiary'], where: { active: 'T' }, at: 'today' }, rowsAtLeast(2)) },
  { area: 'sql', name: 'filter on a dimension by id', run: () => ask('people', { measures: ['headcount'], where: { subsidiary: '2', active: 'T' }, at: 'today' }, rowsAtLeast(1)) },
  { area: 'sql', name: 'filter on a dimension by label', run: () => ask('people', { measures: ['headcount'], where: { subsidiary_label: 'Fusion5 Pty Ltd', active: 'T' }, at: 'today' }, rowsAtLeast(1)) },
  { area: 'sql', name: 'filter by a name given where the id belongs', run: () => ask('people', { measures: ['headcount'], where: { pillar: 'CEC', active: 'T' }, at: 'today' }) },
  { area: 'sql', name: 'contains on a label', run: () => ask('people', { measures: ['headcount'], by: ['pillar'], where: { pillar_label: { contains: 'net' }, active: 'T' }, at: 'today' }, rowsAtLeast(1)) },
  { area: 'sql', name: 'order and limit', run: () => ask('people', { measures: ['headcount'], by: ['pillar'], where: { active: 'T' }, order: [{ by: 'headcount', desc: true }], limit: 3, at: 'today' }, (v) => (v.rows.length === 3 ? null : `limit 3 gave ${v.rows.length}`)) },
  { area: 'sql', name: 'limit per group', run: () => ask('people', { measures: ['headcount'], by: ['subsidiary', 'pillar'], where: { active: 'T' }, order: [{ by: 'headcount', desc: true }], limit: 2, limitPer: ['subsidiary'], at: 'today' }, rowsAtLeast(2)) },
  { area: 'sql', name: 'having', run: () => ask('people', { measures: ['headcount'], by: ['pillar'], where: { active: 'T' }, having: { headcount: { gte: 50 } }, at: 'today' }, (v) => (v.rows.every((r: any) => r.headcount >= 50) ? null : 'a row below the having')) },
  { area: 'sql', name: 'flow by day over a week', run: () => ask('time entries', { measures: ['hours'], by: ['day'], during: WEEK }, rowsAtLeast(5)) },
  { area: 'sql', name: 'flow by week and month', run: () => ask('time entries', { measures: ['hours'], by: ['month'], during: { from: '2026-08-01', to: '2026-09-14' } }, rowsAtLeast(2)) },
  { area: 'sql', name: 'relative span: previous week', run: () => ask('time entries', { measures: ['hours'], during: { previous: 'week' } }, rowsAtLeast(1)) },
  { area: 'sql', name: 'compare with a week before', run: () => ask('time entries', { measures: ['hours'], during: WEEK, compare: { offset: { weeks: 1 } } }, rowsAtLeast(1)) },
  { area: 'sql', name: 'totals and share', run: () => ask('time entries', { measures: ['hours'], by: ['billable'], during: WEEK, totals: [[]], share: { measures: ['hours'], within: [] } }, rowsAtLeast(2)) },
  { area: 'sql', name: 'cumulative by day', run: () => ask('time entries', { measures: ['hours'], by: ['day'], during: WEEK, cumulative: true }, rowsAtLeast(5)) },
  { area: 'sql', name: 'attribute through an entity (SQL to SQL)', run: () => ask('time entries', { measures: ['hours'], by: ['employee.subsidiary'], during: WEEK }, rowsAtLeast(2)) },
  { area: 'sql', name: 'money converted at rates (SQL to SQL)', run: () => ask('time entries', { measures: ['charged_amount'], during: WEEK, currency: 'AUD' }, rowsAtLeast(1)) },
  { area: 'sql', name: 'money refused across currencies', run: () => ask('time entries', { measures: ['charged_amount'], during: WEEK }) },
  { area: 'sql', name: 'detail rows', run: () => ask('time entries', { measures: ['hours'], during: WEEK, detail: { limit: 20 }, order: [{ by: 'hours', desc: true }] }, rowsAtLeast(1)) },
  { area: 'sql', name: 'more rows than a read returns', run: () => ask('time entries', { measures: ['hours'], by: ['entry'], during: WEEK }) },
  { area: 'sql', name: 'members matching typed text', run: async () => { const m = await engine.members('people', 'employee', { search: 'kristy chong', at: 'today' } as any); return { note: JSON.stringify(m.matches.slice(0, 2)) } } },
  // ── relations on relations ────────────────────────────────────────────────────────────────────────────────────
  { area: 'nesting', name: 'a relation on a relation (one level)', run: () => ask('approved time', { measures: ['hours'], by: ['day'], during: WEEK }, rowsAtLeast(3)) },
  { area: 'nesting', name: 'a relation on a relation on a relation', run: () => ask('approved billable time', { measures: ['hours'], by: ['day'], during: WEEK }, rowsAtLeast(3)) },
  { area: 'nesting', name: 'base budget (budget, filtered), four months', run: () => ask('base budget', { measures: ['budget'], by: ['month'], where: { subsidiary: '2' }, during: { from: '2026-07-01', to: '2026-11-01' } }, rowsAtLeast(4)) },
  { area: 'nesting', name: 'budget alone, four months, grouped', run: () => ask('budget', { measures: ['amount'], by: ['month'], where: { subsidiary: '2', category: '5', currency: 'AUD' }, during: { from: '2026-07-01', to: '2026-11-01' } }, rowsAtLeast(4)) },
  // ── rows computed here ────────────────────────────────────────────────────────────────────────────────────────
  { area: 'local', name: 'rows concept by month', run: () => ask('working days', { measures: ['working_days'], by: ['month'], during: { from: '2026-09-01', to: '2026-11-01' } }, rowsAtLeast(2)) },
  { area: 'local', name: 'rows concept over an empty span', run: () => ask('working days', { measures: ['working_days'], during: { from: '2000-01-01', to: '2000-01-02' } }) },
  { area: 'local', name: 'allocations over a week, by commitment', run: () => ask('allocations', { measures: ['hours'], by: ['commitment'], during: WEEK }, rowsAtLeast(2)) },
  { area: 'local', name: 'attribute through an entity (local to SQL)', run: () => ask('allocations', { measures: ['hours'], by: ['resource.subsidiary'], during: WEEK }, rowsAtLeast(2)) },
  { area: 'local', name: 'a relation on local rows', run: () => ask('allocation revenue', { measures: ['hours'], by: ['commitment'], during: WEEK }, rowsAtLeast(2)) },
  { area: 'local', name: 'money converted at rates (local to SQL)', run: () => ask('allocation revenue', { measures: ['revenue'], by: ['commitment'], during: WEEK, currency: 'AUD' }, rowsAtLeast(2)) },
]

const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null
const results: any[] = []
for (const c of checks.filter((c) => !only || only.test(c.name))) {
  const t = Date.now()
  let status = 'pass', detail = ''
  let callId: string | undefined
  try {
    const r = await Promise.race([c.run(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMED OUT after 60s')), LIMIT_MS))])
    detail = r.note ?? ''; callId = r.callId
  } catch (e: any) { status = /TIMED OUT/.test(e.message) ? 'slow' : 'fail'; detail = String(e.message).replace(/\s+/g, ' ').slice(0, 300); callId = e.callId }
  const call = callId ? engine.store.getCall(callId) : null
  const queries = call?.queries ?? []
  const row = { area: c.area, check: c.name, status, seconds: +((Date.now() - t) / 1000).toFixed(1), queries: queries.length,
                slowestQuery: queries.length ? +(Math.max(...queries.map((q) => q.ms)) / 1000).toFixed(1) : null, capped: queries.some((q) => q.capped), detail }
  results.push(row)
  console.log(`${status.padEnd(5)} ${String(row.seconds).padStart(5)}s  ${c.area.padEnd(8)} ${c.name.padEnd(46)} ${detail.slice(0, 150)}`)
}
const out = join(dbDir, 'report.json')
writeFileSync(out, JSON.stringify(results, null, 2))
console.log(`\n${results.filter((r) => r.status === 'pass').length} pass · ${results.filter((r) => r.status === 'fail').length} fail · ${results.filter((r) => r.status === 'slow').length} slow — ${out}`)
process.exit(0)
