// A library: another team's model in a store of its own, mounted read-only under a namespace. It is asked by its full
// name, its own programs are found inside its namespace, answers are remembered in this organisation's memory, and
// nothing here can change it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraph, Store, type Sources } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

test('a mounted model is asked by its namespace, remembered here, and read-only', async () => {
  const { query, sources } = toSqlite(s, I)
  const shared = new Store(':memory:')
  const team = createGraph({ store: shared, query, today: () => '2026-10-10' })
  team.defineSchema('branches', { ...s, objects: { ...s.objects, Planned: { kind: 'fact', arrows: { project: 'Project', day: 'Day' }, measures: { hours: { unit: 'h', kind: 'flow', aggregate: 'sum' } } } } }, 'the sales team')
  team.defineProgram('plan', { produces: 'Planned', reads: { sources: [], objects: [] }, body: `export default async () => [{ project_id: 'j1', day: '2026-09-08', hours: 6 }]` }, 'the sales team')
  const src: Sources = { ...sources, facts: { ...sources.facts, Planned: { source: '@local', program: 'plan', arrows: { project: 'project_id' }, time: 'day', measures: { hours: 'hours' } } } }
  await team.defineSources('branches', src, 'the sales team')

  const mine = new Store(':memory:')
  const org = createGraph({ store: mine, query, today: () => '2026-10-10', libraries: [{ namespace: 'sales', store: shared }] })
  const r = await org.ask({ measures: ['Sale.hours', 'Planned.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], span: { from: '2026-09-01', to: '2026-10-01' } }, { model: 'sales/branches' })
  assert.ok(r.ok, (r as any).reason)
  assert.deepEqual(r.result.rows, [['b1', 15, 6], ['b3', 8, null]])
  assert.equal(mine.counts().calls, 1)
  assert.equal(shared.counts().calls, 0)
  assert.throws(() => org.defineSchema('sales/branches', s, 'me'), /library "sales", which is read-only/)
  assert.throws(() => org.defineProgram('sales/plan', { produces: 'Planned', reads: { sources: [], objects: [] }, body: '' }, 'me'), /read-only/)
  // A replay here finds the library's definitions by their hashes.
  assert.ok((await org.replay(r.callId, { model: 'sales/branches' })).same)
  await assert.rejects(org.ask({ measures: ['Sale.hours'] }, { model: 'hr/people' }), /no schema "hr\/people"/)
})
