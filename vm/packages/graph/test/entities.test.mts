// Attributes reached through an entity: revenue by each customer's segment, without the orders relation knowing
// segments exist. Local rows, so the joins the planner writes actually run in SQLite.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, createEngine, type Contract } from '../src/index.ts'

const ORDERS = [
  { ordered_on: '2026-01-05', customer_id: 'c1', amount: 300 },
  { ordered_on: '2026-02-14', customer_id: 'c2', amount: 250 },
  { ordered_on: '2026-04-01', customer_id: 'c3', amount: 80 },
  { ordered_on: '2026-04-30', customer_id: 'c1', amount: 20 },
  { ordered_on: '2026-06-09', customer_id: 'c4', amount: 400 },
  { ordered_on: '2026-06-10', customer_id: null, amount: 5 },
]
// A customer's segment and account manager over time: c2 moves to enterprise on 1 May.
const CUSTOMERS = [
  { customer_id: 'c1', name: 'Ash',   segment: 'enterprise', manager_id: 'm1', manager_name: 'Mere', from: '2020-01-01', to: null },
  { customer_id: 'c2', name: 'Birch', segment: 'smb',        manager_id: 'm2', manager_name: 'Tama', from: '2020-01-01', to: '2026-05-01' },
  { customer_id: 'c2', name: 'Birch', segment: 'enterprise', manager_id: 'm1', manager_name: 'Mere', from: '2026-05-01', to: null },
  { customer_id: 'c3', name: 'Cedar', segment: 'smb',        manager_id: 'm2', manager_name: 'Tama', from: '2020-01-01', to: null },
  { customer_id: 'c4', name: 'Dune',  segment: 'smb',        manager_id: null, manager_name: null,   from: '2026-06-01', to: null },
]

