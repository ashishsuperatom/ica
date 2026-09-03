// Run:  cd vm && pnpm exec tsx --test packages/node-store/src/embed-cache.test.ts
//
// A vector that survives a restart wrong is worse than one that is recomputed: retrieval would quietly rank on
// nonsense. So the round-trip is pinned exactly, including the reopen.
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeStore } from './store.js'
import { createEmbedCache } from './embed-cache.js'

const vec = (...n: number[]) => Float32Array.from(n)
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'sa-embed-')), 'project.sqlite')

test('a vector survives the round trip byte for byte', () => {
  const store = new NodeStore(dbPath())
  const c = createEmbedCache(store.db, 'bge-small')
  const v = vec(0.5, -0.25, 1e-7, -3.5e8)
  c.put('doc', [['revenue', v]])
  const got = c.get('doc', ['revenue']).get('revenue')!
  assert.deepEqual([...got], [...v])
})

test('it survives REOPENING the database — the whole point', () => {
  const path = dbPath()
  const v = vec(0.125, 0.25, 0.375)
  { const s = new NodeStore(path); createEmbedCache(s.db, 'bge-small').put('doc', [['margin', v]]) }
  { const s = new NodeStore(path)
    assert.deepEqual([...createEmbedCache(s.db, 'bge-small').get('doc', ['margin']).get('margin')!], [...v]) }
})

test('misses are absent, not wrong', () => {
  const c = createEmbedCache(new NodeStore(dbPath()).db, 'bge-small')
  c.put('doc', ['a'].map(t => [t, vec(1, 2)] as [string, Float32Array]))
  const got = c.get('doc', ['a', 'never-seen'])
  assert.equal(got.size, 1)
  assert.equal(got.has('never-seen'), false)
})

test('a different MODEL misses rather than returning the old vectors', () => {
  const store = new NodeStore(dbPath())
  createEmbedCache(store.db, 'old-model').put('doc', [['revenue', vec(1, 1)]])
  assert.equal(createEmbedCache(store.db, 'new-model').get('doc', ['revenue']).size, 0)
})

test('doc and query embeddings of the same text do not collide', () => {
  const c = createEmbedCache(new NodeStore(dbPath()).db, 'bge-small')
  c.put('doc', [['revenue', vec(1, 0)]])
  c.put('query', [['revenue', vec(0, 1)]])
  assert.deepEqual([...c.get('doc', ['revenue']).get('revenue')!], [1, 0])
  assert.deepEqual([...c.get('query', ['revenue']).get('revenue')!], [0, 1])
})

test('the frozen mean vector persists and clears on reindex', () => {
  const c = createEmbedCache(new NodeStore(dbPath()).db, 'bge-small')
  c.putOne('mu', 'background', vec(0.1, 0.2))
  assert.deepEqual([...c.getOne('mu', 'background')!], [0.1, 0.2].map(n => Math.fround(n)))
  c.clear()
  assert.equal(c.getOne('mu', 'background'), null)
})
