// SWAPPABLE semantic search for intent nodes.
//
// Three seams, each replaceable in ISOLATION — callers only ever touch searchIntents()/indexIntent():
//   1. Embedder    — the model.        small local model now  → bigger/API model later
//   2. VectorIndex — storage + kNN.    SqliteVectorIndex now   → Qdrant/HNSW later
//   3. rrfFuse()   — the reranker.     RRF now                 → weighted / cross-encoder later
//
// node-store stays dependency-free: it defines the Embedder INTERFACE but never calls a model — the engine
// injects a concrete embedder. Vectors are stored L2-normalised so cosine == dot product.

import type { NodeStore } from './store.js'
import { createRequire } from 'node:module'

export interface Embedder {
  readonly id: string           // model id (e.g. 'bge-small-en-v1.5'); stamped so a model swap is detectable
  readonly dim: number
  // asQuery=true → embed as a search QUERY, else as an indexed PASSAGE. Asymmetric models (BGE, E5) prefix the
  // two differently; symmetric models can ignore the flag.
  embed(texts: string[], opts?: { asQuery?: boolean }): Promise<Float32Array[]>
}

export interface VectorIndex {
  upsert(id: string, vec: Float32Array): void
  remove(id: string): void
  has(id: string): boolean
  // cosine DESC; `keep` (if given) restricts candidates to ids it approves (liveness / kind filter).
  // `sim` is the cosine similarity itself (0..1) — the only value here that says HOW CLOSE the match is;
  // `score` just orders the list.
  search(vec: Float32Array, opts: { limit: number; keep?: (id: string) => boolean }): Array<{ id: string; score: number; sim: number }>
}

// Reciprocal Rank Fusion — rank-based, so lexical (BM25) and semantic (cosine) never need score calibration.
// k dampens the head. THE reranker seam: swap for a weighted blend or a cross-encoder later; nothing else moves.
export function rrfFuse(lists: string[][], k = 60): Array<{ id: string; score: number }> {
  const acc = new Map<string, number>()
  for (const list of lists) list.forEach((id, rank) => acc.set(id, (acc.get(id) ?? 0) + 1 / (k + rank + 1)))
  return [...acc].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
}

function normalize(v: Float32Array): Float32Array {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const n = Math.sqrt(s) || 1, out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}
const toBuf = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)

// VectorIndex: sqlite-vec. A vec0 virtual table in the SAME db as the nodes — vectors are co-located
// and transactional with the truth, no second store, no sync. Vectors are stored L2-NORMALISED, so vec0's L2
// KNN ranks identically to cosine. One model/dim per table; a model swap re-indexes (clears + re-embeds).
export class SqliteVecIndex implements VectorIndex {
  private static loaded = new WeakSet<object>()
  private tbl = 'vec_nodes'
  constructor(private db: NodeStore['db'], readonly model: string, readonly dim: number) {
    // Require sqlite-vec LAZILY (not a top-level import) so merely importing node-store never needs the native
    // binary present — a host without it just can't construct this (caller guards), rather than failing to load.
    if (!SqliteVecIndex.loaded.has(db)) {
      const sqliteVec = createRequire(import.meta.url)('sqlite-vec')
      sqliteVec.load(db); SqliteVecIndex.loaded.add(db)
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tbl} USING vec0(node_id TEXT PRIMARY KEY, embedding float[${dim}])`)
  }
  upsert(id: string, vec: Float32Array) {
    const buf = toBuf(normalize(vec))
    this.db.prepare(`DELETE FROM ${this.tbl} WHERE node_id = ?`).run(id)   // vec0 has no upsert; delete+insert
    this.db.prepare(`INSERT INTO ${this.tbl}(node_id, embedding) VALUES (?, ?)`).run(id, buf)
  }
  remove(id: string) { this.db.prepare(`DELETE FROM ${this.tbl} WHERE node_id = ?`).run(id) }
  has(id: string) { return !!this.db.prepare(`SELECT 1 FROM ${this.tbl} WHERE node_id = ?`).get(id) }
  search(q: Float32Array, opts: { limit: number; keep?: (id: string) => boolean }) {
    const k = Math.max(opts.limit * 4, 32)   // over-fetch so post-filtering (keep) still fills `limit`
    const rows = this.db.prepare(`SELECT node_id, distance FROM ${this.tbl} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
      .all(toBuf(normalize(q)), k) as Array<{ node_id: string; distance: number }>
    const out: Array<{ id: string; score: number; sim: number }> = []
    for (const r of rows) {
      if (opts.keep && !opts.keep(r.node_id)) continue
      // Vectors are stored L2-normalised, so cosine is exact: |a-b|² = 2 - 2·cos ⇒ cos = 1 - d²/2. Carry it
      // alongside the ordering score — cosine is the only number here that says HOW CLOSE, on a scale a caller
      // can threshold (≈1 near-identical, ≈0 unrelated). Rank position cannot express that.
      out.push({ id: r.node_id, score: -r.distance, sim: 1 - (r.distance * r.distance) / 2 })
      if (out.length >= opts.limit) break
    }
    return out
  }
}

