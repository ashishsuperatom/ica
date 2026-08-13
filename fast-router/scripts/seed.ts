// Seed a project's Qdrant collection with sample prior questions (embedded), so semantic match has
// something to match against. In production these arrive via `ingest`; this is the test fixture.
//   node_modules/.bin/tsx scripts/seed.ts
import { readFileSync } from 'node:fs'
import { QdrantClient } from '@qdrant/js-client-rest'
import { ingest, ensureCollection } from '../src/router.js'

const data = JSON.parse(readFileSync(new URL('./sample_questions.json', import.meta.url), 'utf8'))
const projectId = process.env.SEED_PROJECT || data.projectId   // override to seed the real (UUID) project
const collection = `proj_${projectId}`
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || 'http://127.0.0.1:6333' })

console.log(`[seed] embedding + upserting ${data.questions.length} questions → ${collection}`)
await qdrant.deleteCollection(collection).catch(() => {})
await ensureCollection(collection)
let id = 1
for (const q of data.questions) {
  await ingest(projectId, q.question, { intent: q.intent, params: q.params, id: id++ })
  process.stdout.write('.')
}
const info = await qdrant.getCollection(collection)
console.log(`\n[seed] done — ${info.points_count} points in ${collection}`)
process.exit(0)
