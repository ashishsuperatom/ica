// ── THE QUERY CACHE ──────────────────────────────────────────────────────────────────────────────────────────
//
// hash(source, the SQL exactly as sent, params) → the rows that came back. Kept forever.
//
// The SQL is the FINAL statement — after the rewrite has injected policies and the row cap — so two entries
// share a key only when the source received the identical statement. Nothing is normalised: a different
// spelling is a miss, never a wrong hit.
//
// Stored only when the answer is a property of the statement alone:
//   - not an error (a failure is about that moment, not the data)
//   - not a query that reads the clock (SYSDATE is the same text with a different answer each day)
//   - not the raw or non-SQL path (nothing has parsed those, so nothing can say whether they read the clock)
//
// Every hit reports when its rows were fetched. `fresh: true` on a request re-reads the source and replaces
// the entry.

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Cached { rows: any[]; cappedTo: number | null; notes: string[] | null; fetchedAt: number }

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

export const cacheKey = (source: string, sql: string, params: unknown): string =>
  createHash('sha256').update(canonical({ source, sql, params: params ?? {} })).digest('hex')

export class QueryCache {
  private readonly db: DatabaseSync

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS query_result (
      key        TEXT PRIMARY KEY,
      source     TEXT NOT NULL,
      sql        TEXT NOT NULL,
      params     TEXT NOT NULL,
      rows       TEXT NOT NULL,
      capped_to  INTEGER,
      notes      TEXT,
      fetched_at INTEGER NOT NULL,
      hits       INTEGER NOT NULL DEFAULT 0
    )`)
  }

  get(key: string): Cached | null {
    const r: any = this.db.prepare('SELECT rows, capped_to, notes, fetched_at FROM query_result WHERE key = ?').get(key)
    if (!r) return null
    this.db.prepare('UPDATE query_result SET hits = hits + 1 WHERE key = ?').run(key)
    return { rows: JSON.parse(r.rows), cappedTo: r.capped_to == null ? null : Number(r.capped_to),
             notes: r.notes ? JSON.parse(r.notes) : null, fetchedAt: Number(r.fetched_at) }
  }

  put(key: string, source: string, sql: string, params: unknown, c: Cached): void {
    this.db.prepare(`INSERT OR REPLACE INTO query_result (key, source, sql, params, rows, capped_to, notes, fetched_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, source, sql, canonical(params ?? {}), JSON.stringify(c.rows), c.cappedTo,
           c.notes ? JSON.stringify(c.notes) : null, c.fetchedAt)
  }

  stats() {
    const r: any = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(LENGTH(rows)),0) AS bytes FROM query_result').get()
    return { entries: Number(r.n), hits: Number(r.hits), bytes: Number(r.bytes) }
  }
}
