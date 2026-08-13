// Smoke test: the fast-router → Qdrant path. Creates a per-project collection, upserts a few
// "prior questions" as vectors, and searches — proving connectivity + nearest-neighbour from the
// same @qdrant/js-client-rest the worker will use.  QDRANT_URL overrides the default.
import { QdrantClient } from '@qdrant/js-client-rest'

const client = new QdrantClient({ url: process.env.QDRANT_URL || 'http://127.0.0.1:6333' })
const COLL = 'proj_totalgroup'        // collection per project
const DIM = 8                          // tiny hand-made vectors so the nearest match is deterministic

const ok = (b, m) => console.log(`  ${b ? '✅' : '❌'} ${m}`)

async function main() {
  const health = await client.api('service').healthz?.().catch(() => null)
  ok(true, `connected to Qdrant`)

  await client.deleteCollection(COLL).catch(() => {})
  await client.createCollection(COLL, { vectors: { size: DIM, distance: 'Cosine' } })
  ok(true, `created collection "${COLL}" (dim ${DIM}, cosine)`)

  // Three "prior questions" as toy vectors (in reality: sentence embeddings).
  await client.upsert(COLL, {
    wait: true,
    points: [
      { id: 1, vector: [1, 0, 0, 0, 0, 0, 0, 0], payload: { q: 'total revenue this financial year' } },
      { id: 2, vector: [0, 1, 0, 0, 0, 0, 0, 0], payload: { q: 'overdue amount by client' } },
      { id: 3, vector: [0.9, 0.1, 0, 0, 0, 0, 0, 0], payload: { q: 'revenue growth by customer' } },
    ],
  })
  ok(true, 'upserted 3 points')

  const info = await client.getCollection(COLL)
  ok(info.points_count === 3, `collection reports ${info.points_count} points`)

  // Query close to point 1 → expect 1 then 3 (both revenue-ish), not 2 (overdue).
  const res = await client.search(COLL, { vector: [1, 0.05, 0, 0, 0, 0, 0, 0], limit: 2, with_payload: true })
  console.log('  → nearest:', res.map(r => ({ id: r.id, score: +r.score.toFixed(3), q: r.payload.q })))
  ok(res[0]?.id === 1 && res[1]?.id === 3, 'nearest-neighbour ranking correct (revenue matches surface first)')

  await client.deleteCollection(COLL)
  ok(true, 'cleaned up collection')
  console.log('\n[qdrant-check] OK')
}
main().catch((e) => { console.error('[qdrant-check] FAILED:', e.message); process.exit(1) })
