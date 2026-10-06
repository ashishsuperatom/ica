// ── The store: content by hash, names pointing at it, every change recorded ─────────────────────────────────────
//
// A node is a name and a kind pointing at a piece of content. Content is stored once, by the sha-256 of its canonical
// JSON, and never changed; editing a node stores new content and moves the name. Every move is a change row: which
// name, from which hash to which, by whom, why, from what evidence, when. So the graph as of any moment is the last
// change to each name before it, and a session made from the graph can always be compared with it.

import { migrateFile } from '@superatom/migrate/node'
import { addColumnIfMissing, type Migration } from '@superatom/migrate'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Kind = 'domain' | 'concept' | 'file' | 'setting' | 'agent'
/** Who sees a node: everyone (global), a group's members (group:<name>), or one person (user:<id>). */
export type Scope = string
export interface Node<B = unknown> { name: string; kind: Kind; hash: string; body: B; scope: Scope; owner: string | null }
export interface ChangeContext { by: string; reason?: string; from?: string }
/** A node's scope and owner, when it is put. Left out: a new node is global with no owner; an existing one keeps its own. */
export interface Placement { scope?: Scope; owner?: string | null }

/** Is a node in this scope visible to someone who sees these scopes? Global is visible to all. */
export const visibleTo = (scope: Scope, viewer: Scope[]) => scope === 'global' || viewer.includes(scope)
/** A question and the agent it went to: routed by its own words (a session's first question) or asked in a session that
 *  already was a domain. `ranked` is the router's scoring when it routed: every domain, its score, the terms that decided. */
