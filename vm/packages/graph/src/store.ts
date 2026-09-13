// ── WHERE THE GRAPH IS KEPT ───────────────────────────────────────────────────────────────────────────────
//
// Three tables, one per idea.
//
//   program   what exists — immutable, written once per hash, never updated
//   name      what a name points at — every pointing kept, so what a name meant at any moment is answerable
//   call      memory — each run: what was asked, which exact program answered, what came out
//
// Nothing here is ever deleted or overwritten. A correction is a new program and a moved name; the record of
// the old pointing and every call that went through it stays, which is what lets a past answer name the exact
// program that produced it.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Contract } from './contract.js'

export interface StoredProgram { hash: string; contract: Contract; body: string; createdAt: number; createdBy: string }

export interface CallRecord {
  id: string
  parentId: string | null
  name: string
  hash: string
  request: unknown
  output: unknown
  error: string | null
  decisions: Array<{ label: string; took: boolean; reason: string }>
  verifications: Array<{ label: string; held: boolean; detail?: string }>
  caveats: string[]
  /** Every statement run against a source, so an answer can show the SQL that produced it. */
  queries: Array<{ source: string; sql: string; params: Record<string, unknown>; rows: number; ms: number; capped: boolean }>
  ms: number
  at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS program (
  hash        TEXT PRIMARY KEY,
  contract    TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS name (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  hash        TEXT NOT NULL REFERENCES program(hash),
  valid_from  INTEGER NOT NULL,
  valid_to    INTEGER,                                  -- NULL while this is what the name points at
  changed_by  TEXT NOT NULL,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS name_current ON name(name) WHERE valid_to IS NULL;
CREATE TABLE IF NOT EXISTS call (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT,
  name          TEXT NOT NULL,
  hash          TEXT NOT NULL,
  request       TEXT NOT NULL,
  output        TEXT,
  error         TEXT,
  decisions     TEXT NOT NULL,
  verifications TEXT NOT NULL,
  caveats       TEXT NOT NULL,
  queries       TEXT NOT NULL,
  ms            INTEGER NOT NULL,
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_parent ON call(parent_id);
CREATE INDEX IF NOT EXISTS call_hash   ON call(hash);
`

/** How much of an output memory keeps verbatim. The rest is counted, never silently dropped. */
const KEPT_ROWS = 500

export class GraphStore {
  readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  // ── programs ──────────────────────────────────────────────────────────────────────────────────────────

  /** Written once per hash. The same program stored twice is the same row. */
  putProgram(p: StoredProgram): void {
    this.db.prepare(`INSERT OR IGNORE INTO program (hash, contract, body, created_at, created_by)
                     VALUES (?, ?, ?, ?, ?)`)
      .run(p.hash, JSON.stringify(p.contract), p.body, p.createdAt, p.createdBy)
  }

  getProgram(hash: string): StoredProgram | null {
    const r: any = this.db.prepare('SELECT * FROM program WHERE hash = ?').get(hash)
    return r ? { hash: r.hash, contract: JSON.parse(r.contract), body: r.body, createdAt: r.created_at, createdBy: r.created_by } : null
  }

  // ── names ─────────────────────────────────────────────────────────────────────────────────────────────

  resolve(name: string): string | null {
    const r: any = this.db.prepare('SELECT hash FROM name WHERE name = ? AND valid_to IS NULL').get(name)
    return r?.hash ?? null
  }

  /** Point a name at a program. The previous pointing is closed, never erased. */
  point(name: string, hash: string, changedBy: string, reason?: string): void {
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      this.db.prepare('UPDATE name SET valid_to = ? WHERE name = ? AND valid_to IS NULL').run(now, name)
      this.db.prepare('INSERT INTO name (name, hash, valid_from, valid_to, changed_by, reason) VALUES (?, ?, ?, NULL, ?, ?)')
        .run(name, hash, now, changedBy, reason ?? null)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  history(name: string): Array<{ hash: string; from: number; to: number | null; by: string; reason: string | null }> {
    return (this.db.prepare('SELECT * FROM name WHERE name = ? ORDER BY valid_from').all(name) as any[])
      .map((r) => ({ hash: r.hash, from: r.valid_from, to: r.valid_to, by: r.changed_by, reason: r.reason }))
  }

  // ── memory ────────────────────────────────────────────────────────────────────────────────────────────

  recordCall(c: CallRecord): void {
    this.db.prepare(`INSERT INTO call (id, parent_id, name, hash, request, output, error, decisions, verifications, caveats, queries, ms, at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.id, c.parentId, c.name, c.hash, JSON.stringify(c.request), JSON.stringify(keep(c.output)),
           c.error, JSON.stringify(c.decisions), JSON.stringify(c.verifications), JSON.stringify(c.caveats),
           JSON.stringify(c.queries), c.ms, c.at)
  }

  getCall(id: string): CallRecord | null {
    const r: any = this.db.prepare('SELECT * FROM call WHERE id = ?').get(id)
    return r ? row(r) : null
  }

  children(id: string): CallRecord[] {
    return (this.db.prepare('SELECT * FROM call WHERE parent_id = ? ORDER BY at').all(id) as any[]).map(row)
  }

  /** Every call that went through one exact program — what a correction to it would have affected. */
  callsThrough(hash: string): CallRecord[] {
    return (this.db.prepare('SELECT * FROM call WHERE hash = ? ORDER BY at').all(hash) as any[]).map(row)
  }

  /** The answer a call was part of: its outermost caller. */
  root(id: string): CallRecord | null {
    let c = this.getCall(id)
    while (c?.parentId) c = this.getCall(c.parentId)
    return c
  }

  /** Every answer that went through one exact program, however deep — what a correction to it changes. */
  answersThrough(hash: string): CallRecord[] {
    const roots = new Map<string, CallRecord>()
    for (const c of this.callsThrough(hash)) { const r = this.root(c.id); if (r) roots.set(r.id, r) }
    return [...roots.values()].sort((a, b) => a.at - b.at)
  }

  close(): void { this.db.close() }
}

/** Outputs kept verbatim up to a limit, and the rest COUNTED — a shortened list that does not say so is a
 *  wrong answer about what the program returned. */
function keep(output: unknown): unknown {
  if (output && typeof output === 'object' && Array.isArray((output as any).rows) && (output as any).rows.length > KEPT_ROWS) {
    const o = output as any
    return { ...o, rows: o.rows.slice(0, KEPT_ROWS), truncated: true, totalRows: o.rows.length }
  }
  if (Array.isArray(output) && output.length > KEPT_ROWS) {
    return { rows: output.slice(0, KEPT_ROWS), truncated: true, totalRows: output.length }
  }
  return output
}

function row(r: any): CallRecord {
  return {
    id: r.id, parentId: r.parent_id, name: r.name, hash: r.hash,
    request: JSON.parse(r.request), output: r.output == null ? null : JSON.parse(r.output), error: r.error,
    decisions: JSON.parse(r.decisions), verifications: JSON.parse(r.verifications), caveats: JSON.parse(r.caveats),
    queries: JSON.parse(r.queries), ms: r.ms, at: r.at,
  }
}
