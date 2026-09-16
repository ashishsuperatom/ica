// What can be done to a pattern: glue two questions at the node they share, refine one into a more specific one,
// and find a method's shape inside it. These are DETERMINISTIC properties — whether an agent asks better questions
// is not decided here, but by running real ones through the composer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonical, check, glue, instantiate, match, patternOf, refine, routeTo, toQuestion, type Pattern } from '../src/index.js'
import { schema as branches } from './fixtures/branches.js'

const span = { from: '2026-01-01', to: '2026-04-01' }
const pattern = (q: any): Pattern => { const p = patternOf(branches, q); assert.ok(p.ok, p.ok ? '' : `${(p as any).rule}: ${(p as any).reason}`); return p.pattern }

test('two questions glue at the grouping they share, and the join is that one node', () => {
  const sales = pattern({ measures: ['Sale.amount'], by: [{ to: 'Month', via: ['day', 'month'] }], span, currency: 'AUD' })
  const budget = pattern({ measures: ['Budget.budget'], by: [{ to: 'Month', via: ['month'] }], where: [{ to: 'BudgetVersion', in: ['base'] }], span, currency: 'AUD' })
  const both = glue(sales, budget)
  assert.ok(both.ok, both.ok ? '' : both.reason)
  const months = both.value.nodes.filter((n) => n.object === 'Month' && n.group)
  assert.equal(months.length, 1, 'one Month node: that is what makes the two comparable')
  assert.deepEqual(both.value.outputs, ['Sale.amount', 'Budget.budget'])
  const q = toQuestion(branches, both.value)
  const verdict = check(branches, q)
  assert.ok(verdict.ok, verdict.ok ? '' : `${verdict.rule}: ${verdict.reason}`)
  assert.equal(verdict.plan.facts.length, 2)
})

test('glue refuses two questions asked over different spans', () => {
  const a = pattern({ measures: ['Sale.amount'], by: [{ to: 'Month', via: ['day', 'month'] }], span, currency: 'AUD' })
  const b = pattern({ measures: ['Budget.budget'], by: [{ to: 'Month', via: ['month'] }], where: [{ to: 'BudgetVersion', in: ['base'] }], span: { from: '2025-01-01', to: '2025-04-01' }, currency: 'AUD' })
  const both = glue(a, b)
  assert.equal(both.ok, false)
  assert.match((both as any).reason, /different spans/)
})

test('a refinement is a question one step more specific, and the question it came from is untouched', () => {
  const p = pattern({ measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], span })
  const branch = p.nodes.find((n) => n.object === 'Branch')!
  const up = refine(branches, p, { refine: 'extend', node: branch.id, along: 'state' })
  assert.ok(up.ok, up.ok ? '' : up.reason)
  assert.equal(p.nodes.find((n) => n.object === 'Branch')!.group!.order, 0, 'the original still groups by Branch')
  const q = toQuestion(branches, up.value)
  assert.equal(canonical(branches, q), canonical(branches, { measures: ['Sale.hours'], by: [{ to: 'State', via: ['project', 'branch', 'state'] }], span }))
})

test('refining back towards the fact is the other direction, along the route the graph actually took', () => {
  // project.branch.state and project.state are the same path under the schema's equations, and the pattern holds
  // the normal form — so stepping back from State lands on Project, which is what the graph really walked.
  const p = pattern({ measures: ['Sale.hours'], by: [{ to: 'State', via: ['project', 'branch', 'state'] }], span })
  const state = p.nodes.find((n) => n.object === 'State')!
  const down = refine(branches, p, { refine: 'contract', node: state.id })
  assert.ok(down.ok, down.ok ? '' : down.reason)
  assert.equal(canonical(branches, toQuestion(branches, down.value)), canonical(branches, { measures: ['Sale.hours'], by: [{ to: 'Project', via: ['project'] }], span }))
})

test('a refinement that the graph does not hold is refused, and says what the links are', () => {
  const p = pattern({ measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], span })
  const branch = p.nodes.find((n) => n.object === 'Branch')!
  const bad = refine(branches, p, { refine: 'extend', node: branch.id, along: 'country' })
  assert.equal(bad.ok, false)
  assert.match((bad as any).reason, /Branch has no link "country" — its links are state/)
})

test('a method written as holes is recognised in a question, and says what each hole stands for', () => {
  const p = pattern({ measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], where: [{ to: 'Branch', via: ['project', 'branch'], in: ['b1'] }], span })
  // "some fact, measured, grouped by a thing it reaches" — no mention of this business at all.
  const found = match(p, { nodes: [{ id: 'f', object: '?fact', root: true }, { id: 'x', object: '?thing', group: true }], edges: [], measures: [{ at: 'f' }] })
  assert.ok(found.length >= 1)
  assert.equal(p.nodes.find((n) => n.id === found[0].f)!.object, 'Sale')
  assert.equal(p.nodes.find((n) => n.id === found[0].x)!.object, 'Branch')
})

test('a method fills its holes with real objects', () => {
  const made = instantiate(branches, { nodes: [{ id: 'f', object: '?fact', root: true }, { id: 'x', object: '?thing', group: true }], edges: [{ from: 'f', to: 'x', role: 'person' }] }, { f: 'Sale', x: 'Person' })
  assert.ok(made.ok, made.ok ? '' : made.reason)
  assert.equal(made.value.edges[0].role, 'person')
})

test('a node knows the route it was reached by, in normal form', () => {
  const p = pattern({ measures: ['Sale.hours'], by: [{ to: 'Region', via: ['project', 'branch', 'state', 'region'] }], span })
  const region = p.nodes.find((n) => n.object === 'Region')!
  assert.deepEqual(routeTo(branches, p, region.id), { fact: 'Sale', path: ['project', 'state', 'region'] })
})
