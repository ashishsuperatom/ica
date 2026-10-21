import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lint, fixed } from '../lint.ts'

const md = ['All three bids were compliant.', '', '| Supplier | **Price** | Days |', '|---|---:|---:|', '| A (V1) | ₹15.4 lakh | 48 |', '| B (V2) | ₹16.9 lakh | 38 |', '', 'Quotes are five months old.'].join('\n')

test('a markdown table is found, and said to the composer as a rule to put right; words, table markers and code are not', () => {
  assert.deepEqual(lint({ markdown: md, blocks: [] }).map((p) => p.check), ['markdown-table'])
  assert.match(lint({ markdown: md, blocks: [] })[0].says, /:::table/)
  assert.deepEqual(lint({ markdown: 'Two bids.\n:::table bids.json\nA | B is not a table', blocks: [] }), [])
  assert.deepEqual(lint({ markdown: '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```', blocks: [] }), [])
})

test('what is still wrong is fixed: the markdown table becomes a table block in its place, its name not one already taken', () => {
  const f = fixed({ markdown: md, blocks: [{ marker: 'table-1', block: { type: 'kpis', items: [] } }] })
  assert.deepEqual(f.fixed, ['markdown-table'])
  assert.equal(f.markdown, 'All three bids were compliant.\n\n:::table table-2\n\nQuotes are five months old.')
  const t = f.blocks.find((b) => b.marker === 'table-2')!.block as any
  assert.deepEqual(t.columns.map((c: any) => c.label), ['Supplier', 'Price', 'Days'])
  assert.deepEqual(t.rows[1], { c1: 'B (V2)', c2: '₹16.9 lakh', c3: '38' })
  assert.deepEqual(lint(f), [])
  assert.deepEqual(fixed({ markdown: 'Just words.', blocks: [] }).fixed, [])
})
