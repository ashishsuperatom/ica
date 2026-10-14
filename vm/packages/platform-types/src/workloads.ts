// WORKLOADS — everything the engine runs, in one shape (docs/platform-architecture.md "Workloads"; docs/connectors-plan.md
// step 2). A workload is `kind/id`. Each kind is described ONCE, here: what may be done to it, what can be looked into,
// and who may see and do each — the platform's routes, the engine's handlers, sacli and the console all read this.

/** One vocabulary for every kind. `unknown` is never reported: it is what a workload reads when no engine is connected. */
export const WORKLOAD_STATES = ['pending', 'starting', 'ready', 'degraded', 'failed', 'stopped'] as const
export type WorkloadState = (typeof WORKLOAD_STATES)[number]

/** What the engine reports of one workload — sent only when it changes. */
export interface WorkloadStatus {
  kind: WorkloadKind
  id: string
  state: WorkloadState
  /** What runs (a bridge's hash, a release, harness · provider · model). */
  version?: string | null
  /** The hash of what was wanted that this reflects: the platform compares it with what is wanted now. */
  spec?: string | null
  restarts?: number
  /** The last error: `what` is for anyone who sees the workload, `detail` for operators only. */
  error?: { what: string; detail?: string } | null
  /** Small facts of its health (counts, timings) — never a credential, never data. */
  health?: Record<string, string | number | boolean | null>
}

/** A kind: its actions (one-off, audited) and aspects (looked into on demand), and the capability for each. */
export interface WorkloadKindSpec {
  label: string
  /** Seeing its workloads (status and events). */
  see: string
  actions: Record<string, { label: string; needs: string; /** said before it is done */ says: string }>
  aspects: Record<string, { label: string; needs: string }>
  /** When it needs a person (Attention): failed at once; degraded after this long. */
  attentionAfterMs: number
}

export const WORKLOAD_KINDS = {
  engine: {
    label: 'Engine',
    see: 'project.view',
    actions: {},
    aspects: { health: { label: 'Health', needs: 'project.manage' } },
    attentionAfterMs: 5 * 60_000,
  },
  connection: {
    label: 'Connection',
    see: 'project.view',
    actions: {
      restart: { label: 'Restart', needs: 'project.data', says: 'its bridge is loaded again with its settings' },
      test: { label: 'Test', needs: 'project.data', says: 'it is asked whether it can reach its source' },
      'clear-cache': { label: 'Clear its cache', needs: 'project.data', says: 'every result read from it is forgotten; the next read goes to the source' },
      'refresh-index': { label: 'Refresh its index', needs: 'project.data', says: 'its tables and fields are read from the source again' },
      update: { label: 'Update its connector', needs: 'project.connectors', says: 'it runs the newest version of its connector from now on; the version it runs now is kept for a rollback' },
      rollback: { label: 'Roll back', needs: 'project.connectors', says: 'it runs the version of its connector it ran before its last update' },
    },
    aspects: {
      cache: { label: 'Cache', needs: 'project.data' },
      index: { label: 'Index', needs: 'project.view' },
    },
    attentionAfterMs: 10 * 60_000,
  },
  agent: {
    label: 'Agent',
    see: 'project.view',
    actions: { restart: { label: 'Restart', needs: 'project.manage', says: 'its session is ended; the next question starts a new one' } },
    aspects: { session: { label: 'Session', needs: 'project.manage' } },
    attentionAfterMs: 10 * 60_000,
  },
} as const satisfies Record<string, WorkloadKindSpec>

export type WorkloadKind = keyof typeof WORKLOAD_KINDS
export const isWorkloadKind = (k: unknown): k is WorkloadKind => typeof k === 'string' && Object.prototype.hasOwnProperty.call(WORKLOAD_KINDS, k)

/** What is wrong with a status the engine sent ([] when nothing): the platform keeps only a sound one. */
export function checkWorkloadStatus(s: any): string[] {
  const bad: string[] = []
  if (!s || typeof s !== 'object') return ['not an object']
  if (!isWorkloadKind(s.kind)) bad.push(`kind "${s.kind}" is not a workload kind (${Object.keys(WORKLOAD_KINDS).join(', ')})`)
  if (typeof s.id !== 'string' || !s.id || s.id.length > 200) bad.push('id is missing')
  if (!WORKLOAD_STATES.includes(s.state)) bad.push(`state "${s.state}" is not one of ${WORKLOAD_STATES.join(', ')}`)
  if (s.error != null && (typeof s.error !== 'object' || typeof s.error.what !== 'string')) bad.push('error must be { what, detail? }')
  if (s.health != null && (typeof s.health !== 'object' || Object.values(s.health).some((v) => v !== null && !['string', 'number', 'boolean'].includes(typeof v)))) bad.push('health holds only strings, numbers, booleans')
  return bad
}

/** A spec hash: the same wanted thing, the same hash, on the platform and in the engine. FNV-1a over its canonical JSON
 *  (keys sorted) — a comparison, not a secret. */
export function specOf(wanted: unknown): string {
  const canon = (v: any): string => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null)
  let h = 0x811c9dc5
  for (const c of canon(wanted)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