// `score` ORDERS the list (RRF over the two retrievers — good at fusing incomparable scales, but it is a rank
// position: identical whether the top hit is perfect or merely least-bad). `sim` is the cosine similarity that
// says how close the match actually is — the number to threshold on. null when the hit came only from the
// lexical side, so there is no vector comparison to report.
export interface Hit { id: string; label: string; score: number; sim: number | null }

// GENERIC hybrid retrieval over ANY node kind (intents, semantic-model concepts, units, atoms, …). Omit `kind`
// to search everything. FTS (lexical) ∪ cosine (semantic) → RRF → top-K LIVE nodes. Callers add their own
// precise step (the reflex LLM, the modeler, …) over these — so no cross-encoder rerank baked in here.
export async function hybridSearch(store: NodeStore, index: VectorIndex, embedder: Embedder, query: string, opts: { kind?: string; limit?: number } = {}): Promise<Hit[]> {
  const limit = opts.limit ?? 8, pool = limit * 3, kind = opts.kind
  const keep = (id: string) => !!store.db.prepare(`SELECT 1 FROM nodes WHERE id=? AND valid_to IS NULL${kind ? ` AND kind='${kind.replace(/'/g, '')}'` : ''}`).get(id)
  const lex = store.search(query, { kind, limit: pool }).map(h => h.id)
  const [qv] = await embedder.embed([query], { asQuery: true })
  const semHits = index.search(qv, { limit: pool * 3, keep })   // wide, so fused candidates carry a similarity
  const simById = new Map(semHits.map(h => [h.id, h.sim]))
  const sem = semHits.map(h => h.id)
  // RRF decides WHICH candidates surface (it fuses two incomparable retrievers well). SIMILARITY decides their
  // ORDER, because rank fusion is flat — it scores a perfect match and a passable one identically, and can rank
  // the weaker one first. A candidate with no vector (lexical-only) keeps its fused position, after the scored ones.
  return rrfFuse([lex, sem]).slice(0, limit)
    .map(f => ({ id: f.id, label: store.getNode(f.id)?.label ?? '', score: f.score, sim: simById.get(f.id) ?? null }))
    .filter(h => h.label)
    .sort((a, b) => (b.sim ?? -1) - (a.sim ?? -1) || b.score - a.score)
}

// Embed + store any node's text. Call when the node is (re)built; call index.remove(id) when it's retired.
export async function indexText(index: VectorIndex, embedder: Embedder, id: string, text: string): Promise<void> {
  const [v] = await embedder.embed([text])
  index.upsert(id, v)
}

// One-time catch-up: embed any live nodes (optionally of a kind) not yet in the index. Idempotent (skips those
// already there), batched. Run on boot so pre-existing intents are searchable, not just newly-built ones.
export async function backfillMissing(store: NodeStore, index: VectorIndex, embedder: Embedder, opts: { kind?: string; batch?: number } = {}): Promise<number> {
  const batch = opts.batch ?? 64, kind = opts.kind?.replace(/'/g, '')
  const rows = (store.db.prepare(`SELECT id, label, summary FROM nodes WHERE valid_to IS NULL${kind ? ` AND kind='${kind}'` : ''}`).all() as Array<{ id: string; label: string; summary: string | null }>)
    .filter(r => !index.has(r.id))
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch)
    const vecs = await embedder.embed(chunk.map(r => r.summary || r.label))
    chunk.forEach((r, j) => index.upsert(r.id, vecs[j]))
  }
  return rows.length
}
