// Run:  cd vm && pnpm exec tsx --test packages/node-store/src/basis.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NodeStore } from './store.js'
import { basisFromPairs, basisId, upsertBasis, linkBasis, basisOf, intentsByBasis } from './basis.js'

test('basisFromPairs: open vocabulary, normalises + dedupes, from objects and strings', () => {
  const axes = basisFromPairs([
    { type: 'op', token: 'Overdue', text: 'overdues' },
    'entity:Customer',
    'time: trailing ',
    { type: 'op', token: 'overdue' },          // dup of the first → collapses
    'rank:topN',
    'garbage-without-colon',                    // dropped
    { type: '', token: 'x' },                   // dropped (no type)
  ])
  const ids = axes.map(a => a.id).sort()
  assert.deepEqual(ids, [
    basisId('entity', 'customer'),
    basisId('op', 'overdue'),
    basisId('rank', 'topn'),
    basisId('time', 'trailing'),
  ].sort())
  // first span wins for provenance
  assert.equal(axes.find(a => a.id === basisId('op', 'overdue'))?.text, 'overdues')
})

test('basisId: no fixed schema — a brand-new axis type is allowed', () => {
  assert.equal(basisId('modality', 'CT-scan'), 'basis:modality:ct-scan')
})

test('linkBasis + basisOf: an intent is located by its axes in the store', () => {
  const s = new NodeStore(':memory:')
  s.putNode({ id: 'intent:A', kind: 'intent', label: 'overdues of a customer' })
  const axes = linkBasis(s, 'intent:A', ['op:overdue', 'entity:customer', 'time:trailing', 'rank:topN'])
  assert.equal(axes.length, 4)
  const back = basisOf(s, 'intent:A').map(n => n.label).sort()
  assert.deepEqual(back, ['entity:customer', 'op:overdue', 'rank:topn', 'time:trailing'])
  // the axis nodes were minted as first-class nodes
  assert.equal(s.getNode(basisId('op', 'overdue'))?.kind, 'basis')
})

test('intentsByBasis: same STRUCTURE / different VALUES → same axes → top match (the reuse win)', () => {
  const s = new NodeStore(':memory:')
  // two questions: "overdues of kirby, top 10" and "overdues of party 10230, top 10"
  // identical basis; the names/counts are PARAMS, not axes.
  s.putNode({ id: 'intent:kirby', kind: 'intent', label: 'overdues of kirby' })
  s.putNode({ id: 'intent:party', kind: 'intent', label: 'overdues of party 10230' })
  const shape = ['op:overdue', 'entity:customer', 'time:trailing', 'rank:topN']
  linkBasis(s, 'intent:kirby', shape)
  linkBasis(s, 'intent:party', shape)
  // an unrelated intent shares only one axis
  s.putNode({ id: 'intent:count', kind: 'intent', label: 'how many customers' })
  linkBasis(s, 'intent:count', ['op:count', 'entity:customer'])

  // a re-worded query with the same structure lands on both overdue intents first
  const ranked = intentsByBasis(s, ['op:overdue', 'entity:customer', 'rank:topN', 'time:trailing'])
  assert.equal(ranked[0].shared, 4)
  assert.equal(ranked[1].shared, 4)
  assert.deepEqual([ranked[0].intentId, ranked[1].intentId].sort(), ['intent:kirby', 'intent:party'])
  // the weakly-related one is ranked last with a single shared axis
  assert.equal(ranked.at(-1)!.intentId, 'intent:count')
  assert.equal(ranked.at(-1)!.shared, 1)
})
