// A PERSISTENT text → vector cache, in the project's own database.
//
// Embedding is deterministic: the same text through the same model is always the same vector. So computing one
// twice is pure waste, and computing it again after every restart is waste on a schedule.
//
// This exists because the concept retriever kept its vectors in a process-local Map. Every restart re-embedded
// every concept surface form and up to 300 background spans — about 26 seconds, paid in the foreground by
// whichever question happened to be asked first, and paid again the next restart. Nothing about the work had
// changed; only the process had.
//
// Keyed by (model, kind, text): `kind` separates a document embedding from a query embedding, which are
// different vectors for the same string, and `model` means a model swap simply misses rather than silently
// returning vectors from the old one.
import type { Database } from 'better-sqlite3'

export const EMBED_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS embed_cache (
  model TEXT NOT NULL,
  kind  TEXT NOT NULL,               -- 'doc' | 'query' | 'mu' (a derived vector, not of any one text)
  text  TEXT NOT NULL,
  vec   BLOB NOT NULL,
  at    INTEGER NOT NULL,
  PRIMARY KEY (model, kind, text)
) WITHOUT ROWID;
`

const toBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength)
const toVec = (b: Buffer): Float32Array => {
  // Copy: the Buffer is owned by the driver and its backing memory is not ours to hold on to.
  const out = new Float32Array(b.byteLength / 4)
  Buffer.from(out.buffer).set(b)
  return out
}

export interface EmbedCache {
  /** The vectors already known, by text. Misses are simply absent — the caller embeds those. */
  get(kind: string, texts: string[]): Map<string, Float32Array>
  /** Remember vectors. Idempotent; re-storing the same text is a no-op write. */
  put(kind: string, entries: Array<[string, Float32Array]>): void
  /** A single derived vector (the retriever's frozen mean), by name. */
  getOne(kind: string, name: string): Float32Array | null
  putOne(kind: string, name: string, vec: Float32Array): void
  /** Forget everything for this model — the deliberate reindex path. */
  clear(): void
}

export function createEmbedCache(db: Database, model: string): EmbedCache {
  const selMany = db.prepare(`SELECT text, vec FROM embed_cache WHERE model = ? AND kind = ? AND text = ?`)
  const ins = db.prepare(`INSERT OR REPLACE INTO embed_cache (model, kind, text, vec, at) VALUES (?, ?, ?, ?, ?)`)
  const del = db.prepare(`DELETE FROM embed_cache WHERE model = ?`)
  const insMany = db.transaction((kind: string, entries: Array<[string, Float32Array]>) => {
    const at = Date.now()
    for (const [text, vec] of entries) ins.run(model, kind, text, toBlob(vec), at)
  })
  return {
    get(kind, texts) {
      const out = new Map<string, Float32Array>()
      // One statement reused per text rather than a giant IN(...): the lists here are hundreds, not millions,
      // and a prepared statement in a loop is faster than building and parsing a query of that width.
      for (const t of texts) {
        const r = selMany.get(model, kind, t) as { text: string; vec: Buffer } | undefined
        if (r) out.set(r.text, toVec(r.vec))
      }
      return out
    },
    put(kind, entries) { if (entries.length) insMany(kind, entries) },
    getOne(kind, name) {
      const r = selMany.get(model, kind, name) as { vec: Buffer } | undefined
      return r ? toVec(r.vec) : null
    },
    putOne(kind, name, vec) { ins.run(model, kind, name, toBlob(vec), Date.now()) },
    clear() { del.run(model) },
  }
}
