// A year of monthly hours in which one project jumps in September: memory expects each month from the months before
// it, the jump is a surprise when it is answered, and triage walks down the graph — region, state, project — to the
// project that jumped, not the ones beside it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraph, expectation, Store, type Instance, type Question } from '../src/index.js'
import { instance as base, schema as s } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

function year(): Instance {
  const I = structuredClone(base)
  I.elements.Project.j3 = { arrows: { branch: 'b2', state: 'VIC', owner: 'p3', sponsor: null } }
  I.rows.Sale = []
  const months = Array.from({ length: 13 }, (_, i) => new Date(Date.UTC(2025, 8 + i, 15)).toISOString().slice(0, 10))
  for (const day of months) {
    const jump = day.startsWith('2026-09')
    for (const [project, hours] of [['j1', jump ? 40 : 10 + (day.charCodeAt(6) % 2)], ['j2', 8], ['j3', 5]] as const) {
      I.rows.Sale.push({ arrows: { person: 'p2', project, day }, attributes: { commitment: 'Hard', currency: 'AUD' }, measures: { hours, amount: hours * 100, rate: 100 } })
    }
  }
  return I
}

test('the expectation is robust to one odd month', () => {
  const e = expectation([10, 11, 10, 11, 10, 90, 11, 10], 12)
  assert.ok(e.known && e.median! >= 10 && e.median! <= 11 && !e.surprising)
  assert.ok(expectation([10, 11, 10, 11, 10], 40).surprising)
  assert.equal(expectation([10, 11], 40).known, false)
})

test('a jump is a surprise when it is answered, and triage finds the project that jumped', async () => {
  const I = year()
  const { query, sources } = toSqlite(s, I)
  const g = createGraph({ store: new Store(':memory:'), query, today: () => '2026-10-02' })
  g.defineSchema('branches', s, 'test'); await g.defineSources('branches', sources, 'test')
  const q: Question = { measures: ['Sale.hours'], by: [{ to: 'Region', via: ['project', 'state', 'region'] }, { to: 'Month' }] }

  const past = await g.ask({ ...q, span: { from: '2025-09-01', to: '2026-09-01' } }, { model: 'branches' })
  assert.ok(past.ok && past.surprises.length === 0)
  const now = await g.ask({ ...q, span: { from: '2026-09-01', to: '2026-10-01' } }, { model: 'branches' })
  assert.ok(now.ok)
  assert.deepEqual(now.surprises.map((x) => [x.group, x.period, x.value]), [[['East'], '2026-09', 45]])
  assert.equal(g.store.getCall(now.callId)!.surprises!.length, 1)

  const { root, leads } = await g.triage(now.callId, { group: ['East'], period: '2026-09', output: 'Sale.hours' }, { model: 'branches' })
  assert.ok(root!.expectation.surprising)
  const states = root!.parts.map((p) => [p.group[0], p.expectation.surprising])
  assert.deepEqual(states.sort(), [['NSW', true], ['VIC', false]])
  assert.deepEqual(leads.map((l) => [l.group[0], l.expectation.value]), [['j1', 40]])
  // Every question triage asked is recorded under the answer it explains.
  assert.ok(g.store.recentCalls().calls.filter((c) => c.parentId === now.callId).length >= 3)
})

test('a computed output is explained by the measures it is computed from', async () => {
  const I = year()
  for (const r of I.rows.Sale) if (r.arrows.project === 'j1' && r.arrows.day.startsWith('2026-09')) { r.measures.amount = 3000; r.measures.hours = 10 }
  const { query, sources } = toSqlite(s, I)
  const g = createGraph({ store: new Store(':memory:'), query, today: () => '2026-10-02' })
  g.defineSchema('branches', s, 'test'); await g.defineSources('branches', sources, 'test')
  const q: Question = { measures: ['[Sale.amount] / [Sale.hours]'], by: [{ to: 'Project', via: ['project'] }, { to: 'Month' }], currency: 'AUD', span: { from: '2026-09-01', to: '2026-10-01' } }
  const now = await g.ask(q, { model: 'branches' })
  assert.ok(now.ok)
  const { leads } = await g.triage(now.callId, { group: ['j1'], period: '2026-09', output: '[Sale.amount] / [Sale.hours]' }, { model: 'branches' })
  assert.deepEqual(leads.map((l) => l.output), ['Sale.amount'])
})
