import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chartData, chartOption, chartKind } from '../src/answer/chart.ts'
import { readCard } from '../src/answer/cards.ts'

const card = (rows: Record<string, unknown>[], hint = 'bar') => { const r = readCard(hint, rows); assert.ok('card' in r); return r.card }

test('a card is drawn along its first column that is not a number, one series per number column', () => {
  const d = chartData(card([{ month: 'April', y2025: 10.5, y2026: '10.3' }, { month: 'May', y2025: 13.5, y2026: 11.8 }]))!
  assert.deepEqual(d.along.values, ['April', 'May'])
  assert.deepEqual(d.series.map((s) => [s.key, s.values]), [['y2025', [10.5, 13.5]], ['y2026', [10.3, 11.8]]])
  const o = chartOption(card([{ month: 'April', amount: 1 }], 'line'), 'line') as any
  assert.equal(o.series[0].type, 'line'); assert.deepEqual(o.xAxis.data, ['April'])
})

test('rows that do not make a chart are drawn as their table (no chart that would mislead)', () => {
  assert.equal(chartData(card([{ branch: 'A', note: 'x' }])), null)    // no number column
  assert.equal(chartData(card([{ a: 1, b: 2 }])), null)                // nothing to draw along
  assert.equal(chartData(card([])), null)
})

test('the marker names the chart; :::table and an unknown kind are no chart', () => {
  assert.deepEqual(['bar', 'chart', 'line', 'pie', 'table', undefined].map((h) => chartKind(h)), ['bar', 'bar', 'line', 'pie', null, null])
  assert.equal(((chartOption(card([{ branch: 'A', share: 3 }], 'pie'), 'pie') as any).series[0].data[0].value), 3)
})
