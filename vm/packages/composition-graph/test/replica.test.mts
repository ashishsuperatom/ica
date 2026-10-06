import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store, compose, governance as g, replicaSince, applyReplica, hasAfter, START, ReplicaConflict, publishDraft, type Cursor } from '../src/node.ts'

const fresh = () => openStore(join(mkdtempSync(join(tmpdir(), 'rep-')), 'composition.sqlite'))
const text = (t: string) => ({ title: 'T', form: 'text', text: t })
const ana = { id: 'user:ana' }, bo = { id: 'user:bo' }

function busyGraph() {
  const a = fresh()
  g.write(a, ana, 'c1', 'concept', text('one'))
  g.write(a, ana, 'c2', 'concept', text('two'), {}, { scope: 'user:ana' })
  g.write(a, ana, 'trips', 'domain', { capabilities: [], concepts: ['c1'], files: [] })
  g.compose(a, ana, 'trips', 'c2', {})
  const s1 = g.suggest(a, bo, 'c1', 'concept', text('one, better'), 'clearer')
  g.decide(a, ana, s1.id, 'approved')
  g.suggest(a, bo, 'c2', 'concept', text('two?'), 'open one')
  g.compose(a, ana, 'trips', 'c2', { leave: true })
  a.remove('c2', { by: 'user:ana', reason: 'gone' })
  return a
}
/** Copy a graph to another in small batches, as the sync does. */
function copy(a: Store, b: Store, limit = 2) {
  let c: Cursor = START, rounds = 0
  while (hasAfter(a, c) && rounds++ < 100) { const batch = replicaSince(a, c, limit); applyReplica(b, batch); c = batch.next }
  return c
}

test('batches applied in order rebuild the graph exactly: names, owners, scopes, history, suggestions, as of any moment', () => {
  const a = busyGraph(), b = fresh()
  copy(a, b)
  assert.deepEqual(b.names(), a.names())
  assert.deepEqual(b.history('c1'), a.history('c1'))
  assert.deepEqual(b.history('c2'), a.history('c2'))
  assert.deepEqual(g.list(b), g.list(a))
  assert.equal(b.get('trips')!.owner, 'user:ana')
  const mid = a.history('trips')[0].at
  assert.deepEqual(b.names(undefined, { asOf: mid }), a.names(undefined, { asOf: mid }))
  assert.equal(compose(b, 'trips').text, compose(a, 'trips').text)
  // the rebuilt graph works on: governance continues where it left off
  assert.throws(() => g.write(b, bo, 'c1', 'concept', text('x')), /is user:ana's/)
})

test('applying again is harmless; a record that differs is refused and nothing of the batch is kept', () => {
  const a = busyGraph(), b = fresh()
  copy(a, b)
  const all = replicaSince(a, START, 1000)
  assert.equal(applyReplica(b, all).added, 0)
  const forged = { ...all, changes: [{ ...all.changes[0], by: 'user:mallory' }] }
  assert.throws(() => applyReplica(b, forged), ReplicaConflict)
  assert.equal(b.history('c1')[0].by, 'user:ana')
})

test('the cursor moves only forward and says when there is nothing more', () => {
  const a = busyGraph()
  const end = copy(a, fresh())
  assert.equal(hasAfter(a, end), false)
  g.write(a, ana, 'c3', 'concept', text('three'))
  assert.equal(hasAfter(a, end), true)
  assert.deepEqual(replicaSince(a, end).changes.map((c) => c.name), ['c3'])
})

test('named versions travel with the log, each after the change it stands at, in small batches too', () => {
  const a = fresh(), b = fresh()
  const admin = { id: 'user:root', admin: true }
  g.write(a, admin, 'c1', 'concept', text('one'))
  publishDraft(a, admin, 'one concept')
  g.write(a, admin, 'c2', 'concept', text('two'))
  g.write(a, admin, 'c3', 'concept', text('three'))
  publishDraft(a, admin, 'three concepts')
  let c: Cursor = START, rounds = 0
  while (hasAfter(a, c) && rounds++ < 100) { const batch = replicaSince(a, c, 1); applyReplica(b, batch); c = batch.next }
  assert.deepEqual(b.versions().map((v) => [v.name, v.upto, v.changes]), a.versions().map((v) => [v.name, v.upto, v.changes]))
  assert.equal(b.names('concept', { upto: b.version('v1')!.upto }).length, 1)
})
