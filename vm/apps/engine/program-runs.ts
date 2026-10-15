// EACH PROGRAM AS A WORKLOAD (`program/<agent>:<file>`; the kind: platform-types workloads.ts): running now, or how its
// last run ended — a failed one reads degraded, with why — its runs and their time, and who the last was for. Stopped on
// request: its runs in progress are killed (the questions waiting on them are told they failed).

import type { ChildProcess } from 'node:child_process'

type Workloads = ReturnType<typeof import('./workloads.js').createWorkloads>

export const programId = (domain: string, file: string) => `${domain.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${file}`

export function createProgramRuns(workloads?: Workloads) {
  const running = new Map<string, Set<Pick<ChildProcess, 'kill'>>>()
  const counts = new Map<string, { runs: number; failed: number; lastMs: number; lastFor: string | null }>()
  const report = (id: string, error?: string) => {
    const c = counts.get(id), n = running.get(id)?.size ?? 0
    workloads?.set({ kind: 'program', id, state: n ? 'starting' : error ? 'degraded' : 'ready', error: !n && error ? { what: 'its last run failed', detail: error.slice(0, 500) } : null,
      health: { running: n, runs: c?.runs ?? 0, failed: c?.failed ?? 0, lastMs: c?.lastMs ?? 0, lastFor: c?.lastFor ?? null } })
  }
  workloads?.onAct('program', async (id, action) => {
    if (action !== 'stop') throw new Error(`a program has no action "${action}"`)
    const live = [...(running.get(id) ?? [])]
    for (const c of live) { try { c.kill('SIGTERM') } catch { /* gone */ } }
    return { note: live.length ? `${live.length} run${live.length === 1 ? '' : 's'} stopped` : 'nothing of it was running' }
  })
  return {
    /** A run of it began (its process, and who it is for); call the answer when it ends, with why if it failed. */
    began(id: string, child: Pick<ChildProcess, 'kill'> | undefined, forWhom: string | null): (error?: string) => void {
      const t0 = Date.now()
      const c = counts.get(id) ?? { runs: 0, failed: 0, lastMs: 0, lastFor: null }
      counts.set(id, { ...c, runs: c.runs + 1, lastFor: forWhom })
      if (child) (running.get(id) ?? running.set(id, new Set()).get(id)!).add(child)
      report(id)
      return (error?: string) => {
        if (child) running.get(id)?.delete(child)
        const now = counts.get(id)!
        counts.set(id, { ...now, lastMs: Date.now() - t0, failed: now.failed + (error ? 1 : 0) })
        report(id, error)
      }
    },
  }
}
