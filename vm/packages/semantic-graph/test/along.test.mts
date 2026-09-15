// Along a calendar: filled periods, running totals with resets, moving windows with a ratio recomputed from its parts'
// windows, limits within groups, medians, like-for-like comparison of a span still running, and drill-through in SQL
// — each worked out by hand, and each also run in SQL and required to match the evaluator.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, detail, detailSql, evaluate, runSql, type Instance, type Question, type Schema } from '../src/index.js'
import { instance as base, schema as s0 } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

// Sales by month: July 10h, September 20h (August empty), October 30h, November 40h — j1 (b1) — and j2 (b3) 5h each month.
function data(): { s: Schema; I: Instance } {
  const s: Schema = structuredClone(s0)
  s.objects.Sale.measures!.medianHours = { unit: 'h', kind: 'flow', aggregate: 'median' }
  const I = structuredClone(base)
  const row = (day: string, project: string, hours: number) => ({ arrows: { person: 'p2', project, day }, attributes: { commitment: 'Hard', currency: 'AUD' }, measures: { hours, amount: hours * 100, rate: 100, medianHours: hours } })
  I.rows.Sale = [row('2026-07-10', 'j1', 10), row('2026-09-10', 'j1', 20), row('2026-10-10', 'j1', 30), row('2026-11-10', 'j1', 40), row('2026-11-11', 'j1', 2),
    ...['07', '08', '09', '10', '11'].map((m) => row(`2026-${m}-12`, 'j2', 5))]
  return { s, I }
}
const SPAN = { from: '2026-07-01', to: '2026-12-01' }
const B = { to: 'Branch', via: ['project', 'branch'] }

async function both(s: Schema, I: Instance, q: Question, context: { today?: string } = {}) {
  const v = check(s, q, context)
  if (!v.ok) assert.fail(`${v.rule}: ${v.reason}`)
  const mem = evaluate(s, I, v.plan)
  const { query, sources } = toSqlite(s, I)
  assert.deepEqual((await runSql(s, sources, v.plan, query)).rows, mem.rows, 'SQL and the evaluator agree')
  return mem.rows
}

test('fill: every month of the span, an empty one as zero', async () => {
  const { s, I } = data()
  assert.deepEqual(await both(s, I, { measures: ['Sale.hours'], by: [{ to: 'Month' }], where: [{ to: 'Project', via: ['project'], in: ['j1'] }], span: SPAN, fill: true }),
    [['2026-07', 10], ['2026-08', 0], ['2026-09', 20], ['2026-10', 30], ['2026-11', 42]])
})

test('running totals, starting again each quarter', async () => {
  const { s, I } = data()
  assert.deepEqual(await both(s, I, { measures: ['Sale.hours'], by: [B, { to: 'Month' }], span: SPAN, cumulative: {} }),
    [['b1', '2026-07', 10], ['b1', '2026-09', 30], ['b1', '2026-10', 60], ['b1', '2026-11', 102],
     ['b3', '2026-07', 5], ['b3', '2026-08', 10], ['b3', '2026-09', 15], ['b3', '2026-10', 20], ['b3', '2026-11', 25]])
  assert.deepEqual(await both(s, I, { measures: ['Sale.hours'], by: [{ to: 'Month' }], where: [{ to: 'Project', via: ['project'], in: ['j1'] }], span: SPAN, cumulative: { reset: 'Quarter' } }),
    [['2026-07', 10], ['2026-09', 30], ['2026-10', 30], ['2026-11', 72]])
  const bad = check(s, { measures: ['Sale.people'], by: [{ to: 'Month' }], span: SPAN, cumulative: {} })
  assert.ok(!bad.ok && bad.rule === 'B4')
})

test('a moving window reads the periods before the span; a ratio is computed from the windows of its parts', async () => {
  const { s, I } = data()
  const j1 = [{ to: 'Project', via: ['project'], in: ['j1'] }]
  // Three-month total for September to November: Jul–Sep 30, Aug–Oct 50, Sep–Nov 92.
  assert.deepEqual(await both(s, I, { measures: ['Sale.hours'], by: [{ to: 'Month' }], where: j1, span: { from: '2026-09-01', to: '2026-12-01' }, rolling: { window: 3 } }),
    [['2026-09', 30], ['2026-10', 50], ['2026-11', 92]])
  const avg = await both(s, I, { measures: ['Sale.hours', '[Sale.amount] / [Sale.hours]'], by: [{ to: 'Month' }], where: j1, span: { from: '2026-09-01', to: '2026-12-01' }, rolling: { window: 3, average: true }, currency: 'AUD' })
  assert.deepEqual(avg.map((r) => [r[0], r[1], r[2]]), [['2026-09', 10, 100], ['2026-10', 50 / 3, 100], ['2026-11', 92 / 3, 100]])
})

test('limit within groups: the top month of each branch', async () => {
  const { s, I } = data()
  assert.deepEqual(await both(s, I, { measures: ['Sale.hours'], by: [B, { to: 'Month' }], span: SPAN, order: { by: 'Sale.hours', desc: true }, limit: 1, limitPer: ['Branch by project.branch'] }),
    [['b1', '2026-11', 42], ['b3', '2026-07', 5]])
})

test('a median is taken of the rows in each group, and recomputed for totals', async () => {
  const { s, I } = data()
  assert.deepEqual(await both(s, I, { measures: ['Sale.medianHours'], by: [B], span: SPAN }), [['b1', 20], ['b3', 5]])
  const v = check(s, { measures: ['Sale.medianHours'], by: [B], span: SPAN, totals: [[]] })
  assert.ok(v.ok)
  assert.deepEqual(evaluate(s, I, v.plan).totals, [{ by: [], rows: [[5]] }])
})

test('a span still running is compared like for like', () => {
  const { s, I } = data()
  const q: Question = { measures: ['Sale.hours'], by: [B], span: { from: '2026-11-01', to: '2026-12-01' }, compare: { back: { months: 1 } } }
  const v = check(s, q, { today: '2026-11-10' })
  assert.ok(v.ok)
  assert.ok(v.plan.notes.some((n) => /first 10 days/.test(n)))
  // November to the 10th (j1 40h on the 10th) against October 1–10 (30h on the 10th); j2 on the 12th is outside both.
  assert.deepEqual(evaluate(s, I, v.plan).rows, [['b1', 42, 30, 12], ['b3', 5, 0, 5]])
})

test('drill through in SQL: the rows behind a group, as the evaluator finds them', async () => {
  const { s, I } = data()
  const v = check(s, { measures: ['Sale.hours'], by: [B, { to: 'Month' }], span: SPAN })
  assert.ok(v.ok)
  const { query, sources } = toSqlite(s, I)
  const [sql] = await detailSql(s, sources, v.plan, ['b1', '2026-11'], query, { limit: 1 })
  assert.equal(sql.rows.length, 1); assert.equal(sql.more, true)
  const [all] = await detailSql(s, sources, v.plan, ['b1', '2026-11'], query)
  assert.deepEqual(all.rows.map((r) => r.hours), detail(s, I, v.plan, ['b1', '2026-11'])[0].rows.map((r) => r.measures.hours))
})
