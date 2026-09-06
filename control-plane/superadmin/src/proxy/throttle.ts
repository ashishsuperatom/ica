// ── THROTTLING FAILED AUTHENTICATION ─────────────────────────────────────────────────────────────────────
// The endpoints here hand out credentials that are attached to a payment card, and until now a wrong key
// could be tried without limit — twelve forged attempts in a row were all answered, none slowed. Guessing a
// UUID plus an `sk-proj-` token is not realistic, but "not realistic" is the wrong thing to be relying on
// when the prize is a provider key.
//
// A VALID CREDENTIAL IS ALWAYS SERVED. The check happens FIRST; the counter only decides what to do with a
// caller that has already failed. An earlier version gated before checking, and a legitimate box sharing a
// project and address with a burst of bad attempts was locked out — a rate limiter that can refuse a correct
// credential is one that gets removed a month later, deservedly.
//
// So: right key, always in. Wrong key, rationed. The 401-vs-429 distinction leaks nothing, since both mean
// the same thing to anyone who does not hold the credential.
//
// KV, not a Durable Object: this sits in front of every credential call, and a DO is single-threaded per
// object — the throttle would become the contention it exists to prevent. The cost is that a burst spread
// across edge locations may take a few extra attempts to be noticed, which is irrelevant against a keyspace
// this size, and each counter self-expires so nothing has to clean up.

import type { KV } from './vault.js'

const WINDOW_S = 300      // five minutes
const MAX_FAILURES = 10   // per identity per window

const K = (who: string) => `throttle:${who}`

/** Has this caller failed too often lately? Consulted only AFTER a credential has already been rejected. */
export async function throttled(kv: KV | undefined, who: string): Promise<boolean> {
  if (!kv) return false
  const n = Number((await kv.get(K(who), 'text')) ?? 0)
  return n >= MAX_FAILURES
}

/** Record a failure. Absolute count in a fixed window, written through waitUntil by the caller: a lost
 *  increment under a race costs one extra attempt out of ten, which does not change the answer. */
export async function noteFailure(kv: KV | undefined, who: string): Promise<void> {
  if (!kv) return
  const n = Number((await kv.get(K(who), 'text')) ?? 0)
  await kv.put(K(who), String(n + 1), { expirationTtl: WINDOW_S })
}

/** Who is being throttled. The project id AND the caller's address, so one noisy box cannot lock out a whole
 *  project, and one address cannot work through every project it can name. */
export const identityOf = (projectId: string | null, request: Request): string =>
  `${projectId || '-'}|${request.headers.get('cf-connecting-ip') ?? 'unknown'}`

// ── AUDIT: who was handed a credential, and when ─────────────────────────────────────────────────────────
// The same project key sits in every engine's .env and on the proxy box, and it unlocks every pooled
// credential for that project's group. That reach is inherent — a box has to authenticate somehow — so what
// can be done is make its use VISIBLE: a credential handed out leaves a record, and a key being used from
// somewhere it should not be becomes something you can see rather than something you infer from a bill.
//
// ONE KEY PER EVENT, never an appended list. Appending is read-modify-write, and concurrent Workers would
// lose each other's entries — an audit trail with holes is worse than none, because it is trusted. Each event
// self-expires, so the trail is bounded without anything having to prune it.
const AUDIT_TTL_S = 30 * 24 * 3600   // thirty days

export async function auditIssue(kv: KV | undefined, e: {
  project: string; provider: string; keyId: string | null; ip: string; agent?: string
}): Promise<void> {
  if (!kv) return
  const at = Date.now()
  const id = `${at}-${Math.random().toString(36).slice(2, 8)}`
  await kv.put(`audit:${e.project}:${id}`, JSON.stringify({ at, ...e }), { expirationTtl: AUDIT_TTL_S })
}

/** A credential that cannot possibly be ours. Checked before anything expensive, so a flood of nonsense costs
 *  a regex rather than a Durable Object call — the cheap half of not being a free denial-of-service target. */
export const plausible = (cred: string | null): boolean => !!cred && /^sk-proj-[A-Za-z0-9-]{8,}$/.test(cred)

/** A success clears the record: a box that had a bad key and was fixed should not stay in the doghouse. */
export async function noteSuccess(kv: KV | undefined, who: string): Promise<void> {
  if (!kv) return
  await kv.put(K(who), '0', { expirationTtl: 60 })
}
