// ── HOW MUCH IS LEFT ─────────────────────────────────────────────────────────────────────────────────────
// We do NOT count. We ask the provider, and store the answer.
//
// That distinction is the whole design. Counting means accumulating, accumulating means read-modify-write, and
// read-modify-write on KV means concurrent Workers silently losing each other's increments — the exact failure
// worth avoiding, because a usage figure that is quietly wrong is worse than none at all.
//
// Every value here is ABSOLUTE and comes from the provider: "22% of the monthly allowance", "$4.67 of $10".
// So a write never depends on what was there before, two Workers writing at once both write the same observed
// truth, and last-write-wins is not merely safe — it is correct, because the later observation is the better
// one. A write lost to a race costs nothing: the next observation replaces it.
//
// ONE KV KEY PER CREDENTIAL (`usage:<entryId>`), so credentials cannot clobber one another, and the ~1 write
// per second per key limit applies to each separately rather than to all of them together.
//
// Written through waitUntil, never in the response path: an agent's turn must not wait on a figure nobody is
// looking at yet.

export interface UsageSnapshot {
  observedAt: number
  provider: string
  /** 0-100 where the provider talks in proportions. */
  percentUsed?: number
  /** Where it talks in money or tokens. */
  limit?: number
  remaining?: number
  used?: number
  unit?: 'usd' | 'tokens'
  /** Several windows at once (opencode-go reports rolling / weekly / monthly together). */
  windows?: Record<string, { percent: number; resetsAt?: string; status?: string }>
  resetsAt?: string
  error?: string
}

/** Providers that can tell us. The others are not omissions — a tunnelled credential is invisible by
 *  construction, and Anthropic's API has no equivalent endpoint. Saying "unknown" is better than implying a
 *  number we cannot see. */
const ASK: Record<string, (key: string) => Promise<UsageSnapshot>> = {
  openrouter: async (key) => {
    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` } })
    if (!r.ok) return { observedAt: Date.now(), provider: 'openrouter', error: `HTTP ${r.status}` }
    const d: any = ((await r.json()) as any)?.data ?? {}
    const limit = typeof d.limit === 'number' ? d.limit : undefined
    return {
      observedAt: Date.now(), provider: 'openrouter', unit: 'usd',
      limit, remaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : undefined,
      used: typeof d.usage === 'number' ? d.usage : undefined,
      percentUsed: limit && typeof d.usage === 'number' ? Math.round((d.usage / limit) * 100) : undefined,
      resetsAt: d.limit_reset,
    }
  },

  'opencode-go': async (key) => {
    const r = await fetch('https://opencode.ai/zen/go/v1/usage', { headers: { authorization: `Bearer ${key}` } })
    if (!r.ok) return { observedAt: Date.now(), provider: 'opencode-go', error: `HTTP ${r.status}` }
    const u: any = ((await r.json()) as any)?.usage ?? {}
    const windows: UsageSnapshot['windows'] = {}
    for (const [name, w] of Object.entries<any>(u)) {
      if (w && typeof w.percent === 'number') windows[name] = { percent: w.percent, resetsAt: w.resetsAt, status: w.status }
    }
    // The headline is whichever window is closest to its limit — that is the one that will stop you.
    const worst = Object.entries(windows).sort((a, b) => b[1].percent - a[1].percent)[0]
    return {
      observedAt: Date.now(), provider: 'opencode-go', windows,
      percentUsed: worst?.[1].percent, resetsAt: worst?.[1].resetsAt,
    }
  },
}

export const canAsk = (provider: string): boolean => provider in ASK

/** Ask the provider what is left. Never throws: a usage figure is a nicety, and failing to get one must not
 *  disturb anything that was working. */
export async function askUsage(provider: string, key: string): Promise<UsageSnapshot | null> {
  const fn = ASK[provider]
  if (!fn) return null
  try { return await fn(key) }
  catch (e: any) { return { observedAt: Date.now(), provider, error: String(e?.message ?? e).slice(0, 120) } }
}

const K = (entryId: string) => `usage:${entryId}`

export async function readUsage(kv: any, entryId: string): Promise<UsageSnapshot | null> {
  return (await kv.get(K(entryId), 'json')) || null
}

export async function writeUsage(kv: any, entryId: string, snap: UsageSnapshot): Promise<void> {
  await kv.put(K(entryId), JSON.stringify(snap))
}

/** Ask, but only if what we have is old. The staleness check is a READ, which is cheap and edge-cached; the
 *  point is to stay well under the per-key write limit rather than to be exactly on time. */
export async function refreshIfStale(kv: any, entryId: string, provider: string, key: string, maxAgeMs = 5 * 60_000): Promise<void> {
  if (!canAsk(provider)) return
  const have = await readUsage(kv, entryId)
  if (have && Date.now() - have.observedAt < maxAgeMs) return
  const snap = await askUsage(provider, key)
  if (snap) await writeUsage(kv, entryId, snap)
}

/** A short line for a screen: "22% used · resets 7 Sep" or "$4.67 of $10". */
export function describeUsage(u: UsageSnapshot | null): string {
  if (!u) return ''
  if (u.error) return `unavailable (${u.error})`
  if (u.unit === 'usd' && typeof u.limit === 'number') return `$${(u.used ?? 0).toFixed(2)} of $${u.limit}`
  if (typeof u.percentUsed === 'number') return `${u.percentUsed}% used`
  return ''
}
