// A method written in the graph's terms with the parts left open: found inside a real question, applied to it, and
// carried to a different business without changing a word of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applicable, apply, canonical, ModelStore, patternOf, strategyText, toQuestion, type Strategy } from '../src/index.js'
import { schema as branches } from './fixtures/branches.js'

const span = { from: '2026-01-01', to: '2026-04-01' }

// "Measured per thing, look at it one level coarser as well" — nothing here mentions any business.
const coarser: Strategy = {
  name: 'one level up',
  about: 'a measure grouped by a thing is also worth seeing by what that thing belongs to',
  shape: { nodes: [{ id: 'fact', object: '?fact', root: true }, { id: 'thing', object: '?thing', group: true }], edges: [], measures: [{ at: 'fact' }] },
  refinements: [{ step: { refine: 'extend', node: 'thing', along: 'state' }, why: 'grouped by what it belongs to, one level up' }],
  says: ['how the coarser groups compare with the finer ones'],
  from: 'a conversation about branch reporting',
}

test('a method finds itself in a question, and says what its holes stand for', () => {
  const p = patternOf(branches, { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], span })
  assert.ok(p.ok)
  const found = applicable(p.pattern, [coarser])
  assert.ok(found.length >= 1)
  assert.equal(found[0].stands.fact, 'Sale')
  assert.equal(found[0].stands.thing, 'Branch')
})

test('applying a method turns the question into the one it says to ask, and says what it did', () => {
  const p = patternOf(branches, { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], span })
  assert.ok(p.ok)
  const [found] = applicable(p.pattern, [coarser])
  const done = apply(branches, p.pattern, coarser, found.binding)
  assert.ok(done.ok, done.ok ? '' : done.reason)
  assert.deepEqual(done.value.did, ['grouped by what it belongs to, one level up'])
  assert.equal(canonical(branches, toQuestion(branches, done.value.pattern)),
    canonical(branches, { measures: ['Sale.hours'], by: [{ to: 'State', via: ['project', 'branch', 'state'] }], span }))
})

test('a method that does not fit is not applied, and says why it could not be', () => {
  const p = patternOf(branches, { measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], span })
  assert.ok(p.ok)
  const [found] = applicable(p.pattern, [coarser])
  const done = apply(branches, p.pattern, coarser, found.binding)
  assert.equal(done.ok, false)
  assert.match((done as any).reason, /one level up: grouped by what it belongs to, one level up — Month has no link "state"/)
})

test('a method reads as a method, with what is open and what it then does', () => {
  const text = strategyText(coarser)
  assert.match(text, /open: \?fact \(the fact\), \?thing \(grouped by\)/)
  assert.match(text, /then: grouped by what it belongs to/)
  assert.match(text, /from: a conversation about branch reporting/)
})

test('a method is a recorded change of the model, checked like every other', () => {
  const g = new ModelStore(':memory:')
  const ctx = { by: 'test', reason: 'a method worth keeping' }
  assert.ok(g.createModel('m', ctx).ok)
  for (const op of [
    { op: 'add-entity', name: 'Region' }, { op: 'add-entity', name: 'Branch' }, { op: 'add-arrow', id: 'Branch.region', to: 'Region' },
    { op: 'add-calendar', name: 'Day', level: 'day' }, { op: 'add-fact', name: 'Sale' },
    { op: 'add-arrow', id: 'Sale.branch', to: 'Branch' }, { op: 'add-arrow', id: 'Sale.day', to: 'Day' },
    { op: 'add-measure', id: 'Sale.units', unit: 'units', kind: 'flow', aggregate: 'sum' },
  ] as any[]) assert.ok(g.apply('m', op, ctx).ok, op.op)

  const method: Strategy = { name: 'one level up', about: 'also worth seeing by what it belongs to',
    shape: { nodes: [{ id: 'fact', object: '?fact', root: true }, { id: 'thing', object: '?thing', group: true }], edges: [] },
    refinements: [{ step: { refine: 'extend', node: 'thing', along: 'region' }, why: 'grouped by what it belongs to' }] }
  assert.ok(g.apply('m', { op: 'add-strategy', name: method.name, strategy: method } as any, ctx).ok)
  assert.equal(Object.keys(g.state('m').strategies).length, 1)

  // A method that names something the model does not have cannot be kept: it could never match anything here.
  const bad = g.apply('m', { op: 'add-strategy', name: 'bad', strategy: { name: 'bad', about: '', shape: { nodes: [{ id: 'a', object: 'Nothing' }], edges: [] } } } as any, ctx)
  assert.equal(bad.ok, false)
  assert.match((bad as any).reason, /the method names Nothing, which is not in the model/)

  // And it survives being exported and built again, like the rest of the model.
  const again = new ModelStore(':memory:')
  again.import('m', g.export('m'), ctx)
  assert.equal(Object.keys(again.state('m').strategies ?? {}).length, 1)
  assert.ok(g.changes('m', { id: 'one level up' }).length >= 1, 'the change is findable by the method it touched')
})
