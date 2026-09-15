// do() on the data for one question: rows left out, measures set or scaled, rows added, where an entity's arrow leads
// — from a date, for one that changes over time. Each is applied in memory and wrapped around the source's SQL, and
// the two must give the same answer; through the runtime the answer is hypothetical, recorded as such, and adds
// nothing to memory's series; a counterfactual lines the two answers up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyToInstance, check, createGraph, evaluate, intervenedSources, runSql, sqlite, Store, type Intervention, type Question } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

const B = { to: 'Branch', via: ['project', 'branch'] }
const P = { to: 'Branch', via: ['person', 'branch'] }

const CASES: Array<[string, Question, Intervention[], unknown[][]]> = [
  ['soft sales left out', { measures: ['Sale.hours'], by: [B] }, [{ on: 'Sale', match: { commitment: 'Soft' }, remove: true }], [['b1', 21]]],
  ['j1 hours doubled', { measures: ['Sale.hours'], by: [B] }, [{ on: 'Sale', match: { project: 'j1' }, scale: { hours: 2 } }], [['b1', 42], ['b3', 8]]],
  ['a rate set (j2 is in NZD, 0.9 to AUD)', { measures: ['Sale.rate'], by: [B], currency: 'AUD' }, [{ on: 'Sale', match: { project: ['j1', 'j2'] }, set: { rate: 200 } }], [['b1', 200], ['b3', 180]]],
  ['a sale added in November', { measures: ['Sale.hours'], by: [{ to: 'Month' }] },
    [{ on: 'Sale', add: [{ arrows: { person: 'p3', project: 'j2', day: '2026-11-02' }, attributes: { commitment: 'Soft', currency: 'AUD' }, measures: { hours: 7, amount: 700, rate: 100 } }] }],
    [['2026-09', 23], ['2026-10', 6], ['2026-11', 7]]],
  ['j2 moved to Sydney', { measures: ['Sale.hours'], by: [B] }, [{ on: 'Project', keys: ['j2'], arrows: { branch: 'b1' } }], [['b1', 29]]],
  ['p2 moved to Melbourne from 1 October', { measures: ['Sale.hours'], by: [P] }, [{ on: 'Person', keys: ['p2'], arrows: { branch: 'b2' }, from: '2026-10-01' }], [['b1', 18], ['b2', 11]]],
  ['a stock scaled', { measures: ['Headcount.people'], by: [{ to: 'Branch' }, { to: 'Quarter' }] }, [{ on: 'Headcount', match: { branch: 'b1' }, scale: { people: 2 } }], [['b1', '2026-Q3', 14], ['b2', '2026-Q3', 0]]],
]

test('each intervention gives the same answer in memory and in SQL — and the answer worked out by hand', async () => {
  const { query, sources } = toSqlite(s, I)
  for (const [name, q, ivs, expected] of CASES) {
    const v = check(s, q)
    if (!v.ok) assert.fail(`${name}: ${v.reason}`)
    const mem = evaluate(s, applyToInstance(s, I, ivs), v.plan).rows
    assert.deepEqual(mem, expected, `${name}: by hand`)
    assert.deepEqual((await runSql(s, intervenedSources(s, sources, ivs, sqlite), v.plan, query)).rows, mem, `${name}: in SQL`)
  }
  // The data itself is untouched.
  assert.deepEqual(evaluate(s, I, (check(s, { measures: ['Sale.hours'], by: [B] }) as any).plan).rows, [['b1', 21], ['b3', 8]])
})

test('a hypothetical answer says so, is recorded with its interventions, and adds nothing to memory', async () => {
  const { query, sources } = toSqlite(s, I)
  const g = createGraph({ store: new Store(':memory:'), query, today: () => '2026-10-10' })
  g.defineSchema('b', s, 't'); await g.defineSources('b', sources, 't')
  const q: Question = { measures: ['Sale.hours'], by: [B, { to: 'Month' }], span: { from: '2026-09-01', to: '2026-11-01' } }
  const ivs: Intervention[] = [{ on: 'Sale', match: { project: 'j1' }, scale: { hours: 2 } }]
  const r = await g.ask(q, { model: 'b', intervene: ivs })
  assert.ok(r.ok && r.caveats.some((c) => /hypothetical: Sale where project j1: hours × 2/.test(c)))
  assert.deepEqual(g.store.getCall(r.callId)!.interventions, ivs)
  assert.equal(g.store.counts().observations, 0)

  const c = await g.counterfactual(q, ivs, { model: 'b' })
  assert.ok(c.ok)
  assert.deepEqual(c.rows.map((x) => [...x.key, x.actual[0], x.intervened[0], x.difference[0]]), [['b1', '2026-09', 15, 30, 15], ['b1', '2026-10', 6, 12, 6], ['b3', '2026-09', 8, 8, 0]])
  assert.equal(g.store.getCall(c.intervened!.callId)!.parentId, c.actual.callId)
  assert.ok(g.store.counts().observations > 0, 'the actual answer is remembered')

  const bad = await g.ask(q, { model: 'b', intervene: [{ on: 'Project', keys: ['j1'], arrows: { branch: 'b9' } }] })
  assert.ok(!bad.ok && bad.rule === 'intervention' && /Branch has no member b9/.test(bad.reason))

  const again = await g.replay(r.callId, { model: 'b' })
  assert.ok(again.same)
})
