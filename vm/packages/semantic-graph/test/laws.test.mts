// The laws a measure obeys, stated once: what may be folded along which arrow, and which aggregates combine from
// partial results. The pattern's traversal and the checker both read these, so they cannot disagree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { admissible, check, combineAll, foldable, monoidFor, patternOf, reusable } from '../src/index.js'
import { schema as branches } from './fixtures/branches.js'

test('a level at an instant does not fold over time until it says which instant stands for the period', () => {
  const stock = { fact: 'Headcount', measure: 'people', kind: 'stock' as const, aggregate: 'sum' as const }
  assert.equal(foldable(stock, { kind: 'rollup', role: 'month', toCalendar: true }).ok, false)
  assert.equal(foldable({ ...stock, overTime: 'last' }, { kind: 'rollup', role: 'month', toCalendar: true }).ok, true)
  assert.equal(foldable(stock, { kind: 'belongs', role: 'branch' }).ok, true, 'but it adds across things')
})

test('a rate is never summed, whatever it is grouped by', () => {
  const rate = { fact: 'Sale', measure: 'rate', kind: 'value-per-unit' as const, aggregate: 'sum' as const }
  assert.equal(foldable(rate, { kind: 'belongs', role: 'project' }).ok, false)
  assert.equal(foldable({ ...rate, aggregate: 'weighted average' }, { kind: 'belongs', role: 'project' }).ok, true)
})

test('versions are never added together', () => {
  const budget = { fact: 'Budget', measure: 'budget', kind: 'flow' as const, aggregate: 'sum' as const, versions: 'version' }
  assert.equal(foldable(budget, { kind: 'belongs', role: 'version' }).ok, false)
  assert.equal(foldable({ ...budget, versions: undefined }, { kind: 'version', role: 'version' }).ok, false)
})

test('the checker and the traversal answer the same question the same way', () => {
  // The rules refuse a stock grouped over time; a step of the pattern refuses the same thing, from the same law.
  // `desks` is a level that does not say which instant stands for a period; `people` says "last" and is allowed.
  const q: any = { measures: ['Headcount.desks'], by: [{ to: 'Quarter', via: ['month', 'quarter'] }], span: { from: '2026-01-01', to: '2026-07-01' } }
  const verdict = check(branches, q)
  const p = patternOf(branches, q)
  if (verdict.ok) {
    assert.ok(p.ok)
  } else {
    assert.equal(p.ok, false)
    assert.match(verdict.reason, /last, the first or the average/)
  }
})

test('sum, count, min, max, average and a weighted average combine from partial results', () => {
  assert.equal(reusable('sum'), true)
  assert.equal(reusable('count distinct'), false, 'a distinct count needs the things themselves')
  assert.equal(reusable('median'), false, 'a median needs every value')
  const m = monoidFor('sum')!
  const parts = [{ kind: 'sum' as const, total: 3 }, { kind: 'sum' as const, total: 4 }, { kind: 'sum' as const, total: null }]
  assert.equal(m.value(combineAll('sum', parts)!), 7)
  // The same answer whatever order they arrive in — that is what licenses reusing a finer result for a coarser one.
  assert.equal(m.value(combineAll('sum', [...parts].reverse())!), 7)
  const w = monoidFor('weighted average')!
  assert.equal(w.value(combineAll('weighted average', [{ kind: 'weighted', total: 10, weight: 2 }, { kind: 'weighted', total: 20, weight: 2 }])!), 7.5)
})

test('the pattern carries the law with it, so a step answers for itself', () => {
  const p = patternOf(branches, { measures: ['Sale.rate'], by: [{ to: 'Project', via: ['project'] }], span: { from: '2026-01-01', to: '2026-04-01' }, currency: 'AUD' })
  assert.ok(p.ok)
  const m = p.pattern.measures[0]
  const step = admissible({ ...m, aggregate: 'sum' }, { from: 'a', to: 'b', role: 'project', kind: 'grain', partial: false }, { id: 'b', object: 'Project', kind: 'entity' })
  assert.equal(step.ok, false)
  assert.match((step as any).reason, /value per unit/)
})
