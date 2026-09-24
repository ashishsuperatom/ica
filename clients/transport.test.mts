import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sender, receiver, isPart, type Parcel } from './transport.ts'

const big = (n: number) => ({ t: 'app:answer', reqId: 'r1', words: 'w', rows: Array.from({ length: n }, (_, i) => ({ i, text: 'x'.repeat(100) })) })

test('a small message travels whole', async () => {
  const frames: unknown[] = []
  const out = sender({ send: (f) => frames.push(f), limit: 10_000 })
  assert.equal(await out.send({ t: 'hi', reqId: '1' }), 'whole')
  assert.deepEqual(frames, [{ t: 'hi', reqId: '1' }])
})

test('without a store, a large message goes as parts and comes back whole', async () => {
  const frames: unknown[] = []
  const out = sender({ send: (f) => frames.push(f), limit: 10_000, partBytes: 3_000 })
  const msg = big(200)
  assert.equal(await out.send(msg), 'parts')
  assert.ok(frames.length > 1 && frames.every(isPart))
  const got: unknown[] = []
  const inn = receiver({ deliver: (m) => got.push(m) })
  for (const f of [...frames].reverse()) await inn.receive(f)   // any order
  assert.deepEqual(got, [msg])
  assert.equal(inn.pending(), 0)
})

test('a missing part keeps the message pending; two ids interleave', async () => {
  const frames: unknown[] = []
  const out = sender({ send: (f) => frames.push(f), limit: 10_000, partBytes: 3_000 })
  await out.send({ ...big(100), reqId: 'a' })
  await out.send({ ...big(100), reqId: 'b' })
  const got: unknown[] = []
  const inn = receiver({ deliver: (m) => got.push(m) })
  const parts = frames.filter(isPart)
  for (const f of parts.slice(0, -1)) await inn.receive(f)
  assert.equal(inn.pending(), 1)
  await inn.receive(parts[parts.length - 1])
  assert.equal(got.length, 2); assert.equal(inn.pending(), 0)
})

test('with a store, a large message goes as a parcel: the summary travels, the body is fetched', async () => {
  const store = new Map<string, string>()
  const parcels = {
    put: async (body: string): Promise<Parcel> => { const hash = `h${store.size}`; store.set(hash, body); return { hash, bytes: body.length, ticket: 'tk' } },
    get: async (p: Parcel) => store.get(p.hash) ?? Promise.reject(new Error('no such parcel')),
  }
  const frames: any[] = []
  const out = sender({ send: (f) => frames.push(f), limit: 10_000, parcels })
  const msg = big(200)
  assert.equal(await out.send(msg), 'parcel')
  assert.equal(frames.length, 1)
  assert.equal(frames[0].t, 'app:answer'); assert.equal(frames[0].words, 'w'); assert.ok(!('rows' in frames[0])); assert.ok(frames[0].parcel.hash)
  const got: unknown[] = []
  const inn = receiver({ deliver: (m) => got.push(m), parcels })
  await inn.receive(frames[0])
  assert.deepEqual(got, [msg])
})

test('a store that fails falls back to parts, and says so', async () => {
  const frames: unknown[] = []
  let why = ''
  const out = sender({ send: (f) => frames.push(f), limit: 10_000, partBytes: 3_000, parcels: { put: async () => { throw new Error('bucket down') } }, onFallback: (w) => { why = w } })
  assert.equal(await out.send(big(200)), 'parts')
  assert.equal(why, 'bucket down'); assert.ok(frames.every(isPart))
})

test('a receiver without a store delivers a pointer it cannot resolve, marked', async () => {
  const got: any[] = []
  const inn = receiver({ deliver: (m) => got.push(m), parcels: { get: async () => { throw new Error('no ticket') } } })
  await inn.receive({ t: 'app:answer', id: 'x', parcel: { hash: 'h', bytes: 1, ticket: 't' } })
  assert.equal(got[0].parcelError, 'no ticket')
})
