// Settings from the nearest layer — this request, the person asking, the organisation, a default — as rules chosen by
// who asks and what the question keeps; two rules equally specific that disagree are refused; every value read is
// recorded on the answer with where it came from.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraph, mostSpecific, setting, Store, type Assumed, type When } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

test('the most specific rule wins: a person over their group, a group over the data, the data over everyone', () => {
  const rules: Array<{ when?: When; value: unknown }> = [
    { value: 'AUD' },
    { when: { Branch: 'b3' }, value: 'NZD' },
    { when: { 'who.department': 'finance' }, value: 'USD' },
    { when: { 'who.department': 'finance', Branch: 'b3' }, value: 'EUR' },
    { when: { 'who.id': 'ana' }, value: 'GBP' },
  ]
  const pick = (who: object, about: object) => mostSpecific(rules, { ...Object.fromEntries(Object.entries(who).map(([k, v]) => [`who.${k}`, v])), ...about })!.value
  assert.equal(pick({}, {}), 'AUD')
  assert.equal(pick({}, { Branch: ['b3'] }), 'NZD')
  assert.equal(pick({ department: 'finance' }, { Branch: ['b1'] }), 'USD')
  assert.equal(pick({ department: 'finance' }, { Branch: ['b3'] }), 'EUR')
  assert.equal(pick({ id: 'ana', department: 'finance' }, { Branch: ['b3'] }), 'GBP')
  assert.throws(() => mostSpecific([{ when: { 'who.team': 'x' }, value: 1 }, { when: { 'who.role': 'y' }, value: 2 }], { 'who.team': 'x', 'who.role': 'y' }), /apply equally/)
})

test('the nearest layer that gives a value gives it, and a layer whose rules do not apply passes on', () => {
  const assumed: Assumed[] = []
  const layers = { caller: {}, asker: { currency: { rules: [{ when: { Branch: 'b9' }, value: 'NZD' }] } }, organisation: { currency: 'AUD' } }
  assert.equal(setting('currency', layers, {}, assumed), 'AUD')
  assert.deepEqual(assumed, [{ name: 'currency', value: 'AUD', from: 'organisation' }])
  assert.equal(setting('currency', { ...layers, caller: { currency: 'USD' } }, {}, []), 'USD')
  assert.equal(setting('missing', { default: 7 }, {}, []), 7)
})

test('an answer reads its reporting currency from settings, by who asks, and records where it came from', async () => {
  const { query, sources } = toSqlite(s, I)
  const g = createGraph({ store: new Store(':memory:'), query, today: () => '2026-10-10' })
  g.defineSchema('branches', s, 'test'); await g.defineSources('branches', sources, 'test')
  g.defineSettings('branches', { currency: { rules: [{ value: 'AUD' }, { when: { 'who.department': 'nz' }, value: 'NZD' }] } }, 'test')
  const q = { measures: ['Sale.amount'] }

  const au = await g.ask(q, { model: 'branches', who: { id: 'bo' } })
  assert.ok(au.ok)
  assert.deepEqual(au.result.rows, [[3200]])
  assert.deepEqual(g.store.getCall(au.callId)!.assumptions, [{ name: 'currency', value: 'AUD', from: 'organisation', rule: {} },
    { name: 'surprise threshold', value: 3, from: 'default' }, { name: 'expectation window', value: 12, from: 'default' }])

  const nz = await g.ask(q, { model: 'branches', who: { id: 'kiri', department: 'nz' } })
  assert.ok(!nz.ok && /no rate from AUD to NZD|some rows have no rate/.test(nz.reason), 'there are no AUD→NZD rates, so it is refused rather than guessed')

  const caller = await g.ask(q, { model: 'branches', who: { id: 'kiri', department: 'nz' }, assume: { currency: 'AUD' } })
  assert.ok(caller.ok)
  assert.equal(g.store.getCall(caller.callId)!.assumptions![0].from, 'caller')

  g.defineSettings('branches', { currency: { rules: [{ when: { 'who.team': 'a' }, value: 'AUD' }, { when: { 'who.role': 'b' }, value: 'NZD' }] } }, 'test')
  const clash = await g.ask(q, { model: 'branches', who: { team: 'a', role: 'b' } })
  assert.ok(!clash.ok && clash.rule === 'settings' && /apply equally/.test(clash.reason))
  assert.equal(g.store.getCall(clash.callId)!.refusal!.rule, 'settings')
})
