// A data session: questions become states, follow-ups are messages, answers are kept, and what the person was shown
// can be found again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, createEngine, type Contract } from '../src/index.ts'

const ORDERS = [
  { ordered_on: '2026-04-03', customer_id: 'c1', customer_name: 'Ash',   region: 'north', amount: 500 },
  { ordered_on: '2026-04-20', customer_id: 'c2', customer_name: 'Birch', region: 'south', amount: 300 },
  { ordered_on: '2026-05-09', customer_id: 'c3', customer_name: 'Cedar', region: 'south', amount: 200 },
  { ordered_on: '2026-06-15', customer_id: 'c4', customer_name: 'Dune',  region: 'north', amount: 100 },
  { ordered_on: '2026-06-18', customer_id: 'c1', customer_name: 'Ash',   region: 'north', amount: 50 },
]
const orders: Contract = { name: 'orders', kind: 'concept', description: 'Orders.', reads: { sources: ['SHOP'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { customer: { column: 'customer_id', label: 'customer_name', history: 'stable' }, region: { column: 'region', history: 'stable' } },
           measures: { revenue: { aggregate: 'sum', column: 'amount', unit: 'NZD', kind: 'flow' }, orders: { aggregate: 'count', unit: 'orders', kind: 'flow' } },
           time: 'ordered_on' } }

async function setup() {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-ses-')), 'org.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14' })
  await engine.define({ body: `export default async () => ({ source: 'SHOP', rows: ${JSON.stringify(ORDERS)} })`, contract: orders }, { by: 'test' })
  return { engine, store }
}
const Q2 = { from: '2026-04-01', to: '2026-07-01' }

test('q1 → S1 → D1, a follow-up → S2 → D2, and "the third customer" is the row the person saw', async () => {
  const { engine } = await setup()
  const s = engine.sessions
  const id = s.open({ who: { id: 'u1' } })
  const a1 = await s.apply(id, { ask: 'orders', request: { measures: ['revenue'], by: ['customer'], during: Q2, order: [{ by: 'revenue', desc: true }], limit: 10 } })
  assert.deepEqual((a1.value as any).rows.map((r: any) => r.customer_label), ['Ash', 'Birch', 'Cedar', 'Dune'])
  const third = s.find(id, { row: 3 })[0]
  assert.equal(third.row!.customer_label, 'Cedar')
  const a2 = await s.apply(id, { filter: { customer: third.row!.customer as string } })
  assert.deepEqual(a2.state!.request.where, { customer: 'c3' })
  assert.equal((a2.value as any).rows[0].revenue, 200)
  const a3 = await s.apply(id, { measures: { add: ['orders'] } })
  assert.deepEqual((a3.state as any).request.measures, ['revenue', 'orders'])
  const h = s.history(id)
  assert.deepEqual(h.steps.map((x) => x.parent), [null, a1.step, a2.step])
  assert.equal(h.current, a3.step)
})

test('a follow-up that cannot apply is refused before anything runs, and the session stays where it was', async () => {
  const { engine, store } = await setup()
  const s = engine.sessions
  const id = s.open()
  const a1 = await s.apply(id, { ask: 'orders', request: { by: ['region'], during: Q2 } })
  const calls = () => Number((store.db.prepare('SELECT COUNT(*) AS n FROM call').get() as any).n)
  const before = calls()
  const bad = await s.apply(id, { split: { add: ['salesperson'] } })
  assert.match(bad.refused!, /cannot be split by "salesperson"/)
  assert.equal(calls(), before, 'nothing was asked of the data')
  assert.equal(s.history(id).current, a1.step)
  assert.match((await s.apply(id, { set: { nonsense: 1 } })).refused!, /"nonsense" is not something a relation can be asked/)
})

test('going back branches the session; a new question keeps the when with keep', async () => {
  const { engine } = await setup()
  const s = engine.sessions
  const id = s.open()
  const a1 = await s.apply(id, { ask: 'orders', request: { by: ['region'], during: Q2, where: { region: 'north' } } })
  const a2 = await s.apply(id, { set: { during: { from: '2026-06-01', to: '2026-07-01' } } })
  const branch = await s.apply(id, { split: { add: ['customer'] } }, { from: a1.step })
  assert.deepEqual(branch.state!.request.during, Q2, 'the branch starts from S1, not S2')
  assert.equal(s.history(id).steps.find((x) => x.id === branch.step)!.parent, a1.step)
  const fresh = await s.apply(id, { ask: 'orders', request: { measures: ['orders'] }, keep: true })
  assert.deepEqual(fresh.state!.request, { during: Q2, where: { region: 'north' }, measures: ['orders'] })
  void a2
})

test('find: rows by text and by value across every answer, newest first', async () => {
  const { engine } = await setup()
  const s = engine.sessions
  const id = s.open()
  await s.apply(id, { ask: 'orders', request: { by: ['customer'], during: Q2 } })
  await s.apply(id, { split: { add: ['region'] } })
  const found = s.find(id, { text: 'birch' })
  assert.equal(found.length, 2)
  assert.ok(found[0].step > found[1].step, 'newest first')
  assert.deepEqual(s.find(id, { column: 'region', equals: 'south' }).map((f) => f.row!.customer_label).sort(), ['Birch', 'Cedar'])
})

test('the answers a session showed are kept when history is compacted', async () => {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-ses-')), 'org.sqlite'), { fullCalls: 1, calls: 2 })
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14' })
  await engine.define({ body: `export default async () => ({ source: 'SHOP', rows: ${JSON.stringify(ORDERS)} })`, contract: orders }, { by: 'test' })
  const id = engine.sessions.open()
  await engine.sessions.apply(id, { ask: 'orders', request: { by: ['customer'], during: Q2 } })
  for (let i = 0; i < 4; i++) await engine.call('orders', { during: Q2 })
  store.compact()
  assert.equal(engine.sessions.find(id, { row: 1 })[0].row!.customer_label !== undefined, true)
})
