import { describe, it, expect } from 'vitest'
import { mintTicket, verifyTicket, handleParcelRoute, putParcel, pruneParcels, bucketStore, PARCEL_DAYS } from '../parcels.js'
import { sender, receiver } from '../../../../clients/transport.js'
import { parcelStore } from '../../../../clients/parcels.js'

/** A bucket in memory with the three calls the module makes. */
function fakeBucket(now = () => Date.now()) {
  const objects = new Map<string, { bytes: ArrayBuffer; uploaded: Date }>()
  const b = {
    objects,
    head: async (key: string) => (objects.has(key) ? { key } : null),
    put: async (key: string, bytes: ArrayBuffer) => { objects.set(key, { bytes, uploaded: new Date(now()) }) },
    get: async (key: string) => {
      const o = objects.get(key); if (!o) return null
      return { key, size: o.bytes.byteLength, body: new Blob([o.bytes]).stream(), text: async () => new TextDecoder().decode(o.bytes) }
    },
    list: async (o: { prefix: string }) => ({ objects: [...objects].filter(([k]) => k.startsWith(o.prefix)).map(([key, v]) => ({ key, uploaded: v.uploaded })), truncated: false, cursor: undefined }),
    delete: async (keys: string[]) => { for (const k of keys) objects.delete(k) },
  }
  return b as unknown as R2Bucket & { objects: typeof objects }
}
const SECRET = 'test-secret'
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc(s))), (b) => b.toString(16).padStart(2, '0')).join('')

describe('tickets', () => {
  it('a ticket opens its own parcel for its own project until it expires, and nothing else', async () => {
    const exp = Date.now() + 1000
    const t = await mintTicket(SECRET, 'p1', 'h1', exp)
    expect(await verifyTicket(SECRET, 'p1', 'h1', t)).toBe(true)
    expect(await verifyTicket(SECRET, 'p2', 'h1', t)).toBe(false)
    expect(await verifyTicket(SECRET, 'p1', 'h2', t)).toBe(false)
    expect(await verifyTicket('other', 'p1', 'h1', t)).toBe(false)
    expect(await verifyTicket(SECRET, 'p1', 'h1', t, exp + 1)).toBe(false)
    // a tampered signature: the first character after the dot, always changed (replacing it with a fixed letter was a
    // no-op whenever it already was that letter — about one run in 64)
    expect(await verifyTicket(SECRET, 'p1', 'h1', t.replace(/\.(.)/, (_m, c) => '.' + (c === 'x' ? 'y' : 'x')))).toBe(false)
    expect(await verifyTicket(SECRET, 'p1', 'h1', '')).toBe(false)
  })
})

describe('the route', () => {
  const body = JSON.stringify({ t: 'app:answer', rows: Array.from({ length: 50 }, (_, i) => i) })
  const route = (bucket: R2Bucket, req: Request, hash: string, ok = true) =>
    handleParcelRoute({ request: req, bucket, secret: SECRET, projectId: 'p1', hash, authorize: async () => ok })

  it('PUT stores by hash and answers a ticket; GET with the ticket reads the body back', async () => {
    const bucket = fakeBucket()
    const hash = await sha(body)
    const put = await route(bucket, new Request(`https://x/api/projects/p1/objects/parcel/${hash}`, { method: 'PUT', body }), hash)
    expect(put.status).toBe(200)
    const p = await put.json() as any
    expect(p.hash).toBe(hash); expect(p.bytes).toBe(body.length); expect(p.expires).toBeGreaterThan(Date.now() + (PARCEL_DAYS - 1) * 86_400_000)
    expect(bucket.objects.has(`parcel/p1/${hash}`)).toBe(true)
    const get = await route(bucket, new Request(`https://x/api/projects/p1/objects/parcel/${hash}?ticket=${encodeURIComponent(p.ticket)}`), hash)
    expect(get.status).toBe(200)
    expect(get.headers.get('cache-control')).toBe('private, no-store')
    expect(await get.text()).toBe(body)
  })
  it('a body that does not hash to its name is refused; a bad name, a missing ticket and a stranger too', async () => {
    const bucket = fakeBucket()
    const hash = await sha('something else')
    expect((await route(bucket, new Request('https://x/', { method: 'PUT', body }), hash)).status).toBe(400)
    expect((await route(bucket, new Request('https://x/', { method: 'PUT', body }), 'nothex')).status).toBe(400)
    expect((await route(bucket, new Request('https://x/', { method: 'PUT', body }), await sha(body), false)).status).toBe(401)
    expect((await route(bucket, new Request('https://x/?ticket=nope'), await sha(body))).status).toBe(401)
    expect(bucket.objects.size).toBe(0)
  })
  it('the same body put twice is stored once', async () => {
    const bucket = fakeBucket()
    const hash = await sha(body)
    await putParcel(bucket, SECRET, 'p1', hash, enc(body)); await putParcel(bucket, SECRET, 'p1', hash, enc(body))
    expect(bucket.objects.size).toBe(1)
  })
  it('pruning drops what is older than the retention and keeps the rest', async () => {
    let now = Date.now()
    const bucket = fakeBucket(() => now)
    await putParcel(bucket, SECRET, 'p1', await sha('old'), enc('old'))
    now += (PARCEL_DAYS + 1) * 86_400_000
    await putParcel(bucket, SECRET, 'p1', await sha('new'), enc('new'))
    expect(await pruneParcels(bucket, 'p1', now)).toBe(1)
    expect([...bucket.objects.keys()]).toEqual([`parcel/p1/${await sha('new')}`])
  })
})

describe('end to end through the transport', () => {
  it('a large message goes as a parcel over the route and comes back whole, for a ticket client and for a bucket client', async () => {
    const bucket = fakeBucket()
    // The platform, as fetch sees it.
    const f: typeof fetch = async (input, init) => {
      const req = new Request(input as string, init)
      const m = new URL(req.url).pathname.match(/\/api\/projects\/([^/]+)\/objects\/parcel\/([^/]+)$/)!
      return handleParcelRoute({ request: req, bucket, secret: SECRET, projectId: m[1], hash: m[2], authorize: async () => req.headers.get('authorization') === 'Bearer sk-proj-k' })
    }
    const frames: unknown[] = []
    const engine = sender({ send: (fr) => frames.push(fr), limit: 2_000, parcels: parcelStore({ api: 'https://x', projectId: 'p1', credential: 'sk-proj-k', fetch: f }) })
    const msg = { t: 'analyst:answer', reqId: 'r1', answer: { rows: Array.from({ length: 200 }, (_, i) => ({ i, s: 'x'.repeat(40) })) } }
    expect(await engine.send(msg)).toBe('parcel')
    expect(frames).toHaveLength(1)
    expect((frames[0] as any).parcel.ticket).toBeTypeOf('string')
    expect((frames[0] as any).answer).toBeUndefined()
    const got: unknown[] = []
    await receiver({ deliver: (m) => got.push(m), parcels: parcelStore({ api: 'https://x', projectId: 'p1', fetch: f }) }).receive(frames[0])
    await receiver({ deliver: (m) => got.push(m), parcels: bucketStore(bucket, 'p1') }).receive(frames[0])
    expect(got).toEqual([msg, msg])
  })
})
