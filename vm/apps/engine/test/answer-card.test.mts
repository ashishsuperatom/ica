// The answer every surface takes (clients/protocol.ts Answer): the markdown as written, each card it names as rows with
// their words as the web shows them (its one formatter), and the time the answer covers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerOf, genericCard } from '../answer-card.ts'
import { partsOf } from '../../../../clients/protocol.ts'
import { periodsIn } from '../agents/composer/index.ts'

const md = ':::period Oct 2026 · forecast\nOctober has 63,498 h allocated.\n:::table t.json'
const blocks = [{ marker: ':::table t.json', block: { type: 'table', columns: [{ key: 'k', label: 'Kind' }, { key: 'h', label: 'Hours', unit: 'h' }, { key: 'r', label: 'Revenue', unit: 'AUD' }],
  rows: [{ k: 'Hard', h: 49047.68, r: 6566988.36 }] } }]

test('a card carries its rows and the words the web shows for them', () => {
  const a = answerOf(md, blocks, periodsIn(md))
  assert.deepEqual(a.cards['t.json']?.rows, blocks[0].block.rows)
  assert.deepEqual(a.cards['t.json']?.text, [['Hard', '49,048 h', 'A$6.6M']])
})

test('the answer is the markdown as written; its parts are its words and cards in order, the period apart', () => {
  const a = answerOf(md, blocks, periodsIn(md))
  assert.equal(a.markdown, md)
  assert.deepEqual(a.periods, [{ label: 'Oct 2026', detail: 'forecast' }])
  assert.deepEqual(partsOf(a).map((p) => ('text' in p ? p.text : `card ${p.name}`)), ['October has 63,498 h allocated.', 'card t.json'])
})

test("a program's own cards reach every surface as rows: figures, bars, a grid", () => {
  assert.deepEqual(genericCard({ type: 'kpis', items: [{ label: 'Spend', value: 1200000, unit: 'AUD' }, { label: 'Orders', value: 12, unit: 'count' }] }).text, [['Spend', 'A$1.2M'], ['Orders', '12']])
  const bars = genericCard({ type: 'bars', title: 'Spend', axis: 'Region', unit: 'count', series: [{ key: 's', label: 'Spend' }], rows: [{ label: 'North', values: { s: 3 } }] })
  assert.deepEqual([bars.columns.map((c) => c.label), bars.text], [['Region', 'Spend'], [['North', '3']]])
  assert.deepEqual(genericCard({ type: 'grid', periods: ['W1'], unit: 'count', rows: [{ label: 'A', cells: [{ period: 'W1', value: 4 }] }] }).text, [['A', '4']])
})

test('a table file that is a bare list of rows draws as a table: its columns the rows\' fields, its title the file\'s name', async () => {
  const { blocksOf } = await import('../answer-card.ts')
  const rows = [{ rfq_id: 'RFQ-01191', quotes_received: 6 }, { rfq_id: 'RFQ-00034', quotes_received: 3, rounds: 1 }]
  const [b] = await blocksOf(':::table consumables-negotiation.json', () => rows)
  assert.equal(b.error, undefined)
  assert.deepEqual(b.block, { kind: 'table', title: 'Consumables negotiation', columns: [{ key: 'rfq_id', label: 'Rfq id' }, { key: 'quotes_received', label: 'Quotes received' }, { key: 'rounds', label: 'Rounds' }], rows })
})

test('a table with rows but no columns takes its columns from its rows; a list that is not rows is refused', async () => {
  const { blocksOf } = await import('../answer-card.ts')
  const [a] = await blocksOf(':::table t.json', () => ({ title: 'T', rows: [{ a: 1 }] }))
  assert.deepEqual(a.block?.columns, [{ key: 'a', label: 'A' }])
  const [b] = await blocksOf(':::table t.json', () => [1, 2])
  assert.match(b.error ?? '', /each row is an object by column .* not a plain value/)
})

test('the answer contract: a card is rows — our table — whatever its marker (a :::bar is the same rows, its kind a hint); one not that shape is an error its writer is told, never drawn empty', async () => {
  const { blocksOf, blockFixes, answerOf } = await import('../answer-card.ts')
  const files: Record<string, unknown> = {
    // rows as lists beside column names: not our table
    'by-month.json': { title: 'By month', columns: ['Month', 'Expected'], rows: [['Feb', 350], ['Mar', 350]] },
    // categories and series of numbers: not rows
    'by-month-bar.json': { title: 'Expected', categories: ['Feb', 'Mar'], series: [{ name: 'Expected', data: [350, 350] }] },
    'rows.json': [{ month: 'Feb', expected: 350 }, { month: 'Mar', expected: null }],
    'plot.json': { title: 'Expected by month', rows: [{ month: 'Feb', expected: 350 }, { month: 'Mar', expected: 340 }] },
  }
  const md = 'Two months.\n:::table by-month.json\n:::bar by-month-bar.json\n:::table rows.json\n:::bar plot.json'
  const blocks = await blocksOf(md, (n) => files[n])
  assert.deepEqual(blocks.map((b) => !!b.block), [false, false, true, true])
  assert.match(blocks[0].error!, /each row is an object by column .* not a list/)
  assert.match(blocks[1].error!, /a table has "rows"/)
  const told = blockFixes(blocks)!
  assert.match(told, /^- by-month\.json: /m); assert.match(told, /^- by-month-bar\.json: /m); assert.match(told, /a list of rows \(objects by column\)/)
  assert.equal(blockFixes(blocks.slice(2)), null)
  assert.deepEqual((blocks[2].block as any).columns.map((c: any) => c.key), ['month', 'expected'])
  assert.equal((blocks[3].block as any).hint, 'bar')   // kept for a runtime that draws charts
  // every surface gets the same rows
  const card = answerOf(md, blocks.slice(2))
  assert.deepEqual(card.cards['plot.json']?.text, [['Feb', '350'], ['Mar', '340']])
  assert.equal(card.cards['by-month.json'], undefined)   // only the cards given
  // a program's own card (with its type) is read as before
  assert.ok((await blocksOf(':::bar spend.json', () => ({ type: 'bars', title: 'Spend', series: [{ key: 's', label: 'Spend' }], rows: [{ label: 'A', values: { s: 1 } }] })))[0].block)
})
