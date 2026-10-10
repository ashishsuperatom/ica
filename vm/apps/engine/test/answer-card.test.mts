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

test('a table file that is a bare list of rows draws as a table: its columns the rows\' fields, its title the file\'s name', async () => {
  const { blocksOf } = await import('../answer-card.ts')
  const rows = [{ rfq_id: 'RFQ-01191', quotes_received: 6 }, { rfq_id: 'RFQ-00034', quotes_received: 3, rounds: 1 }]
  const [b] = await blocksOf(':::table consumables-negotiation.json', () => rows)
  assert.equal(b.error, undefined)
  assert.deepEqual(b.block, { title: 'Consumables negotiation', columns: [{ key: 'rfq_id', label: 'Rfq id' }, { key: 'quotes_received', label: 'Quotes received' }, { key: 'rounds', label: 'Rounds' }], rows, type: 'table' })
})

test('a table with rows but no columns takes its columns from its rows; a list that is not rows is refused', async () => {
  const { blocksOf } = await import('../answer-card.ts')
  const [a] = await blocksOf(':::table t.json', () => ({ title: 'T', rows: [{ a: 1 }] }))
  assert.deepEqual(a.block?.columns, [{ key: 'a', label: 'A' }])
  const [b] = await blocksOf(':::table t.json', () => [1, 2])
  assert.match(b.error ?? '', /not rows/)
})
