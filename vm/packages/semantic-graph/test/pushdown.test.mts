// A filter travels towards the source when crossing a step cannot change whether it holds — and a program that
// says which of its fact's arrows it accepts is given the filter instead of being handed the whole span.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, pushable, pushedPlan, travel, type Question } from '../src/index.js'
import { schema as branches } from './fixtures/branches.js'

const span = { from: '2026-01-01', to: '2026-04-01' }
const planOf = (q: Question) => { const v = check(branches, q); assert.ok(v.ok, v.ok ? '' : `${v.rule}: ${v.reason}`); return v.plan }

test('a filter on one of the fact\'s own arrows reaches the source', () => {
  const plan = planOf({ measures: ['Sale.hours'], where: [{ to: 'Project', via: ['project'], in: ['p1'] }], span })
  const t = travel(branches, 'Sale', plan.facts[0].where[0] as any)
  assert.equal(t.to, 'source')
  assert.match(t.why, /every Sale row has exactly one Project/)
})

test('a filter through an arrow that may lead nowhere stays where it is, because those rows are kept as none', () => {
  const plan = planOf({ measures: ['Sale.hours'], where: [{ to: 'Person', via: ['project', 'sponsor'], in: ['x1'] }], span })
  const t = travel(branches, 'Sale', plan.facts[0].where[0] as any)
  assert.equal(t.to, 'here')
  assert.match(t.why, /may lead nowhere/)
})

test('a filter through a link that changes over time stays where it is, because the row\'s own date decides it', () => {
  const plan = planOf({ measures: ['Sale.hours'], where: [{ to: 'Branch', via: ['person', 'branch'], in: ['b1'] }], span })
  const t = travel(branches, 'Sale', plan.facts[0].where[0] as any)
  assert.equal(t.to, 'here')
  assert.match(t.why, /changes over time/)
})

test('a program is given the filters it says it accepts, and the rest are applied after', () => {
  const plan = planOf({ measures: ['Sale.hours'], where: [{ to: 'Project', via: ['project'], in: ['p1', 'p2'] }, { to: 'Person', via: ['project', 'sponsor'], in: ['x1'] }], span })
  const split = pushable(branches, plan.facts[0], { accepts: { project: true } })
  assert.deepEqual(split.pushed, [{ role: 'project', keys: ['p1', 'p2'] }])
  assert.equal(split.kept.length, 1, 'the sponsor filter is not pushed: that arrow may lead nowhere')
})

test('a program with no ports is given nothing, and everything is applied after', () => {
  const plan = planOf({ measures: ['Sale.hours'], where: [{ to: 'Project', via: ['project'], in: ['p1'] }], span })
  assert.deepEqual(pushable(branches, plan.facts[0], undefined).pushed, [])
  assert.equal(pushable(branches, plan.facts[0], undefined).kept.length, 1)
})

test('the plan says, per fact, what its reader is given and why the rest stays', () => {
  const plan = planOf({ measures: ['Sale.hours'], where: [{ to: 'Project', via: ['project'], in: ['p1'] }], span })
  const [sale] = pushedPlan(branches, plan, () => ({ accepts: { project: true } }))
  assert.equal(sale.fact, 'Sale')
  assert.match(sale.why.join('\n'), /Sale.project is given to the reader: 1 of them/)
})
