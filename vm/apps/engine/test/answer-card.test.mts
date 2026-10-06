// The answer card the older surfaces draw (the phone, chat channels, sacli): a table's figures arrive in the words the
// web shows (its one formatter), the value kept beside them; the time the answer covers comes with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readingAnswer } from '../answer-card.ts'
import { periodsIn } from '../agents/composer/index.ts'

const md = ':::period Oct 2026 · forecast\nOctober has 63,498 h allocated.\n:::table t.json'
const blocks = [{ marker: ':::table t.json', block: { type: 'table', columns: [{ key: 'k', label: 'Kind' }, { key: 'h', label: 'Hours', unit: 'h' }, { key: 'r', label: 'Revenue', unit: 'AUD' }],
  rows: [{ k: 'Hard', h: 49047.68, r: 6566988.36 }] } }]

test('figures carry the words the web shows, beside their values', () => {
  const a = readingAnswer(md, blocks, periodsIn(md))
  assert.deepEqual(a.sections?.[0].rows?.[0], ['Hard', { value: 49047.68, display: '49,048 h' }, { value: 6566988.36, display: 'A$6.6M' }])
})

test('the period an answer names reaches the card, and its marker line is not prose', () => {
  const a = readingAnswer(md, blocks, periodsIn(md))
  assert.deepEqual(a.periods, [{ label: 'Oct 2026', detail: 'forecast' }])
  assert.equal(a.answer, 'October has 63,498 h allocated.')
})
