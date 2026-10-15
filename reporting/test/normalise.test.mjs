import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalise } from '../src/normalise.ts'

const card = { title: 'By branch', columns: [{ key: 'b', label: 'Branch' }, { key: 'r', label: 'Revenue', unit: 'AUD' }], rows: [{ b: 'Hard', r: 6566988.36 }], text: [['Hard', 'A$6.6M']] }

test("the answer's words and cards become its sections, in the order written; a card is drawn by its words", () => {
  const a = normalise({ status: 'answered', markdown: ':::period Oct 2026 · to date\nFirst.\n:::table b.json\nThen.', cards: { 'b.json': card }, periods: [{ label: 'Oct 2026', detail: 'to date' }] })
  assert.deepEqual(a.sections, [{ kind: 'text', body: 'First.' }, { kind: 'table', title: 'By branch', columns: ['Branch', 'Revenue'], rows: [['Hard', 'A$6.6M']] }, { kind: 'text', body: 'Then.' }])
  assert.equal(a.period, 'Oct 2026 (to date)')
})

test('a card that could not be shown says so in its place', () => {
  assert.deepEqual(normalise({ status: 'answered', markdown: 'X.\n:::table gone.json', cards: { 'gone.json': null } }).sections, [{ kind: 'text', body: 'X.' }, { kind: 'text', body: 'A table here could not be shown.' }])
})
