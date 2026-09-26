// ── Parcels: message bodies beside the wire ──────────────────────────────────────────────────────────────────
//
// A message too large for one hub frame does not go through the Durable Object at all: its body is put here,
// in the shared bucket under parcel/<project>/<sha256>, and a pointer (the message's routing and summary plus
// { hash, bytes, ticket, expires }) travels the socket instead. The receiving end fetches the body with the
// ticket. Nothing but this module knows where a parcel lives or how a ticket is made.
//
// The ticket is HMAC-SHA256 over project · hash · expiry, signed with the platform's JWT secret: it proves the
// platform wrote this body for this project and says until when it may be read. It is not tied to a reader —
// whoever holds the pointer (a member who received it, a client replaying a buffered answer) may fetch the body
// until it expires. Expiry is the parcel's retention: a body is kept as long as its ticket works, and pruned
// after. No edge cache: a body is private to the project and served straight from the bucket.
//
// The body is content-addressed, so the same answer sent twice is stored once, and a put whose bytes do not
// hash to the name in the path is refused: the name is the proof of what is stored.
import { b64url } from './auth/tokens.js'
import { isParcelled, type Parcel, type ParcelStore } from '../../../clients/transport.js'

/** How long a parcel lives, and so how long its ticket works. */
export const PARCEL_DAYS = 30
/** The largest body the route accepts — a table of some hundred thousand rows, not a file upload. */
export const PARCEL_MAX_BYTES = 64 * 1024 * 1024

const enc = new TextEncoder()
const keyOf = (projectId: string, hash: string) => `parcel/${projectId}/${hash}`
const isHash = (s: string) => /^[a-f0-9]{64}$/.test(s)

async function hmac(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(input))))
}

/** A ticket for one parcel of one project, good until `expires` (ms since the epoch): "<expires>.<signature>". */
export async function mintTicket(secret: string, projectId: string, hash: string, expires: number): Promise<string> {
  return `${expires}.${await hmac(secret, `${projectId}\n${hash}\n${expires}`)}`
}

/** Whether a ticket was minted here for this project and hash, and has not expired. */
export async function verifyTicket(secret: string, projectId: string, hash: string, ticket: string, now = Date.now()): Promise<boolean> {
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]+)$/.exec(ticket ?? '')
  if (!m) return false
  const expires = Number(m[1])
  if (!(expires > now)) return false
  const want = await hmac(secret, `${projectId}\n${hash}\n${expires}`)
  if (want.length !== m[2].length) return false
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2].charCodeAt(i)
  return diff === 0
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Put a body for a project: stored once by hash, ticketed for PARCEL_DAYS. The caller has already authenticated. */
export async function putParcel(bucket: R2Bucket, secret: string, projectId: string, hash: string, bytes: ArrayBuffer): Promise<Parcel> {
  if (bytes.byteLength > PARCEL_MAX_BYTES) throw new ParcelError(413, `a parcel is at most ${PARCEL_MAX_BYTES} bytes`)
  const actual = await sha256Hex(bytes)
  if (actual !== hash) throw new ParcelError(400, 'the body does not hash to the name in the path')
  const key = keyOf(projectId, hash)
  if (!(await bucket.head(key))) await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/json' } })
  const expires = Date.now() + PARCEL_DAYS * 86_400_000
  return { hash, bytes: bytes.byteLength, ticket: await mintTicket(secret, projectId, hash, expires), expires }
}

/** The body of a parcel, or null when there is none. */
export async function getParcel(bucket: R2Bucket, projectId: string, hash: string): Promise<R2ObjectBody | null> {
  return bucket.get(keyOf(projectId, hash))
}

/** Drop a project's parcels older than their retention. Run beside a put, never in a request's critical path. */
export async function pruneParcels(bucket: R2Bucket, projectId: string, now = Date.now()): Promise<number> {
  const before = now - PARCEL_DAYS * 86_400_000
  let cursor: string | undefined, dropped = 0
  do {
    const page = await bucket.list({ prefix: `parcel/${projectId}/`, cursor })
    const old = page.objects.filter((o) => o.uploaded.getTime() < before).map((o) => o.key)
    if (old.length) { await bucket.delete(old); dropped += old.length }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return dropped
}

export class ParcelError extends Error { constructor(public status: number, message: string) { super(message) } }

/**
 * The route: GET with a ticket reads, PUT with a credential writes. `authorize` is the worker's own check of the
 * PUT's bearer credential (project key or user token) — this module does not know how the platform proves a caller.
 */
export async function handleParcelRoute(o: {
  request: Request; bucket: R2Bucket | undefined; secret: string | undefined; projectId: string; hash: string
  authorize: () => Promise<boolean>; after?: (p: Promise<unknown>) => void
}): Promise<Response> {
  const { request } = o
  if (!o.bucket) return new Response('no bucket bound', { status: 500 })
  if (!o.secret) return new Response('server misconfigured: JWT_SECRET not set', { status: 500 })
  if (!isHash(o.hash)) return new Response('a parcel is named by its sha-256', { status: 400 })
  if (request.method === 'GET') {
    const ticket = new URL(request.url).searchParams.get('ticket') ?? ''
    if (!(await verifyTicket(o.secret, o.projectId, o.hash, ticket))) return new Response('no valid ticket', { status: 401 })
    const obj = await getParcel(o.bucket, o.projectId, o.hash)
    if (!obj) return new Response('no such parcel', { status: 404 })
    return new Response(obj.body, { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', 'content-length': String(obj.size) } })
  }
  if (request.method === 'PUT') {
    if (!(await o.authorize())) return new Response('unauthorized', { status: 401 })
    const len = Number(request.headers.get('content-length') ?? 0)
    if (len > PARCEL_MAX_BYTES) return new Response(`a parcel is at most ${PARCEL_MAX_BYTES} bytes`, { status: 413 })
    try {
      const parcel = await putParcel(o.bucket, o.secret, o.projectId, o.hash, await request.arrayBuffer())
      o.after?.(pruneParcels(o.bucket, o.projectId).catch(() => 0))
      return Response.json(parcel)
    } catch (e: any) {
      if (e instanceof ParcelError) return new Response(e.message, { status: e.status })
      return new Response(`the parcel was not stored: ${e?.message ?? e}`, { status: 500 })
    }
  }
  return new Response('method not allowed', { status: 405 })
}

/** The store a Durable Object hands the transport: it reads the bucket directly, no ticket, no HTTP — the DO is the platform. */
export function bucketStore(bucket: R2Bucket | undefined, projectId: string): ParcelStore {
  return {
    get: async (parcel: Parcel) => {
      if (!bucket) throw new Error('no bucket bound')
      const obj = await getParcel(bucket, projectId, parcel.hash)
      if (!obj) throw new Error('no such parcel')
      return obj.text()
    },
  }
}

export { isParcelled }
