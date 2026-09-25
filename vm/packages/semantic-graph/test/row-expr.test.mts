// A MEASURE WORKED OUT PER ROW: an expression with max, min and numbers over the fact's own columns, taken before the
// rows are added up — because the shortfall of each shift, summed, is not the shortfall of the sums. Compiled to SQL
// it must give the oracle's answer; its units are worked out from its parts; a number stands in the unit beside it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, evaluate, parseExpr, runSql, schemaProblems, type Question, type Schema } from '../src/index.js'
import { instance as I, schema as base } from './fixtures/shifts.js'
import { toSqlite } from './fixtures/sqlite.js'

function data(): Schema {
  const s: Schema = structuredClone(base)
  Object.assign(s.objects.Shift.measures!, {
    shortfall: { unit: 'h', kind: 'flow', aggregate: 'sum', expr: 'max(0, [Shift.target] - [Shift.worked])', at: 'row' },
    worstShortfall: { unit: 'h', kind: 'flow', aggregate: 'max', expr: 'max(0, [Shift.target] - [Shift.worked])', at: 'row' },
    capped: { unit: 'h', kind: 'flow', aggregate: 'sum', expr: 'min([Shift.worked], [Shift.target]) * 1', at: 'row' },
    attainment: { unit: 'ratio', kind: 'flow', aggregate: 'average', expr: '[Shift.worked] / [Shift.target]', at: 'row' },
    /** an expression after aggregation may use a measure worked out per row: it is a column like any other. */
    shortfallShare: { unit: 'ratio', kind: 'flow', aggregate: 'sum', expr: '[Shift.shortfall] / [Shift.target]' },
  })
  return s
}

async function both(s: Schema, q: Question) {
  const v = check(s, q)
  if (!v.ok) assert.fail(`${v.rule}: ${v.reason}`)
  const mem = evaluate(s, I, v.plan)
  const { query, sources } = toSqlite(s, I)
  assert.deepEqual((await runSql(s, sources, v.plan, query)).rows, mem.rows, 'SQL and the oracle agree')
  return mem.rows
}

test('max(0, target - worked) summed per row is the oracle\'s, and is not the clipped difference of sums', async () => {
  const s = data()
  assert.deepEqual(schemaProblems(s), [])
  // p1: 8-6 → 2, every other week over target → 0: shortfall 2. p2: 8-7 → 1; the week with nothing recorded is skipped.
  const got = await both(s, { measures: ['Shift.shortfall', 'Shift.worstShortfall', 'Shift.capped', 'Shift.attainment'], by: [{ to: 'Person' }] })
  assert.deepEqual(got, [['p1', 2, 2, 6 + 8 + 8 + 8 + 8 + 8, (6 / 8 + 9 / 8 + 9 / 8 + 12 / 8 + 9 / 8 + 9 / 8) / 6], ['p2', 1, 1, 8 + 8 + 8 + 7 + 8, (1 + 1 + 1 + 7 / 8 + 1) / 5]])
  // The reason it exists: clipped after the sums, p1's shortfall vanishes into the weeks over target, and p2's week
  // with nothing recorded counts its whole target against nothing.
  const clipped = await both(s, { measures: ['max(0, [Shift.target] - [Shift.worked])'], by: [{ to: 'Person' }] })
  assert.deepEqual(clipped, [['p1', 0], ['p2', 9]])
  assert.notDeepEqual(got.map((r) => r[1]), clipped.map((r) => r[1]))
  const v = check(s, { measures: ['Shift.shortfall'] })
  assert.ok(v.ok)
  assert.deepEqual(v.plan.facts[0].measures, ['shortfall'])
  assert.deepEqual(v.plan.facts[0].perRow, { shortfall: { fn: 'max', args: [{ num: 0 }, { op: '-', args: [{ ref: 'target' }, { ref: 'worked' }] }] } })
  assert.equal(v.plan.outputs[0].unit, 'h')
})

test('max and min after aggregation work in an output expression, nested, with numbers', async () => {
  const s = data()
  assert.deepEqual(await both(s, { measures: ['min(max([Shift.worked] - 40, 0), 10)', '[Shift.shortfallShare]'], by: [{ to: 'Person' }] }), [['p1', 10, 2 / 48], ['p2', 0, 1 / 48]])
  assert.deepEqual(parseExpr('max(1.5, min([A.x], 2))'), { fn: 'max', args: [{ num: 1.5 }, { fn: 'min', args: [{ ref: 'A.x' }, { num: 2 }] }] })
  assert.throws(() => parseExpr('max([A.x])'), /max takes two arguments/)
})

test('units: max and min need the same unit; a number takes the unit beside it; a declared unit must be the one worked out', () => {
  const s = data()
  Object.assign(s.objects.Shift.measures!, {
    mixed: { unit: 'h', kind: 'flow', aggregate: 'sum', expr: 'max([Shift.target], [Shift.people])', at: 'row' },
    misdeclared: { unit: 'people', kind: 'flow', aggregate: 'sum', expr: '[Shift.target] - [Shift.worked]', at: 'row' },
  })
  const a = check(s, { measures: ['Shift.mixed'] })
  assert.ok(!a.ok && a.rule === 'E1' && /h and people are not the same unit, so they cannot be compared by max/.test(a.reason), JSON.stringify(a))
  const b = check(s, { measures: ['Shift.misdeclared'] })
  assert.ok(!b.ok && b.rule === 'E3' && /declared in people, and its expression works out in h/.test(b.reason), JSON.stringify(b))
  const c = check(s, { measures: ['[Shift.target] + [Shift.people]'] })
  assert.ok(!c.ok && c.rule === 'E1')
})

test('a row expression is over the fact\'s columns: not over another expression, and added up by sum, min, max or average', () => {
  const s = data()
  Object.assign(s.objects.Shift.measures!, {
    twice: { unit: 'h', kind: 'flow', aggregate: 'sum', expr: '[Shift.shortfall] * 2', at: 'row' },
    counted: { unit: 'h', kind: 'flow', aggregate: 'count', expr: '[Shift.target]', at: 'row' },
    bare: { unit: 'h', kind: 'flow', aggregate: 'sum', at: 'row' },
  })
  const p = schemaProblems(s)
  assert.ok(p.some((x) => x === 'Shift.twice: Shift.shortfall is itself worked out from an expression; a row expression is over the columns of Shift'), p.join('\n'))
  assert.ok(p.some((x) => x === 'Shift.counted is worked out per row and then added up by sum, min, max or average, never by count'), p.join('\n'))
  assert.ok(p.some((x) => x === 'Shift.bare is worked out per row, so it needs an expression'), p.join('\n'))
})
