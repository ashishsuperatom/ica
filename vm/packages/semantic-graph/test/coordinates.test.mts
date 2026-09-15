// Totals, shares, having, comparison with an earlier span, and the rows behind a group — on the branches fixture,
// with each answer worked out by hand from its five sales.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, detail, evaluate, type Question } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'

const plan = (q: Question) => { const v = check(s, q); if (!v.ok) assert.fail(`${v.rule}: ${v.reason}`); return v.plan }
const refused = (q: Question, rule: string) => { const v = check(s, q); assert.equal(v.ok, false); if (!v.ok) assert.equal(v.rule, rule, v.reason) }
const BRANCH = { to: 'Branch', via: ['project', 'branch'] }

test('totals at coarser groupings are asked again, not added up', () => {
  const r = evaluate(s, I, plan({ measures: ['Sale.hours'], by: [BRANCH, { to: 'Month' }], totals: [['Branch by project.branch'], []] }))
  assert.deepEqual(r.rows, [['b1', '2026-09', 15], ['b1', '2026-10', 6], ['b3', '2026-09', 8]])
  assert.deepEqual(r.totals, [{ by: ['Branch by project.branch'], rows: [['b1', 21], ['b3', 8]] }, { by: [], rows: [[29]] }])
  // Two people each month, but three people in all: a distinct count is counted again for the total.
  assert.deepEqual(evaluate(s, I, plan({ measures: ['Sale.people'], by: [{ to: 'Month' }], totals: [[]] })).totals, [{ by: [], rows: [[3]] }])
  refused({ measures: ['Sale.hours'], by: [BRANCH], totals: [['Month']] }, 'Q')
})

test('a share is a part over its whole, and only where parts add up to the whole', () => {
  const r = evaluate(s, I, plan({ measures: ['Sale.hours'], by: [BRANCH], share: { outputs: ['Sale.hours'], within: [] } }))
  assert.deepEqual(r.rows, [['b1', 21, 21 / 29], ['b3', 8, 8 / 29]])
  const m = evaluate(s, I, plan({ measures: ['Sale.hours'], by: [BRANCH, { to: 'Month' }], share: { outputs: ['Sale.hours'], within: ['Month'] } }))
  assert.deepEqual(m.rows, [['b1', '2026-09', 15, 15 / 23], ['b1', '2026-10', 6, 1], ['b3', '2026-09', 8, 8 / 23]])
  refused({ measures: ['Sale.people'], by: [BRANCH], share: { outputs: ['Sale.people'], within: [] } }, 'B3')
  refused({ measures: ['Sale.rate'], by: [BRANCH], currency: 'AUD', share: { outputs: ['Sale.rate'], within: [] } }, 'B3')
  refused({ measures: ['[Sale.amount] / [Sale.hours]'], by: [BRANCH], currency: 'AUD', share: { outputs: ['[Sale.amount] / [Sale.hours]'], within: [] } }, 'B3')
})

test('having keeps groups by their answer, before order and limit', () => {
  assert.deepEqual(evaluate(s, I, plan({ measures: ['Sale.hours'], by: [{ to: 'Month' }], having: [{ output: 'Sale.hours', op: '>', value: 10 }] })).rows, [['2026-09', 23]])
  refused({ measures: ['Sale.hours'], having: [{ output: 'Sale.amount', op: '>', value: 1 }] }, 'Q')
})

test('compare: October beside September, matched period to period', () => {
  const r = evaluate(s, I, plan({ measures: ['Sale.hours'], by: [{ to: 'Month' }], span: { from: '2026-10-01', to: '2026-11-01' }, compare: { back: { months: 1 } } }))
  assert.deepEqual(r.columns.map((c) => c.name), ['Month', 'Sale.hours', 'Sale.hours before', 'Sale.hours change'])
  assert.deepEqual(r.rows, [['2026-10', 6, 23, -17]])
  const byBranch = evaluate(s, I, plan({ measures: ['Sale.hours'], by: [BRANCH], span: { from: '2026-10-01', to: '2026-11-01' }, compare: { back: { months: 1 } } }))
  assert.deepEqual(byBranch.rows, [['b1', 6, 15, -9], ['b3', 0, 8, -8]])
  refused({ measures: ['Sale.hours'], by: [{ to: 'Quarter' }], span: { from: '2026-10-01', to: '2027-01-01' }, compare: { back: { months: 1 } } }, 'D6')
  refused({ measures: ['Sale.hours'], compare: { back: { months: 1 } } }, 'D6')
})

test('drill through: the rows behind a group', () => {
  const p = plan({ measures: ['Sale.hours'], by: [BRANCH] })
  const [sales] = detail(s, I, p, ['b3'])
  assert.equal(sales.rows.length, 1)
  assert.equal(sales.rows[0].measures.hours, 8)
  assert.equal(detail(s, I, p, ['b1'])[0].rows.reduce((a, r) => a + r.measures.hours!, 0), 21)
})
