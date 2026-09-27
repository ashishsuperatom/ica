// ── The store: content by hash, names pointing at it, every change recorded ─────────────────────────────────────
//
// A node is a name and a kind pointing at a piece of content. Content is stored once, by the sha-256 of its canonical
// JSON, and never changed; editing a node stores new content and moves the name. Every move is a change row: which
// name, from which hash to which, by whom, why, from what evidence, when. So the graph as of any moment is the last
// change to each name before it, and a session made from the graph can always be compared with it.

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Kind = 'domain' | 'part' | 'file'
export interface Node<B = unknown> { name: string; kind: Kind; hash: string; body: B }
export interface ChangeContext { by: string; reason?: string; from?: string }
export interface Change { id: number; at: number; name: string; kind: Kind; fromHash: string | null; toHash: string | null; by: string; reason: string | null; from: string | null }

const TABLES = `
CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS name (name TEXT PRIMARY KEY, kind TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS change (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  from_hash TEXT, to_hash TEXT, by TEXT NOT NULL, reason TEXT, evidence TEXT);
CREATE INDEX IF NOT EXISTS change_name ON change(name, at);
`

/** JSON with keys in a fixed order, so the same content always has the same hash. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
export const hashOf = (body: unknown) => createHash('sha256').update(canonical(body)).digest('hex')

export class Store {
  readonly db: DatabaseSync
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA busy_timeout = 15000')
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(TABLES)
  }
  close() { this.db.close() }

  /** Point a name at this content. Unchanged content is no change and records nothing. */
  put<B>(name: string, kind: Kind, body: B, ctx: ChangeContext): { hash: string; changed: boolean } {
    const hash = hashOf(body)
    const cur = this.db.prepare('SELECT kind, hash FROM name WHERE name = ?').get(name) as { kind: string; hash: string } | undefined
    if (cur && cur.kind !== kind) throw new Error(`"${name}" is a ${cur.kind}, not a ${kind}`)
    if (cur?.hash === hash) return { hash, changed: false }
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT OR IGNORE INTO content (hash, body, at) VALUES (?, ?, ?)').run(hash, canonical(body), now)
      this.db.prepare('INSERT INTO name (name, kind, hash) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash').run(name, kind, hash)
      this.db.prepare('INSERT INTO change (at, name, kind, from_hash, to_hash, by, reason, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(now, name, kind, cur?.hash ?? null, hash, ctx.by, ctx.reason ?? null, ctx.from ?? null)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    return { hash, changed: true }
  }

  /** Take a name away. Its content stays, so history can still show what it was. */
  remove(name: string, ctx: ChangeContext): boolean {
    const cur = this.db.prepare('SELECT kind, hash FROM name WHERE name = ?').get(name) as { kind: string; hash: string } | undefined
    if (!cur) return false
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM name WHERE name = ?').run(name)
      this.db.prepare('INSERT INTO change (at, name, kind, from_hash, to_hash, by, reason, evidence) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
        .run(Date.now(), name, cur.kind, cur.hash, ctx.by, ctx.reason ?? null, ctx.from ?? null)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    return true
  }

  /** A node as it is now, or as it was at a moment (ms since the epoch). */
  get<B = unknown>(name: string, asOf?: number): Node<B> | null {
    let row: { kind: string; hash: string | null } | undefined
    if (asOf === undefined) row = this.db.prepare('SELECT kind, hash FROM name WHERE name = ?').get(name) as any
    else row = this.db.prepare('SELECT kind, to_hash AS hash FROM change WHERE name = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1').get(name, asOf) as any
    if (!row?.hash) return null
    return { name, kind: row.kind as Kind, hash: row.hash, body: this.content<B>(row.hash) }
  }

  /** Content by its hash. */
  content<B = unknown>(hash: string): B {
    const r = this.db.prepare('SELECT body FROM content WHERE hash = ?').get(hash) as { body: string } | undefined
    if (!r) throw new Error(`no content ${hash.slice(0, 12)}`)
    return JSON.parse(r.body) as B
  }

  /** The names there are now, of one kind or all. */
  names(kind?: Kind): { name: string; kind: Kind; hash: string }[] {
    const rows = kind ? this.db.prepare('SELECT name, kind, hash FROM name WHERE kind = ? ORDER BY name').all(kind) : this.db.prepare('SELECT name, kind, hash FROM name ORDER BY name').all()
    return rows as any
  }

  /** Every change to a name, oldest first. */
  history(name: string): Change[] {
    return (this.db.prepare('SELECT id, at, name, kind, from_hash, to_hash, by, reason, evidence FROM change WHERE name = ? ORDER BY at, id').all(name) as any[])
      .map((r) => ({ id: r.id, at: r.at, name: r.name, kind: r.kind, fromHash: r.from_hash, toHash: r.to_hash, by: r.by, reason: r.reason, from: r.evidence }))
  }

  /** The latest changes across the graph, newest first. */
  changes(limit = 50): Change[] {
    return (this.db.prepare('SELECT id, at, name, kind, from_hash, to_hash, by, reason, evidence FROM change ORDER BY at DESC, id DESC LIMIT ?').all(limit) as any[])
      .map((r) => ({ id: r.id, at: r.at, name: r.name, kind: r.kind, fromHash: r.from_hash, toHash: r.to_hash, by: r.by, reason: r.reason, from: r.evidence }))
  }
}
