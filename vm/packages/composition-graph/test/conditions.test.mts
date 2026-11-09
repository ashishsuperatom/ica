// CONDITIONS ON THE GRAPH'S EDGES (docs/connectors-plan.md 9f): what a condition may say (only the person's fields — nothing
// that reaches past them), and a domain composed for a person leaving out what is not theirs, whole.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, governance as g, compose, checkCondition, holds } from '../src/node.ts'

const fresh = () => openStore(join(mkdtempSync(join(tmpdir(), 'when-')), 'composition.sqlite'))
const root = { id: 'user:root', admin: true }
const text = (title: string, t: string) => ({ title, form: 'text', text: t })
const builder = { id: 'u1', role: 'member', caps: ['project.ask', 'project.connectors'] }
const reader = { id: 'u2', role: 'member', caps: ['project.ask'] }

test('a condition reads the person, and nothing else: their fields, text, numbers, comparisons', () => {
  assert.equal(checkCondition("user.caps.includes('project.connectors')"), null)
  assert.equal(checkCondition("user.role === 'admin' || (user.caps.includes('x') && !user.caps.includes('y'))"), null)
  assert.match(checkCondition("process.exit(1)")!, /reads only user/)
  assert.match(checkCondition("user.constructor.constructor('return process')()")!, /reads only user/)
  assert.match(checkCondition("user['constructor']")!, /may hold only/)
  assert.match(checkCondition("(() => true)()")!, /may hold only|not a function/)
  assert.match(checkCondition('true')!, /reads the person/)
  assert.equal(holds("user.caps.includes('project.connectors')", builder), true)
  assert.equal(holds("user.caps.includes('project.connectors')", reader), false)
  assert.equal(holds('user.nope.deeper', reader), false)   // fails → false, never lets a concept in
})

test('a domain composed for a person leaves out an edge whose condition is false — the concept and all it composes; composed for no one, everything', () => {
  const s = fresh()
  g.write(s, root, 'answering', 'concept', text('Answering', 'How answers are given.'))
  g.write(s, root, 'connector/building', 'concept', text('Building connectors', 'How a connector is built.'))
  g.write(s, root, 'connector/testing', 'concept', text('Testing connectors', 'How a connector is tried.'))
  g.write(s, root, 'connector/builder', 'concept', { title: 'The builder', form: 'composed', concepts: ['connector/building', 'connector/testing'] })
  const when = { 'connector/builder': "user.caps.includes('project.connectors')" }
  assert.throws(() => g.write(s, root, 'main', 'domain', { capabilities: [], concepts: ['answering'], files: [], when }), /when names "connector\/builder", which it does not compose/)
  assert.throws(() => g.write(s, root, 'main', 'domain', { capabilities: [], concepts: ['answering', 'connector/builder'], files: [], when: { 'connector/builder': 'process.exit()' } }), /reads only user/)
  g.write(s, root, 'main', 'domain', { capabilities: [], concepts: ['answering', 'connector/builder'], files: [], when })
  assert.match(compose(s, 'main', undefined, { person: builder }).text, /How a connector is built[\s\S]*How a connector is tried/)
  const forReader = compose(s, 'main', undefined, { person: reader }).text
  assert.match(forReader, /How answers are given/)
  assert.doesNotMatch(forReader, /connector is built|connector is tried/)
  assert.match(compose(s, 'main').text, /How a connector is built/)   // for no one (a console): every edge
  // an intermediate concept's own edges, the same way
  g.write(s, root, 'connector/builder', 'concept', { title: 'The builder', form: 'composed', concepts: ['connector/building', 'connector/testing'], when: { 'connector/testing': "user.role === 'admin'" } })
  const b = compose(s, 'main', undefined, { person: builder }).text
  assert.match(b, /connector is built/); assert.doesNotMatch(b, /connector is tried/)
})

test("a domain's sources are { only, remove }, names", () => {
  const s = fresh()
  g.write(s, root, 'answering', 'concept', text('Answering', 'How answers are given.'))
  assert.throws(() => g.write(s, root, 'teams', 'domain', { capabilities: [], concepts: ['answering'], files: [], sources: { only: 'MICROSOFT_365' } }), /sources are/)
  g.write(s, root, 'teams', 'domain', { capabilities: [], concepts: ['answering'], files: [], sources: { only: ['MICROSOFT_365'] } })
  assert.deepEqual(compose(s, 'teams').sources, { only: ['MICROSOFT_365'] })
})
