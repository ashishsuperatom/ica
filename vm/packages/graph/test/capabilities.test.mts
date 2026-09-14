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

test('refused at definition: a replacement that would make a program reach itself', async () => {
  const { engine } = await setup()
  const prog = (name: string, calls: string) => ({ body: `export default (ctx) => ctx.call(${JSON.stringify(calls)})`,
    contract: { name, kind: 'program', description: 'loops', reads: { sources: [], programs: [calls] }, params: {}, returns: 'value' } as Contract })
  await engine.define({ body: 'export default () => 1', contract: { name: 'c', kind: 'program', description: 'placeholder', reads: { sources: [], programs: [] }, params: {}, returns: 'value' } }, { by: 'test' })
  await engine.define(prog('b', 'c'), { by: 'test' })
  await engine.define(prog('a', 'b'), { by: 'test' })
  await assert.rejects(engine.define(prog('c', 'a'), { by: 'test', replace: true }), /would reach itself: c → a → b → c/)
})

test('refused when run: a loop made through a program named in a parameter', async () => {
  const { engine } = await setup()
  await engine.define({ body: `export default (ctx, { next }) => ctx.call(next, { next })`,
    contract: { name: 'relay', kind: 'program', description: 'calls what it is given', reads: { sources: [], programs: [] },
                params: { next: { description: 'the program to call', program: {} } }, returns: 'value' } }, { by: 'test' })
  await assert.rejects(engine.call('relay', { next: 'relay' }), /calls itself/)
})