const orders: Contract = { name: 'orders', kind: 'concept', description: 'Orders placed.', reads: { sources: ['SHOP'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { customer: { column: 'customer_id', history: 'stable', entity: 'customer' } },
           measures: { revenue: { aggregate: 'sum', column: 'amount', unit: 'NZD', kind: 'flow' } }, time: 'ordered_on' } }
const customers: Contract = { name: 'customers', kind: 'concept', description: 'Customers as at an instant.', reads: { sources: ['SHOP'], programs: [] }, params: {}, returns: 'relation',
  shape: { grain: 'customer',
           dimensions: { customer: { column: 'customer_id', label: 'name', history: 'stable', entity: 'customer' },
                         segment: { column: 'segment', history: 'as-at' },
                         manager: { column: 'manager_id', label: 'manager_name', history: 'as-at', entity: 'employee' } },
           measures: { customers: { aggregate: 'count', unit: 'customers', kind: 'stock' } } } }
const ORDERS_BODY = `export default async () => ({ source: 'SHOP', rows: ${JSON.stringify(ORDERS)} })`
const customersBody = (rows = CUSTOMERS) => `const C = ${JSON.stringify(rows)}
export default async (ctx, { asAt }) => ({ source: 'SHOP', rows: C.filter((c) => c.from <= asAt && (!c.to || c.to > asAt)) })`

async function setup() {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-en-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14' })
  await engine.define({ body: ORDERS_BODY, contract: orders }, { by: 'test' })
  await engine.define({ body: customersBody(), contract: customers }, { by: 'test' })
  return { engine, store }
}
const H1 = { from: '2026-01-01', to: '2026-07-01' }
const segmentAt = (id: string | null, d: string) => CUSTOMERS.find((c) => c.customer_id === id && c.from <= d && (!c.to || c.to > d))?.segment ?? null
const sum = (xs: any[]) => xs.reduce((a, x) => a + x.amount, 0)

test('revenue by customer segment — an attribute the orders relation never names', async () => {
  const { engine, store } = await setup()
  const r = await engine.call<any>('orders', { by: ['customer.segment'], during: H1 })
  const want = new Map<string | null, number>()
  for (const o of ORDERS) { const s = segmentAt(o.customer_id, '2026-06-30'); want.set(s, (want.get(s) ?? 0) + o.amount) }
  assert.deepEqual(new Map(r.value.rows.map((x: any) => [x['customer.segment'], x.revenue])), want)
  const c = store.getCall(r.callId)!
  assert.ok(c.verifications.some((v) => /"customers" has one row per customer as at 2026-06-30/.test(v.label) && v.held))
  assert.ok(c.verifications.some((v) => /sums to the whole/.test(v.label) && v.held), 'no row was repeated or lost by the join')
  assert.ok(c.caveats.some((x) => /attributes of customer are as at 2026-06-30/.test(x)))
  assert.ok(store.children(r.callId).some((k) => k.name === 'customers'), 'memory knows the answer went through customers')
})

test('an attribute beside the member, with its label, filtered and ordered', async () => {
  const { engine } = await setup()
  const r = (await engine.call<any>('orders', { by: ['customer', 'customer.manager'], where: { 'customer.segment': 'enterprise' }, during: H1,
    order: [{ by: 'customer.manager_label' }, { by: 'revenue', desc: true }] })).value
  assert.deepEqual(r.rows.map((x: any) => [x.customer, x['customer.manager_label'], x.revenue]), [['c1', 'Mere', 320], ['c2', 'Mere', 250]])
  assert.deepEqual(r.columns.map((c: any) => c.name), ['customer', 'customer.manager', 'customer.manager_label', 'revenue'])
})

test('attributes of a stock are read as at the same instant as the stock', async () => {
  const { engine } = await setup()
  const at = async (d: string) => new Map((await engine.call<any>('customers', { by: ['customer.segment'], at: d })).value.rows.map((x: any) => [x['customer.segment'], x.customers]))
  assert.deepEqual(await at('2026-04-01'), new Map([['enterprise', 1], ['smb', 2]]))
  assert.deepEqual(await at('2026-06-30'), new Map([['enterprise', 2], ['smb', 2]]))
})

test('refused at definition: a grain that repeats a member', async () => {
  const { engine } = await setup()
  const twice = [...CUSTOMERS, { ...CUSTOMERS[0], segment: 'smb' }]
  await assert.rejects(engine.define({ body: customersBody(twice), contract: { ...customers, name: 'customers again' } }, { by: 'test' }),
    /its grain is customer, but 5 rows hold only 4 distinct/)
})

test('refused when read: a grain that repeats a member at the instant joined', async () => {
  const { engine } = await setup()
  // From June, c1 is listed twice — unique when defined today? No: define checks today, so repeat only in June.
  const overlap = [...CUSTOMERS, { ...CUSTOMERS[0], segment: 'smb', from: '2026-06-01', to: '2026-07-01' }]
  await engine.define({ body: customersBody(overlap), contract: customers }, { by: 'test', replace: true })
  await assert.rejects(engine.call('orders', { by: ['customer.segment'], during: H1 }), /invariant failed: "customers" has one row per customer as at 2026-06-30/)
})

test('refused: no relation of the entity, two of them, or a dimension that identifies no entity', async () => {
  const { engine } = await setup()
  await assert.rejects(engine.call('customers', { by: ['manager.team'], at: '2026-06-30' }), /no relation has employee as its grain/)
  await assert.rejects(engine.call('orders', { by: ['customer.region'], during: H1 }), /has no dimension "region"/)
  await engine.define({ body: customersBody(), contract: { ...customers, name: 'clients' } }, { by: 'test' })
  await assert.rejects(engine.call('orders', { by: ['customer.segment'], during: H1 }), /"clients" and "customers" all have customer as their grain/)
  await assert.rejects(engine.call('customers', { by: ['segment.name'], at: '2026-06-30' }), /does not declare the entity/)
})

test('a correction to the entity\'s relation reaches every question that went through it', async () => {
  const { engine } = await setup()
  const before = (await engine.call<any>('orders', { by: ['customer.segment'], during: H1 })).value.rows
  const fixed = CUSTOMERS.map((c) => (c.customer_id === 'c4' ? { ...c, segment: 'enterprise' } : c))
  await engine.define({ body: customersBody(fixed), contract: customers }, { by: 'test', replace: true })
  const after = (await engine.call<any>('orders', { by: ['customer.segment'], during: H1 })).value.rows
  const ent = (rows: any[]) => rows.find((x) => x['customer.segment'] === 'enterprise').revenue
  assert.equal(ent(after) - ent(before), 400)
})