export interface Asked { id: number; at: number; session: string; qid: string | null; question: string; domain: string | null; domainHash: string | null; how: 'routed' | 'chosen' | 'session'; ranked: unknown }
/** A named version: a name and a message given to one moment of the change log (like a git tag over it). */
export interface Version { id: number; name: string; message: string; upto: number; at: number; by: string; asOf: number; changes: number }
export interface Change { id: number; at: number; name: string; kind: Kind; fromHash: string | null; toHash: string | null; by: string; reason: string | null; from: string | null; scope: Scope | null }

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
  // What were parts are concepts: text composed, in order, into an agent's context.
  { id: 2, name: 'parts are concepts', up: `
UPDATE name SET kind = 'concept' WHERE kind = 'part';
UPDATE change SET kind = 'concept' WHERE kind = 'part';
` },
  // Every node has a scope (global, group:<name>, user:<id>) and one owner; each change records the scope it set, so
  // the graph can be read as it was, scopes included.
  { id: 3, name: 'scope and owner', up: (db) => {
    addColumnIfMissing(db, 'name', 'scope', "TEXT NOT NULL DEFAULT 'global'")
    addColumnIfMissing(db, 'name', 'owner', 'TEXT')
    addColumnIfMissing(db, 'change', 'scope', 'TEXT')
  } },
  // Governance (governance.ts): a suggestion to change a node, and the owner's decision on it — both append-only; a
  // suggestion's status is read from its decision, never stored on it.
  { id: 4, name: 'suggestions and decisions', up: `
CREATE TABLE IF NOT EXISTS suggestion (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, body_hash TEXT NOT NULL,
  base_hash TEXT, scope TEXT, by TEXT NOT NULL, reason TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS suggestion_name ON suggestion(name, at);
CREATE TABLE IF NOT EXISTS decision (
  suggestion INTEGER PRIMARY KEY REFERENCES suggestion(id), at INTEGER NOT NULL, by TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approved', 'rejected', 'withdrawn')), reason TEXT);
CREATE TRIGGER IF NOT EXISTS suggestion_no_update BEFORE UPDATE ON suggestion BEGIN SELECT RAISE(ABORT, 'suggestions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS suggestion_no_delete BEFORE DELETE ON suggestion BEGIN SELECT RAISE(ABORT, 'suggestions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS decision_no_update BEFORE UPDATE ON decision BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS decision_no_delete BEFORE DELETE ON decision BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
` },
  // Each change records the owner it left the node with, so the graph can be rebuilt from its log alone (replica.ts).
  { id: 5, name: 'owner on each change', up: (db) => { addColumnIfMissing(db, 'change', 'owner', 'TEXT') } },
  // Named versions (versions.ts): a name and a message for one moment of the change log — the change it stands at.
  // Every change is still saved at once; a version only names a point of that history. Append-only.
  { id: 6, name: 'named versions', up: `
CREATE TABLE IF NOT EXISTS version (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, message TEXT NOT NULL, upto INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS version_no_update BEFORE UPDATE ON version BEGIN SELECT RAISE(ABORT, 'versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS version_no_delete BEFORE DELETE ON version BEGIN SELECT RAISE(ABORT, 'versions are append-only'); END;
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
  put<B>(name: string, kind: Kind, body: B, ctx: ChangeContext, place: Placement = {}): { hash: string; changed: boolean } {
    const hash = hashOf(body)
    const cur = this.db.prepare('SELECT kind, hash, scope, owner FROM name WHERE name = ?').get(name) as { kind: string; hash: string; scope: string; owner: string | null } | undefined
    if (cur && cur.kind !== kind) throw new Error(`"${name}" is a ${cur.kind}, not a ${kind}`)
    const scope = place.scope ?? cur?.scope ?? 'global'
    const owner = place.owner !== undefined ? place.owner : (cur?.owner ?? null)
    if (!/^(global|group:[^\s:]+|user:[^\s:]+)$/.test(scope)) throw new Error(`"${scope}" is not a scope: global, group:<name> or user:<id>`)
    // Unchanged content, scope and owner records nothing; a new scope or owner alone is a change (same content).
    if (cur?.hash === hash && cur.scope === scope && cur.owner === owner) return { hash, changed: false }
    const now = Date.now()
    this.db.exec('SAVEPOINT cg_write')
    try {
      this.db.prepare('INSERT OR IGNORE INTO content (hash, body, at) VALUES (?, ?, ?)').run(hash, canonical(body), now)
      this.db.prepare('INSERT INTO name (name, kind, hash, scope, owner) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, scope = excluded.scope, owner = excluded.owner').run(name, kind, hash, scope, owner)
      this.db.prepare('INSERT INTO change (at, name, kind, from_hash, to_hash, by, reason, evidence, scope, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(now, name, kind, cur?.hash ?? null, hash, ctx.by, ctx.reason ?? null, ctx.from ?? null, scope, owner)
      this.db.exec('RELEASE cg_write')
    } catch (e) { this.db.exec('ROLLBACK TO cg_write'); this.db.exec('RELEASE cg_write'); throw e }
    return { hash, changed: true }
  }

  /** Take a name away. Its content stays, so history can still show what it was. */
  remove(name: string, ctx: ChangeContext): boolean {
    const cur = this.db.prepare('SELECT kind, hash FROM name WHERE name = ?').get(name) as { kind: string; hash: string } | undefined
    if (!cur) return false
    this.db.exec('SAVEPOINT cg_write')
    try {
      this.db.prepare('DELETE FROM name WHERE name = ?').run(name)
      this.db.prepare('INSERT INTO change (at, name, kind, from_hash, to_hash, by, reason, evidence, scope) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL)')
        .run(Date.now(), name, cur.kind, cur.hash, ctx.by, ctx.reason ?? null, ctx.from ?? null)
      this.db.exec('RELEASE cg_write')
    } catch (e) { this.db.exec('ROLLBACK TO cg_write'); this.db.exec('RELEASE cg_write'); throw e }
    return true
  }

  /** A node as it is now, as it was at a moment (ms since the epoch), or as it was after one change (`upto`: a change's id —
   *  exact even when several changes share a millisecond; what a named version reads by). */
  get<B = unknown>(name: string, asOf?: number, upto?: number): Node<B> | null {
    let row: { kind: string; hash: string | null; scope: string | null; owner: string | null } | undefined
    if (upto !== undefined) row = this.db.prepare('SELECT kind, to_hash AS hash, scope, NULL AS owner FROM change WHERE name = ? AND id <= ? ORDER BY id DESC LIMIT 1').get(name, upto) as any
    else if (asOf === undefined) row = this.db.prepare('SELECT kind, hash, scope, owner FROM name WHERE name = ?').get(name) as any
    else row = this.db.prepare('SELECT kind, to_hash AS hash, scope, NULL AS owner FROM change WHERE name = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1').get(name, asOf) as any
    if (!row?.hash) return null
    return { name, kind: row.kind as Kind, hash: row.hash, body: this.content<B>(row.hash), scope: row.scope ?? 'global', owner: row.owner ?? null }
  }

  /** Content by its hash. */
  content<B = unknown>(hash: string): B {
    const r = this.db.prepare('SELECT body FROM content WHERE hash = ?').get(hash) as { body: string } | undefined
    if (!r) throw new Error(`no content ${hash.slice(0, 12)}`)
    return JSON.parse(r.body) as B
  }

  /** The names there are now (or were at a moment), of one kind or all, and only those a viewer's scopes see. */
  names(kind?: Kind, opts: { asOf?: number; upto?: number; viewer?: Scope[] } = {}): { name: string; kind: Kind; hash: string; scope: Scope; owner: string | null }[] {
    const rows = (opts.upto !== undefined
      // After one change: each name's last change up to it, if that change did not remove it.
      ? this.db.prepare(`SELECT c.name, c.kind, c.to_hash AS hash, COALESCE(c.scope, 'global') AS scope, NULL AS owner FROM change c
          WHERE c.id = (SELECT MAX(c2.id) FROM change c2 WHERE c2.name = c.name AND c2.id <= ?) AND c.to_hash IS NOT NULL ORDER BY c.name`).all(opts.upto)
      : opts.asOf === undefined
      ? this.db.prepare('SELECT name, kind, hash, scope, owner FROM name ORDER BY name').all()
      // As it was: each name's last change at or before the moment, if that change did not remove it.
      : this.db.prepare(`SELECT c.name, c.kind, c.to_hash AS hash, COALESCE(c.scope, 'global') AS scope, NULL AS owner FROM change c
          WHERE c.id = (SELECT c2.id FROM change c2 WHERE c2.name = c.name AND c2.at <= ? ORDER BY c2.at DESC, c2.id DESC LIMIT 1) AND c.to_hash IS NOT NULL ORDER BY c.name`).all(opts.asOf)) as any[]
    return rows.filter((r) => (!kind || r.kind === kind) && (!opts.viewer || visibleTo(r.scope, opts.viewer)))
  }

  /** Every change to a name, oldest first. */
  history(name: string): Change[] {
    return (this.db.prepare('SELECT id, at, name, kind, from_hash, to_hash, by, reason, evidence, scope FROM change WHERE name = ? ORDER BY at, id').all(name) as any[])
      .map((r) => ({ id: r.id, at: r.at, name: r.name, kind: r.kind, fromHash: r.from_hash, toHash: r.to_hash, by: r.by, reason: r.reason, from: r.evidence, scope: r.scope ?? null }))
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

  /** The named versions, newest first — each with the moment it reads the graph at and how many changes it covers
   *  since the version before it. */
  versions(): Version[] {
    const rows = this.db.prepare('SELECT v.id, v.name, v.message, v.upto, v.at, v.by, COALESCE((SELECT at FROM change WHERE id = v.upto), v.at) AS as_of FROM version v ORDER BY v.id').all() as any[]
    let prev = 0
    const out = rows.map((r) => { const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM change WHERE id > ? AND id <= ?').get(prev, r.upto) as any).n); prev = r.upto
      return { id: r.id, name: r.name, message: r.message, upto: r.upto, at: r.at, by: r.by, asOf: r.as_of, changes: n } })
    return out.reverse()
  }
  version(name: string): Version | null { return this.versions().find((v) => v.name === name) ?? null }
  /** The last change there is (0: none). */
  lastChange(): number { return Number((this.db.prepare('SELECT MAX(id) AS v FROM change').get() as any)?.v ?? 0) }
  /** Changes after one change, up to another (or now), oldest first. */
  changesBetween(after: number, upto?: number): Change[] {
    return (this.db.prepare(`SELECT id, at, name, kind, from_hash, to_hash, by, reason, evidence, scope FROM change WHERE id > ?${upto === undefined ? '' : ' AND id <= ?'} ORDER BY id`).all(...(upto === undefined ? [after] : [after, upto])) as any[])
      .map((r) => ({ id: r.id, at: r.at, name: r.name, kind: r.kind, fromHash: r.from_hash, toHash: r.to_hash, by: r.by, reason: r.reason, from: r.evidence, scope: r.scope ?? null }))
  }

  /** The latest changes across the graph, newest first. */
  changes(limit = 50): Change[] {
    return (this.db.prepare('SELECT id, at, name, kind, from_hash, to_hash, by, reason, evidence, scope FROM change ORDER BY at DESC, id DESC LIMIT ?').all(limit) as any[])
      .map((r) => ({ id: r.id, at: r.at, name: r.name, kind: r.kind, fromHash: r.from_hash, toHash: r.to_hash, by: r.by, reason: r.reason, from: r.evidence, scope: r.scope ?? null }))
  }
}
