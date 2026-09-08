// ── THE PLATFORM TOKEN, owned in ONE place ─────────────────────────────────────────────────────────────────
//
// Two apps authenticate identically — the admin console and the user app. Same mint endpoint
// (POST /api/auth/token), same storage key (`sa-token`), same JWT, same hub. They implemented it twice, and
// the copies drifted: the console checked `exp` before trusting a stored token; the user app did not.
//
// That divergence cost a project a working session and took an hour to find. The user app read the token from
// localStorage and used it forever, because its "do we need one" test was `if (token) return` and an EXPIRED
// TOKEN IS STILL A STRING. The hub rejected every connect with 4001, the socket reconnected every three
// seconds with the same dead token, and signing in again fixed nothing — that writes a Clerk session, not
// ours, and nothing ever replaced what was in storage.
//
// It presented as ONE PROJECT being broken while others worked, because localStorage is per-ORIGIN: every
// project subdomain carries its own token with its own expiry, so one going stale strands exactly that one.
//
// So the rules live here, once, and both apps import them:
//
//   1. NEVER trust a stored token without checking `exp`. Absent is safer than expired — absent re-mints,
//      expired retries forever.
//   2. A REJECTION CLEARS IT. 401 over HTTP, 4001 over the socket: the token is dead, so drop it rather than
//      re-sending it.
//   3. RE-MINTING IS ATTEMPTED ONCE. If a fresh token is also rejected the problem is not the token, and a
//      reload loop helps nobody.

/** `exp` from a JWT payload, in seconds. 0 for anything unreadable — which fails every check below. */
export function jwtExp(token: string | null): number {
  if (!token) return 0
  try {
    let b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    b += '='.repeat((4 - (b.length % 4)) % 4)
    const payload = JSON.parse(atob(b))
    return typeof payload.exp === 'number' ? payload.exp : 0
  } catch { return 0 }
}

/** A minute of headroom, so a token cannot lapse between passing this and the request landing. */
export const tokenValid = (token: string | null): boolean => jwtExp(token) * 1000 - Date.now() > 60_000

export const TOKEN_KEY = 'sa-token'
const REAUTH_GUARD = 'sa-reauth'

/** The stored token if it is still usable, else null — and the unusable one is REMOVED on the way past, so a
 *  later reader cannot find it and try again. */
export function loadToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY)
    if (tokenValid(t)) return t
    localStorage.removeItem(TOKEN_KEY)
  } catch { /* storage disabled — treat as no token */ }
  return null
}

/** Exchange a Clerk session token for ours. Returns null on failure; the caller stays unauthenticated rather
 *  than holding something that will be rejected. */
export async function mintToken(clerkToken: string | null): Promise<string | null> {
  try {
    const r = await fetch('/api/auth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clerkToken }),
    })
    if (!r.ok) return null
    const { token } = await r.json() as { token: string }
    if (!token) return null
    localStorage.setItem(TOKEN_KEY, token)
    clearReauthGuard()          // a token that minted re-arms the one-shot recovery for next time
    return token
  } catch { return null }
}

/** Throw the token away. Called when something AUTHORITATIVE rejected it — a 401, or a 4001 from the hub. */
export function dropToken(): void {
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* nothing to drop */ }
}

/** True the first time only. Both apps recover from a rejection by reloading, and both need the same
 *  protection from doing that forever when re-minting also fails. */
export function claimReauthOnce(): boolean {
  try {
    if (sessionStorage.getItem(REAUTH_GUARD)) return false
    sessionStorage.setItem(REAUTH_GUARD, '1')
    return true
  } catch { return false }
}

export function clearReauthGuard(): void {
  try { sessionStorage.removeItem(REAUTH_GUARD) } catch { /* ignore */ }
}