test('a program parameter: one ranking program for any relation that has the measure', async () => {
  const { engine, ask } = await setup()
  await engine.define({ body: `export default async (ctx, { of, measure, by, during }) => {
      const r = await ctx.call(of, { measures: [measure], by: [by], during, order: [{ by: measure, desc: true }], limit: 1 })
      return r.rows[0]
    }`,
    contract: { name: 'top', kind: 'program', description: 'The largest member by a measure.', reads: { sources: [], programs: [] },
      params: { of: { description: 'the relation', program: { returns: 'relation' } }, measure: 'the measure', by: 'the dimension', during: 'the span' }, returns: 'value' } }, { by: 'test' })
  assert.equal((await engine.call<any>('top', { of: 'orders', measure: 'revenue', by: 'customer', during: H1 })).value.customer, 'c4')
  assert.equal((await engine.call<any>('top', { of: 'people', measure: 'headcount', by: 'team', during: H1 }).catch((e) => e)).message.includes('stock'), true)
  await assert.rejects(engine.call('top', { of: 'nothing', measure: 'x', by: 'y', during: H1 }), /no program named "nothing"/)
  await engine.define({ body: 'export default () => 1', contract: { name: 'one', kind: 'program', description: 'one', reads: { sources: [], programs: [] }, params: {}, returns: 'value' } }, { by: 'test' })
  await assert.rejects(engine.call('top', { of: 'one', measure: 'x', by: 'y', during: H1 }), /returns value, and a relation is needed/)
  void ask
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

// ── calendars ─────────────────────────────────────────────────────────────────────────────────────────────
const NZ_FISCAL = { fiscal_year: { fiscal: 'year', startMonth: 4 }, fiscal_quarter: { fiscal: 'quarter', startMonth: 4 }, fiscal_month: { fiscal: 'month', startMonth: 4 } }

test('calendar: a fiscal year starting in April labels and splits the same in SQL and JavaScript', async () => {
  const { engine } = await setup()
  const all = { from: '2025-04-01', to: '2026-10-01' }
  const r = (await engine.call<any>('orders', { measures: ['revenue'], by: ['fiscal_quarter'], during: all }, { assume: { calendar: NZ_FISCAL } })).value
  const quarter = (d: string) => { const m = Number(d.slice(5, 7)); const fy = m >= 4 ? Number(d.slice(0, 4)) + 1 : Number(d.slice(0, 4)); return `FY${fy}-Q${Math.floor(((m - 4 + 12) % 12) / 3) + 1}` }
  const want = new Map<string, number>()
  for (const o of ORDERS) want.set(quarter(o.ordered_on), (want.get(quarter(o.ordered_on)) ?? 0) + o.amount)
  assert.deepEqual(new Map(r.rows.map((x: any) => [x.fiscal_quarter, x.revenue])), want)
  assert.ok(want.has('FY2026-Q3') && want.has('FY2026-Q4'), 'November 2025 and January 2026 fall in FY2026')
})

test('calendar: fiscal year to date resets in April, not January', async () => {
  const { engine } = await setup()
  const r = (await engine.call<any>('orders', { measures: ['revenue'], by: ['month'], during: { from: '2026-01-01', to: '2026-07-01' },
    cumulative: { reset: 'fiscal_year' }, fill: true }, { assume: { calendar: NZ_FISCAL } })).value
  const ytd = (month: string) => sum(ORDERS.filter((o) => (o.ordered_on.slice(0, 7) <= month) && (o.ordered_on >= (month >= '2026-04' ? '2026-04-01' : '2025-04-01'))), (o) => o.amount)
  assert.deepEqual(r.rows.map((x: any) => [x.month, x.revenue]), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'].map((m) => [m, ytd(m)]))
})

test('calendar: listed periods — a 4-4-5 quarter — and a span outside them refused', async () => {
  const { engine } = await setup()
  const retail = { retail_month: { periods: [
    { label: 'R1', from: '2026-01-04', to: '2026-02-01' }, { label: 'R2', from: '2026-02-01', to: '2026-03-01' },
    { label: 'R3', from: '2026-03-01', to: '2026-04-05' }, { label: 'R4', from: '2026-04-05', to: '2026-05-03' } ] } }
  const r = (await engine.call<any>('orders', { measures: ['revenue'], by: ['retail_month'], during: { from: '2026-01-04', to: '2026-05-03' } }, { assume: { calendar: retail } })).value
  assert.deepEqual(new Map(r.rows.map((x: any) => [x.retail_month, x.revenue])), new Map([['R1', 350], ['R2', 250], ['R3', 80], ['R4', 20]]))
  await assert.rejects(engine.call('orders', { measures: ['revenue'], by: ['retail_month'], during: H1 }, { assume: { calendar: retail } }), /before calendar grain/)
})

test('calendar: chosen by who is asking, and a stock read at each fiscal quarter end', async () => {
  const { engine, store } = await setup('2026-09-14')
  const calendar = { rules: [{ value: {} }, { when: { 'who.country': 'NZ' }, value: NZ_FISCAL }] }
  const q = { measures: ['headcount'], by: ['fiscal_quarter'], during: { from: '2026-01-01', to: '2026-07-01' } }
  await assert.rejects(engine.call('people', q, { assume: { calendar } }), /not a dimension/)
  const r = await engine.call<any>('people', q, { assume: { calendar }, who: { country: 'NZ' } })
  const at = (d: string) => PEOPLE.filter((p) => p.hired <= d && (!p.released || p.released > d)).length
  assert.deepEqual(r.value.rows.map((x: any) => [x.fiscal_quarter, x.headcount]), [['FY2026-Q4', at('2026-03-31')], ['FY2027-Q1', at('2026-06-30')]])
  assert.equal(store.getCall(r.callId)!.assumptions.find((a) => a.name === 'calendar')!.from, 'caller')
})

// ── comparison ────────────────────────────────────────────────────────────────────────────────────────────
import { shift } from '../src/index.ts'

test('comparison: month ends and offsets move time the way people mean', () => {
  assert.equal(shift('2026-08-31', { months: 6 }), '2026-02-28')
  assert.equal(shift('2024-02-29', { years: 1 }), '2023-02-28')
  assert.equal(shift('2026-03-15', { quarters: 1 }), '2025-12-15')
  assert.equal(shift('2026-07-01', { weeks: 1, days: 1 }), '2026-06-23')
})

test('comparison: each region against the same half a year earlier, with the change', async () => {
  const { engine } = await setup()
  const r = (await engine.call<any>('orders', { measures: ['revenue', 'price'], by: ['region'], during: H1, compare: { offset: { months: 6 } } })).value
  const span = (s: { from: string; to: string }, region: string | null) => ORDERS.filter((o) => inSpan(o, s) && o.region === region)
  const earlier = { from: '2025-07-01', to: '2026-01-01' }
  const north = r.rows.find((x: any) => x.region === 'north')
  assert.equal(north.revenue, sum(span(H1, 'north'), (o) => o.amount))
  assert.equal(north.revenue_compare, sum(span(earlier, 'north'), (o) => o.amount))
  assert.equal(north.revenue_change, north.revenue - north.revenue_compare)
  assert.equal(north.revenue_change_ratio, (north.revenue - north.revenue_compare) / north.revenue_compare)
  assert.equal(north.price_change_ratio, null, 'a ratio changes by points, not by a percentage of itself')
  const south = r.rows.find((x: any) => x.region === 'south')
  assert.equal(south.revenue_compare, 0, 'a member with nothing then is zero for an amount')
  assert.equal(south.price_compare, null, 'and unknown for a ratio')
})

test('comparison: periods aligned by place — each month of a quarter against the quarter before', async () => {
  const { engine } = await setup()
  const r = (await engine.call<any>('orders', { measures: ['revenue'], by: ['month'], during: { from: '2026-04-01', to: '2026-07-01' },
    compare: { offset: { quarters: 1 } }, fill: true })).value
  assert.deepEqual(r.rows.map((x: any) => [x.month, x.month_compare]), [['2026-04', '2026-01'], ['2026-05', '2026-02'], ['2026-06', '2026-03']])
  assert.deepEqual(r.rows.map((x: any) => x.revenue_compare), [350, 250, 0])
})

test('comparison: a span still running is compared like for like', async () => {
  const { engine, store } = await setup('2026-04-15')
  const c = await engine.call<any>('orders', { measures: ['revenue'], during: { from: '2026-04-01', to: '2026-05-01' }, compare: { offset: { years: 1 } } })
  assert.ok(store.getCall(c.callId)!.caveats.some((x) => /like for like: 2026-04-01 to 2026-04-15 against 2025-04-01 to 2025-04-15/.test(x)))
  assert.equal(c.value.rows[0].revenue, sum(ORDERS.filter((o) => o.ordered_on >= '2026-04-01' && o.ordered_on <= '2026-04-15'), (o) => o.amount))
})

test('comparison: the biggest falls first — order and limit on the change', async () => {
  const { engine } = await setup()
  const r = (await engine.call<any>('orders', { measures: ['revenue'], by: ['customer'], during: { from: '2026-04-01', to: '2026-07-01' },
    compare: { offset: { quarters: 1 } }, order: [{ by: 'revenue_change' }], limit: 2 })).value
  assert.deepEqual(r.rows.map((x: any) => [x.customer, x.revenue_change]), [['c1', -280], ['c2', -300]].sort((a: any, b: any) => a[1] - b[1]))
})

test('comparison: a stock at an instant against a year before', async () => {
  const { engine } = await setup()
  const r = (await engine.call<any>('people', { measures: ['headcount'], by: ['team'], at: '2026-06-30', compare: { at: '2025-12-31' } })).value
  const at = (d: string, team: string) => PEOPLE.filter((p) => p.team === team && p.hired <= d && (!p.released || p.released > d)).length
  for (const team of ['a', 'b']) {
    const row = r.rows.find((x: any) => x.team === team)
    assert.deepEqual([row.headcount, row.headcount_compare], [at('2026-06-30', team), at('2025-12-31', team)])
  }
})

// ── totals, shares, top N per group ───────────────────────────────────────────────────────────────────────

test('pivot totals: each level asked of the source, so a ratio and a distinct count are right at every level', async () => {
  const { engine } = await setup()
  const r = (await engine.call<any>('orders', { measures: ['revenue', 'price', 'customers'], by: ['region', 'month'], during: H1,
    totals: [['region'], ['month'], []] })).value
  const os = ORDERS.filter((o) => inSpan(o))
  const grand = r.totals.find((t: any) => t.by.length === 0).rows[0]
  assert.equal(grand.revenue, sum(os, (o) => o.amount))
  assert.equal(grand.price, sum(os, (o) => o.amount) / sum(os, (o) => o.units), 'the ratio of the totals, not a total of ratios')
  assert.equal(grand.customers, new Set(os.map((o) => o.customer_id)).size, 'people counted once across months')
  const north = r.totals.find((t: any) => t.by[0] === 'region').rows.find((x: any) => x.region === 'north')
  assert.equal(north.customers, 1, 'c1 bought in two months and is one customer')
  const months = r.rows.filter((x: any) => x.region === 'north').reduce((a: number, x: any) => a + x.customers, 0)
  assert.equal(months, 2, 'while the month cells count it twice — which is why totals are not sums')
})

test('share: each customer\'s part of its region, and of the whole', async () => {
  const { engine } = await setup()
  const r = (await engine.call<any>('orders', { measures: ['revenue'], by: ['region', 'customer'], during: H1, share: { measures: ['revenue'], within: ['region'] } })).value
  for (const region of ['north', 'south']) {
    const total = r.rows.filter((x: any) => x.region === region).reduce((a: number, x: any) => a + x.revenue_share, 0)
    assert.ok(Math.abs(total - 1) < 1e-9, `${region} shares add to one`)
  }
  await assert.rejects(engine.call('orders', { measures: ['price'], by: ['region'], during: H1, share: { measures: ['price'], within: [] } }), /does not add up/)
})

test('top N per group: the largest customer in each region', async () => {
  const { engine } = await setup()
  const r = (await engine.call<any>('orders', { measures: ['revenue'], by: ['region', 'customer'], during: H1,
    order: [{ by: 'revenue', desc: true }], limit: 1, limitPer: ['region'], totals: [['region']] })).value
  assert.deepEqual(r.rows.map((x: any) => [x.region, x.customer, x.revenue]).sort(), [['north', 'c1', 320], ['south', 'c4', 400], [null, 'c3', 80]].sort())
  assert.equal(r.totals[0].rows.find((x: any) => x.region === 'south').revenue, 700, 'the total counts the customers the limit leaves out')
})

// ── relative dates ────────────────────────────────────────────────────────────────────────────────────────
import { Grains, resolveSpan, resolveInstant } from '../src/index.ts'

test('relative spans resolve against today and the calendar', () => {
  const g = new Grains()
  const fiscal = new Grains({ fiscal_quarter: { fiscal: 'quarter', startMonth: 4 } })
  const today = '2026-09-14'
  assert.deepEqual(resolveSpan({ this: 'quarter' }, today, g), { from: '2026-07-01', to: '2026-10-01', said: 'this quarter' })
  assert.deepEqual(resolveSpan({ this: 'month', toDate: true }, today, g), { from: '2026-09-01', to: '2026-09-15', said: 'this month to date' })
  assert.deepEqual(resolveSpan({ previous: 'month', count: 3 }, today, g), { from: '2026-06-01', to: '2026-09-01', said: 'the previous 3 months' })
  assert.deepEqual(resolveSpan({ last: 30, unit: 'day' }, today, g), { from: '2026-08-16', to: '2026-09-15', said: 'the last 30 days' })
  assert.deepEqual(resolveSpan({ last: 1, unit: 'year' }, '2024-02-29', g), { from: '2023-03-01', to: '2024-03-01', said: 'the last 1 year' })
  assert.deepEqual(resolveSpan({ previous: 'fiscal_quarter' }, today, fiscal), { from: '2026-04-01', to: '2026-07-01', said: 'the previous fiscal_quarter' })
  assert.deepEqual(resolveInstant({ endOf: 'month' }, today, g), { at: '2026-08-31', said: 'the end of the previous month' })
  assert.deepEqual(resolveInstant({ endOf: 'quarter', count: 2 }, today, g), { at: '2026-03-31', said: 'the end of the previous 2 quarters' })
})

test('a question asked in relative dates is answered in dates, says which, and a replay means the same days', async () => {
  let day = '2026-06-15'
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-rel-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => day })
  await engine.define({ body: ORDERS_BODY, contract: ordersConcept }, { by: 'test' })
  const r = await engine.call<any>('orders', { measures: ['revenue'], during: { previous: 'quarter' }, compare: { offset: { quarters: 1 } } })
  assert.equal(r.value.rows[0].revenue, sum(ORDERS.filter((o) => o.ordered_on >= '2026-01-01' && o.ordered_on < '2026-04-01'), (o) => o.amount))
  assert.ok(store.getCall(r.callId)!.caveats.includes('the previous quarter: 2026-01-01 to 2026-03-31'))
  day = '2026-12-01'
  const again = await engine.replay<any>(r.callId)
  assert.deepEqual(again.value.rows, r.value.rows)
})

// ── time zones ────────────────────────────────────────────────────────────────────────────────────────────
import { dayIn, offsetMinutes, stretches } from '../src/index.ts'

// Moments written in UTC around New Zealand's return to standard time: 03:00 NZDT on 5 April 2026 is 14:00 UTC on
// the 4th, when Auckland moves from 13 hours ahead to 12.
const CLICKS = [
  { at: '2026-03-31 11:30:00', n: 1 },   // 1 April 00:30 in Auckland — April there, March in UTC
  { at: '2026-04-04 10:30:00', n: 1 },   // 4 April 23:30 NZDT
  { at: '2026-04-04 11:30:00', n: 1 },   // 5 April 00:30 NZDT
  { at: '2026-04-04 14:30:00', n: 1 },   // 5 April 02:30 NZST, after the change
  { at: '2026-04-05 11:30:00', n: 1 },   // 5 April 23:30 NZST
  { at: '2026-04-05 12:30:00', n: 1 },   // 6 April 00:30 NZST
]
const clicks: Contract = { name: 'clicks', kind: 'concept', description: 'Clicks.', reads: { sources: ['WEB'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: {}, measures: { clicks: { aggregate: 'sum', column: 'n', unit: 'clicks', kind: 'flow' } }, time: 'at', timeZone: 'UTC' } }

test('time zones: offsets and the stretches between daylight-saving changes', () => {
  assert.equal(offsetMinutes('Pacific/Auckland', new Date('2026-04-04T13:59:00Z')), 780)
  assert.equal(offsetMinutes('Pacific/Auckland', new Date('2026-04-04T14:00:00Z')), 720)
  assert.deepEqual(stretches('UTC', 'Pacific/Auckland', { from: '2026-04-01', to: '2026-04-10' }),
    [{ until: '2026-04-04 14:00:00', minutes: 780 }, { until: null, minutes: 720 }])
  assert.equal(dayIn('Pacific/Auckland', new Date('2026-09-13T20:00:00Z')), '2026-09-14')
})

test('time zones: moments counted on the day they happened where the question is asked', async () => {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-tz-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14' })
  await engine.define({ body: `export default async () => ({ source: 'WEB', rows: ${JSON.stringify(CLICKS)} })`, contract: clicks }, { by: 'test' })
  const byDay = async (timezone?: string) => new Map((await engine.call<any>('clicks', { by: ['day'], during: { from: '2026-03-31', to: '2026-04-07' } },
    timezone ? { assume: { timezone } } : {})).value.rows.map((r: any) => [r.day, r.clicks]))
  assert.deepEqual(await byDay(), new Map([['2026-03-31', 1], ['2026-04-04', 3], ['2026-04-05', 2]]), 'as written, in UTC')
  assert.deepEqual(await byDay('Pacific/Auckland'), new Map([['2026-04-01', 1], ['2026-04-04', 1], ['2026-04-05', 3], ['2026-04-06', 1]]), 'in Auckland, across the change')
  const march = await engine.call<any>('clicks', { during: { from: '2026-03-01', to: '2026-04-01' } }, { assume: { timezone: 'Pacific/Auckland' } })
  assert.equal(march.value.rows[0]?.clicks ?? 0, 0, 'the 31 March UTC click is April in Auckland, so outside March')
  assert.ok(store.getCall(march.callId)!.assumptions.some((a) => a.name === 'timezone' && a.value === 'Pacific/Auckland'))
})

test('time zones: today is the date where the asker is', async () => {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-tz-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [],
    assumptions: { timezone: { rules: [{ value: 'UTC' }, { when: { 'who.country': 'NZ' }, value: 'Pacific/Kiritimati' }] } } })
  await engine.define({ body: `export default (ctx) => ctx.today`, contract: { name: 'today', kind: 'program', description: 'Today.', reads: { sources: [], programs: [] }, params: {}, returns: 'value' } }, { by: 'test' })
  assert.equal((await engine.call('today')).value, dayIn('UTC'))
  assert.equal((await engine.call('today', {}, { who: { country: 'NZ' } })).value, dayIn('Pacific/Kiritimati'))
  await assert.rejects(engine.call('today', {}, { assume: { timezone: 'Mars/Olympus' } }), /not a time zone/)
})
