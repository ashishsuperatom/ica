// ── WHERE THE SEMANTIC GRAPH IS KEPT, AND WHAT IT REMEMBERS ──────────────────────────────────────────────────
//
// One SQLite file.
//
//   definition   what exists — a schema, the sources that say where its objects' rows are, a program that produces a
//                fact. Written once per content hash, never updated.
//   name         what a name points at, with every earlier pointing kept: what a model name meant on any day is answerable.
//   call         memory — every question asked: the question and its canonical form, the plan, the exact definitions
//                it ran on, each statement with its SQL, rows and time, the answer, caveats, the day, who asked,
//                assumptions and interventions, or the refusal or error.
//   call_node    the nodes of the graph an answer went through — facts, entities, arrows, measures. What a correction
//                to a node reaches is a lookup, not a search through text.
//   observation  every value of an answer grouped by a calendar level, as a series: one output, one group, period by
//                period, for one question apart from its span. series_summary keeps what memory let go of.
//   session      a person's data session: its steps form a tree, each a question and the call that answered it.
//
// Nothing is overwritten. A correction is a new definition and a moved name; past answers still name the definitions
// they ran on. How much of the past is kept is bounded, and what is let go of is counted, never silently dropped.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DefinitionKind = 'schema' | 'sources' | 'settings' | 'program'
export interface Definition { hash: string; kind: DefinitionKind; body: unknown; createdAt: number; createdBy: string }

export interface StatementRecord { fact: string; source: string; sql: string; params: Record<string, unknown>; rows: number; ms: number; capped: boolean }

export interface CallRecord {
  id: string
  parentId: string | null
  sessionId: string | null
  question: unknown
  canonical: string | null
  plan: unknown
  /** The exact definitions the answer ran on. */
  schema: string
  sources: string | null
  settings: string | null
  /** The programs that produced rows for this answer, by name, and the exact definition each name pointed at. */
  programs?: Record<string, string>
  /** What programs decided while producing rows: each choice, why, and — for a threshold — how near it was to going the other way. */
  decisions?: Array<{ program: string; label: string; took: boolean; reason: string; boundary?: { value: number; op: string; threshold: number; margin: number } }>
  output: unknown
  /** refused by a rule — the rule and why — or failed while running. */
  refusal: { rule: string; reason: string } | null
  error: string | null
  statements: StatementRecord[]
  caveats: string[]
  ms: number
  at: number
  today: string
  asOf: string | null
  who: Record<string, unknown> | null
  assumptions: Array<{ name: string; value: unknown; from: string; rule?: Record<string, unknown> }> | null
  interventions: unknown | null
  surprises?: Array<{ group: Array<string | null>; period: string; output: string; value: number | null; median: number; z: number }>
  /** The graph nodes the answer went through. */
  nodes: string[]
}

