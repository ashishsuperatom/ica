// The SQL executor against the reference evaluator: every question below is answered from the same data twice —
// in memory, and by SQL run on SQLite — and the answers must be the same. The questions cover every rule and
// coordinate the evaluator tests prove correct by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, CompileError, compileSql, evaluate, materialise, runSql, type Instance, type Question, type Schema } from '../src/index.js'
import * as branches from './fixtures/branches.js'
import * as f5 from './fixtures/fusion5-sim.js'
import { toSqlite } from './fixtures/sqlite.js'

const round = (x: unknown): unknown => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : Array.isArray(x) ? x.map(round) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, round(v)])) : x)

async function same(s: Schema, I: Instance, questions: Array<[string, Question]>) {
  const { query, sources } = toSqlite(s, I)
  for (const [name, q] of questions) {
    const v = check(s, q)
    if (!v.ok) assert.fail(`${name}: ${v.rule} ${v.reason}`)
    const expected = evaluate(s, I, v.plan)
    const got = await runSql(s, sources, v.plan, query)
    assert.ok(expected.rows.length, `${name}: the reference answer is empty`)
    assert.deepEqual(round({ rows: got.rows, totals: got.totals }), round({ rows: expected.rows, totals: expected.totals }), name)
  }
}

const B = { to: 'Branch', via: ['project', 'branch'] }
test('branches: every rule, in SQL, gives the reference answer', async () => {
  await same(branches.schema, branches.instance, [
    ['fan trap', { measures: ['Sale.hours', 'Contract.value'], by: [B], currency: 'AUD' }],
    ['chasm trap with a ratio', { measures: ['Sale.amount', 'Budget.budget', '[Sale.amount] / [Budget.budget]'], by: [{ to: 'Branch', via: { Sale: ['project', 'branch'], Budget: ['branch'] } }, { to: 'Month' }], where: [{ to: 'BudgetVersion', in: ['base'] }], span: { from: '2026-09-01', to: '2026-11-01' }, currency: 'AUD' }],
    ['versions grouped', { measures: ['Budget.budget'], by: [{ to: 'BudgetVersion' }], currency: 'AUD', span: { from: '2026-09-01', to: '2026-10-01' } }],
    ['equation path', { measures: ['Sale.hours'], by: [{ to: 'State', via: ['project', 'branch', 'state'] }] }],
    ['as of', { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['person', 'branch'] }], span: { from: '2026-09-01', to: '2026-10-01' } }],
    ['two arrows up a hierarchy', { measures: ['Sale.hours'], by: [{ to: 'Region', via: ['project', 'state', 'region'] }] }],
    ['as of, then up', { measures: ['Sale.hours'], by: [{ to: 'Region', via: ['person', 'branch', 'state', 'region'] }] }],
    ['quarters', { measures: ['Sale.hours'], by: [{ to: 'Quarter' }] }],
    ['stock at the last month', { measures: ['Headcount.people'], by: [{ to: 'Branch' }, { to: 'Quarter' }] }],
    ['stock overall', { measures: ['Headcount.people'] }],
    ['stock by month', { measures: ['Headcount.people'], by: [{ to: 'Month' }] }],
    ['money by currency', { measures: ['Sale.amount'], by: [{ attribute: 'currency' }] }],
    ['money converted per row', { measures: ['Sale.amount'], by: [{ to: 'Month' }], currency: 'AUD' }],
    ['a rate over hours', { measures: ['[Sale.amount] / [Sale.hours]'], by: [B], currency: 'AUD' }],
    ['weighted rate', { measures: ['Sale.rate'], by: [{ attribute: 'commitment' }], currency: 'AUD' }],
    ['distinct people', { measures: ['Sale.people'], by: [{ to: 'Month' }] }],
    ['partial arrow', { measures: ['Sale.hours'], by: [{ to: 'Person', via: ['project', 'sponsor'] }] }],
    ['under a manager', { measures: ['Sale.hours'], where: [{ to: 'Person', via: ['person'], under: 'manager', in: ['p2'] }] }],
    ['names', { measures: ['Sale.hours'], where: [{ to: 'Branch', via: ['project', 'branch'], in: ['Sydney'] }] }],
    ['attribute filter', { measures: ['Sale.hours'], by: [{ to: 'Month' }], where: [{ attribute: 'commitment', in: ['Hard'] }] }],
    ['totals', { measures: ['Sale.hours', 'Sale.people'], by: [B, { to: 'Month' }], totals: [['Branch by project.branch'], []] }],
    ['share', { measures: ['Sale.hours'], by: [B, { to: 'Month' }], share: { outputs: ['Sale.hours'], within: ['Month'] } }],
    ['having, order, limit', { measures: ['Sale.hours'], by: [{ to: 'Person', via: ['person'] }], having: [{ output: 'Sale.hours', op: '>=', value: 4 }], order: { by: 'Sale.hours', desc: true }, limit: 2 }],
    ['compare', { measures: ['Sale.hours'], by: [B], span: { from: '2026-10-01', to: '2026-11-01' }, compare: { back: { months: 1 } } }],
  ])
})

