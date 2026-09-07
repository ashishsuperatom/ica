// ── THE VAULT — one sealed document, not a scattering of keys ────────────────────────────────────────────
// Everything about credentials lives in ONE KV entry, encrypted as a whole: the values, which key serves
// which group, and which project is in which group. Read it, decrypt it, and the answer to every question is
// in memory; change anything and the whole document is re-sealed and written back.
//
// WHY ONE DOCUMENT. Spreading this across `value:*`, `pool:*` and `group:*` meant several KV reads to answer
// one request, a value per entry to seal and unseal separately, and no way to change two related things
// together — a pool entry and the value it names could disagree for as long as it took the second write to
// land. One document is a single read (edge-cached), a single decrypt (~0.02ms), and every change is atomic.
//
// WHAT STAYS OUTSIDE: only the MASTER KEY, a Worker secret. It is the one thing that must not be in KV,
// because it is what makes this document useless to anyone who obtains the KV.
//
// EXHAUSTION IS IN HERE TOO, as an expiry timestamp per entry. The alternative — a self-expiring KV key each —
// saves a re-seal when a subscription runs out, which happens a few times a day, and costs an extra read on
// every request plus a second place for the truth to live. Concurrent exhaustion writes can lose one another
// (read-modify-write on one key), and the consequence is one extra 429 before it is marked again.

import { seal, unseal, isSealed } from './seal.js'
// ── THE ONE KV TYPE ──────────────────────────────────────────────────────────────────────────────────────
// There were three ways to say "a KV store" across this directory: `KV` in pool.js, `KVLike` in throttle.ts,
// and a bare `any` in usage.ts. Nothing was wrong yet, which is exactly when to fix it — three spellings of
// one idea is how a signature quietly drifts and the compiler stops being able to tell you.
export interface KV {
  get(key: string, type?: 'text' | 'json'): Promise<any>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }>
}

// The one entry in the CREDENTIALS namespace that holds every coding-agent key. Named for its CONTENTS, not
// for the mechanism — "vault" in a store called CREDENTIALS says the same word twice and tells a reader
// nothing, and this namespace will have neighbours.
const AGENT_CREDENTIALS_KEY = 'agent-credentials'

export interface VaultEntry {
  id: string            // 'oc1' — stable; what appears in logs, metrics and the exhaustion state
  provider: string      // 'opencode-go'
  value: string         // the credential
  groups?: string[]     // project groups that may use it; absent ⇒ any
  note?: string
  addedAt?: string
  // WHEN IT DIES. A ChatGPT access token lasts about ten days, and when it lapses the symptom is an agent that
  // looks broken rather than a token that looks expired — which is exactly the confusion that has cost real
  // time here before. Read from the credential itself where it says so (a JWT carries `exp`), so it is a fact
  // rather than someone's note, and reported before it bites.
  expiresAt?: number    // epoch ms
  // PARKED, not deleted. A credential we do not want spent right now — OpenRouter while its cost is being
  // watched, a subscription being rested — but that we do not want to re-enter later either. Absent means
  // usable, so an entry added without thinking about it works, and switching it off is the deliberate act.
  disabled?: boolean
}

export interface Vault {
  entries: VaultEntry[]
  groups: Record<string, string>   // projectId → group
  spent?: Record<string, number>   // entry id → epoch ms until which it is considered exhausted
}

const EMPTY: Vault = { entries: [], groups: {} }

export async function readVault(kv: KV, master?: string): Promise<Vault> {
  const raw = await kv.get(AGENT_CREDENTIALS_KEY, 'text')
  if (!raw) return { ...EMPTY }
  if (isSealed(raw)) {
    if (!master) throw new Error('the vault is sealed but CREDENTIALS_MASTER_KEY is not set')
    return JSON.parse(await unseal(raw, master))
  }
  return JSON.parse(raw)   // written before sealing existed; sealed again on the next write
}

export async function writeVault(kv: KV, v: Vault, master?: string): Promise<void> {
  const body = JSON.stringify(v)
  await kv.put(AGENT_CREDENTIALS_KEY, master ? await seal(body, master) : body)
}

/** The credentials this project may use for this provider, in order, minus any currently exhausted.
 *  Expiry is evaluated on READ, so nothing has to run to put a key back in service. */
export function candidates(v: Vault, provider: string, projectId: string, now = Date.now()): VaultEntry[] {
  const group = v.groups[projectId] || 'default'
  return v.entries.filter((e) =>
    e.provider === provider &&
    (!e.groups?.length || e.groups.includes(group)) &&
    !e.disabled &&
    !((v.spent?.[e.id] ?? 0) > now) &&
    usable(e, now))
}

/** Mark a credential spent for a while. The cooldown is how long before it is tried again — hours for a
 *  subscription that resets daily, minutes for a rate limit. */
export function markSpent(v: Vault, id: string, seconds: number, now = Date.now()): Vault {
  return { ...v, spent: { ...(v.spent ?? {}), [id]: now + seconds * 1000 } }
}

/** Drop expired marks so the document does not grow forever with keys that came back long ago. */
export function tidy(v: Vault, now = Date.now()): Vault {
  const spent = Object.fromEntries(Object.entries(v.spent ?? {}).filter(([, until]) => until > now))
  return { ...v, spent }
}

export const groupOf = (v: Vault, projectId: string): string => v.groups[projectId] || 'default'

/** What an admin screen may see: everything EXCEPT the values. A screen that can render a credential is a
 *  screen that can leak one, and there is no reason for one to leave except to a box that asked for it. */
export function redact(v: Vault) {
  const now = Date.now()
  return {
    entries: v.entries.map(({ value, ...rest }) => ({
      ...rest,
      spentUntil: v.spent?.[rest.id] ?? null,
      exhausted: (v.spent?.[rest.id] ?? 0) > now,
      // Days, not a timestamp: "expires in 2 days" is read correctly at a glance, where an epoch is not read
      // at all. Negative means it already has.
      expiresInDays: rest.expiresAt ? Math.floor((rest.expiresAt - now) / 86_400_000) : null,
      expired: rest.expiresAt ? rest.expiresAt <= now : false,
    })),
    groups: v.groups,
  }
}

/** Anything expiring within `days` (or already gone). What a warning is built from. A disabled entry is not
 *  warned about: it is not being used, so its expiry is not a problem to act on. */
export function expiring(v: Vault, days = 3, now = Date.now()) {
  return v.entries
    .filter((e) => !e.disabled && e.expiresAt && e.expiresAt - now < days * 86_400_000)
    .map((e) => ({ id: e.id, provider: e.provider, expiresAt: e.expiresAt!,
                   inDays: Math.floor((e.expiresAt! - now) / 86_400_000) }))
}

/** A credential that says when it dies — read it rather than trust a note. JWTs carry `exp`; anything else
 *  simply has no expiry we can know, and claiming one would be worse than admitting we cannot tell. */
export function expiryOf(value: string): number | undefined {
  const parts = value.split('.')
  if (parts.length !== 3) return undefined
  try {
    const b = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(b + '='.repeat((4 - (b.length % 4)) % 4)))
    return typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined
  } catch { return undefined }
}

/** An entry the pool should not hand out: expired credentials are worse than missing ones, because the failure
 *  surfaces at the agent as something unrelated. */
export const usable = (e: VaultEntry, now = Date.now()) => !e.expiresAt || e.expiresAt > now
