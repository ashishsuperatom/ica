// Run:  cd vm && pnpm exec tsx --test packages/node-store/src/retrieval-state.test.ts
//
// A frozen parameter that comes back WRONG is worse than one that is recomputed: every score would shift and
// nothing would say so. The round trip is pinned exactly, including across a reopen — which is the only reason
// this table exists.
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeStore } from './store.js'
import { createRetrievalState } from './retrieval-state.js'

const vec = (...n: number[]) => Float32Array.from(n)
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'sa-state-')), 'project.sqlite')

test('a vector survives the round trip byte for byte', () => {
  const s = createRetrievalState(new NodeStore(dbPath()).db, 'bge-small')
  const v = vec(0.5, -0.25, 1e-7, -3.5e8)
  s.putVector('mu:background', v)
  assert.deepEqual([...s.getVector('mu:background')!], [...v])
})

test('it survives REOPENING the database — the whole point', () => {
  const path = dbPath()
  const v = vec(0.125, 0.25, 0.375)
  { createRetrievalState(new NodeStore(path).db, 'bge-small').putVector('mu:background', v) }
  { assert.deepEqual([...createRetrievalState(new NodeStore(path).db, 'bge-small').getVector('mu:background')!], [...v]) }
})

test('an absent key is null, never a wrong vector', () => {
  assert.equal(createRetrievalState(new NodeStore(dbPath()).db, 'bge-small').getVector('mu:background'), null)
})

test('a different MODEL does not inherit the old mean', () => {
  // Scores are only comparable within one embedding model. Silently reusing the previous model's mean would
  // rescale everything with nothing to show for it.
  const store = new NodeStore(dbPath())
  createRetrievalState(store.db, 'old-model').putVector('mu:background', vec(1, 1))
  assert.equal(createRetrievalState(store.db, 'new-model').getVector('mu:background'), null)
})

test('clear() forgets it — the deliberate reindex path', () => {
  const s = createRetrievalState(new NodeStore(dbPath()).db, 'bge-small')
  s.putVector('mu:background', vec(0.1, 0.2))
  assert.ok(s.getVector('mu:background'))
  s.clear()
  assert.equal(s.getVector('mu:background'), null)
})
