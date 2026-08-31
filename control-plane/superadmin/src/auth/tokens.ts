// Platform token primitives — the SINGLE place identity tokens are minted, verified, and derived from Clerk.
// Web login, the mobile device flow, and any future surface (desktop/CLI/Android) all go through here, so the
// token rules exist exactly once. Pure Web Crypto, no dependencies.

const encoder = new TextEncoder()

export function b64url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function b64urlDecode(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return atob(s)
}

// `email` is the identity every membership decision keys on: org users are added by EMAIL (an allowlist —
// people sign in through Clerk themselves), so a token without it cannot answer 'which orgs/projects is this
// person in?'. `role` here is PLATFORM role only ('superadmin' | 'user'); org and project roles are stored
// with the org and the project, never in the token, so revoking access takes effect immediately.
export interface JwtClaims { userId: string; email?: string; role?: string; exp: number }

export async function signJwt(payload: JwtClaims, secret: string): Promise<string> {
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body   = b64url(encoder.encode(JSON.stringify(payload)))
  const input  = `${header}.${body}`
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input)))
  return `${input}.${b64url(sig)}`
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const sigBytes = Uint8Array.from(b64urlDecode(sig), c => c.charCodeAt(0))
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(`${header}.${body}`))
  if (!ok) return null
  try {
    const claims = JSON.parse(b64urlDecode(body)) as JwtClaims
    if (claims.exp && claims.exp * 1000 < Date.now()) return null
    return claims
  } catch { return null }
}

// The ONLY emails granted superadmin (full access to every org/project). Hard-coded on purpose — self-serve
// superadmin is not a thing. Lower-case; matched case-insensitively.
export const SUPERADMIN_EMAILS = ['ashish@superatom.ai']

// Clerk user's primary email (the session object carries only user_id). '' on any failure → "not superadmin".
export async function fetchClerkPrimaryEmail(userId: string, env: Env): Promise<string> {
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } })
    if (!res.ok) return ''
    const u = await res.json() as any
    const emails: any[] = u.email_addresses ?? []
    const primary = emails.find((e) => e.id === u.primary_email_address_id) ?? emails[0]
    return primary?.email_address ?? ''
  } catch { return '' }
}

export type MintResult =
  | { ok: true; token: string; userId: string; email: string; role: string }
  | { ok: false; status: number; error: string }

// Validate a Clerk session token → mint OUR platform JWT (Clerk validation + superadmin gate + 30-day expiry).
// Reused by the web exchange AND the mobile flow — never a second copy of the rules. Strategy: decode the
// Clerk JWT for the session id, then re-validate that session against Clerk's REST API (so we trust Clerk,
// not the raw token bytes).
export async function mintPlatformTokenFromClerk(clerkToken: string | undefined, env: Env): Promise<MintResult> {
  if (!clerkToken) return { ok: false, status: 400, error: 'missing clerkToken' }
  const parts = clerkToken.split('.')
  if (parts.length !== 3) return { ok: false, status: 400, error: 'malformed token' }
  let sid: string | undefined
  try { sid = JSON.parse(b64urlDecode(parts[1])).sid } catch { return { ok: false, status: 400, error: 'malformed token' } }
  if (!sid) return { ok: false, status: 400, error: 'no session id in token' }
  const clerkRes = await fetch(`https://api.clerk.com/v1/sessions/${sid}`, { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } })
  if (!clerkRes.ok) { console.error(`[auth] Clerk session lookup failed (${clerkRes.status})`); return { ok: false, status: 401, error: 'invalid session' } }
  const session = await clerkRes.json() as any
  if (session.status !== 'active') return { ok: false, status: 401, error: 'session not active' }
  const userId = session.user_id
  if (!userId) return { ok: false, status: 401, error: 'no user in session' }
  const primaryEmail = await fetchClerkPrimaryEmail(userId, env)
  const isSuperadmin = !!primaryEmail && SUPERADMIN_EMAILS.includes(primaryEmail.toLowerCase())
  const role = isSuperadmin ? 'superadmin' : 'user'
  const email = (primaryEmail || '').toLowerCase()
  const token = await signJwt({ userId, email, role, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 }, env.JWT_SECRET)
  console.log(`[auth] issued ${role} token for ${email || userId}`)
  return { ok: true, token, userId, email, role }
}

// PKCE (RFC 7636) S256 challenge: base64url( SHA-256( verifier ) ).
export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return b64url(new Uint8Array(digest))
}
