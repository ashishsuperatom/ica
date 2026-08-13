// The intelligence — per project. Given typed text, return ready-to-run suggestions in milliseconds.
//
// ALL Node/TypeScript. No Python runtime.
//   - semantic question-match  → embed(text) [all-MiniLM, ONNX] → Qdrant nearest prior questions
//                                (collection per projectId). DONE (phase 1).
//   - intent + entity/param extract → GLiNER2 via ONNX. TODO (phase 2).
//
// Qdrant is a co-located datastore reached over its own client (like SQLite) — not the UI transport.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { QdrantClient } from '@qdrant/js-client-rest'
import { embed } from './embed.js'
import { classifyIntent, extractEntities } from './gliner.js'
import { streamKey, type IntentGuess, type Suggestion, type SuggestMsg, type SuggestionsMsg, type SuggestDiag } from './protocol.js'

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || 'http://127.0.0.1:6333' })
const collectionFor = (projectId: string) => `proj_${projectId}`
const MATCH_THRESHOLD = 0.4    // cosine similarity above which a prior question is offered as a suggestion

// Per-project entity labels for NER (dataset-specific → loaded from projects/<id>.json, not hardcoded).
const HERE = dirname(fileURLToPath(import.meta.url))
const labelCache = new Map<string, string[]>()
function entityLabelsFor(projectId: string): string[] {
  if (labelCache.has(projectId)) return labelCache.get(projectId)!
  let labels: string[] = []
  try { labels = JSON.parse(readFileSync(join(HERE, '..', 'projects', `${projectId}.json`), 'utf8')).entityLabels ?? [] } catch { /* none */ }
  labelCache.set(projectId, labels)
  return labels
}

// Drop-stale guard: highest seq seen per (projectId, userId, inputId). Applied at THIS layer too,
// because messages cross several hops and can arrive/finish out of order.
const lastSeq = new Map<string, number>()

// The hot path. Returns null when the request is STALE (a newer seq for the same stream already
// arrived) — the caller then sends no reply.
export async function suggest(msg: SuggestMsg): Promise<SuggestionsMsg | null> {
  const key = streamKey(msg)
  if (msg.seq < (lastSeq.get(key) ?? -1)) return null      // stale on arrival
  lastSeq.set(key, msg.seq)

  const timings: Record<string, number> = {}
  const text = (msg.text || '').trim()

  // 1) embed the typed text
  let t = nowMs()
  const vector = text ? await embed(text) : []
  timings.embed = nowMs() - t

  // 2) nearest prior questions for THIS project
  const collection = collectionFor(msg.projectId)
  let raw: Array<{ question: string; score: number; intent?: string; params?: Record<string, unknown> }> = []
  let points = 0
  t = nowMs()
  if (vector.length) {
    try {
      const info = await qdrant.getCollection(collection)
      points = (info.points_count as number) ?? 0
      const res = await qdrant.search(collection, { vector, limit: 5, with_payload: true })
      raw = res.map(r => ({
        question: String((r.payload as any)?.question ?? ''),
        score: r.score,
        intent: (r.payload as any)?.intent,
        params: (r.payload as any)?.params,
      }))
    } catch { /* collection not seeded yet → no matches */ }
  }
  timings.qdrant = nowMs() - t

  // 3) GLiNER2 — intent classification (generic labels) + entity/param extraction (per-project labels)
  t = nowMs()
  const [intentRes, entities] = text
    ? await Promise.all([classifyIntent(text), extractEntities(text, entityLabelsFor(msg.projectId))])
    : [{ guess: { intent: 'unknown' as const, confidence: 0 }, scores: {} }, []]
  timings.gliner = nowMs() - t

  // Re-check staleness AFTER the async work: a newer keystroke may have superseded us meanwhile.
  if (msg.seq < (lastSeq.get(key) ?? -1)) return null

  const items: Suggestion[] = raw
    .filter(m => m.score >= MATCH_THRESHOLD)
    .map(m => ({ kind: 'match', label: m.question, question: m.question, params: m.params, score: m.score }))

  const intent: IntentGuess = intentRes.guess
  const diag: SuggestDiag = {
    text, collection, points, matches: raw,
    intentScores: intentRes.scores, entities,
    timings, threshold: MATCH_THRESHOLD,
  }

  return {
    t: 'suggestions',
    projectId: msg.projectId, userId: msg.userId, inputId: msg.inputId, seq: msg.seq,
    intent, items,
    ms: Object.values(timings).reduce((a, b) => a + b, 0),
    diag,
  }
}

// Fire-and-forget: fold a well-answered question into the project's index for next time.
export async function ingest(projectId: string, question: string, extra?: { intent?: string; params?: any; id?: number }): Promise<void> {
  const collection = collectionFor(projectId)
  await ensureCollection(collection)
  const vector = await embed(question)
  await qdrant.upsert(collection, {
    wait: true,
    points: [{ id: extra?.id ?? Math.abs(hash(question)), vector, payload: { question, intent: extra?.intent, params: extra?.params } }],
  })
}

export async function ensureCollection(collection: string): Promise<void> {
  try { await qdrant.getCollection(collection) }
  catch {
    const { EMBED_DIM } = await import('./embed.js')
    await qdrant.createCollection(collection, { vectors: { size: EMBED_DIM, distance: 'Cosine' } })
  }
}

function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }
function nowMs(): number { return Number(process.hrtime.bigint() / 1_000_000n) }
