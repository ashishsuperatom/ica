// THE LONGEST RUN along a calendar: for each group, the most consecutive periods in a row in which an output meets a
// comparison — consecutive in the calendar, so a period missing from the answer breaks the run. An extra column, one
// value per group on each of its rows, in the calendar's periods; the SQL path must give the oracle's answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, evaluate, runSql, type Question, type Schema } from '../src/index.js'
import { instance as I, schema as s, W } from './fixtures/shifts.js'
import { toSqlite } from './fixtures/sqlite.js'

const SPAN = { from: '2026-01-05', to: '2026-02-23' }
async function both(q: Question, context: { settings?: Record<string, unknown> } = {}) {
  const v = check(s, q, context)
  if (!v.ok) assert.fail(`${v.rule}: ${v.reason}`)
  const mem = evaluate(s, I, v.plan)
  const { query, sources } = toSqlite(s, I)
  assert.deepEqual((await runSql(s, sources, v.plan, query)).rows, mem.rows, 'SQL and the oracle agree')
  return { rows: mem.rows, columns: mem.columns, plan: v.plan }
}

test('the longest run of weeks at or over 8h, per person, with a week nobody worked breaking it', async () => {
  const q: Question = { measures: ['Shift.worked'], by: [{ to: 'Person' }, { to: 'Week' }], span: SPAN, runs: { output: 'Shift.worked', op: '>=', value: 8, along: 'Week' } }
  const { rows, columns } = await both(q)
  assert.deepEqual(columns.at(-1), { name: 'Shift.worked longest run', unit: 'weeks' })
  // p1: 6, 9, 9 | gap | 12, 9, 9 → 3.  p2: 8, 8, (nothing) | gap | 8, 7, 8 → 2.
  assert.deepEqual(rows, [
    ['p1', W[0], 6, 3], ['p1', W[1], 9, 3], ['p1', W[2], 9, 3], ['p1', W[3], 12, 3], ['p1', W[4], 9, 3], ['p1', W[5], 9, 3],
    ['p2', W[0], 8, 2], ['p2', W[1], 8, 2], ['p2', W[2], null, 2], ['p2', W[3], 8, 2], ['p2', W[4], 7, 2], ['p2', W[5], 8, 2],
  ])
  // Filled, the missing week is 0h, which still breaks the run; and a run is of any output, a count included.
  const filled = await both({ ...q, fill: true })
  assert.equal(filled.rows.length, 14)
  assert.ok(filled.rows.every((r) => r[3] === (r[0] === 'p1' ? 3 : 2)))
  const none = await both({ ...q, runs: { output: 'Shift.worked', op: '>', value: 100, along: 'Week' } })
  assert.ok(none.rows.every((r) => r[3] === 0))
  // Without the calendar's companion target, one group: p1 and p2 together, 14, 17, 9 | gap | 20, 16, 17 → 3.
  const all = await both({ measures: ['Shift.worked'], by: [{ to: 'Week' }], span: SPAN, runs: { output: 'Shift.worked', op: '>=', value: 16, along: 'Week' } })
  assert.deepEqual(all.rows.map((r) => r.at(-1)), [3, 3, 3, 3, 3, 3])
  // Ordered by the run: the column is one of the answer's.
  const ordered = await both({ ...q, order: { by: 'Shift.worked longest run', desc: true }, limit: 1 })
  assert.deepEqual(ordered.rows, [['p1', W[0], 6, 3]])
})

test('a run is refused when its calendar is not grouped by, its output is not answered, or its setting has no value', () => {
  const q: Question = { measures: ['Shift.worked'], by: [{ to: 'Person' }, { to: 'Week' }], span: SPAN }
  const a = check(s, { ...q, runs: { output: 'Shift.worked', op: '>=', value: 8, along: 'Month' } })
  assert.ok(!a.ok && a.rule === 'Q' && /Month is not one of its targets \(Person, Week\) — group by it/.test(a.reason), JSON.stringify(a))
  const b = check(s, { ...q, runs: { output: 'Shift.worked', op: '>=', value: 8, along: 'Person' } })
  assert.ok(!b.ok && b.rule === 'Q' && /Person is not one/.test(b.reason), JSON.stringify(b))
  const c = check(s, { ...q, runs: { output: 'Shift.target', op: '>=', value: 8, along: 'Week' } })
  assert.ok(!c.ok && c.rule === 'Q' && /the answer has no output Shift.target/.test(c.reason), JSON.stringify(c))
  const d = check(s, { ...q, runs: { output: 'Shift.worked', op: '>=', setting: 'full week', along: 'Week' } })
  assert.ok(!d.ok && d.rule === 'Q' && /the setting "full week", which has no value here/.test(d.reason), JSON.stringify(d))
  const e = check(s, { ...q, runs: { output: 'Shift.worked', op: '>=', value: 8, along: 'Week' } })
  assert.ok(e.ok)
  assert.deepEqual({ ...e.plan.runs, def: undefined }, { output: 'Shift.worked', op: '>=', value: 8, target: 1, def: undefined })
})
