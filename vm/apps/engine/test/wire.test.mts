// The engine's wire: a large message (in parts, or a parcel) is handled with the sender as stamped on the frame that
// completed it — who they are now, the environment they are attached to now — never as on the first message heard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWire } from '../wire.ts'

test('a large message carries its own sender\'s stamp, not the first message\'s', async () => {
  const handled: { t: unknown; dev: unknown }[] = []
  const parcels = { put: async () => 'k', get: async (k: string) => JSON.stringify({ t: 'program:build', files: { big: k } }) } as any
  const wire = createWire({ emit: () => {}, handle: (whole, from) => handled.push({ t: whole.t, dev: from?.dev?.id ?? null }), parcels })
  const sacli = (dev: string | null) => ({ id: 'pg-key1', type: 'agent', ...(dev ? { dev: { id: dev } } : {}) })
  assert.equal(wire.receive({ parcel: 'p1', t: 'program:build', reqId: 'r1' }, sacli(null)), true)       // before attaching
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(wire.receive({ parcel: 'p2', t: 'program:build', reqId: 'r2' }, sacli('dv_new')), true)   // attached since
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(handled, [{ t: 'program:build', dev: null }, { t: 'program:build', dev: 'dv_new' }])
})
