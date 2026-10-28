// Placing a question in the intent graph (intent.ts): a node followed, a node made (its links kept to known domains, its
// agent only one the person may use), a reaction to the answer staying where it is, and an unplaceable message still
// answered — at a new node on the domain its words reach. The platform and the placing model are scripted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIntents } from '../intent.ts'

const here = { id: 'procurement-aaaaaa1', cluster: 'procurement', title: 'Open RFQs', intent: 'Which RFQs are open', links: [{ kind: 'domain', name: 'Procurement' }], agent: null, stale: null, passages: 3 }
const bids = { ...here, id: 'procurement-bbbbbb2', title: 'Bids for an RFQ', intent: 'The bids for one RFQ' }
const ctx = { here, next: [{ ...bids, count: 2, scope: 'user:u1' }], similar: [], domains: [{ name: 'Procurement', title: 'Procurement', description: '' }], agents: [{ name: 'builder', title: 'Builder', description: 'builds programs', allowed: true }, { name: 'connector', title: 'Connector', description: 'connects sources', allowed: false }], total: 2 }

function harness(verdict: any | Error) {
  const sent: any[] = []
  const it = createIntents({ cwd: '/tmp', send: (m) => { sent.push(m); queueMicrotask(() => it.onMessage(m.type === 'intent:context' ? { t: 'intent:context', reqId: m.reqId, ...ctx } : { t: 'intent:recorded', reqId: m.reqId, node: { ...bids, id: 'procurement-new0001' } })); return true },
    judge: async () => { if (verdict instanceof Error) throw verdict; return verdict } })
  return { it, sent }
}
const q = (text: string) => ({ text, recent: [], at: here.id, caps: ['project.ask', 'project.develop'], scopes: ['user:u1'], fallbackDomain: async () => 'Procurement' })

test('a node that answers it completely is followed', async () => {
  const { it } = harness({ asks: 'request', standalone: 'bids for RFQ-9', node: bids.id, why: 'same request, another RFQ' })
  const p = await it.place(q('and the bids for RFQ-9?'))
  assert.equal(p.how, 'followed'); assert.equal(p.node?.id, bids.id); assert.equal(p.standalone, 'bids for RFQ-9')
})

test('no node answers it: a new one, linked only to known domains, its agent one the project has (whether this person may use it is decided when it is answered)', async () => {
  const { it } = harness({ asks: 'request', node: null, new: { title: 'Build a should-cost program', intent: 'A program computing should-cost', links: [{ kind: 'domain', name: 'Procurement' }, { kind: 'domain', name: 'Imaginary' }], agent: 'builder' }, why: 'asks for a program' })
  const p = await it.place(q('build me a should-cost program'))
  assert.equal(p.how, 'made'); assert.equal(p.node, null)
  assert.deepEqual(p.body?.links, [{ kind: 'domain', name: 'Procurement' }]); assert.equal(p.body?.agent, 'builder')
  const { it: it2 } = harness({ asks: 'request', node: null, new: { title: 'Connect', intent: 'connect a source', links: [], agent: 'connector' } })
  const p2 = await it2.place(q('connect our ERP'))
  assert.equal(p2.body?.agent, 'connector')   // a request for its work, though this person may not use it: refused when answered
  const { it: it3 } = harness({ asks: 'request', node: null, new: { title: 'X', intent: 'x', links: [], agent: 'imaginary' } })
  assert.equal((await it3.place(q('x'))).body?.agent, null)   // an agent the project does not have, never
  assert.deepEqual(p2.body?.links, [{ kind: 'domain', name: 'Procurement' }])   // none given: the domain its words reach
})

test('a node it names that was not offered is never followed', async () => {
  const { it } = harness({ asks: 'request', node: 'procurement-zzzzzz9', new: null })
  assert.equal((await it.place(q('anything'))).how, 'made')
})

test('a reaction to the answer stays at the node', async () => {
  const { it } = harness({ asks: 'about-answer', node: null, why: 'asks for a line chart' })
  const p = await it.place(q('show that as a line chart'))
  assert.equal(p.how, 'stayed'); assert.equal(p.node?.id, here.id)
})

test('a message the model cannot place is still answered: a new node on the domain its words reach', async () => {
  const { it } = harness(new Error('the model said nothing'))
  const p = await it.place(q('something odd'))
  assert.equal(p.how, 'made'); assert.deepEqual(p.body?.links, [{ kind: 'domain', name: 'Procurement' }]); assert.match(p.why, /not placed/)
})

test('what happened is told to the platform: the node (made from its body when new), the way from the node before', async () => {
  const { it, sent } = harness({ asks: 'request', node: null, new: { title: 'T', intent: 'I', links: [{ kind: 'domain', name: 'Procurement' }] } })
  const p = await it.place(q('new thing'))
  const n = await it.record({ placed: p, from: here.id, session: 's1', block: 'b1', question: 'new thing', answer: 'done', who: 'user:u1', scope: 'user:u1' })
  assert.equal(n?.id, 'procurement-new0001')
  const rec = sent.find((m) => m.type === 'intent:record')
  assert.equal(rec.node, null); assert.equal(rec.body.title, 'T'); assert.equal(rec.from, here.id); assert.equal(rec.how, 'made')
})
