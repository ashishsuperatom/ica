// A question's program gives back an answer: data, views, narration whose numbers are read from the data, and next
// steps a data session can apply.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, createEngine, type Contract } from '../src/index.ts'

const ORDERS = [
  { ordered_on: '2026-04-03', customer_id: 'c1', customer_name: 'Ash', region: 'north', amount: 500 },
  { ordered_on: '2026-04-20', customer_id: 'c2', customer_name: 'Birch', region: 'south', amount: 300 },
  { ordered_on: '2026-06-15', customer_id: 'c4', customer_name: 'Dune', region: 'north', amount: 100 },
]
const orders: Contract = { name: 'orders', kind: 'concept', description: 'Orders.', reads: { sources: ['SHOP'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { customer: { column: 'customer_id', label: 'customer_name', history: 'stable' }, region: { column: 'region', history: 'stable' } },
           measures: { revenue: { aggregate: 'sum', column: 'amount', unit: 'NZD', kind: 'flow' } }, time: 'ordered_on' } }

const answerProgram = (body: string): { body: string; contract: Contract } => ({ body,
  contract: { name: 'revenue by region', kind: 'program', description: 'Revenue by region, and who leads.', reads: { sources: [], programs: ['orders'] },
              params: { during: 'the span', region: 'a region to look into' }, returns: 'answer' } })

const GOOD = `export default async (ctx, { during, region }) => {
  const byRegion = await ctx.call('orders', { by: ['region'], during, ...(region ? { where: { region } } : {}), totals: [[]] })
  const leader = [...byRegion.rows].sort((a, b) => b.revenue - a.revenue)[0]
  return {
    data: { byRegion, total: { columns: byRegion.totals[0].columns, rows: byRegion.totals[0].rows } },
    views: [{ id: 'bars', component: 'bar', data: 'byRegion', title: 'Revenue by region', encode: { x: 'region', y: 'revenue' } }],
    narration: [
      { text: leader.region + ' leads with {lead} of {all}.', cites: {
          lead: { data: 'byRegion', row: { region: leader.region }, column: 'revenue' },
          all: { data: 'total', column: 'revenue' } }, why: 'the region with the most revenue in the span' },
    ],
    nextSteps: [
      { label: 'Look into ' + leader.region, message: { set: { region: leader.region } } },
      { label: 'By salesperson', message: { set: { salesperson: 'any' } } },
    ],
  }
}`

async function setup() {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-ans-')), 'org.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14' })
  await engine.define({ body: `export default async () => ({ source: 'SHOP', rows: ${JSON.stringify(ORDERS)} })`, contract: orders }, { by: 'test' })
  return { engine, store }
}
const Q2 = { from: '2026-04-01', to: '2026-07-01' }

test('the narration\'s numbers are read from the cells it cites', async () => {
  const { engine } = await setup()
  await engine.define(answerProgram(GOOD), { by: 'test' })
  const a = (await engine.call<any>('revenue by region', { during: Q2 })).value
  assert.equal(a.narration[0].text, 'north leads with 600 of 900.')
  assert.equal(a.narration[0].values.lead.value, 600)
  assert.equal(a.views[0].component, 'bar')
})

test('refused: a typed number, a slot citing nothing, a row that is not there, a view of a column that does not exist', async () => {
  const cases: Array<[string, string, RegExp]> = [
    ['typed', GOOD.replace("' leads with {lead} of {all}.'", "' leads with {lead} of 900.'"), /types the number 900/],
    ['uncited', GOOD.replace("all: { data: 'total', column: 'revenue' } }", "} "), /slot \{all\} that cites nothing/],
    ['no row', GOOD.replace("row: { region: leader.region }", "row: { region: 'west' }"), /matches 0 rows/],
    ['no column', GOOD.replace("y: 'revenue'", "y: 'profit'"), /puts "profit" as y, and "byRegion" has no such column/],
  ]
  for (const [label, body, want] of cases) {
    const { engine } = await setup()
    await engine.define(answerProgram(body), { by: 'test' })
    await assert.rejects(engine.call('revenue by region', { during: Q2 }), want, label)
  }
})

test('in a data session, next steps are offered only when they apply to the state, and applying one answers again', async () => {
  const { engine } = await setup()
  await engine.define(answerProgram(GOOD), { by: 'test' })
  const s = engine.sessions
  const id = s.open()
  const first = await s.apply(id, { ask: 'revenue by region', request: { during: Q2 } })
  const a = first.value as any
  assert.deepEqual(a.nextSteps.map((n: any) => n.label), ['Look into north'])
  assert.match(a.dropped[0], /By salesperson: "revenue by region" takes during, region; it has no "salesperson"/)
  const next = await s.apply(id, a.nextSteps[0].message)
  assert.equal((next.value as any).narration[0].text, 'north leads with 600 of 600.')
})
