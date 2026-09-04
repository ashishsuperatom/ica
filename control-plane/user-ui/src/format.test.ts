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

test('an identified cell reads as its value, never as the wrapper', () => {
  const c = { v: 'Fusion5 PTY LTD', id: 431 }
  assert.equal(cellText(c), 'Fusion5 PTY LTD')
  assert.equal(cellValue(c), 'Fusion5 PTY LTD')
  assert.ok(!cellText(c).includes('object'), 'the [object Object] this exists to prevent')
  assert.equal(cellId(c), '431')            // a string, so a numeric and a text id compare the same way
})

test('the entity type comes from the column, and the cell may override it', () => {
  assert.equal(cellEntity({ v: 'Acme', id: 1 }, 'customer'), 'customer')
  assert.equal(cellEntity({ v: 'Acme', id: 1, e: 'vendor' }, 'customer'), 'vendor', 'a column mixing types')
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
  assert.equal(cellId({ v: 'Zero Co', id: 0 }), '0')
})
