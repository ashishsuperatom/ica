// ── THE QUERY CACHE ──────────────────────────────────────────────────────────────────────────────────────────
//
// hash(source and its generation, the SQL exactly as sent, params) → the rows that came back. A source's generation is
// its connector and settings as loaded: a changed connector or connection never reads a result the old one wrote.
// Fresh for six hours by default (a caller may ask for fresher); at most 20,000 results and 500 MB, the least recently
// used going first.
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

import { migrateFile } from '@superatom/migrate/node'
import type { Migration } from '@superatom/migrate'
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

/** Migrations (@superatom/migrate): numbered, never edited once shipped — a change is a new one. */
export const MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: `CREATE TABLE IF NOT EXISTS query_result (
      key        TEXT PRIMARY KEY,
      source     TEXT NOT NULL,
      sql        TEXT NOT NULL,
      params     TEXT NOT NULL,
      rows       TEXT NOT NULL,
      capped_to  INTEGER,
      notes      TEXT,
      fetched_at INTEGER NOT NULL,
      hits       INTEGER NOT NULL DEFAULT 0
    )` },
  { id: 2, name: 'when each result was last used, for keeping the cache bounded', up: `
    ALTER TABLE query_result ADD COLUMN used_at INTEGER;
    CREATE INDEX IF NOT EXISTS query_result_used ON query_result (used_at);
  ` },
]

export const DEFAULT_FRESH_MS = 6 * 3600_000
const MAX_ENTRIES = 20_000
const MAX_TOTAL_BYTES = 500_000_000

export class QueryCache {
  private readonly db: DatabaseSync

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    migrateFile(this.db, file, MIGRATIONS, 'query-results.sqlite')
  }

  /** Forget every result of one source: its data changed (a write through the manager), so what was read is no longer
   *  what is there. Each person's own results of it too (`<source>~<person>`), unless one person's is named. */
  forgetSource(source: string): number {
    return Number(this.db.prepare("DELETE FROM query_result WHERE source = ? OR (instr(?, '~') = 0 AND source LIKE ? || '~%')").run(source, source, source).changes)
  }

  /** A result no older than `freshMs` (by default six hours), or null. */
  get(key: string, freshMs = DEFAULT_FRESH_MS): Cached | null {
    const r: any = this.db.prepare('SELECT rows, capped_to, notes, fetched_at FROM query_result WHERE key = ?').get(key)
    if (!r) return null
    if (Date.now() - Number(r.fetched_at) > freshMs) return null
    this.db.prepare('UPDATE query_result SET hits = hits + 1, used_at = ? WHERE key = ?').run(Date.now(), key)
    return { rows: JSON.parse(r.rows), cappedTo: r.capped_to == null ? null : Number(r.capped_to),
             notes: r.notes ? JSON.parse(r.notes) : null, fetchedAt: Number(r.fetched_at) }
  }

  put(key: string, source: string, sql: string, params: unknown, c: Cached): void {
    this.db.prepare(`INSERT OR REPLACE INTO query_result (key, source, sql, params, rows, capped_to, notes, fetched_at, used_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, source, sql, canonical(params ?? {}), JSON.stringify(c.rows), c.cappedTo,
           c.notes ? JSON.stringify(c.notes) : null, c.fetchedAt, Date.now())
    if (++this.puts % 50 === 0) this.bound()
  }
  private puts = 0
  /** Kept bounded: past 20,000 results or 500 MB, the least recently used go (and anything stale for a day). */
  bound(): number {
    let gone = Number(this.db.prepare('DELETE FROM query_result WHERE fetched_at < ?').run(Date.now() - 4 * DEFAULT_FRESH_MS).changes)
    const { entries, bytes } = this.stats()
    if (entries > MAX_ENTRIES || bytes > MAX_TOTAL_BYTES) {
      const over = Math.max(entries - MAX_ENTRIES, Math.ceil(entries * Math.max(0, (bytes - MAX_TOTAL_BYTES) / Math.max(bytes, 1)))) + Math.ceil(MAX_ENTRIES / 20)
      gone += Number(this.db.prepare('DELETE FROM query_result WHERE key IN (SELECT key FROM query_result ORDER BY COALESCE(used_at, fetched_at) LIMIT ?)').run(over).changes)
    }
    return gone
  }

  stats() {
    const r: any = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(LENGTH(rows)),0) AS bytes FROM query_result').get()
    return { entries: Number(r.n), hits: Number(r.hits), bytes: Number(r.bytes) }
  }

  /** What is held of one source: how many results, how often read again, how big, the oldest and newest. */
  statsOf(source: string) {
    const r: any = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(LENGTH(rows)),0) AS bytes, MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest FROM query_result WHERE source = ?').get(source)
    const iso = (t: unknown) => (t == null ? null : new Date(Number(t)).toISOString())
    return { source, entries: Number(r.n), hits: Number(r.hits), bytes: Number(r.bytes), oldest: iso(r.oldest), newest: iso(r.newest) }
  }
}
