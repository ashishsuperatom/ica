// The fit rules are the part that can silently corrupt an answer, so they're the
// part with tests: order must never change, reductions must always be announced.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LIMITS, fitAnswer, fitTable } from '../src/render/fit.ts'

const mkTable = (n, cols = 3) => ({
  columns: Array.from({ length: cols }, (_, i) => `c${i}`),
  rows: Array.from({ length: n }, (_, i) => Array.from({ length: cols }, (_, c) => `r${i}c${c}`)),
})

test('rows are truncated from the tail, never re-ordered', () => {
  const t = fitTable(mkTable(100), { ...DEFAULT_LIMITS, maxRows: 5 })
  assert.equal(t.rows.length, 5)
  assert.deepEqual(t.rows.map((r) => r[0]), ['r0c0', 'r1c0', 'r2c0', 'r3c0', 'r4c0'])
})

test('a reduction is always announced', () => {
  const t = fitTable(mkTable(100), { ...DEFAULT_LIMITS, maxRows: 5 })
  assert.match(t.fit.spill ?? '', /\+95 more rows/)
})

test('nothing is announced when nothing was dropped', () => {
  const t = fitTable(mkTable(3), { ...DEFAULT_LIMITS, maxRows: 5 })
  assert.equal(t.fit.spill, undefined)
  assert.equal(t.fit.droppedRows, 0)
})

test('totalRows beyond the rows sent is counted as dropped', () => {
  // The engine paginates: it sends 10 rows but says there are 500.
  const t = fitTable({ ...mkTable(10), totalRows: 500 }, { ...DEFAULT_LIMITS, maxRows: 20 })
  assert.equal(t.fit.droppedRows, 490)
  assert.match(t.fit.spill ?? '', /\+490 more rows/)
})

test('the first column is always kept', () => {
  const t = fitTable(mkTable(3, 12), { ...DEFAULT_LIMITS, maxCols: 4 })
  assert.equal(t.columns[0], 'c0')
  assert.equal(t.columns.length, 4)
  assert.equal(t.fit.droppedCols, 8)
})

test('a total row survives even when the rows it sums do not', () => {
  const t = fitTable({ ...mkTable(100), total: ['Total', '1', '2'] }, { ...DEFAULT_LIMITS, maxRows: 3 })
  assert.deepEqual(t.total, ['Total', '1', '2'])
})

test('fitAnswer leaves the input untouched', () => {
  const a = { answer: 'x', table: mkTable(100) }
  const before = JSON.stringify(a)
  fitAnswer(a, { ...DEFAULT_LIMITS, maxRows: 2 })
  assert.equal(JSON.stringify(a), before)
})

test('table spills do not also appear in the footer notes', () => {
  const { fit } = fitAnswer({ table: mkTable(100) }, { ...DEFAULT_LIMITS, maxRows: 2 })
  assert.equal(fit.notes.some((n) => /more rows/.test(n)), false)
  assert.equal(fit.reduced, true)
})
