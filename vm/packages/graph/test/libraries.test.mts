// Namespaces and libraries: a procurement model built in a store of its own, mounted read-only into an
// organisation's engine, and composed with the organisation's own programs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, createEngine, type Contract } from '../src/index.ts'

const SPEND = [
  { ordered_on: '2026-04-02', supplier_id: 's1', supplier_name: 'Kauri Steel', amount: 900 },
  { ordered_on: '2026-05-11', supplier_id: 's2', supplier_name: 'Rimu Freight', amount: 300 },
  { ordered_on: '2026-06-20', supplier_id: 's1', supplier_name: 'Kauri Steel', amount: 400 },
]
const spend: Contract = { name: 'spend', kind: 'concept', description: 'Purchase order spend.', reads: { sources: ['ERP'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { supplier: { column: 'supplier_id', label: 'supplier_name', history: 'stable', entity: 'supplier' } },
           measures: { spend: { aggregate: 'sum', column: 'amount', unit: 'NZD', kind: 'flow' } }, time: 'ordered_on' } }
const topSupplier = { body: `export default async (ctx, { during }) => {
    const r = await ctx.call('spend', { by: ['supplier'], during, order: [{ by: 'spend', desc: true }], limit: 1 })
    return { supplier: r.rows[0].supplier_label, spend: r.rows[0].spend }
  }`,
  contract: { name: 'top supplier', kind: 'program', description: 'The supplier with the most spend.', reads: { sources: [], programs: ['spend'] },
              params: { during: 'the span' }, returns: 'value' } as Contract }

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'graph-lib-'))
  // The procurement team builds its model in its own store.
  const procurementStore = new GraphStore(join(dir, 'procurement.sqlite'))
  const procurement = createEngine({ store: procurementStore, modulesDir: join(dir, 'proc-modules'), dialects: {}, query: async () => [], today: () => '2026-09-14' })
  await procurement.define({ body: `export default async () => ({ source: 'ERP', rows: ${JSON.stringify(SPEND)} })`, contract: spend }, { by: 'procurement' })
  await procurement.define(topSupplier, { by: 'procurement' })
  // The organisation mounts it.
  const store = new GraphStore(join(dir, 'org.sqlite'))
  const engine = createEngine({ store, modulesDir: join(dir, 'org-modules'), dialects: {}, query: async () => [], today: () => '2026-09-14',
    libraries: [{ namespace: 'procurement', store: procurementStore }] })
  return { engine, store, procurementStore }
}
const Q2 = { from: '2026-04-01', to: '2026-07-01' }

test('a library\'s programs are called by full name, and call each other by their own names', async () => {
  const { engine, store, procurementStore } = await setup()
  const r = await engine.call<any>('procurement/top supplier', { during: Q2 })
  assert.deepEqual(r.value, { supplier: 'Kauri Steel', spend: 1300 })
  const children = store.children(r.callId).map((c) => c.name)
  assert.deepEqual(children, ['procurement/spend'], 'inside the library, "spend" meant procurement/spend')
  assert.ok(Number((store.db.prepare('SELECT COUNT(*) AS n FROM call').get() as any).n) > 0, 'memory is the organisation\'s')
  assert.equal(Number((procurementStore.db.prepare('SELECT COUNT(*) AS n FROM call').get() as any).n), 0, 'the library\'s store is only read')
})

test('the organisation composes with a library: a program of its own, and a relation built on the library\'s', async () => {
  const { engine } = await setup()
  await engine.define({ body: `export default async (ctx, { during }) => {
      const top = await ctx.call('procurement/top supplier', { during })
      return { headline: top.supplier + ' took the most spend', spend: top.spend }
    }`, contract: { name: 'finance/supplier headline', kind: 'program', description: 'A headline about suppliers.',
      reads: { sources: [], programs: ['procurement/top supplier'] }, params: { during: 'the span' }, returns: 'value' } }, { by: 'finance' })
  assert.equal((await engine.call<any>('finance/supplier headline', { during: Q2 })).value.headline, 'Kauri Steel took the most spend')
  await engine.define({ body: `export default () => ({ sql: "SELECT s.* FROM {{procurement/spend}} s WHERE s.amount >= 400" })`,
    contract: { ...spend, name: 'finance/large orders', kind: 'program', reads: { sources: [], programs: ['procurement/spend'] } } }, { by: 'finance' })
  assert.equal((await engine.call<any>('finance/large orders', { during: Q2 })).value.rows[0].spend, 1300)
})

test('refused: redefining a library\'s program; listed: where each program comes from', async () => {
  const { engine } = await setup()
  await assert.rejects(engine.define({ ...topSupplier, contract: { ...topSupplier.contract, name: 'procurement/top supplier' } }, { by: 'org', replace: true }),
    /is in the library "procurement", which is read-only here/)
  const listed = engine.catalog().map((e) => [e.name, e.library ?? null])
  assert.deepEqual(listed, [['procurement/spend', 'procurement'], ['procurement/top supplier', 'procurement']])
})
