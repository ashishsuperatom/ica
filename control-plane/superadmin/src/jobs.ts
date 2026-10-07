// ── Long work, any kind — kept by the platform ────────────────────────────────────────────────────────────────────────
//
// A job is a piece of long work (an index build first; any other later): its kind, the lease it holds (only one job per
// lease runs at a time — a second start is told the one running), who holds it (an engine instance, a worker), who
// asked, and as it runs: its stage, what it is doing now, its counts, and a heartbeat. A job whose heartbeat stops
// (its engine went away) is stale: its lease is free again, and the work resumes from its checkpoints.
//
//   job:start { kind, lease, holder?, by? } → { job } (started) | { busy: job } (one is running on that lease)
//   job:beat  { id, stage?, doing?, counts? } → { job }            job:end { id, state: done|failed, detail? } → { job }
//   job:list  { kind?, active? } → { jobs }                         job:get { id } → { job }

type Storage = DurableObjectStorage

export interface Job {
  id: string; kind: string; lease: string; holder: string | null; by: string | null
  state: 'running' | 'done' | 'failed' | 'stale'
  stage: string | null; doing: string | null; counts: Record<string, unknown> | null; detail: string | null
  startedAt: string; beatAt: string; endedAt: string | null
}

/** How long a running job may go without a heartbeat before it is stale (its lease free again). */
export const STALE_AFTER_MS = 60_000

export class JobRefusal extends Error {}

export function projectJobs(storage: Storage, now: () => number = Date.now) {
  const sql = storage.sql
  const iso = () => new Date(now()).toISOString()
  const row = (r: any): Job => ({ id: r.id, kind: r.kind, lease: r.lease, holder: r.holder ?? null, by: r.by ?? null, state: r.state,
    stage: r.stage ?? null, doing: r.doing ?? null, counts: r.counts ? JSON.parse(r.counts) : null, detail: r.detail ?? null,
    startedAt: r.started_at, beatAt: r.beat_at, endedAt: r.ended_at ?? null })
  const get = (id: string): Job | null => { const [r] = [...sql.exec('SELECT * FROM jobs WHERE id = ?', id)]; return r ? row(r) : null }

  /** Running jobs whose heartbeat stopped become stale (their lease is free). */
  function expire() {
    const before = new Date(now() - STALE_AFTER_MS).toISOString()
    sql.exec("UPDATE jobs SET state = 'stale', ended_at = ?, detail = COALESCE(detail, 'its heartbeat stopped') WHERE state = 'running' AND beat_at < ?", iso(), before)
  }
  /** The job running on a lease now, if any. */
  function running(lease: string): Job | null {
    expire()
    const [r] = [...sql.exec("SELECT * FROM jobs WHERE lease = ? AND state = 'running' ORDER BY started_at DESC LIMIT 1", lease)]
    return r ? row(r) : null
  }
  return {
    get, running,
    start(o: { kind: string; lease: string; holder?: string | null; by?: string | null }): { job: Job } | { busy: Job } {
      if (!/^[a-z][\w.:-]{0,60}$/.test(o.kind) || !o.lease || o.lease.length > 200) throw new JobRefusal('a job needs a kind and a lease')
      const busy = running(o.lease)
      if (busy) return { busy }
      const id = `job_${crypto.randomUUID().slice(0, 12)}`, at = iso()
      sql.exec("INSERT INTO jobs (id, kind, lease, holder, by, state, started_at, beat_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)", id, o.kind, o.lease, o.holder ?? null, o.by ?? null, at, at)
      return { job: get(id)! }
    },
    beat(id: string, p: { stage?: unknown; doing?: unknown; counts?: unknown }): Job {
      const j = get(id)
      if (!j) throw new JobRefusal(`there is no job ${id}`)
      if (j.state !== 'running') throw new JobRefusal(`job ${id} is ${j.state}`)
      sql.exec('UPDATE jobs SET beat_at = ?, stage = COALESCE(?, stage), doing = COALESCE(?, doing), counts = COALESCE(?, counts) WHERE id = ?', iso(),
        typeof p.stage === 'string' ? p.stage.slice(0, 200) : null, typeof p.doing === 'string' ? p.doing.slice(0, 500) : null,
        p.counts && typeof p.counts === 'object' ? JSON.stringify(p.counts).slice(0, 4000) : null, id)
      return get(id)!
    },
    end(id: string, state: unknown, detail?: unknown): Job {
      const j = get(id)
      if (!j) throw new JobRefusal(`there is no job ${id}`)
      if (state !== 'done' && state !== 'failed') throw new JobRefusal('a job ends done or failed')
      if (j.state === 'running') sql.exec('UPDATE jobs SET state = ?, detail = ?, ended_at = ?, beat_at = ? WHERE id = ?', state, detail ? String(detail).slice(0, 2000) : null, iso(), iso(), id)
      return get(id)!
    },
    list(o: { kind?: string; active?: boolean } = {}): Job[] {
      expire()
      const where = [o.kind ? 'kind = ?' : '', o.active ? "state = 'running'" : ''].filter(Boolean)
      return [...sql.exec(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT 50`, ...(o.kind ? [o.kind] : []))].map(row)
    },
  }
}
