// ── Answer store — every question + answer for a project, in one sqlite (engine-owned) ───────────────
// The ENGINE writes here, never the LLM. Two jobs:
//   1. Reuse: look up — deterministically — whether a question was already answered, so we can return
//      it instantly instead of re-running an agent (the "program" fast path, in its simplest form).
//   2. History: keep every session's questions + answers so nothing is lost and we can inspect later.
//
// Each question gets a fresh `qid`; the agent writes its transient deliverable to out/<qid>.json — a
// KNOWN, question-scoped path. Because a new qid never pre-exists, polling that file for completion is
// race-free (no stale read of a previous question's answer.json, and no need to delete anything).

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface AnswerRow {
  qid: string; sessionId: string; question: string; norm: string
  category: string; status: string; answer: any; createdAt: number
  programDir?: string   // the program that produced this answer (relative to the workspace) — re-run it on a repeat
  params?: any          // the bindings it was run with (identity bindings only; time defaults to now each run)
  finishedAt?: number   // when the analyst FINISHED (artifact written) — the cursor the offline modeler consolidates by
}

// Deterministic normalization for the "have we answered this before?" match — no LLM.
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').replace(/[?.!,;:]+$/g, '').trim()
}

const safeParse = (s: string) => { try { return JSON.parse(s) } catch { return null } }

