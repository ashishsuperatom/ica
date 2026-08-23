// ── Identity and access ──────────────────────────────────────────────────────
// A report's id is DERIVED from (projectId, questionId), not random:
//
//   id = base64url(HMAC-SHA256(key, "projectId:questionId"))[0..21]
//
// which buys three things at once.
//  • Idempotent: a retried POST returns the same report instead of minting a
//    duplicate. The engine can re-send an answer safely.
//  • Predictable: a caller holding the qid can derive the URL without storing a
//    second id next to its own pending record.
//  • Unguessable: 128 bits of HMAC. That matters because the id IS the credential —
//    Teams' CDN and Outlook's image proxy fetch the PNG with no cookies and no auth
//    headers, so nothing but the URL can carry authority.
//
// The consequence, stated plainly: anyone with the link can view the report. That is
// inherent to the surfaces, not a shortcut. It is bounded by a TTL, and by the fact
// that rotating the signing key invalidates every derived id at once.
//
// A re-ask is a new questionId, so it is naturally a new report — a shared link keeps
// showing what its recipient was actually told.

const enc = new TextEncoder()

async function hmac(secret: string, msg: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, enc.encode(msg))
}

function b64url(buf: ArrayBuffer): string {
  let s = ''
  const b = new Uint8Array(buf)
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function reportId(secret: string, projectId: string, questionId: string): Promise<string> {
  return b64url(await hmac(secret, `${projectId}:${questionId}`)).slice(0, 22)
}

/** Constant-time compare, so a wrong service token can't be discovered a byte at a
 *  time by timing the response. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The service token authorises WRITING a report. Reading is authorised by holding
 *  the unguessable URL — see the note above. */
export function authorised(request: Request, expected?: string): boolean {
  if (!expected) return false                              // unset secret = closed, never open
  const h = request.headers.get('authorization') ?? ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  return !!token && safeEqual(token, expected)
}

/** Project and report ids go into R2 keys and URLs; keep them boring. */
export const isSafeId = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= 128 && /^[A-Za-z0-9_-]+$/.test(s)
