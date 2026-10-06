import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalise } from '../src/normalise.ts'

test('a column named with a label and unit is drawn by its words', () => {
  const a = normalise({ answer: 'x', sections: [{ kind: 'table', columns: ['Branch', { label: 'Revenue', unit: 'AUD' }, { label: 'Jobs' }], rows: [['A', 1, 2]] }] })
  assert.deepEqual(a.sections[0].columns, ['Branch', 'Revenue (AUD)', 'Jobs'])
  assert.deepEqual(a.sections[0].rows, [['A', 1, 2]])
})

test('the periods an answer covers become its period', () => {
  assert.equal(normalise({ answer: 'x', periods: [{ label: 'Jul 2026' }, { label: 'Aug 2026' }] }).period, 'Jul 2026 · Aug 2026')
  assert.equal(normalise({ answer: 'x', period: 'FY26', periods: [{ label: 'Jul' }] }).period, 'FY26')
})

test('an answer already in this shape is left as it is', () => {
  const a = { answer: 'x', sections: [{ kind: 'text', body: 'b' }], table: { columns: ['a'], rows: [[1]] } }
  assert.deepEqual(normalise(a), a)
})

test('a cell with its own words is drawn by them', () => {
  const a = normalise({ answer: 'x', sections: [{ kind: 'table', columns: ['Kind', { label: 'Revenue', unit: 'AUD' }], rows: [['Hard', { value: 6566988.36, display: 'A$6.6M' }]] }] })
  assert.deepEqual(a.sections[0].rows, [['Hard', 'A$6.6M']])
})
