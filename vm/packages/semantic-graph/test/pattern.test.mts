// A question as a graph: drawn from the checked plan, written back as a question, and the same answer either way.
// The gate for this stage: every question round-trips through the pattern to an identical plan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonical, check, patternOf, toQuestion, patternText, patternKey, admissible, stepsFrom, type Question } from '../src/index.js'
import { schema as branches } from './fixtures/branches.js'

const span = { from: '2026-01-01', to: '2026-04-01' }
const QUESTIONS: Question[] = [
  { measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], span },
  { measures: ['Sale.hours'], by: [{ to: 'Region', via: ['project', 'branch', 'state', 'region'] }], span },
  { measures: ['Sale.hours'], by: [{ attribute: 'commitment' }], span },
  { measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], where: [{ to: 'Branch', via: ['project', 'branch'], in: ['b1', 'b2'] }], span },
  { measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], span, order: { by: 'Sale.hours', desc: true }, limit: 2 },
]

test('a question becomes a pattern and the pattern becomes the same question', () => {
  for (const q of QUESTIONS) {
    const p = patternOf(branches, q)
    assert.ok(p.ok, `pattern: ${JSON.stringify(q)}`)
    const back = toQuestion(branches, p.pattern)
    const first = check(branches, q), again = check(branches, back)
    assert.ok(first.ok && again.ok, `checked: ${JSON.stringify(back)}`)
    // The same question by the graph's own reckoning: paths in normal form, members as keys, sets sorted.
    assert.equal(canonical(branches, back), canonical(branches, q), `not the same question:\n${JSON.stringify(back)}`)
    // And the answer it plans for is the same one. A column's LABEL repeats the path as it was written, and the
    // pattern writes the normal form, so labels are compared by their units and count, not by their text.
    assert.deepEqual(again.plan.columns.map((c) => c.unit), first.plan.columns.map((c) => c.unit))
    assert.deepEqual(again.plan.outputs, first.plan.outputs)
    assert.deepEqual(again.plan.facts.map((f) => f.measures), first.plan.facts.map((f) => f.measures))
  }
})

test('drawing a pattern twice draws the same thing — the normal form is reached at once', () => {
  for (const q of QUESTIONS) {
    const once = patternOf(branches, q)
    assert.ok(once.ok)
    const twice = patternOf(branches, toQuestion(branches, once.pattern))
    assert.ok(twice.ok)
    assert.equal(patternKey(twice.pattern), patternKey(once.pattern), `not stable: ${JSON.stringify(q)}`)
  }
})

test('the same drawing has the same key, however the question was written', () => {
  const a = patternOf(branches, { measures: ['Sale.hours'], by: [{ to: 'Region', via: ['project', 'branch', 'state', 'region'] }], span })
  const b = patternOf(branches, { measures: ['Sale.hours'], by: [{ to: 'Region', via: ['project', 'state', 'region'] }], span })
  assert.ok(a.ok && b.ok)
  assert.equal(patternKey(a.pattern), patternKey(b.pattern))
})

test('a grouping node is shared by the facts that reach it, so the drawing shows what makes them comparable', () => {
  const p = patternOf(branches, { measures: ['Sale.amount', 'Budget.budget'], by: [{ to: 'Month', via: { Sale: ['day', 'month'], Budget: ['month'] } }],
    where: [{ to: 'BudgetVersion', in: ['base'] }], span, currency: 'AUD' })
  assert.ok(p.ok, p.ok ? '' : `${(p as any).rule}: ${(p as any).reason}`)
  const months = p.pattern.nodes.filter((n) => n.object === 'Month' && n.group)
  assert.equal(months.length, 1, 'one Month node, whatever the number of facts')
})

test('what a step is allowed to carry is answered while walking, from the edge and the measure', () => {
  const p = patternOf(branches, { measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], span })
  assert.ok(p.ok)
  const m = p.pattern.measures[0]
  const steps = stepsFrom(branches, p.pattern, 'fact:Sale', m)
  assert.ok(steps.length > 0)
  for (const s of steps) assert.ok(s.allowed, `every step reports whether ${m.measure} may be carried: ${s.role}`)
  const stock = { ...m, kind: 'stock' as const, overTime: undefined }
  const overTime = admissible(stock, { from: 'a', to: 'b', role: 'month', kind: 'rollup' as const, partial: false }, { id: 'b', object: 'Month', kind: 'calendar' as const })
  assert.equal(overTime.ok, false)
  assert.match((overTime as any).reason, /level at an instant/)
})

test('a pattern reads as a drawing', () => {
  const p = patternOf(branches, { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], where: [{ to: 'Branch', via: ['project', 'branch'], in: ['b1'] }], span })
  assert.ok(p.ok)
  const text = patternText(p.pattern)
  assert.match(text, /\(:Sale\) -\[project\]-> \(:Project\)/)
  assert.match(text, /sum Sale.hours/)
})