export function openAnswers(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS answers (
      qid TEXT PRIMARY KEY, session_id TEXT, question TEXT, norm TEXT,
      category TEXT, status TEXT, answer_json TEXT, created_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_norm ON answers(norm);
    CREATE INDEX IF NOT EXISTS idx_session ON answers(session_id);
    -- one ICA session id per (project, agent role), so we resume it after a restart instead of cold-starting.
    -- prompt_version = hash of the agent's instruction files; on restart we resume ONLY if it's unchanged.
    CREATE TABLE IF NOT EXISTS agent_sessions (
      project_id TEXT, role TEXT, harness TEXT, session_id TEXT, prompt_version TEXT, updated_at INTEGER,
      PRIMARY KEY (project_id, role));`)
  try { db.exec(`ALTER TABLE agent_sessions ADD COLUMN prompt_version TEXT`) } catch { /* already there */ }
  try { db.exec(`ALTER TABLE answers ADD COLUMN program_dir TEXT`) } catch { /* already there */ }
  try { db.exec(`ALTER TABLE answers ADD COLUMN params_json TEXT`) } catch { /* already there */ }
  try { db.exec(`ALTER TABLE answers ADD COLUMN finished_at INTEGER`) } catch { /* already there */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_finished ON answers(finished_at);
    -- tiny KV for engine-owned cursors (e.g. the offline modeler's consolidation watermark).
    CREATE TABLE IF NOT EXISTS engine_meta (k TEXT PRIMARY KEY, v TEXT);
    -- PROGRAM RUN AUDIT (deterministic, written by the runner — no LLM). One row per program execution: the
    -- input at that moment, the output's shape/status, whether it was degenerate (empty), and how long it took.
    -- This is the history that lets us SEE how a program behaves as inputs/data change, and count its failures.
    CREATE TABLE IF NOT EXISTS program_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_dir TEXT NOT NULL, qid TEXT, question TEXT, params_json TEXT,
      status TEXT, empty INTEGER, shape_hash TEXT, ms INTEGER, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_program_runs_dir ON program_runs(program_dir, at);`)
  const insert = db.prepare(`INSERT OR REPLACE INTO answers
    (qid, session_id, question, norm, category, status, answer_json, created_at, program_dir, params_json, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const findStmt = db.prepare(`SELECT * FROM answers WHERE norm = ? AND status = 'answered' ORDER BY created_at DESC LIMIT 1`)
  // Consolidation cursor: analyses that FINISHED after the watermark, oldest-first — the offline modeler's inbox.
  const sinceStmt = db.prepare(`SELECT * FROM answers WHERE finished_at > ? ORDER BY finished_at ASC LIMIT ?`)
  // Programs already swept by consolidation (finished at or before the watermark) → their structure is already
  // studied, so a repeat that re-runs the SAME program needs no re-consolidation.
  const consolidatedProgsStmt = db.prepare(`SELECT DISTINCT program_dir FROM answers WHERE program_dir IS NOT NULL AND finished_at IS NOT NULL AND finished_at <= ?`)
  const metaGet = db.prepare(`SELECT v FROM engine_meta WHERE k = ?`)
  const metaSet = db.prepare(`INSERT OR REPLACE INTO engine_meta (k, v) VALUES (?, ?)`)
  const runIns = db.prepare(`INSERT INTO program_runs (program_dir, qid, question, params_json, status, empty, shape_hash, ms, at) VALUES (?,?,?,?,?,?,?,?,?)`)
  const runsStmt = db.prepare(`SELECT * FROM program_runs WHERE program_dir = ? ORDER BY at DESC LIMIT ?`)
  const runsAllStmt = db.prepare(`SELECT * FROM program_runs ORDER BY at DESC LIMIT ?`)
  const runStatsStmt = db.prepare(`SELECT program_dir, COUNT(*) AS runs, SUM(empty) AS empties, MAX(at) AS lastAt FROM program_runs GROUP BY program_dir ORDER BY lastAt DESC`)
  const getStmt = db.prepare(`SELECT * FROM answers WHERE qid = ?`)
  const sessStmt = db.prepare(`SELECT * FROM answers WHERE session_id = ? ORDER BY created_at ASC`)
  const agentGet = db.prepare(`SELECT harness, session_id, prompt_version FROM agent_sessions WHERE project_id = ? AND role = ?`)
  const agentSet = db.prepare(`INSERT OR REPLACE INTO agent_sessions (project_id, role, harness, session_id, prompt_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
  const agentDel = db.prepare(`DELETE FROM agent_sessions WHERE project_id = ? AND role = ?`)
  const row = (r: any): AnswerRow | null => r ? {
    qid: r.qid, sessionId: r.session_id, question: r.question, norm: r.norm,
    category: r.category, status: r.status, answer: safeParse(r.answer_json), createdAt: r.created_at,
    programDir: r.program_dir ?? undefined, params: r.params_json ? safeParse(r.params_json) : undefined,
    finishedAt: r.finished_at ?? undefined,
  } : null
  return {
    save(a: AnswerRow) {
      insert.run(a.qid, a.sessionId, a.question, a.norm, a.category, a.status, JSON.stringify(a.answer ?? null), a.createdAt,
        a.programDir ?? null, a.params != null ? JSON.stringify(a.params) : null, a.finishedAt ?? null)
    },
    // ── Offline-modeler rail ──────────────────────────────────────────────────
    // Analyses that finished after `after` (a finished_at watermark), oldest-first. The consolidation loop
    // reads this batch, studies it, then advances the watermark past the last one it consumed.
    sinceFinished(after: number, limit = 50): AnswerRow[] { return sinceStmt.all(after, limit).map(row).filter(Boolean) as AnswerRow[] },
    // Distinct program dirs already consolidated (finished_at <= watermark) — used to skip re-studying a repeat.
    consolidatedProgramDirs(uptoFinishedAt: number): string[] { return consolidatedProgsStmt.all(uptoFinishedAt).map((r: any) => r.program_dir) },
    getMeta(k: string): string | null { const r: any = metaGet.get(k); return r ? r.v : null },
    setMeta(k: string, v: string) { metaSet.run(k, v) },
    // ── Deterministic program-run audit (written by the runner, never an LLM) ────
    recordRun(r: { programDir: string; qid?: string; question?: string; params?: any; status?: string; empty?: boolean; shapeHash?: string; ms?: number }) {
      runIns.run(r.programDir, r.qid ?? null, r.question ?? null, r.params != null ? JSON.stringify(r.params) : null,
        r.status ?? null, r.empty ? 1 : 0, r.shapeHash ?? null, r.ms ?? null, Date.now())
    },
    programRuns(programDir: string | undefined, limit = 100): any[] {
      const rows = (programDir ? runsStmt.all(programDir, limit) : runsAllStmt.all(limit)) as any[]
      return rows.map(r => ({ id: r.id, programDir: r.program_dir, qid: r.qid ?? null, question: r.question ?? null,
        params: r.params_json ? safeParse(r.params_json) : null, status: r.status ?? null, empty: !!r.empty,
        shapeHash: r.shape_hash ?? null, ms: r.ms ?? null, at: r.at }))
    },
    programRunStats(): any[] { return (runStatsStmt.all() as any[]).map(r => ({ programDir: r.program_dir, runs: r.runs, empties: r.empties ?? 0, lastAt: r.lastAt })) },
    // Reuse the PROGRAM (not the answer): the latest run for this question that has a program to re-run.
    // We ALWAYS re-execute it (fresh query) — we never hand back a stale stored answer.
    findAnswered(norm: string): AnswerRow | null { return row(findStmt.get(norm)) },
    get(qid: string): AnswerRow | null { return row(getStmt.get(qid)) },
    bySession(sid: string): AnswerRow[] { return sessStmt.all(sid).map(row).filter(Boolean) as AnswerRow[] },
    // The ICA session to resume for (project, role): its id + the instruction hash it was created under.
    getAgentSession(projectId: string, role: string): { harness: string; sessionId: string; promptVersion: string } | null {
      const r: any = agentGet.get(projectId, role); return r ? { harness: r.harness, sessionId: r.session_id, promptVersion: r.prompt_version } : null
    },
    setAgentSession(projectId: string, role: string, harness: string, sessionId: string | undefined, promptVersion: string, now: number) {
      if (sessionId) agentSet.run(projectId, role, harness, sessionId, promptVersion, now)
    },
    clearAgentSession(projectId: string, role: string) { agentDel.run(projectId, role) },   // force a fresh session next time
    db,
  }
}
export type AnswerStore = ReturnType<typeof openAnswers>