export interface Observation { callId: string; series: string; group: string; level: string; period: string; output: string; value: number | null; at: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS definition (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS name (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL REFERENCES definition(hash),
  valid_from INTEGER NOT NULL, valid_to INTEGER, changed_by TEXT NOT NULL, reason TEXT
);
CREATE INDEX IF NOT EXISTS name_current ON name(kind, name) WHERE valid_to IS NULL;
CREATE TABLE IF NOT EXISTS call (
  id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT, question TEXT NOT NULL, canonical TEXT, plan TEXT,
  schema_hash TEXT NOT NULL, sources_hash TEXT, settings_hash TEXT, output TEXT, refusal TEXT, error TEXT, statements TEXT NOT NULL,
  caveats TEXT NOT NULL, ms INTEGER NOT NULL, at INTEGER NOT NULL, today TEXT NOT NULL, as_of TEXT,
  who TEXT, assumptions TEXT, interventions TEXT, surprises TEXT, programs TEXT, decisions TEXT
);
CREATE INDEX IF NOT EXISTS call_at ON call(at);
CREATE INDEX IF NOT EXISTS call_canonical ON call(canonical);
CREATE TABLE IF NOT EXISTS call_node (call_id TEXT NOT NULL, node TEXT NOT NULL, PRIMARY KEY (node, call_id));
CREATE TABLE IF NOT EXISTS observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, series TEXT NOT NULL, grp TEXT NOT NULL, level TEXT NOT NULL,
  period TEXT NOT NULL, output TEXT NOT NULL, value REAL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS observation_series ON observation(series, grp, output, level, period);
CREATE INDEX IF NOT EXISTS observation_at ON observation(at);
CREATE TABLE IF NOT EXISTS series_summary (
  series TEXT NOT NULL, grp TEXT NOT NULL, output TEXT NOT NULL, level TEXT NOT NULL,
  n INTEGER NOT NULL, sum REAL NOT NULL, sumsq REAL NOT NULL, min REAL, max REAL, first_period TEXT, last_period TEXT,
  PRIMARY KEY (series, grp, output, level)
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, who TEXT, title TEXT, current_step INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_step (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, parent_step INTEGER, move TEXT NOT NULL, question TEXT NOT NULL,
  canonical TEXT, call_id TEXT, refusal TEXT, context TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_step_session ON session_step(session_id, id);
`

export interface Limits {
  /** Rows of an answer kept verbatim; the rest are counted. */
  keptRows: number
  /** Calls kept whole; older ones keep their question, plan and refusal, and let go of rows and SQL. */
  fullCalls: number
  /** Calls kept at all; past this the oldest not in a session are let go of. */
  calls: number
  /** Periods each series keeps whole; older ones fold into the series' summary. */
  periodsPerSeries: number
  /** Values memory keeps whole across every series. */
  observations: number
  /** Values one answer may add to memory; an answer with more keeps its largest whole series up to this. */
  observationsPerCall: number
  stepsPerSession: number
  sessions: number
}
export const LIMITS: Limits = {
  keptRows: 500, fullCalls: 20_000, calls: 200_000, periodsPerSeries: 120, observations: 1_000_000, observationsPerCall: 10_000,
  stepsPerSession: 1_000, sessions: 10_000,
}
const COMPACT_EVERY = 500

export class Store {
  readonly db: DatabaseSync
  readonly limits: Limits
  private written = 0

  constructor(path: string, limits: Partial<Limits> = {}) {
    this.limits = { ...LIMITS, ...limits }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    // Several processes share one memory (the engine and every tool the agent runs): a writer waits its turn.
    this.db.exec('PRAGMA busy_timeout = 15000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  private tx<T>(f: () => T): T {
    this.db.exec('BEGIN')
    try { const r = f(); this.db.exec('COMMIT'); return r } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  // ── definitions and names ──

  putDefinition(d: Definition): void {
    this.db.prepare('INSERT OR IGNORE INTO definition (hash, kind, body, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(d.hash, d.kind, JSON.stringify(d.body), d.createdAt, d.createdBy)
  }
  getDefinition(hash: string): Definition | null {
    const r: any = this.db.prepare('SELECT * FROM definition WHERE hash = ?').get(hash)
    return r ? { hash: r.hash, kind: r.kind, body: JSON.parse(r.body), createdAt: Number(r.created_at), createdBy: r.created_by } : null
  }
  resolve(kind: DefinitionKind, name: string): string | null {
    return (this.db.prepare('SELECT hash FROM name WHERE kind = ? AND name = ? AND valid_to IS NULL').get(kind, name) as any)?.hash ?? null
  }
  /** What a name pointed at at a moment. */
  resolveAt(kind: DefinitionKind, name: string, at: number): string | null {
    return (this.db.prepare('SELECT hash FROM name WHERE kind = ? AND name = ? AND valid_from <= ? AND (valid_to IS NULL OR ? < valid_to) ORDER BY valid_from DESC LIMIT 1')
      .get(kind, name, at, at) as any)?.hash ?? null
  }
  /** Point a name at a definition; the previous pointing is closed, never erased. */
  point(kind: DefinitionKind, name: string, hash: string, by: string, reason?: string): void {
    const now = Date.now()
    this.tx(() => {
      this.db.prepare('UPDATE name SET valid_to = ? WHERE kind = ? AND name = ? AND valid_to IS NULL').run(now, kind, name)
      this.db.prepare('INSERT INTO name (kind, name, hash, valid_from, valid_to, changed_by, reason) VALUES (?, ?, ?, ?, NULL, ?, ?)').run(kind, name, hash, now, by, reason ?? null)
    })
  }
  names(kind?: DefinitionKind): Array<{ kind: DefinitionKind; name: string; hash: string }> {
    return (this.db.prepare(`SELECT kind, name, hash FROM name WHERE valid_to IS NULL ${kind ? 'AND kind = ?' : ''} ORDER BY kind, name`).all(...(kind ? [kind] : [])) as any[])
      .map((r) => ({ kind: r.kind, name: r.name, hash: r.hash }))
  }
  history(kind: DefinitionKind, name: string): Array<{ hash: string; from: number; to: number | null; by: string; reason: string | null }> {
    return (this.db.prepare('SELECT * FROM name WHERE kind = ? AND name = ? ORDER BY id').all(kind, name) as any[])
      .map((r) => ({ hash: r.hash, from: Number(r.valid_from), to: r.valid_to == null ? null : Number(r.valid_to), by: r.changed_by, reason: r.reason }))
  }

  // ── memory ──

  recordCall(c: CallRecord): void {
    this.tx(() => {
      this.db.prepare(`INSERT INTO call (id, parent_id, session_id, question, canonical, plan, schema_hash, sources_hash, settings_hash, output, refusal, error, statements, caveats, ms, at, today, as_of, who, assumptions, interventions, surprises, programs, decisions)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(c.id, c.parentId, c.sessionId, JSON.stringify(c.question), c.canonical, c.plan ? JSON.stringify(c.plan) : null, c.schema, c.sources, c.settings,
             c.output == null ? null : JSON.stringify(this.keep(c.output)), c.refusal ? JSON.stringify(c.refusal) : null, c.error,
             JSON.stringify(c.statements), JSON.stringify(c.caveats), c.ms, c.at, c.today, c.asOf, json(c.who), json(c.assumptions), json(c.interventions),
             c.surprises?.length ? JSON.stringify(c.surprises) : null, c.programs && Object.keys(c.programs).length ? JSON.stringify(c.programs) : null, c.decisions?.length ? JSON.stringify(c.decisions) : null)
      const node = this.db.prepare('INSERT OR IGNORE INTO call_node (call_id, node) VALUES (?, ?)')
      for (const n of new Set(c.nodes)) node.run(c.id, n)
    })
    if (++this.written % COMPACT_EVERY === 0) this.compact()
  }

