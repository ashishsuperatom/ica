// ── WHICH HARNESS SESSION EACH AGENT RESUMES ───────────────────────────────────────────────────────────────
// One harness session per (project, agent), kept so a restart resumes it rather than starting cold. The instruction
// hash it was created under travels with it: a session made under different instructions is not resumed.
//
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrateFile } from '@superatom/migrate/node'
import type { Migration } from '@superatom/migrate'

/** Migrations (@superatom/migrate): numbered, never edited once shipped — a change is a new one. */
export const MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: `CREATE TABLE IF NOT EXISTS agent_sessions (
    project_id TEXT, role TEXT, harness TEXT, session_id TEXT, prompt_version TEXT, updated_at INTEGER,
    PRIMARY KEY (project_id, role))` },
]

export function openAgentSessions(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  migrateFile(db, path, MIGRATIONS, 'agent-sessions.sqlite')
  const get = db.prepare('SELECT harness, session_id, prompt_version FROM agent_sessions WHERE project_id = ? AND role = ?')
  const set = db.prepare('INSERT OR REPLACE INTO agent_sessions (project_id, role, harness, session_id, prompt_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  const del = db.prepare('DELETE FROM agent_sessions WHERE project_id = ? AND role = ?')
  return {
    get(projectId: string, role: string): { harness: string; sessionId: string; promptVersion: string } | null {
      const r: any = get.get(projectId, role)
      return r ? { harness: r.harness, sessionId: r.session_id, promptVersion: r.prompt_version } : null
    },
    set(projectId: string, role: string, harness: string, sessionId: string | undefined, promptVersion: string, now: number) {
      if (sessionId) set.run(projectId, role, harness, sessionId, promptVersion, now)
    },
    clear(projectId: string, role: string) { del.run(projectId, role) },
    db,
  }
}
export type AgentSessions = ReturnType<typeof openAgentSessions>
