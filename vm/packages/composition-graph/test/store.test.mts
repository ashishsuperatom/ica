import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore, Store, compose, drift, hashOf } from '../src/node.ts'

const by = { by: 'test', reason: 'a test' }
const graph = () => {
  const s = openStore(':memory:')
  s.put('d/definitions', 'concept', { title: 'Definitions', form: 'bullets', items: ['a is a', 'b is b'] }, by)
  s.put('d/examples', 'concept', { title: 'Examples', form: 'worked', items: [{ question: 'Q?', steps: ['one', 'two'] }] }, by)
  s.put('d/run.mjs', 'file', { name: 'run.mjs', text: 'console.log(1)' }, by)
  s.put('d', 'domain', { capabilities: ['c'], concepts: ['d/definitions', 'd/examples'], files: ['d/run.mjs'], tools: ['query'] }, by)
  return s
}

test('content is stored by hash; the same content again is no change', () => {
  const s = graph()
  const again = s.put('d/definitions', 'concept', { form: 'bullets', items: ['a is a', 'b is b'], title: 'Definitions' }, by)
  assert.equal(again.changed, false)
  assert.equal(s.history('d/definitions').length, 1)
  assert.equal(s.get('d/definitions')!.hash, hashOf({ title: 'Definitions', form: 'bullets', items: ['a is a', 'b is b'] }))
})

test('an edit moves the name, keeps the old content, and records who, why and from what', () => {
  const s = graph()
  const before = s.get('d/definitions')!.hash
  s.put('d/definitions', 'concept', { title: 'Definitions', form: 'bullets', items: ['a is A'] }, { by: 'ana', reason: 'a was wrong', from: 'thread 12' })
  const h = s.history('d/definitions')
  assert.equal(h.length, 2)
  assert.deepEqual([h[1].fromHash, h[1].by, h[1].reason, h[1].from], [before, 'ana', 'a was wrong', 'thread 12'])
  assert.deepEqual((s.content(before) as any).items, ['a is a', 'b is b'])
})

test('the graph as of a moment is the last change before it; a removed name is gone now but not then', async () => {
  const s = graph()
  const then = Date.now(); await new Promise((r) => setTimeout(r, 5))
  s.put('d/definitions', 'concept', { title: 'Definitions', form: 'bullets', items: ['changed'] }, by)
  s.remove('d/run.mjs', by)
  assert.deepEqual((s.get('d/definitions', then)!.body as any).items, ['a is a', 'b is b'])
  assert.equal(s.get('d/run.mjs'), null)
  assert.ok(s.get('d/run.mjs', then))
})

test('compose is byte-for-byte the same for the same pieces, says what it used, and drift names what moved since', () => {
  const s = graph()
  const a = compose(s, 'd'), b = compose(s, 'd')
  assert.equal(a.text, b.text)
  assert.match(a.text, /^You are Superatom's agent for d at this organisation\.\n\n# How every answer is given/)
  assert.match(a.text, /# Definitions\n- a is a\n- b is b\n\n# Examples\n## Q\?\n1\. one\n2\. two\n\nIn your folder, from this domain: run\.mjs\.$/)
  assert.deepEqual(Object.keys(a.used).sort(), ['d', 'd/definitions', 'd/examples', 'd/run.mjs'])
  assert.deepEqual(drift(s, a.used), [])
  s.put('d/examples', 'concept', { title: 'Examples', form: 'worked', items: [] }, by)
  assert.deepEqual(drift(s, a.used).map((x) => x.name), ['d/examples'])
})

test('a domain naming a concept that is not there is refused, not composed without it', () => {
  const s = graph()
  s.remove('d/examples', by)
  assert.throws(() => compose(s, 'd'), /names concept "d\/examples"/)
})

test('a question is recorded with the agent it went to and how, newest first, by domain', () => {
  const s = graph()
  s.recordQuestion({ session: 's1', qid: 'q1', question: 'first', domain: 'd', how: 'routed', ranked: [{ domain: 'd', score: 2, terms: ['x'] }] })
  s.recordQuestion({ session: 's1', qid: 'q2', question: 'follow-up', domain: 'd', how: 'session' })
  const qs = s.questions(10, 'd')
  assert.deepEqual(qs.map((q) => [q.question, q.how]), [['follow-up', 'session'], ['first', 'routed']])
  assert.equal(qs[1].domainHash, s.get('d')!.hash)
  assert.deepEqual((qs[1].ranked as any)[0].terms, ['x'])
})

test('a domain names its settings: their values come with the composition, and the prompt lists them', () => {
  const s = graph()
  s.put('utilisation-threshold-setting', 'setting', { value: -0.3, description: 'a week under this variance is red' }, by)
  const d = s.get('d')!.body as any
  s.put('d', 'domain', { ...d, settings: ['utilisation-threshold-setting'] }, by)
  const c = compose(s, 'd')
  assert.deepEqual(c.settings, { 'utilisation-threshold-setting': -0.3 })
  assert.match(c.text, /# Settings \(in settings\.json; the programs read them there\)\n- utilisation-threshold-setting: -0\.3 — a week under this variance is red/)
  assert.ok(c.used['utilisation-threshold-setting'])
})
