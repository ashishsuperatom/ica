// WORKLOADS, as this engine runs them (docs/connectors-plan.md step 2; the kinds: platform-types workloads.ts). Whatever
// runs here — the engine itself, each connection, each agent and the agent runner — says how it stands through `set`;
// what changed goes up to the project (`workload:status`) at most every 200ms, and everything again on each welcome. What
// the platform asks of one — an action, a look into an aspect — goes to the handler its kind registered, and the answer
// back with the request's id.

import type { WorkloadKind, WorkloadStatus } from '@superatom/platform-types'

type Act = (id: string, action: string, by: string | null) => Promise<{ note?: string }>
type Inspect = (id: string, aspect: string, page: number) => Promise<{ data: unknown; next?: number | null }>

export function createWorkloads(o: { send: (msg: Record<string, unknown>) => boolean; log?: (s: string) => void }) {
  const now = new Map<string, WorkloadStatus>()
  const dirty = new Set<string>()
  const gone: { kind: WorkloadKind; id: string }[] = []
  const acts = new Map<WorkloadKind, Act>(), looks = new Map<WorkloadKind, Inspect>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const key = (kind: string, id: string) => `${kind}/${id}`

  const flush = () => {
    timer = undefined
    const statuses = [...dirty].map((k) => now.get(k)).filter(Boolean) as WorkloadStatus[]
    const left = gone.splice(0)
    dirty.clear()
    if (!statuses.length && !left.length) return
    // Not delivered (no hub just now): kept, and sent with the next change or the next welcome.
    if (!o.send({ type: 'workload:status', statuses, ...(left.length ? { gone: left } : {}) })) { for (const s of statuses) dirty.add(key(s.kind, s.id)); gone.push(...left) }
  }
  const soon = () => { timer ??= setTimeout(flush, 200); (timer as any).unref?.() }

  return {
    /** How a workload stands now. Nothing is sent when nothing changed. */
    set(s: WorkloadStatus) {
      const k = key(s.kind, s.id)
      const was = now.get(k)
      const next: WorkloadStatus = { restarts: was?.restarts ?? 0, ...s }
      if (was && JSON.stringify(was) === JSON.stringify(next)) return
      now.set(k, next); dirty.add(k); soon()
    },
    /** Change part of how one stands (its state and error, its health), keeping the rest. */
    update(kind: WorkloadKind, id: string, patch: Partial<WorkloadStatus>) {
      const was = now.get(key(kind, id))
      this.set({ kind, id, state: 'pending', ...was, ...patch })
    },
    get: (kind: WorkloadKind, id: string) => now.get(key(kind, id)),
    /** One that no longer runs here. */
    gone(kind: WorkloadKind, id: string) { if (now.delete(key(kind, id))) { dirty.delete(key(kind, id)); gone.push({ kind, id }); soon() } },
    /** Each welcome: everything again, so the project holds what is true now. */
    resend() { for (const k of now.keys()) dirty.add(k); soon() },
    onAct(kind: WorkloadKind, f: Act) { acts.set(kind, f) },
    onInspect(kind: WorkloadKind, f: Inspect) { looks.set(kind, f) },
    /** A message from the platform; true when it was one of these. */
    onMessage(p: any): boolean {
      if (p?.t !== 'workload:act' && p?.t !== 'workload:inspect') return false
      const answer = (m: Record<string, unknown>) => o.send({ type: p.t === 'workload:act' ? 'workload:acted' : 'workload:inspected', reqId: p.reqId, ...m })
      const f = p.t === 'workload:act' ? acts.get(p.kind) : looks.get(p.kind)
      if (!f) { answer({ error: `this engine does not ${p.t === 'workload:act' ? `do "${p.action}" to` : `look into "${p.aspect}" of`} ${/^[aeiou]/.test(String(p.kind)) ? 'an' : 'a'} ${p.kind}` }); return true }
      const run = p.t === 'workload:act' ? (f as Act)(String(p.id), String(p.action), p.by ?? null) : (f as Inspect)(String(p.id), String(p.aspect), Number(p.page) || 0)
      void run.then((r) => answer(r as Record<string, unknown>), (e) => { o.log?.(`[workloads] ${p.kind}/${p.id} ${p.action ?? p.aspect}: ${e?.message ?? e}`); answer({ error: String(e?.message ?? e) }) })
      return true
    },
  }
}
export type Workloads = ReturnType<typeof createWorkloads>
