// Run:  cd vm && pnpm exec tsx --test packages/node-store/src/semantic.test.ts
import { test } from 'node:test'
import assert from 'node:assert'
import { NodeStore } from './store.js'
import { SqliteVecIndex, hybridSearch, indexText, backfillMissing, rrfFuse, type Embedder } from './semantic.js'

// Deterministic MOCK embedder — hand-placed vectors so the test is meaningful without shipping a real model.
// (The real embedder just swaps in behind the same interface.)
const VECS: Record<string, number[]> = {
  'how many total hours did she log across all her projects': [1, 0, 0, 0],
  'total billed hours for a single employee':                 [0.96, 0.1, 0, 0],  // near ↑ (same meaning)
  'which employees logged the most hours this month':         [0.2, 1, 0, 0],     // related words, different intent
  'top 10 lanes by revenue':                                  [0, 0, 1, 0],       // unrelated
}
const mock: Embedder = {
  id: 'mock', dim: 4,
  async embed(texts) { return texts.map(t => new Float32Array(VECS[t.toLowerCase()] ?? [0, 0, 0, 1])) },
}

function seed() {
  const store = new NodeStore(':memory:')
  const index = new SqliteVecIndex(store.db, mock.id, mock.dim)
  const ids: Record<string, string> = {}
  return (async () => {
    for (const text of Object.keys(VECS)) {
      const id = 'intent:' + text.replace(/\s+/g, '-').slice(0, 24)
      ids[text] = id
      store.putNode({ id, kind: 'intent', label: text })
      await indexText(index, mock, id, text)
    }
    return { store, index, ids }
  })()
}

test('SqliteVecIndex KNN ranks by cosine (nearest meaning first)', async () => {
  const { index } = await seed()
  const [qv] = await mock.embed(['total billed hours for a single employee'])
  const hits = index.search(qv, { limit: 2 })
  assert.equal(hits.length, 2)
  // the two closest must be the employee-hours pair, NOT lanes
  assert.ok(hits.every(h => !h.id.includes('lanes')), 'lanes must not be in the top-2')
})

test('hybridSearch finds the right intent by MEANING + exact phrase ranks #1', async () => {
  const { store, index } = await seed()
  const hits = await hybridSearch(store, index, mock, 'how many total hours did she log across all her projects', { kind: 'intent', limit: 3 })
  assert.ok(hits.length > 0)
  assert.match(hits[0].label.toLowerCase(), /total hours did she/)         // exact match wins (FTS + semantic agree)
  assert.ok(hits.some(h => /single employee/.test(h.label)), 'the paraphrase should be recalled too')
})

test('retire drops from search', async () => {
  const { store, index, ids } = await seed()
  const id = ids['top 10 lanes by revenue']
  store.retire(id); index.remove(id)
  const hits = await hybridSearch(store, index, mock, 'top 10 lanes by revenue', { kind: 'intent', limit: 5 })
  assert.ok(hits.every(h => h.id !== id), 'retired intent must not appear')
})

test('backfillMissing embeds only the not-yet-indexed live intents (idempotent)', async () => {
  const store = new NodeStore(':memory:')
  const index = new SqliteVecIndex(store.db, mock.id, mock.dim)
  for (const text of Object.keys(VECS)) store.putNode({ id: 'intent:' + text.slice(0, 12), kind: 'intent', label: text, summary: text })
  const first = await backfillMissing(store, index, mock, { kind: 'intent' })
  assert.equal(first, Object.keys(VECS).length)          // all embedded on first pass
  const again = await backfillMissing(store, index, mock, { kind: 'intent' })
  assert.equal(again, 0)                                  // idempotent — nothing left to do
})

test('rrfFuse merges two ranked lists', () => {
  const fused = rrfFuse([['a', 'b', 'c'], ['b', 'a', 'd']])
  assert.deepEqual(fused.slice(0, 2).map(f => f.id).sort(), ['a', 'b'])   // a & b top both lists
})
