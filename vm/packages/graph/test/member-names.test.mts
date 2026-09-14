// What people call a member is read as that member; a filter on a member that does not exist is refused, with the
// members that do — an empty answer never stands in for "no such thing".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, GraphStore, type Contract } from '../src/index.js'

const ROWS = [
  { booked_on: '2026-09-02', subsidiary_id: '2', subsidiary_name: 'Fusion5 Pty Ltd', hours: 8 },
  { booked_on: '2026-09-03', subsidiary_id: '3', subsidiary_name: 'Fusion5 Ltd', hours: 5 },
]
const booked: Contract = { name: 'booked', kind: 'concept', description: 'Booked hours.', reads: { sources: ['PLAN'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { subsidiary: { column: 'subsidiary_id', label: 'subsidiary_name', history: 'current', names: { AU: '2', NZ: '3' } } },
           measures: { hours: { aggregate: 'sum', column: 'hours', unit: 'h', kind: 'flow' } }, time: 'booked_on' } }
const SEPTEMBER = { from: '2026-09-01', to: '2026-10-01' }

async function setup() {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-names-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14' })
  await engine.define({ body: `export default async (ctx, { from, to }) => ({ source: 'PLAN', rows: ${JSON.stringify(ROWS)}.filter((r) => r.booked_on >= from && r.booked_on < to) })`, contract: booked }, { by: 'test' })
  return { engine, store }
}

test('a name people use is read as the member, as the label or the dimension, and says so', async () => {
  const { engine, store } = await setup()
  for (const where of [{ subsidiary_label: 'AU' }, { subsidiary: 'au' }, { subsidiary_label: ['AU', 'NZ'] }]) {
    const r = await engine.call<any>('booked', { measures: ['hours'], where, during: SEPTEMBER })
    assert.equal(r.value.rows[0].hours, Array.isArray(where.subsidiary_label) ? 13 : 8, JSON.stringify(where))
    assert.ok(store.getCall(r.callId)!.caveats.some((c) => /"(AU|au)" is read as subsidiary 2/.test(c)))
  }
})

test('refused: a member that does not exist, with the members that do', async () => {
  const { engine } = await setup()
  await assert.rejects(engine.call('booked', { measures: ['hours'], where: { subsidiary_label: 'Australia' }, during: SEPTEMBER }),
    /no subsidiary is named "Australia" in the span asked — its members there are Fusion5 Pty Ltd \(2\), Fusion5 Ltd \(3\) — names people use: AU = 2, NZ = 3/)
  await assert.rejects(engine.call('booked', { measures: ['hours'], where: { subsidiary: 'Fusion5 Pty Ltd' }, during: SEPTEMBER }), /to filter by name, use subsidiary_label/)
})

test('an empty answer for a member that exists is an empty answer', async () => {
  const { engine } = await setup()
  const r = await engine.call<any>('booked', { measures: ['hours'], by: ['subsidiary'], where: { subsidiary: '2' }, during: { from: '2026-10-01', to: '2026-11-01' } })
  assert.deepEqual(r.value.rows, [])
})