  /** Rows kept verbatim up to a limit, and the rest counted: a shortened answer that does not say so is a wrong answer. */
  private keep(output: unknown): unknown {
    const o = output as { rows?: unknown[] }
    if (o && Array.isArray(o.rows) && o.rows.length > this.limits.keptRows) return { ...o, rows: o.rows.slice(0, this.limits.keptRows), truncated: true, totalRows: o.rows.length }
    return output
  }

  getCall(id: string): CallRecord | null {
    const r: any = this.db.prepare('SELECT * FROM call WHERE id = ?').get(id)
    return r ? this.row(r) : null
  }
  recentCalls(q: { canonical?: string; failed?: boolean; limit?: number; offset?: number } = {}): { total: number; calls: CallRecord[] } {
    const where = [...(q.canonical ? ['canonical = ?'] : []), ...(q.failed ? ['(error IS NOT NULL OR refusal IS NOT NULL)'] : [])]
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const bind = q.canonical ? [q.canonical] : []
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM call ${sql}`).get(...bind) as any).n)
    return { total, calls: (this.db.prepare(`SELECT * FROM call ${sql} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...bind, q.limit ?? 100, q.offset ?? 0) as any[]).map((r) => this.row(r)) }
  }
  /** Answers in which a program decided on a threshold — for reviewing how near each decision was to going the other way. */
  decidingCalls(): CallRecord[] {
    return (this.db.prepare(`SELECT * FROM call WHERE decisions LIKE '%"boundary"%' ORDER BY at`).all() as any[]).map((r) => this.row(r))
  }
  /** The calls made while answering this one — triage, a counterfactual's other side. */
  children(id: string): CallRecord[] {
    return (this.db.prepare('SELECT * FROM call WHERE parent_id = ? ORDER BY at, rowid').all(id) as any[]).map((r) => this.row(r))
  }
  /** Every answer that went through a node of the graph — what a correction to it reaches. */
  callsThrough(node: string): CallRecord[] {
    return (this.db.prepare('SELECT c.* FROM call_node n JOIN call c ON c.id = n.call_id WHERE n.node = ? ORDER BY c.at').all(node) as any[]).map((r) => this.row(r))
  }
  /** Every answer that ran on one exact definition. */
  callsOn(hash: string): CallRecord[] {
    return (this.db.prepare('SELECT * FROM call WHERE schema_hash = ? OR sources_hash = ? ORDER BY at').all(hash, hash) as any[]).map((r) => this.row(r))
  }

  private row(r: any): CallRecord {
    const nodes = (this.db.prepare('SELECT node FROM call_node WHERE call_id = ? ORDER BY node').all(r.id) as any[]).map((x) => x.node)
    return {
      id: r.id, parentId: r.parent_id, sessionId: r.session_id, question: JSON.parse(r.question), canonical: r.canonical, plan: r.plan ? JSON.parse(r.plan) : null,
      schema: r.schema_hash, sources: r.sources_hash, settings: r.settings_hash, output: r.output == null ? null : JSON.parse(r.output), refusal: r.refusal ? JSON.parse(r.refusal) : null,
      error: r.error, statements: JSON.parse(r.statements), caveats: JSON.parse(r.caveats), ms: Number(r.ms), at: Number(r.at), today: r.today, asOf: r.as_of,
      who: r.who ? JSON.parse(r.who) : null, assumptions: r.assumptions ? JSON.parse(r.assumptions) : null, interventions: r.interventions ? JSON.parse(r.interventions) : null,
      surprises: r.surprises ? JSON.parse(r.surprises) : undefined, programs: r.programs ? JSON.parse(r.programs) : undefined, decisions: r.decisions ? JSON.parse(r.decisions) : undefined, nodes,
    }
  }

  // ── how much of the past is kept ──
  // The latest `fullCalls` calls are kept whole. Older ones keep their question, plan, definitions, refusal and caveats —
  // what replay, lineage and review need — and let go of their rows and SQL. Past `calls`, the oldest calls not part of a
  // session are let go of, with their nodes.
  compact(): { stripped: number; removed: number } {
    const count = () => Number((this.db.prepare('SELECT COUNT(*) AS n FROM call').get() as any).n)
    return this.tx(() => {
      let removed = 0
      const over = count() - this.limits.calls
      if (over > 0) {
        const doomed = (this.db.prepare(`SELECT id FROM call WHERE id NOT IN (SELECT call_id FROM session_step WHERE call_id IS NOT NULL) ORDER BY at, rowid LIMIT ?`).all(over) as any[]).map((r) => r.id)
        for (const id of doomed) { this.db.prepare('DELETE FROM call_node WHERE call_id = ?').run(id); this.db.prepare('DELETE FROM call WHERE id = ?').run(id) }
        removed = doomed.length
      }
      const total = count()
      const stripped = total > this.limits.fullCalls
        ? Number(this.db.prepare(`UPDATE call SET output = NULL, statements = '[]' WHERE id IN (SELECT id FROM call ORDER BY at, rowid LIMIT ?)
            AND (output IS NOT NULL OR statements <> '[]') AND id NOT IN (SELECT call_id FROM session_step WHERE call_id IS NOT NULL)`).run(total - this.limits.fullCalls).changes)
        : 0
      return { stripped, removed }
    })
  }

  // ── series ──

  /** Adds values to memory, bounded: a period answered again replaces what was held for it, each series keeps its latest
   *  periods, and memory as a whole a fixed number. Refuses (false) more than `observationsPerCall` at once. */
  recordObservations(rows: Observation[]): boolean {
    if (!rows.length) return true
    if (rows.length > this.limits.observationsPerCall) return false
    const replace = this.db.prepare('DELETE FROM observation WHERE series = ? AND grp = ? AND output = ? AND level = ? AND period = ?')
    const insert = this.db.prepare('INSERT INTO observation (call_id, series, grp, level, period, output, value, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const beyond = this.db.prepare(`SELECT id, series, grp, output, level, period, value FROM observation WHERE series = ? AND grp = ? AND output = ? AND level = ?
                                    ORDER BY period DESC LIMIT -1 OFFSET ${this.limits.periodsPerSeries}`)
    this.tx(() => {
      const touched = new Map<string, Observation>()
      for (const r of rows) {
        replace.run(r.series, r.group, r.output, r.level, r.period)
        insert.run(r.callId, r.series, r.group, r.level, r.period, r.output, r.value, r.at)
        touched.set(JSON.stringify([r.series, r.group, r.output, r.level]), r)
      }
      for (const r of touched.values()) this.fold(beyond.all(r.series, r.group, r.output, r.level) as any[])
      const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM observation').get() as any).n)
      if (total > this.limits.observations) this.fold(this.db.prepare('SELECT id, series, grp, output, level, period, value FROM observation ORDER BY at, period LIMIT ?').all(total - this.limits.observations) as any[])
    })
    return true
  }
  private fold(rows: Array<{ id: number; series: string; grp: string; output: string; level: string; period: string; value: number | null }>): void {
    const add = this.db.prepare(`INSERT INTO series_summary (series, grp, output, level, n, sum, sumsq, min, max, first_period, last_period) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (series, grp, output, level) DO UPDATE SET n = n + 1, sum = sum + excluded.sum, sumsq = sumsq + excluded.sumsq,
        min = MIN(COALESCE(min, excluded.min), excluded.min), max = MAX(COALESCE(max, excluded.max), excluded.max),
        first_period = MIN(first_period, excluded.first_period), last_period = MAX(last_period, excluded.last_period)`)
    const drop = this.db.prepare('DELETE FROM observation WHERE id = ?')
    for (const r of rows) {
      if (r.value != null) add.run(r.series, r.grp, r.output, r.level, r.value, r.value * r.value, r.value, r.value, r.period, r.period)
      drop.run(r.id)
    }
  }
  series(q: { series: string; group: string; output: string; level: string; before?: string }): Array<{ period: string; value: number | null; at: number }> {
    return (this.db.prepare(`SELECT period, value, at FROM observation WHERE series = ? AND grp = ? AND output = ? AND level = ? ${q.before ? 'AND period < ?' : ''} ORDER BY period`)
      .all(...[q.series, q.group, q.output, q.level, ...(q.before ? [q.before] : [])]) as any[]).map((r) => ({ period: r.period, value: r.value == null ? null : Number(r.value), at: Number(r.at) }))
  }
  summary(q: { series: string; group: string; output: string; level: string }) {
    const r: any = this.db.prepare('SELECT * FROM series_summary WHERE series = ? AND grp = ? AND output = ? AND level = ?').get(q.series, q.group, q.output, q.level)
    if (!r) return null
    const n = Number(r.n), mean = Number(r.sum) / n
    return { n, mean, sd: Math.sqrt(Math.max(0, Number(r.sumsq) / n - mean * mean)), min: r.min, max: r.max, from: r.first_period, to: r.last_period }
  }

  // ── data sessions ──

  openSession(id: string, who: Record<string, unknown> | null, title: string | null): void {
    const now = Date.now()
    this.db.prepare('INSERT INTO session (id, who, title, current_step, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)').run(id, json(who), title, now, now)
    const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM session').get() as any).n)
    if (total > this.limits.sessions) {
      for (const s of this.db.prepare('SELECT id FROM session ORDER BY updated_at LIMIT ?').all(total - this.limits.sessions) as any[]) {
        this.db.prepare('DELETE FROM session_step WHERE session_id = ?').run(s.id); this.db.prepare('DELETE FROM session WHERE id = ?').run(s.id)
      }
    }
  }
  getSession(id: string): { id: string; who: Record<string, unknown> | null; title: string | null; currentStep: number | null } | null {
    const r: any = this.db.prepare('SELECT * FROM session WHERE id = ?').get(id)
    return r ? { id: r.id, who: r.who ? JSON.parse(r.who) : null, title: r.title, currentStep: r.current_step == null ? null : Number(r.current_step) } : null
  }
  addStep(s: { sessionId: string; parent: number | null; move: unknown; question: unknown; canonical: string | null; callId: string | null; refusal: unknown | null; context?: unknown }, moveCurrent: boolean): number {
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM session_step WHERE session_id = ?').get(s.sessionId) as any).n)
    if (n >= this.limits.stepsPerSession) throw new Error(`this session has ${this.limits.stepsPerSession} steps, the most one holds — start a new session`)
    const now = Date.now()
    const id = Number(this.db.prepare('INSERT INTO session_step (session_id, parent_step, move, question, canonical, call_id, refusal, context, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.sessionId, s.parent, JSON.stringify(s.move), JSON.stringify(s.question), s.canonical, s.callId, json(s.refusal), json(s.context), now).lastInsertRowid)
    this.db.prepare(`UPDATE session SET updated_at = ?${moveCurrent ? ', current_step = ?' : ''} WHERE id = ?`).run(...(moveCurrent ? [now, id, s.sessionId] : [now, s.sessionId]))
    return id
  }
  moveCurrent(sessionId: string, step: number): void {
    this.db.prepare('UPDATE session SET current_step = ?, updated_at = ? WHERE id = ?').run(step, Date.now(), sessionId)
  }
  steps(sessionId: string): Array<{ id: number; parent: number | null; move: any; question: any; canonical: string | null; callId: string | null; refusal: any; context: any; at: number }> {
    return (this.db.prepare('SELECT * FROM session_step WHERE session_id = ? ORDER BY id').all(sessionId) as any[]).map((r) => ({
      id: Number(r.id), parent: r.parent_step == null ? null : Number(r.parent_step), move: JSON.parse(r.move), question: JSON.parse(r.question),
      canonical: r.canonical, callId: r.call_id, refusal: r.refusal ? JSON.parse(r.refusal) : null, context: r.context ? JSON.parse(r.context) : null, at: Number(r.at) }))
  }
  listSessions(limit = 200) {
    return (this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM session_step t WHERE t.session_id = s.id) AS steps FROM session s ORDER BY s.updated_at DESC LIMIT ?`).all(limit) as any[])
      .map((r) => ({ id: r.id, who: r.who ? JSON.parse(r.who) : null, title: r.title, currentStep: r.current_step == null ? null : Number(r.current_step), steps: Number(r.steps), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }))
  }

  counts() {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as any).n)
    return {
      definitions: n('SELECT COUNT(*) AS n FROM definition'), names: n('SELECT COUNT(*) AS n FROM name WHERE valid_to IS NULL'),
      calls: n('SELECT COUNT(*) AS n FROM call'), refused: n('SELECT COUNT(*) AS n FROM call WHERE refusal IS NOT NULL'), failed: n('SELECT COUNT(*) AS n FROM call WHERE error IS NOT NULL'),
      observations: n('SELECT COUNT(*) AS n FROM observation'), sessions: n('SELECT COUNT(*) AS n FROM session'), steps: n('SELECT COUNT(*) AS n FROM session_step'),
    }
  }

  close(): void { this.db.close() }
}

const json = (v: unknown) => (v == null ? null : JSON.stringify(v))
