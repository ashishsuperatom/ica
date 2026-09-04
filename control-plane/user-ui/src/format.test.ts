// Run:  cd control-plane/user-ui && pnpm exec tsx --test src/format.test.ts
//
// A cell may now be `{v, id}`. The failure this guards against is not a crash — it is String()ing the wrapper
// and printing "[object Object]" where a name should be, which has happened before and reached a user. There
// are five readers, and two of them are copy and CSV rather than the visible one.
import { test } from 'node:test'
import assert from 'node:assert'
import { cellValue, cellText, cellId, cellEntity, colLabel, colSpec, formatNumber, buildBeatRows } from './format.js'

test('a plain cell is untouched', () => {
  assert.equal(cellText('Acme Ltd'), 'Acme Ltd')
  assert.equal(cellValue(412), 412)
  assert.equal(cellText(null), '')
  assert.equal(cellId('Acme Ltd'), undefined)
})

test('a number carrying its own formatting reads as the formatting', () => {
  // The shape an agent actually emitted, and the one that printed "[object Object]" on screen: it had been
  // taught that a figure is {label, display, value} and applied the same idea to a cell.
  const c = { value: 686.76895, display: '686.8 h', unit: 'hours' }
  assert.equal(cellText(c), '686.8 h')
  assert.equal(cellValue(c), 686.76895, 'the RAW value survives, so the column still sorts and aligns as numeric')
  assert.equal(cellId(c), undefined)
})

test('an identified cell reads as its value, never as the wrapper', () => {
  const c = { value: 'Acme Ltd', id: 431 }
  assert.equal(cellText(c), 'Acme Ltd')
  assert.equal(cellId(c), '431')
})

test('the keys are spelled out — one name per idea', () => {
  // Two spellings for one idea is how a renderer and a prompt drift apart, and the abbreviation saved nothing:
  // an agent writes a PROGRAM, so the object is typed once in a loop.
  assert.equal(cellText({ value: 'Acme Ltd', id: 431 }), 'Acme Ltd')
  assert.equal(cellId({ value: 'Acme Ltd', id: 431 }), '431')   // a string, so numeric and text ids compare alike
})

test('the entity type comes from the column, and the cell may override it', () => {
  assert.equal(cellEntity({ value: 'Acme', id: 1 }, 'customer'), 'customer')
  assert.equal(cellEntity({ value: 'Acme', id: 1, entity: 'vendor' }, 'customer'), 'vendor', 'a column mixing kinds')
  assert.equal(cellEntity('Acme', 'customer'), undefined, 'no id means nothing to view')
})

test('a column is a label or a declaration', () => {
  assert.equal(colLabel('revenue'), 'revenue')
  assert.equal(colLabel({ label: 'customer name', entity: 'customer' }), 'customer name')
  assert.deepEqual(colSpec('revenue'), { label: 'revenue' })
  assert.equal(colSpec({ label: 'u', good: 'high' }).good, 'high')
})

test('an id of 0 is still an id', () => {
  // A falsy id is a real id. Treating it as absent would make exactly one row unclickable, silently.
  assert.equal(cellId({ value: 'Zero Co', id: 0 }), '0')
})

test('a number reads the way the column says, not the way JS prints it', () => {
  // "686.769" for hours was the bug: three decimals of precision the data never had, because nothing said
  // what the number was.
  assert.equal(formatNumber(686.76895, { label: 'Hours', unit: 'h', decimals: 1 }), '686.8 h')
  assert.equal(formatNumber(140, { label: 'Hours', unit: 'h', decimals: 1 }), '140.0 h')
  assert.equal(formatNumber(83.42, { label: 'Util', unit: '%', decimals: 1 }), '83.4%')   // no space before %
  assert.equal(formatNumber(4160000, { label: 'Rev', unit: 'AUD', scale: 'compact' }), 'AUD 4.16 M')
  assert.equal(formatNumber(1234, { label: 'Orders' }), '1,234')                          // plain integer
})

test('money is not a special case — it is a unit like any other', () => {
  // A currency code LEADS the number, a unit of measure FOLLOWS it. One mechanism, so the next unit needs no
  // new machinery.
  assert.equal(formatNumber(1500, { label: 'x', unit: 'USD' }), 'USD 1,500')
  assert.equal(formatNumber(1500, { label: 'x', unit: 'kg' }), '1,500 kg')
  assert.equal(formatNumber(1500, { label: 'x', unit: '$' }), '$ 1,500')
})

test('compact scaling stays readable at every magnitude', () => {
  const c = { label: 'x', scale: 'compact' as const }
  assert.equal(formatNumber(950, c), '950')
  assert.equal(formatNumber(4_160_000, c), '4.16 M')
  assert.equal(formatNumber(2_500_000_000, c), '2.5 B')
})

// ── GROUPING THE BEATS ──────────────────────────────────────────────────────────────────────────────────────
const beats = (kinds: string) => kinds.split('').map(k => ({ kind: k === 'p' ? 'program' as const : 'narrator' as const }))

test('a run of program beats collapses to one row', () => {
  const rows = buildBeatRows(['n1', 'p1', 'p2', 'p3', 'n2'], beats('nppp n'.replace(' ', '')), () => 1, new Set())
  assert.deepEqual(rows.map(r => r.text), ['n1', 'p3', 'n2'], 'the run shows its latest and hides the rest')
  assert.equal(rows[1].chevron, 'closed')
  assert.equal(rows[1].count, 3)
})

test('a COLLAPSED row carries the whole run\'s time, not the last beat\'s', () => {
  // The bug: twelve steps taking most of a minute showed "2s" — the one number on the row, describing
  // something the reader could not see.
  const secsOf = [1, 1, 12, 1, 14, 1]          // n, then a 5-beat run
  const rows = buildBeatRows(['n', 'a', 'b', 'c', 'd', 'e'], beats('nppppp'), i => secsOf[i], new Set())
  assert.equal(rows.length, 2)
  assert.equal(rows[1].secs, 1 + 12 + 1 + 14 + 1, 'the run total, 29s')
})

test('an EXPANDED run gives each beat its own time back', () => {
  const secsOf = [1, 1, 12, 1, 14, 1]
  const rows = buildBeatRows(['n', 'a', 'b', 'c', 'd', 'e'], beats('nppppp'), i => secsOf[i], new Set([1]))
  assert.deepEqual(rows.map(r => r.secs), secsOf, 'every step, its own duration')
  assert.equal(rows[1].chevron, 'open')
})

test('a lone program beat is not a run — no chevron, its own time', () => {
  const rows = buildBeatRows(['n', 'p', 'n'], beats('npn'), () => 7, new Set())
  assert.equal(rows.length, 3)
  assert.equal(rows[1].chevron, 'none')
  assert.equal(rows[1].secs, 7)
})

test('narrator beats are never grouped, however many in a row', () => {
  const rows = buildBeatRows(['a', 'b', 'c'], beats('nnn'), () => 1, new Set())
  assert.equal(rows.length, 3)
  assert.ok(rows.every(r => r.chevron === 'none'))
})
