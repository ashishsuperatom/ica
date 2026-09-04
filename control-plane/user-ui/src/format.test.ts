// Run:  cd control-plane/user-ui && pnpm exec tsx --test src/format.test.ts
//
// A cell may now be `{v, id}`. The failure this guards against is not a crash — it is String()ing the wrapper
// and printing "[object Object]" where a name should be, which has happened before and reached a user. There
// are five readers, and two of them are copy and CSV rather than the visible one.
import { test } from 'node:test'
import assert from 'node:assert'
import { cellValue, cellText, cellId, cellEntity, colLabel, colSpec } from './format.js'

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
