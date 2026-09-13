// What a relation can be asked, one capability at a time. The source here is rows, not a database, so the
// engine queries them locally with SQLite — which means every test runs the SQL the planner actually generated,
// and every expected number is worked out independently, in plain JavaScript, from the same rows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, createEngine, periods, type Contract } from '../src/index.ts'

// ── the data: orders over two years, and people employed over time ─────────────────────────────────────────
const ORDERS = [
  { order_id: 1, ordered_on: '2025-11-03', customer_id: 'c1', customer_name: 'Ash',   region: 'north', amount: 100, units: 4, cost: 60 },
  { order_id: 2, ordered_on: '2026-01-05', customer_id: 'c1', customer_name: 'Ash',   region: 'north', amount: 300, units: 10, cost: 200 },
  { order_id: 3, ordered_on: '2026-01-20', customer_id: 'c2', customer_name: 'Birch', region: 'south', amount: 50,  units: 5, cost: 20 },
  { order_id: 4, ordered_on: '2026-02-14', customer_id: 'c2', customer_name: 'Birch', region: 'south', amount: 250, units: 5, cost: 100 },
  { order_id: 5, ordered_on: '2026-04-01', customer_id: 'c3', customer_name: 'Cedar', region: null,    amount: 80,  units: 8, cost: 40 },
  { order_id: 6, ordered_on: '2026-04-30', customer_id: 'c1', customer_name: 'Ash',   region: 'north', amount: 20,  units: 1, cost: 5 },
  { order_id: 7, ordered_on: '2026-06-09', customer_id: 'c4', customer_name: 'Dune',  region: 'south', amount: 400, units: 20, cost: 300 },
]
const PEOPLE = [
  { person_id: 'p1', team: 'a', hired: '2025-01-01', released: null,         hours: 40, salary: 100 },
  { person_id: 'p2', team: 'a', hired: '2026-02-10', released: null,         hours: 20, salary: 80 },
  { person_id: 'p3', team: 'b', hired: '2025-06-01', released: '2026-05-15', hours: 40, salary: 120 },
  { person_id: 'p4', team: 'b', hired: '2026-03-01', released: null,         hours: 40, salary: 90 },
]

const ordersConcept: Contract = {
  name: 'orders', kind: 'concept', description: 'Orders placed.', reads: { sources: ['SHOP'], programs: [] }, params: {}, returns: 'relation',
  shape: {
    dimensions: { customer: { column: 'customer_id', label: 'customer_name', history: 'stable' }, region: { column: 'region', history: 'current' } },
    measures: {
      revenue:   { aggregate: 'sum', column: 'amount', unit: 'NZD', kind: 'flow' },
      cost:      { aggregate: 'sum', column: 'cost', unit: 'NZD', kind: 'flow' },
      units:     { aggregate: 'sum', column: 'units', unit: 'units', kind: 'flow' },
      orders:    { aggregate: 'count', unit: 'orders', kind: 'flow' },
      customers: { aggregate: 'count distinct', column: 'customer_id', unit: 'customers', kind: 'flow' },
      largest:   { aggregate: 'max', column: 'amount', unit: 'NZD', kind: 'flow' },
      margin:    { expression: 'revenue - cost', unit: 'NZD', kind: 'flow' },
      price:     { expression: 'revenue / units', unit: 'NZD per unit', kind: 'ratio' },
    },
    time: 'ordered_on',
  },
}
const ORDERS_BODY = `export default async (ctx, { from, to }) => ({ source: 'SHOP', rows: ${JSON.stringify(ORDERS)} })`

const peopleConcept: Contract = {
  name: 'people', kind: 'concept', description: 'People employed.', reads: { sources: ['HR'], programs: [] }, params: {}, returns: 'relation',
  shape: {
    dimensions: { team: { column: 'team', history: 'current' } },
    measures: {
      headcount: { aggregate: 'count', unit: 'people', kind: 'stock' },
      fte:       { aggregate: 'sum', column: 'fte', unit: 'FTE', kind: 'stock' },
      pay:       { aggregate: 'average', column: 'salary', unit: 'NZD', kind: 'stock' },
    },
  },
}
// A stock's rows are the people employed as at the date asked — computed in the body, as any source would.
const PEOPLE_BODY = `const P = ${JSON.stringify(PEOPLE)}
export default async (ctx, { asAt }) => ({ source: 'HR',
  rows: P.filter((p) => p.hired <= asAt && (!p.released || p.released > asAt)).map((p) => ({ ...p, fte: p.hours / 40 })) })`

