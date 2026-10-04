// ── The store: content by hash, names pointing at it, every change recorded ─────────────────────────────────────
//
// A node is a name and a kind pointing at a piece of content. Content is stored once, by the sha-256 of its canonical
// JSON, and never changed; editing a node stores new content and moves the name. Every move is a change row: which
// name, from which hash to which, by whom, why, from what evidence, when. So the graph as of any moment is the last
// change to each name before it, and a session made from the graph can always be compared with it.

import { migrateFile } from '@superatom/migrate/node'
import type { Migration } from '@superatom/migrate'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Kind = 'domain' | 'part' | 'file' | 'setting'
export interface Node<B = unknown> { name: string; kind: Kind; hash: string; body: B }
export interface ChangeContext { by: string; reason?: string; from?: string }
/** A question and the agent it went to: routed by its own words (a session's first question) or asked in a session that
 *  already was a domain. `ranked` is the router's scoring when it routed: every domain, its score, the terms that decided. */
export interface Asked { id: number; at: number; session: string; qid: string | null; question: string; domain: string | null; domainHash: string | null; how: 'routed' | 'chosen' | 'session'; ranked: unknown }
export interface Change { id: number; at: number; name: string; kind: Kind; fromHash: string | null; toHash: string | null; by: string; reason: string | null; from: string | null }

/** The composition graph's migrations (@superatom/migrate): numbered, never edited once shipped — a change is a new one. */
export const MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: `
CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS name (name TEXT PRIMARY KEY, kind TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS change (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  from_hash TEXT, to_hash TEXT, by TEXT NOT NULL, reason TEXT, evidence TEXT);
CREATE INDEX IF NOT EXISTS change_name ON change(name, at);
CREATE TABLE IF NOT EXISTS question (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, session TEXT NOT NULL, qid TEXT, question TEXT NOT NULL,
  domain TEXT, domain_hash TEXT, how TEXT NOT NULL, ranked TEXT);
CREATE INDEX IF NOT EXISTS question_domain ON question(domain, at);
CREATE INDEX IF NOT EXISTS question_session ON question(session, at);
` },
]

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
    migrateFile(this.db, file, MIGRATIONS, 'composition.sqlite')
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

  /** Record a question and the agent it went to. */
  recordQuestion(q: { session: string; qid?: string; question: string; domain: string | null; how: 'routed' | 'chosen' | 'session'; ranked?: unknown }): void {
    const domainHash = q.domain ? (this.get(q.domain)?.hash ?? null) : null
    this.db.prepare('INSERT INTO question (at, session, qid, question, domain, domain_hash, how, ranked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), q.session, q.qid ?? null, q.question, q.domain, domainHash, q.how, q.ranked === undefined ? null : JSON.stringify(q.ranked))
  }

  /** The questions asked, newest first — all of them, or one domain's. */
  questions(limit = 100, domain?: string): Asked[] {
    const rows = (domain ? this.db.prepare('SELECT * FROM question WHERE domain = ? ORDER BY at DESC, id DESC LIMIT ?').all(domain, limit)
      : this.db.prepare('SELECT * FROM question ORDER BY at DESC, id DESC LIMIT ?').all(limit)) as any[]
    return rows.map((r) => ({ id: r.id, at: r.at, session: r.session, qid: r.qid, question: r.question, domain: r.domain, domainHash: r.domain_hash, how: r.how, ranked: r.ranked ? JSON.parse(r.ranked) : null }))
  }

  /** The latest changes across the graph, newest first. */
  changes(limit = 50): Change[] {
    return (this.db.prepare('SELECT id, at, name, kind, from_hash, to_hash, by, reason, evidence FROM change ORDER BY at DESC, id DESC LIMIT ?').all(limit) as any[])
      .map((r) => ({ id: r.id, at: r.at, name: r.name, kind: r.kind, fromHash: r.from_hash, toHash: r.to_hash, by: r.by, reason: r.reason, from: r.evidence }))
  }
}
