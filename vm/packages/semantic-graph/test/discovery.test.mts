// Filter conditions beyond a list, in memory and in SQL; and the graph as an agent sees it: a node, the paths between
// two, the nodes a word is, and which member someone meant by what they typed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { bestMembers, check, createGraph, evaluate, find, node, paths, runSql, Store, type Question, type Schema } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

const B = { to: 'Branch', via: ['project', 'branch'] }

test('filters: not in, nothing there, something there, labels containing or starting — the same in memory and in SQL', async () => {
  const { query, sources } = toSqlite(s, I)
  const cases: Array<[Question, unknown[][]]> = [
    [{ measures: ['Sale.hours'], by: [B], where: [{ to: 'Branch', via: ['project', 'branch'], notIn: ['b1'] }] }, [['b3', 8]]],
    [{ measures: ['Sale.hours'], where: [{ to: 'Person', via: ['project', 'sponsor'], none: true }] }, [[8]]],
    [{ measures: ['Sale.hours'], where: [{ to: 'Person', via: ['project', 'sponsor'], notIn: ['p3'] }] }, [[8]]],
    [{ measures: ['Sale.hours'], where: [{ to: 'Person', via: ['project', 'sponsor'], none: false }] }, [[21]]],
    [{ measures: ['Sale.hours'], by: [B], where: [{ to: 'Branch', via: ['project', 'branch'], contains: 'YDN' }] }, [['b1', 21]]],
    [{ measures: ['Sale.hours'], by: [B], where: [{ to: 'Branch', via: ['project', 'branch'], startsWith: 'per' }] }, [['b3', 8]]],
    [{ measures: ['Sale.hours'], where: [{ attribute: 'commitment', startsWith: 'so' }] }, [[8]]],
    [{ measures: ['Budget.budget'], where: [{ to: 'BudgetVersion', startsWith: 'Ba' }], currency: 'AUD', span: { from: '2026-09-01', to: '2026-11-01' } }, [[3000]]],
  ]
  for (const [q, expected] of cases) {
    const v = check(s, q)
    if (!v.ok) assert.fail(`${JSON.stringify(q.where)}: ${v.reason}`)
    assert.deepEqual(evaluate(s, I, v.plan).rows, expected, JSON.stringify(q.where))
    assert.deepEqual((await runSql(s, sources, v.plan, query)).rows, expected, `SQL: ${JSON.stringify(q.where)}`)
  }
  const never = check(s, { measures: ['Sale.hours'], where: [{ to: 'Branch', via: ['project', 'branch'], none: true }] })
  assert.ok(!never.ok && never.rule === 'A4')
  const two = check(s, { measures: ['Sale.hours'], where: [{ to: 'Branch', via: ['project', 'branch'], in: ['b1'], notIn: ['b3'] } as any] })
  assert.ok(!two.ok && /one condition/.test(two.reason))
})

test('a node, the paths between two, and the nodes a word is', () => {
  const branch = node(s, 'Branch')
  assert.deepEqual(branch.arrows, [{ role: 'state', to: 'State', kind: 'rollup' }])
  assert.ok(branch.pointedAtBy.some((p) => p.from === 'Project' && p.role === 'branch'))
  assert.equal(branch.members!.names!.Sydney, 'b1')
  assert.deepEqual(node(s, 'Sale').measures!.map((m) => m.name), ['hours', 'amount', 'rate', 'people'])
  assert.throws(() => node(s, 'branch office'), /no node "branch office"/)
  assert.ok(paths(s, 'Sale', 'Region').some((p) => p.join('.') === 'person.branch.state.region'))
  assert.deepEqual(find(s, 'sydney').map((f) => [f.kind, f.node, (f as any).key, f.as]), [['member', 'Branch', 'b1', 'its label; a name people use, "Sydney"']])
  assert.deepEqual(find(s, 'Soft').map((f) => [f.kind, f.node, (f as any).value]), [['attribute', 'Sale', 'Soft']])
  assert.deepEqual(find(s, 'sponsor').map((f) => [f.kind, f.node, (f as any).to]), [['role', 'Project', 'Person']])
  assert.deepEqual(find(s, 'turnover'), [])
})

test('which member was meant: exact, starting with, containing, a typing mistake — and ambiguity said', async () => {
  const people = [{ key: 'c1', label: 'Acme Corporation' }, { key: 'c2', label: 'Acme Pty Ltd' }, { key: 'c3', label: 'Globex' }, { key: 'c4', label: 'Initech' }]
  assert.deepEqual(bestMembers(people, 'globex'), { matches: [{ key: 'c3', label: 'Globex', how: 'exact' }], ambiguous: false })
  assert.deepEqual(bestMembers(people, 'acme').matches.map((m) => m.key), ['c1', 'c2'])
  assert.equal(bestMembers(people, 'acme').ambiguous, true)
  assert.deepEqual(bestMembers(people, 'tech').matches.map((m) => [m.key, m.how]), [['c4', 'contains']])
  assert.deepEqual(bestMembers(people, 'Glbex').matches.map((m) => [m.key, m.how, m.mistakes]), [['c3', 'close', 1]])
  assert.deepEqual(bestMembers(people, 'Umbrella').matches, [])

  const cs: Schema = { name: 'crm', objects: { Customer: { kind: 'entity' }, Day: { kind: 'calendar', level: 'day' }, Order: { kind: 'fact', arrows: { customer: 'Customer', day: 'Day' }, measures: { n: { unit: 'orders', kind: 'flow', aggregate: 'count' } } } } }
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE customer (id TEXT, name TEXT); CREATE TABLE orders (customer TEXT, day TEXT, n INTEGER)')
  for (const p of people) db.prepare('INSERT INTO customer VALUES (?, ?)').run(p.key, p.label)
  const g = createGraph({ store: new Store(':memory:'), query: async (_s, sql, params) => db.prepare(sql).all(params as any) as any[], today: () => '2026-10-10' })
  g.defineSchema('crm', cs, 't')
  await g.defineSources('crm', { facts: { Order: { source: 'DB', sql: 'SELECT * FROM orders', arrows: { customer: 'customer' }, time: 'day', measures: { n: 'n' } } },
    entities: { Customer: { source: 'DB', sql: 'SELECT * FROM customer', key: 'id', label: 'name', arrows: {} } } }, 't')
  assert.deepEqual((await g.members('crm', 'Customer', 'initech')).matches.map((m) => m.key), ['c4'])
  const acme = await g.members('crm', 'Customer', 'Acme')
  assert.ok(acme.ambiguous && acme.matches.length === 2)
  assert.deepEqual((await g.members('crm', 'Customer', 'Initeck')).matches.map((m) => [m.key, m.how]), [['c4', 'close']])
  assert.deepEqual((await g.members('crm', 'Customer', 'Umbrella')).matches, [])
})
