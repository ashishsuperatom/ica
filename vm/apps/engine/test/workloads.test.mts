// The engine's workloads (workloads.ts): a status goes up only when it changes, several together; nothing sent is lost
// when the hub is away (sent with the next change); every welcome sends everything again; one that goes is said to be
// gone; an action or a look goes to its kind's handler and its answer — or its failure, plainly — comes back with the
// request's id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkloads } from '../workloads.ts'

const tick = () => new Promise((r) => setTimeout(r, 260))
const make = () => { const sent: any[] = []; let up = true; const w = createWorkloads({ send: (m) => { if (!up) return false; sent.push(m); return true } }); return { w, sent, down: () => { up = false }, upAgain: () => { up = true } } }

test('only changes go up, together', async () => {
  const { w, sent } = make()
  w.set({ kind: 'connection', id: 'A', state: 'ready' }); w.set({ kind: 'connection', id: 'B', state: 'starting' })
  await tick()
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].statuses.map((s: any) => `${s.id}:${s.state}`), ['A:ready', 'B:starting'])
  w.set({ kind: 'connection', id: 'A', state: 'ready' })   // the same: nothing
  await tick(); assert.equal(sent.length, 1)
  w.update('connection', 'B', { state: 'ready' })
  await tick(); assert.deepEqual(sent[1].statuses.map((s: any) => `${s.id}:${s.state}`), ['B:ready'])
})

test('not delivered: kept and sent later; a welcome sends everything; gone is said', async () => {
  const { w, sent, down, upAgain } = make()
  down(); w.set({ kind: 'agent', id: 'composer', state: 'ready' }); await tick()
  assert.equal(sent.length, 0)
  upAgain(); w.set({ kind: 'agent', id: 'runner', state: 'ready' }); await tick()
  assert.deepEqual(sent[0].statuses.map((s: any) => s.id).sort(), ['composer', 'runner'])
  w.resend(); await tick(); assert.equal(sent[1].statuses.length, 2)
  w.gone('agent', 'runner'); await tick(); assert.deepEqual(sent[2].gone, [{ kind: 'agent', id: 'runner' }])
})

test('an action goes to its kind; its answer, or its failure, comes back with the request id', async () => {
  const { w, sent } = make()
  w.onAct('connection', async (id, action) => { if (action === 'boom') throw new Error('it would not'); return { note: `${action} ${id}` } })
  assert.equal(w.onMessage({ t: 'workload:act', kind: 'connection', id: 'A', action: 'test', reqId: 'r1' }), true)
  assert.equal(w.onMessage({ t: 'workload:act', kind: 'connection', id: 'A', action: 'boom', reqId: 'r2' }), true)
  assert.equal(w.onMessage({ t: 'workload:inspect', kind: 'engine', id: 'self', aspect: 'health', reqId: 'r3' }), true)
  assert.equal(w.onMessage({ t: 'something:else' }), false)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(sent.find((m) => m.reqId === 'r1'), { type: 'workload:acted', reqId: 'r1', note: 'test A' })
  assert.match(sent.find((m) => m.reqId === 'r2').error, /it would not/)
  assert.match(sent.find((m) => m.reqId === 'r3').error, /does not look into "health" of an engine/)
})
