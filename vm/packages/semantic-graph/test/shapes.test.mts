// A coordinate given the wrong shape is refused with the shape, never thrown: what a reader types is checked, not trusted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check } from '../src/index.js'
import { schema as s } from './fixtures/shifts.js'

const q = { measures: ['Shift.shifts'], by: [{ to: 'Person' }] }

test('totals, share within and limit per refuse a shape that is not a list of targets', () => {
  for (const bad of [{ totals: ['Person'] }, { totals: [[{ to: 'Person' }]] }, { share: { outputs: ['Shift.shifts'], within: 'Person' } }, { share: { outputs: 'Shift.shifts', within: [] } }, { order: { by: 'Shift.shifts' }, limit: 1, limitPer: 'Person' }]) {
    const v = check(s, { ...q, ...(bad as any) })
    assert.equal(v.ok, false, JSON.stringify(bad))
    assert.match((v as any).reason, /list|targets|outputs/)
  }
})
