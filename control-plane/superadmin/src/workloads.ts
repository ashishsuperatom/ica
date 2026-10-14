// WORKLOADS, kept by the project (docs/connectors-plan.md step 2): each workload's state as its engine last reported it
// (`workload_status`, ProjectDO migration 48) and every change of it and action taken on it (`workload_events`, bounded).
// The kinds — what may be done and seen, by whom — are vm/packages/platform-types workloads.ts. What is WANTED stays where
// it is kept (a connection's row, the chosen release, the agent profile): the engine reports the spec it acted on, and a
// workload whose spec is not the wanted one is "changed, not yet taken".

import { checkWorkloadStatus, type WorkloadKind, type WorkloadStatus } from '../../../vm/packages/platform-types/src/index.js'

const KEEP_MS = 30 * 86_400_000
const KEEP_ROWS = 5_000

export interface WorkloadRow {
  kind: WorkloadKind; id: string; state: string; version: string | null; spec: string | null; restarts: number
  error: { what: string; detail?: string } | null; health: Record<string, unknown> | null; since: number; reportedAt: number
}
export interface WorkloadEvent { seq: number; kind: string; id: string; at: number; state: string | null; what: string; detail: string | null; by: string | null }

export function projectWorkloads(storage: DurableObjectStorage) {
  const sql = storage.sql
  const rowOf = (r: any): WorkloadRow => ({ kind: r.kind, id: r.id, state: r.state, version: r.version ?? null, spec: r.spec ?? null, restarts: Number(r.restarts ?? 0),
    error: r.error_what ? { what: r.error_what, ...(r.error_detail ? { detail: r.error_detail } : {}) } : null,
    health: r.health ? (() => { try { return JSON.parse(r.health) } catch { return null } })() : null, since: Number(r.since), reportedAt: Number(r.reported_at) })

  const event = (kind: string, id: string, what: string, o: { state?: string | null; detail?: string | null; by?: string | null; at?: number } = {}) => {
    sql.exec('INSERT INTO workload_events (kind, id, at, state, what, detail, by) VALUES (?, ?, ?, ?, ?, ?, ?)', kind, id, o.at ?? Date.now(), o.state ?? null, what.slice(0, 500), o.detail ? String(o.detail).slice(0, 4000) : null, o.by ?? null)
  }
  const prune = () => {
    sql.exec('DELETE FROM workload_events WHERE at < ?', Date.now() - KEEP_MS)
    sql.exec('DELETE FROM workload_events WHERE seq <= (SELECT seq FROM workload_events ORDER BY seq DESC LIMIT 1 OFFSET ?)', KEEP_ROWS)
  }

  return {
    /** What the engine reported. A status that is not sound is refused (and why returned); a change of state or error is an
     *  event. Returns the rows that changed state (for whoever is watching). */
    report(list: unknown[], now = Date.now()): { kept: WorkloadRow[]; refused: { status: unknown; problems: string[] }[] } {
      const kept: WorkloadRow[] = [], refused: { status: unknown; problems: string[] }[] = []
      storage.transactionSync(() => {
        for (const s of list) {
          const problems = checkWorkloadStatus(s)
          if (problems.length) { refused.push({ status: s, problems }); continue }
          const w = s as WorkloadStatus
          const [was] = [...sql.exec('SELECT * FROM workload_status WHERE kind = ? AND id = ?', w.kind, w.id)] as any[]
          const moved = !was || was.state !== w.state || (was.error_what ?? null) !== (w.error?.what ?? null) || (was.version ?? null) !== (w.version ?? null)
          const since = !was || was.state !== w.state ? now : Number(was.since)
          sql.exec(`INSERT INTO workload_status (kind, id, state, version, spec, restarts, error_what, error_detail, health, since, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (kind, id) DO UPDATE SET state = excluded.state, version = excluded.version, spec = excluded.spec, restarts = excluded.restarts,
            error_what = excluded.error_what, error_detail = excluded.error_detail, health = excluded.health, since = excluded.since, reported_at = excluded.reported_at`,
            w.kind, w.id, w.state, w.version ?? null, w.spec ?? null, w.restarts ?? 0, w.error?.what ?? null, w.error?.detail ?? null, w.health ? JSON.stringify(w.health) : null, since, now)
          if (moved) {
            event(w.kind, w.id, w.error?.what ? `${w.state}: ${w.error.what}` : !was ? `${w.state} (first report)` : was.state !== w.state ? `${was.state} → ${w.state}` : `now ${w.version ?? 'another version'}`,
              { state: w.state, detail: w.error?.detail ?? null, at: now })
            kept.push(rowOf([...sql.exec('SELECT * FROM workload_status WHERE kind = ? AND id = ?', w.kind, w.id)][0]))
          }
        }
        if (kept.length) prune()
      })
      return { kept, refused }
    },
    /** A workload the engine no longer runs (a connection removed): its row goes, its going is an event. */
    gone(kind: string, id: string, by?: string) {
      if (![...sql.exec('SELECT 1 FROM workload_status WHERE kind = ? AND id = ?', kind, id)].length) return
      sql.exec('DELETE FROM workload_status WHERE kind = ? AND id = ?', kind, id)
      event(kind, id, 'removed', { by: by ?? null })
    },
    event,
    list(): WorkloadRow[] { return ([...sql.exec('SELECT * FROM workload_status ORDER BY kind, id')] as any[]).map(rowOf) },
    one(kind: string, id: string): WorkloadRow | null { const [r] = [...sql.exec('SELECT * FROM workload_status WHERE kind = ? AND id = ?', kind, id)] as any[]; return r ? rowOf(r) : null },
    /** Events, newest first: of one workload, or of all (filtered by kind and since), paged by `before` (a seq). */
    events(o: { kind?: string; id?: string; since?: number; before?: number; limit?: number } = {}): WorkloadEvent[] {
      const where: string[] = [], args: unknown[] = []
      if (o.kind) { where.push('kind = ?'); args.push(o.kind) }
      if (o.id) { where.push('id = ?'); args.push(o.id) }
      if (o.since) { where.push('at >= ?'); args.push(o.since) }
      if (o.before) { where.push('seq < ?'); args.push(o.before) }
      const limit = Math.min(Math.max(Number(o.limit) || 50, 1), 200)
      return [...sql.exec(`SELECT * FROM workload_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ${limit}`, ...args)] as any[]
    },
  }
}
