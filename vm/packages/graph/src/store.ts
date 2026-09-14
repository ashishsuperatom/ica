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

/** The number a decision turned on, and where it would have gone the other way. */
export interface Boundary { value: number; op: '<' | '<=' | '>' | '>='; threshold: number; margin: number }

export interface Observation { name: string; hash: string; callId: string; series: string; member: string; grain: string; period: string; measure: string; value: number | null; at: number }

export interface CallRecord {
  id: string
  parentId: string | null
  name: string
  hash: string
  request: unknown
  output: unknown
  error: string | null
  decisions: Array<{ label: string; took: boolean; reason: string; boundary?: Boundary }>
  verifications: Array<{ label: string; held: boolean; detail?: string }>
  caveats: string[]
  /** Every statement run against a source, so an answer can show the SQL that produced it. */
  queries: Array<{ source: string; sql: string; params: Record<string, unknown>; rows: number; ms: number; capped: boolean }>
  ms: number
  at: number
  /** The date the call took as today. Anything that reads the clock reads this, so a replay can use the same day. */
  today: string
  /** Every assumption this call read, its value, and where the value came from. */
  assumptions: Array<{ name: string; value: unknown; from: 'caller' | 'asker' | 'organisation' | 'default'; about?: Record<string, unknown>; rule?: Record<string, unknown> }>
  /** Who asked, as the request said. */
  who: Record<string, unknown> | null
  /** The interventions in force for this call — on every call they reached. An answer with any is hypothetical, not a fact. */
  interventions: Record<string, unknown> | null
  /** The assumptions the caller passed down, on its outermost call, so a replay can pass the same. */
  context: Record<string, unknown> | null
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
  at            INTEGER NOT NULL,
  today         TEXT
);
CREATE INDEX IF NOT EXISTS call_parent ON call(parent_id);
-- A series in memory: one measure of one member, period by period, from every answer that had a time grain.
CREATE TABLE IF NOT EXISTS observation (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  hash      TEXT NOT NULL,
  call_id   TEXT NOT NULL,
  series    TEXT NOT NULL,                              -- the question apart from time: filters, splits, assumptions
  member    TEXT NOT NULL,                              -- the row's dimension values, apart from the period
  grain     TEXT NOT NULL,
  period    TEXT NOT NULL,
  measure   TEXT NOT NULL,
  value     REAL,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS observation_series ON observation(name, series, member, measure, grain, period);
CREATE INDEX IF NOT EXISTS observation_at ON observation(at);
-- What memory let go of: the periods dropped from a series, kept as their distribution — count, sum, sum of squares,
-- least and greatest, and the periods they span. Recent periods stay whole; the far past stays as its shape.
CREATE TABLE IF NOT EXISTS series_summary (
  name TEXT NOT NULL, series TEXT NOT NULL, member TEXT NOT NULL, measure TEXT NOT NULL, grain TEXT NOT NULL,
  n INTEGER NOT NULL, sum REAL NOT NULL, sumsq REAL NOT NULL, min REAL, max REAL, first_period TEXT, last_period TEXT,
  PRIMARY KEY (name, series, member, measure, grain)
);
CREATE INDEX IF NOT EXISTS call_hash   ON call(hash);
`

/** How much of an output memory keeps verbatim. The rest is counted, never silently dropped. */
const KEPT_ROWS = 500
/** Values one answer may add to the series in memory. An answer with more — every employee by every day — is not
 *  remembered as series at all: a partial series would teach an expectation from whichever rows happened to fit. */
export const MAX_OBSERVATIONS_PER_CALL = 10_000
/** Periods each series keeps whole. Older ones are folded into the series' summary as newer arrive. */
export const MAX_PERIODS_PER_SERIES = 120
/** Values memory keeps whole across every series. Past this, the oldest are folded into their summaries. */
export const MAX_OBSERVATIONS = 1_000_000

export class GraphStore {
  readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    const columns = (this.db.prepare('PRAGMA table_info(call)').all() as any[]).map((c) => c.name)
    for (const c of ['today', 'assumptions', 'interventions', 'context', 'who']) {
      if (!columns.includes(c)) this.db.exec(`ALTER TABLE call ADD COLUMN ${c} TEXT`)
    }
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

  /** Every name and the program it points at now. */
  current(): Array<{ name: string; hash: string }> {
    return (this.db.prepare('SELECT name, hash FROM name WHERE valid_to IS NULL ORDER BY name').all() as any[]).map((r) => ({ name: r.name, hash: r.hash }))
  }

  history(name: string): Array<{ hash: string; from: number; to: number | null; by: string; reason: string | null }> {
    return (this.db.prepare('SELECT * FROM name WHERE name = ? ORDER BY valid_from').all(name) as any[])
      .map((r) => ({ hash: r.hash, from: r.valid_from, to: r.valid_to, by: r.changed_by, reason: r.reason }))
  }

  // ── memory ────────────────────────────────────────────────────────────────────────────────────────────

  recordCall(c: CallRecord): void {
    this.db.prepare(`INSERT INTO call (id, parent_id, name, hash, request, output, error, decisions, verifications, caveats, queries, ms, at, today, assumptions, interventions, context, who)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.id, c.parentId, c.name, c.hash, JSON.stringify(c.request), JSON.stringify(keep(c.output)),
           c.error, JSON.stringify(c.decisions), JSON.stringify(c.verifications), JSON.stringify(c.caveats),
           JSON.stringify(c.queries), c.ms, c.at, c.today, JSON.stringify(c.assumptions ?? []),
           c.interventions ? JSON.stringify(c.interventions) : null, c.context ? JSON.stringify(c.context) : null, c.who ? JSON.stringify(c.who) : null)
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

  /** Adds an answer's values to memory, bounded: a period answered again replaces what was held for it, and each
   *  series keeps only its latest MAX_PERIODS_PER_SERIES periods. Returns false, recording nothing, when there are
   *  more than MAX_OBSERVATIONS_PER_CALL values. */
  recordObservations(rows: Observation[]): boolean {
    if (!rows.length) return true
    if (rows.length > MAX_OBSERVATIONS_PER_CALL) return false
    const replace = this.db.prepare(`DELETE FROM observation WHERE name = ? AND series = ? AND member = ? AND measure = ? AND grain = ? AND period = ?`)
    const insert = this.db.prepare(`INSERT INTO observation (name, hash, call_id, series, member, grain, period, measure, value, at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const beyond = this.db.prepare(`SELECT id, name, series, member, measure, grain, period, value FROM observation
                                     WHERE name = ? AND series = ? AND member = ? AND measure = ? AND grain = ? ORDER BY period DESC LIMIT -1 OFFSET ${MAX_PERIODS_PER_SERIES}`)
    this.db.exec('BEGIN')
    try {
      const touched = new Map<string, Observation>()
      for (const r of rows) {
        replace.run(r.name, r.series, r.member, r.measure, r.grain, r.period)
        insert.run(r.name, r.hash, r.callId, r.series, r.member, r.grain, r.period, r.measure, r.value, r.at)
        touched.set(JSON.stringify([r.name, r.series, r.member, r.measure, r.grain]), r)
      }
      for (const r of touched.values()) this.fold(beyond.all(r.name, r.series, r.member, r.measure, r.grain) as any[])
      const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM observation').get() as any).n)
      if (total > MAX_OBSERVATIONS) {
        this.fold(this.db.prepare('SELECT id, name, series, member, measure, grain, period, value FROM observation ORDER BY at, period LIMIT ?').all(total - MAX_OBSERVATIONS) as any[])
      }
      this.db.exec('COMMIT')
      return true
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  /** Let go of observations, keeping them in their series' summary distribution. Runs inside the caller's transaction. */
  private fold(rows: Array<{ id: number; name: string; series: string; member: string; measure: string; grain: string; period: string; value: number | null }>): void {
    if (!rows.length) return
    const add = this.db.prepare(`INSERT INTO series_summary (name, series, member, measure, grain, n, sum, sumsq, min, max, first_period, last_period)
                                 VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
                                 ON CONFLICT (name, series, member, measure, grain) DO UPDATE SET
                                   n = n + 1, sum = sum + excluded.sum, sumsq = sumsq + excluded.sumsq,
                                   min = MIN(COALESCE(min, excluded.min), excluded.min), max = MAX(COALESCE(max, excluded.max), excluded.max),
                                   first_period = MIN(first_period, excluded.first_period), last_period = MAX(last_period, excluded.last_period)`)
    const drop = this.db.prepare('DELETE FROM observation WHERE id = ?')
    for (const r of rows) {
      if (r.value != null) add.run(r.name, r.series, r.member, r.measure, r.grain, r.value, r.value * r.value, r.value, r.value, r.period, r.period)
      drop.run(r.id)
    }
  }

  /** The distribution of a series' periods that memory let go of, if any. */
  summary(q: { name: string; series: string; member: string; measure: string; grain: string }) {
    const r: any = this.db.prepare('SELECT * FROM series_summary WHERE name = ? AND series = ? AND member = ? AND measure = ? AND grain = ?')
      .get(q.name, q.series, q.member, q.measure, q.grain)
    if (!r) return null
    const n = Number(r.n), mean = Number(r.sum) / n
    return { n, mean, sd: Math.sqrt(Math.max(0, Number(r.sumsq) / n - mean * mean)), min: r.min, max: r.max, from: r.first_period, to: r.last_period }
  }

  /** One series, a value per period — a period answered again, after a correction, has replaced what memory held. */
  series(q: { name: string; series: string; member: string; measure: string; grain: string; before?: string }): Array<{ period: string; value: number | null; at: number }> {
    return (this.db.prepare(`SELECT o.period, o.value, o.at FROM observation o
        WHERE o.name = ? AND o.series = ? AND o.member = ? AND o.measure = ? AND o.grain = ? ${q.before ? 'AND o.period < ?' : ''}
        ORDER BY o.period`)
      .all(...[q.name, q.series, q.member, q.measure, q.grain, ...(q.before ? [q.before] : [])]) as any[])
      .map((r) => ({ period: r.period, value: r.value == null ? null : Number(r.value), at: Number(r.at) }))
  }

  /** Outermost calls that made a decision on a boundary. */
  decidingCalls(): CallRecord[] {
    return (this.db.prepare(`SELECT * FROM call WHERE parent_id IS NULL AND error IS NULL AND decisions LIKE '%"boundary"%' ORDER BY at`).all() as any[]).map(row)
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
    queries: JSON.parse(r.queries), ms: r.ms, at: r.at, today: r.today,
    assumptions: r.assumptions ? JSON.parse(r.assumptions) : [], interventions: r.interventions ? JSON.parse(r.interventions) : null,
    context: r.context ? JSON.parse(r.context) : null, who: r.who ? JSON.parse(r.who) : null,
  }
}