async function setup(today = '2026-09-14') {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-cap-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {},
    query: async () => { throw new Error('no database in these tests') }, today: () => today })
  await engine.define({ body: ORDERS_BODY, contract: ordersConcept }, { by: 'test' })
  await engine.define({ body: PEOPLE_BODY, contract: peopleConcept }, { by: 'test' })
  const ask = async (name: string, request: any) => {
    const r = await engine.call<any>(name, request)
    return { ...r.value, call: store.getCall(r.callId)! }
  }
  return { engine, store, ask }
}
const H1 = { from: '2026-01-01', to: '2026-07-01' }
const inSpan = (o: any, span = H1) => o.ordered_on >= span.from && o.ordered_on < span.to
const sum = (xs: any[], f: (x: any) => number) => xs.reduce((a, x) => a + f(x), 0)

test('a ratio is its parts divided, per row and in total — never a sum of ratios', async () => {
  const { ask } = await setup()
  const r = await ask('orders', { measures: ['price'], by: ['region'], during: H1 })
  for (const region of ['north', 'south']) {
    const os = ORDERS.filter((o) => inSpan(o) && o.region === region)
    assert.equal(r.rows.find((x: any) => x.region === region).price, sum(os, (o) => o.amount) / sum(os, (o) => o.units))
  }
  assert.deepEqual(r.columns.map((c: any) => c.name), ['region', 'price'], 'the parts it was computed from are not in the result')
  const checked = r.call.verifications.map((v: any) => v.label)
  assert.ok(checked.some((l: string) => l.startsWith('revenue:')) && checked.some((l: string) => l.startsWith('units:')), 'its parts are checked against the whole')
  assert.ok(!checked.some((l: string) => l.startsWith('price:')), 'the ratio itself is not summed to check it')
})

test('a derived measure that adds up is checked like one', async () => {
  const { ask } = await setup()
  const r = await ask('orders', { measures: ['margin'], by: ['customer'], during: H1 })
  assert.equal(sum(r.rows, (x) => x.margin), sum(ORDERS.filter((o) => inSpan(o)), (o) => o.amount - o.cost))
  assert.ok(r.call.verifications.some((v: any) => v.label.startsWith('margin:') && v.held))
})

test('refused at definition: a product of measures declared as if it adds up', async () => {
  const { engine } = await setup()
  const bad = structuredClone(ordersConcept)
  bad.name = 'bad orders'
  ;(bad.shape!.measures as any).weighted = { expression: 'revenue * units', unit: 'x', kind: 'flow' }
  await assert.rejects(engine.define({ body: ORDERS_BODY, contract: bad }, { by: 'test' }), /does not add up — declare it a ratio/)
})

test('a distinct count by month is bounded by its parts, not equal to their sum', async () => {
  const { ask } = await setup()
  const r = await ask('orders', { measures: ['customers'], by: ['month'], during: { from: '2026-01-01', to: '2026-05-01' } })
  const v = r.call.verifications.find((x: any) => x.label.startsWith('customers:'))
  assert.ok(v.held, v.detail)
  assert.match(v.label, /between the largest part and the sum/)
})

test('time grains label periods the same way in SQL and in JavaScript', async () => {
  const { ask } = await setup()
  for (const grain of ['day', 'week', 'month', 'quarter', 'year'] as const) {
    const span = { from: '2025-01-01', to: '2027-01-01' }
    const r = await ask('orders', { measures: ['revenue'], by: [grain], during: span })
    const want = new Map<string, number>()
    for (const o of ORDERS) {
      const label = periods(grain, o.ordered_on, new Date(Date.parse(o.ordered_on) + 864e5).toISOString().slice(0, 10))[0].label
      want.set(label, (want.get(label) ?? 0) + o.amount)
    }
    assert.deepEqual(new Map(r.rows.map((x: any) => [x[grain], x.revenue])), want, grain)
  }
})

test('conditions: ranges, exclusions and missing values', async () => {
  const { ask } = await setup()
  const all = { from: '2025-01-01', to: '2027-01-01' }
  const noRegion = await ask('orders', { measures: ['revenue'], where: { region: null }, during: all })
  assert.equal(noRegion.rows[0].revenue, 80)
  const notNorth = await ask('orders', { measures: ['orders'], where: { region: { notIn: ['north'], isNull: false } }, during: all })
  assert.equal(notNorth.rows[0].orders, ORDERS.filter((o) => o.region && o.region !== 'north').length)
  const range = await ask('orders', { measures: ['orders'], where: { customer: { gte: 'c2', lt: 'c4' } }, during: all })
  assert.equal(range.rows[0].orders, ORDERS.filter((o) => o.customer_id >= 'c2' && o.customer_id < 'c4').length)
})

test('top customers: having, order and limit, pushed into the statement', async () => {
  const { ask } = await setup()
  const r = await ask('orders', { measures: ['revenue'], by: ['customer'], during: H1, having: { revenue: { gt: 60 } },
                                  order: [{ by: 'revenue', desc: true }], limit: 2 })
  assert.deepEqual(r.rows.map((x: any) => [x.customer, x.revenue]), [['c4', 400], ['c1', 320]])
  assert.match(r.call.queries[0].sql, /HAVING[\s\S]*ORDER BY revenue DESC[\s\S]*LIMIT 2/)
  assert.ok(r.call.caveats.some((c: string) => /not checked against the whole/.test(c)))
})

