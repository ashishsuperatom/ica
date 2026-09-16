// Work as a graph, pulled on demand: nothing runs until something asks, identical work is one node, and what is
// already known is not done again. Deterministic properties only — the agent's behaviour is judged by real runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, coldNodes, memoInMemory, needed, pull, workGraph, type Question } from '../src/index.js'
import { schema as branches } from './fixtures/branches.js'

const span = { from: '2026-01-01', to: '2026-04-01' }
const planOf = (q: Question) => { const v = check(branches, q); assert.ok(v.ok, v.ok ? '' : `${v.rule}: ${v.reason}`); return v.plan }
// One statement per fact, standing in for the compiler — the graph's shape does not depend on the SQL's text.
const statements = (fact: string) => [{ source: 'S', sql: `SELECT * FROM ${fact}`, params: {} }]

test('a question becomes a graph of work, and nothing has run', () => {
  const g = workGraph(planOf({ measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], span }), statements)
  const order = needed(g).map((n) => n.kind)
  assert.deepEqual(order, ['read', 'fold', 'derive'])
  assert.equal(g.nodes.get(g.root)!.kind, 'derive')
})

test('two facts side by side are two folds and a join', () => {
  const g = workGraph(planOf({ measures: ['Sale.amount', 'Budget.budget'], by: [{ to: 'Month', via: { Sale: ['day', 'month'], Budget: ['month'] } }],
    where: [{ to: 'BudgetVersion', via: { Budget: ['version'] }, in: ['base'] }], span, currency: 'AUD' }), statements)
  const kinds = needed(g).map((n) => n.kind)
  assert.equal(kinds.filter((k) => k === 'fold').length, 2)
  assert.equal(kinds.filter((k) => k === 'join').length, 1)
})

test('the same work is the same node, so two questions share what they have in common', () => {
  const a = workGraph(planOf({ measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], span }), statements)
  const b = workGraph(planOf({ measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], span, order: { by: 'Sale.hours', desc: true } }), statements)
  const reads = (g: typeof a) => needed(g).filter((n) => n.kind === 'read').map((n) => n.hash)
  assert.deepEqual(reads(b), reads(a), 'the same rows are read by one node')
  assert.notEqual(a.root, b.root, 'and the answers differ, because the ordering does')
})

test('only what is asked for runs, and what is known is not run again', async () => {
  const g = workGraph(planOf({ measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], span }), statements)
  const ran: string[] = []
  const memo = memoInMemory()
  const run = async (n: any) => { ran.push(n.kind); return n.kind }
  await pull(g, g.root, run, { memo })
  assert.deepEqual(ran, ['read', 'fold', 'derive'])
  await pull(g, g.root, run, { memo })
  assert.deepEqual(ran, ['read', 'fold', 'derive'], 'the second pull did no work at all')
})

test('what a question would cost is answerable before it runs', async () => {
  const memo = memoInMemory()
  const first = workGraph(planOf({ measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], span }), statements)
  assert.equal(coldNodes(first, memo).length, 3)
  await pull(first, first.root, async (n) => n.kind, { memo })
  // A second question over the same rows: the read is already known, so only its own work is left.
  const second = workGraph(planOf({ measures: ['Sale.hours'], by: [{ to: 'Month', via: ['day', 'month'] }], span, limit: 2 }), statements)
  const cold = coldNodes(second, memo)
  assert.ok(cold.length < 3, `${cold.length} nodes left, from ${needed(second).length}`)
  assert.ok(!cold.some((n) => n.kind === 'read'), 'the rows are not read again')
})
