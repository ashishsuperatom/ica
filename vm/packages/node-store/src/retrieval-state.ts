// A small persisted slot for the retrieval system's own PARAMETERS — not a vector store.
//
// There is exactly one vector store in this system: the sqlite-vec index. Searchable vectors belong there and
// nowhere else, because a second place to look is a second place to be out of date.
//
// What does not belong there is a vector that is never searched FOR: the span retriever's frozen background
// mean, `mu`. It is one number-shaped parameter of the scoring function, read once at boot and subtracted from
// everything. Putting it in the search index would mean it turned up as a result of itself.
//
// Why it must persist at all: `mu` is specified as FROZEN (§4 of the retrieval spec) — recomputing it silently
// rescales every score. It was being rebuilt at every process start from whatever intents existed at that
// moment, so the reference drifted as questions accumulated and the same question could score differently
// after a restart. A frozen value that only lives in memory is not frozen.
import type { Database } from 'better-sqlite3'

export const RETRIEVAL_STATE_SCHEMA = `
-- A bulk text->vector cache lived here for about an hour today. It was the wrong answer: searchable vectors
-- belong in the one vector index, and everything it held is derivable. Dropped rather than left to be found
-- later by someone wondering which of the two places is authoritative.
DROP TABLE IF EXISTS embed_cache;

CREATE TABLE IF NOT EXISTS retrieval_state (
  model TEXT NOT NULL,               -- scoped to the embedding model: a model swap must not inherit its mean
  key   TEXT NOT NULL,
  vec   BLOB NOT NULL,
  at    INTEGER NOT NULL,
  PRIMARY KEY (model, key)
) WITHOUT ROWID;
`

const toBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength)
const toVec = (b: Buffer): Float32Array => {
  // Copy: the Buffer belongs to the driver and its memory is not ours to keep.
  const out = new Float32Array(b.byteLength / 4)
  Buffer.from(out.buffer).set(b)
  return out
}

export interface RetrievalState {
  getVector(key: string): Float32Array | null
  putVector(key: string, vec: Float32Array): void
  /** Forget this model's parameters — the deliberate reindex path, and nothing else. */
  clear(): void
}

export function createRetrievalState(db: Database, model: string): RetrievalState {
  const sel = db.prepare(`SELECT vec FROM retrieval_state WHERE model = ? AND key = ?`)
  const ins = db.prepare(`INSERT OR REPLACE INTO retrieval_state (model, key, vec, at) VALUES (?, ?, ?, ?)`)
  const del = db.prepare(`DELETE FROM retrieval_state WHERE model = ?`)
  return {
    getVector(key) {
      const r = sel.get(model, key) as { vec: Buffer } | undefined
      return r ? toVec(r.vec) : null
    },
    putVector(key, vec) { ins.run(model, key, toBlob(vec), Date.now()) },
    clear() { del.run(model) },
  }
}