test('refused: a limit with no order', async () => {
  const { ask } = await setup()
  await assert.rejects(ask('orders', { measures: ['revenue'], by: ['customer'], during: H1, limit: 2 }), /needs an order/)
})

test('fill: a month with no orders is there, as zero', async () => {
  const { ask } = await setup()
  const r = await ask('orders', { measures: ['revenue', 'price'], by: ['month'], during: H1, fill: true })
  assert.deepEqual(r.rows.map((x: any) => x.month).sort(), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'])
  const march = r.rows.find((x: any) => x.month === '2026-03')
  assert.equal(march.revenue, 0)
  assert.equal(march.price, null, 'a ratio of nothing is unknown, not zero')
})

test('cumulative: year to date counts the months before the span that belong to its year', async () => {
  const { ask } = await setup()
  const r = await ask('orders', { measures: ['revenue'], by: ['month'], during: { from: '2026-02-01', to: '2026-05-01' }, cumulative: { reset: 'year' }, fill: true })
  const ytd = (month: string) => sum(ORDERS.filter((o) => o.ordered_on >= '2026-01-01' && o.ordered_on.slice(0, 7) <= month), (o) => o.amount)
  assert.deepEqual(r.rows.map((x: any) => [x.month, x.revenue]), ['2026-02', '2026-03', '2026-04'].map((m) => [m, ytd(m)]))
})

test('a stock by quarter is read at each quarter end, and never after today', async () => {
  const { ask } = await setup('2026-08-20')
  const r = await ask('people', { measures: ['headcount'], by: ['quarter'], during: { from: '2026-01-01', to: '2027-01-01' } })
  const at = (d: string) => PEOPLE.filter((p) => p.hired <= d && (!p.released || p.released > d)).length
  assert.deepEqual(r.rows.map((x: any) => [x.quarter, x.headcount]), [['2026-Q1', at('2026-03-31')], ['2026-Q2', at('2026-06-30')], ['2026-Q3', at('2026-08-20')]])
})

test('refused: averaging readings of a measure that is already an average', async () => {
  const { ask } = await setup()
  await assert.rejects(ask('people', { measures: ['pay'], during: H1, rollup: { time: 'average' } }), /an average already/)
})

test('today is fixed per call, and a replay answers as of the same day', async () => {
  let day = '2026-03-15'
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-cap-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => day })
  await engine.define({ body: PEOPLE_BODY, contract: peopleConcept }, { by: 'test' })
  await engine.define({ body: `export default async (ctx) => ({ today: ctx.today, now: await ctx.call('people', { measures: ['headcount'], at: ctx.today }) })`,
    contract: { name: 'now', kind: 'program', description: 'Headcount today.', reads: { sources: [], programs: ['people'] }, params: {}, returns: 'value' } }, { by: 'test' })
  const first = await engine.call<any>('now')
  day = '2026-09-01'
  const again = await engine.replay<any>(first.callId)
  assert.equal(again.value.today, '2026-03-15')
  assert.deepEqual(again.value.now.rows, first.value.now.rows)
})

test('refused: a program that reaches itself through its calls', async () => {
  const { engine } = await setup()
  const prog = (name: string, calls: string) => ({ body: `export default (ctx) => ctx.call(${JSON.stringify(calls)})`,
    contract: { name, kind: 'program', description: 'loops', reads: { sources: [], programs: [calls] }, params: {}, returns: 'value' } as Contract })
  await engine.define({ body: 'export default () => 1', contract: { name: 'b', kind: 'program', description: 'placeholder', reads: { sources: [], programs: [] }, params: {}, returns: 'value' } }, { by: 'test' })
  await engine.define(prog('a', 'b'), { by: 'test' })
  await engine.define(prog('b', 'a'), { by: 'test', replace: true })
  await assert.rejects(engine.call('a'), /calls itself/)
})

test('refused at definition: rows that lack a column the shape names', async () => {
  const { engine } = await setup()
  const bad = structuredClone(ordersConcept)
  bad.name = 'thin orders'
  ;(bad.shape!.dimensions as any).channel = { column: 'channel', history: 'stable' }
  await assert.rejects(engine.define({ body: ORDERS_BODY, contract: bad }, { by: 'test' }), /rows have no "channel"/)
})

test('a relation built on rows composes the same way as one built on SQL', async () => {
  const { engine, ask } = await setup()
  await engine.define({ body: `export default () => ({ sql: "SELECT o.* FROM {{orders}} o WHERE o.region = 'south'" })`,
    contract: { ...ordersConcept, name: 'south orders', kind: 'program', reads: { sources: [], programs: ['orders'] } } }, { by: 'test' })
  const r = await ask('south orders', { measures: ['revenue'], during: H1 })
  assert.equal(r.rows[0].revenue, sum(ORDERS.filter((o) => inSpan(o) && o.region === 'south'), (o) => o.amount))
})
