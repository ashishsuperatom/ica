// Money in several currencies: never added across currencies; converted to one at rates as at the end of what is
// asked, with every row that could not be converted caught in the same statement.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, createEngine, type Contract } from '../src/index.ts'

const SALES = [
  { sold_on: '2026-05-03', region: 'nz', currency_code: 'NZD', amount: 100 },
  { sold_on: '2026-05-10', region: 'au', currency_code: 'AUD', amount: 200 },
  { sold_on: '2026-06-01', region: 'au', currency_code: 'AUD', amount: 50 },
  { sold_on: '2026-06-20', region: 'us', currency_code: 'USD', amount: 10 },
]
// Rates into NZD, changing on 1 June.
const RATES = [
  { from_code: 'AUD', to_code: 'NZD', rate: 1.10, from: '2026-01-01', to: '2026-06-01' },
  { from_code: 'AUD', to_code: 'NZD', rate: 1.12, from: '2026-06-01', to: null },
  { from_code: 'USD', to_code: 'NZD', rate: 1.70, from: '2026-01-01', to: null },
]
const sales: Contract = { name: 'sales', kind: 'concept', description: 'Sales.', reads: { sources: ['SHOP'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { region: { column: 'region', history: 'stable' }, currency: { column: 'currency_code', history: 'stable' } },
           measures: { revenue: { aggregate: 'sum', column: 'amount', unit: 'money', kind: 'flow', currency: 'currency' },
                       sales: { aggregate: 'count', unit: 'sales', kind: 'flow' } }, time: 'sold_on' } }
const rates: Contract = { name: 'fx', kind: 'concept', description: 'Exchange rates as at an instant.', reads: { sources: ['SHOP'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { from_currency: { column: 'from_code', history: 'stable' }, to_currency: { column: 'to_code', history: 'stable' } },
           measures: { rate: { aggregate: 'max', column: 'rate', unit: 'ratio', kind: 'stock' } } } }
const ratesBody = (rows = RATES) => `const R = ${JSON.stringify(rows)}
export default async (ctx, { asAt }) => ({ source: 'SHOP', rows: R.filter((r) => r.from <= asAt && (!r.to || r.to > asAt)) })`

const AT_END = { relation: 'fx', at: 'end' }
async function setup(organisation: Record<string, unknown> = { 'exchange rates': AT_END }, rateRows = RATES) {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-fx-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14', assumptions: organisation })
  await engine.define({ body: `export default async () => ({ source: 'SHOP', rows: ${JSON.stringify(SALES)} })`, contract: sales }, { by: 'test' })
  await engine.define({ body: ratesBody(rateRows), contract: rates }, { by: 'test' })
  return { engine, store }
}
const Q2 = { from: '2026-04-01', to: '2026-07-01' }

test('refused: adding amounts across currencies; allowed split by currency or filtered to one', async () => {
  const { engine } = await setup({})
  await assert.rejects(engine.call('sales', { measures: ['revenue'], during: Q2 }), /say the currency to report in, split by "currency", or filter to one/)
  const split = (await engine.call<any>('sales', { measures: ['revenue'], by: ['currency'], during: Q2 })).value.rows
  assert.deepEqual(new Map(split.map((r: any) => [r.currency, r.revenue])), new Map([['AUD', 250], ['NZD', 100], ['USD', 10]]))
  assert.equal((await engine.call<any>('sales', { measures: ['revenue'], where: { currency: 'AUD' }, during: Q2 })).value.rows[0].revenue, 250)
  assert.equal((await engine.call<any>('sales', { measures: ['sales'], during: Q2 })).value.rows[0].sales, 4, 'a count has no currency')
})

test('converted to one currency at rates as at the end of the span, and the unit says which', async () => {
  const { engine, store } = await setup()
  const r = await engine.call<any>('sales', { measures: ['revenue'], by: ['region'], during: Q2, currency: 'NZD' })
  const byRegion = new Map(r.value.rows.map((x: any) => [x.region, x.revenue]))
  assert.equal(byRegion.get('nz'), 100)
  assert.ok(Math.abs((byRegion.get('au') as number) - 250 * 1.12) < 1e-9, 'June 30 rate, for May and June alike')
  assert.ok(Math.abs((byRegion.get('us') as number) - 17) < 1e-9)
  assert.equal(r.value.columns.find((c: any) => c.name === 'revenue').unit, 'NZD')
  const call = store.getCall(r.callId)!
  assert.ok(call.caveats.includes('amounts are converted to NZD at rates as at 2026-06-30'))
  assert.ok(call.verifications.some((v) => v.label === 'every amount has a rate to convert it with' && v.held))
  assert.ok(call.verifications.some((v) => /sums to the whole/.test(v.label) && v.held))
})

test('the organisation\'s reporting currency applies when the question names none; a missing rate is refused', async () => {
  const { engine } = await setup({ 'exchange rates': AT_END, currency: 'NZD' })
  assert.ok(Math.abs((await engine.call<any>('sales', { measures: ['revenue'], during: Q2 })).value.rows[0].revenue - (100 + 250 * 1.12 + 17)) < 1e-9)
  const noUsd = await setup({ 'exchange rates': AT_END }, RATES.filter((r) => r.from_code !== 'USD'))
  await assert.rejects(noUsd.engine.call('sales', { measures: ['revenue'], during: Q2, currency: 'NZD' }), /every amount has a rate to convert it with — 1 row\(s\) have no rate/)
})

test('refused: two rates for one pair of currencies at the same instant', async () => {
  const { engine } = await setup({ 'exchange rates': AT_END }, [...RATES, { from_code: 'USD', to_code: 'NZD', rate: 1.8, from: '2026-06-01', to: null }])
  await assert.rejects(engine.call('sales', { measures: ['revenue'], during: Q2, currency: 'NZD' }), /one rate per pair of currencies/)
})

test('per row: each amount at the rate in effect on its own date, when the organisation converts that way', async () => {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-fx-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14',
    assumptions: { 'exchange rates': { relation: 'fx history', at: 'row' } } })
  await engine.define({ body: `export default async () => ({ source: 'SHOP', rows: ${JSON.stringify(SALES)} })`, contract: sales }, { by: 'test' })
  const history: Contract = { ...rates, name: 'fx history', shape: { ...rates.shape!, dimensions: { ...rates.shape!.dimensions,
    effective_from: { column: 'valid_from', history: 'stable' }, effective_to: { column: 'valid_to', history: 'stable' } } } }
  const rows = RATES.map(({ from, to, ...r }) => ({ ...r, valid_from: from, valid_to: to }))
  await engine.define({ body: `export default async (ctx, { asAt }) => ({ source: 'SHOP', rows: ${JSON.stringify(rows)}.filter((r) => r.valid_from <= asAt) })`, contract: history }, { by: 'test' })
  const r = await engine.call<any>('sales', { measures: ['revenue'], by: ['region'], during: Q2, currency: 'NZD' })
  const au = r.value.rows.find((x: any) => x.region === 'au').revenue
  assert.ok(Math.abs(au - (200 * 1.10 + 50 * 1.12)) < 1e-9, 'May at the May rate, June at the June rate')
  assert.ok(store.getCall(r.callId)!.caveats.some((c) => /rate in effect on each row's date/.test(c)))
  await assert.rejects(createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14',
    assumptions: { 'exchange rates': 'fx history' } }).call('sales', { measures: ['revenue'], during: Q2, currency: 'NZD' }), /must say which relation holds the rates and how they apply/)
})