test('Scenario 1: every question, in SQL, gives the reference answer', async () => {
  const I = materialise(f5.model)
  const SPAN = { from: '2026-09-01', to: '2026-11-01' }
  await same(f5.schema, I, [
    ['AU revenue, hard and soft', { measures: ['AllocationDay.revenue'], by: [{ to: 'Month' }, { attribute: 'commitment' }], where: [{ to: 'Subsidiary', via: ['project', 'subsidiary'], in: ['AU'] }], span: SPAN, currency: 'AUD' }],
    ['all revenue in AUD, as of today', { measures: ['AllocationDay.revenue'], by: [{ to: 'Month' }], span: SPAN, currency: 'AUD', asOf: '2026-09-15' }],
    ['revenue against Base Budget', { measures: ['AllocationDay.revenue', 'BudgetLine.budget', '[AllocationDay.revenue] - [BudgetLine.budget]'], by: [{ to: 'Pillar', via: { AllocationDay: ['project', 'pillar'], BudgetLine: ['pillar'] } }, { to: 'Month' }], where: [{ to: 'Subsidiary', via: { AllocationDay: ['project', 'subsidiary'], BudgetLine: ['subsidiary'] }, in: ['AU'] }, { to: 'BudgetCategory', in: ['Base Budget'] }], span: SPAN, currency: 'AUD' }],
    ['by the pillar a person was in', { measures: ['AllocationDay.hours'], by: [{ to: 'Pillar', via: ['person', 'pillar'] }, { to: 'Month' }], span: SPAN }],
    ['by the project manager\'s pillar that day', { measures: ['AllocationDay.hours'], by: [{ to: 'Pillar', via: ['project', 'manager', 'pillar'] }], span: SPAN }],
    ['everyone under e1', { measures: ['AllocationDay.hours'], where: [{ to: 'Person', via: ['person'], under: 'manager', in: ['e1'] }], span: SPAN }],
    ['pillar shares with totals', { measures: ['AllocationDay.hours', 'AllocationDay.unpriced hours'], by: [{ to: 'Pillar', via: ['project', 'pillar'] }], span: SPAN, share: { outputs: ['AllocationDay.hours'], within: [] }, totals: [[]] }],
    ['October against September', { measures: ['AllocationDay.revenue'], by: [{ to: 'Month' }], span: { from: '2026-10-01', to: '2026-11-01' }, currency: 'AUD', compare: { back: { months: 1 } } }],
  ])
})

test('a statement is one per fact, and says why it cannot be made', () => {
  const { sources } = toSqlite(branches.schema, branches.instance)
  const v = check(branches.schema, { measures: ['Sale.hours', 'Contract.value'], by: [B], currency: 'AUD' })
  assert.ok(v.ok)
  const st = compileSql(branches.schema, sources, v.plan)
  assert.deepEqual(st.map((x) => x.fact), ['Sale', 'Contract'])
  assert.ok(!/JOIN[^]*Contract/.test(st[0].sql), 'sales are not joined to contracts')
  const elsewhere = structuredClone(sources)
  elsewhere.entities.Project.source = 'CRM'
  assert.throws(() => compileSql(branches.schema, elsewhere, v.plan), (e) => e instanceof CompileError && /Project is in CRM and Sale in DB/.test((e as Error).message))
})
