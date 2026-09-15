// The last capabilities the program graph had: comparison with an earlier span given outright, sessions whose steps
// change settings, interventions and the day, a catalog, programs whose decisions are recorded, and the datasource
// manager reached over HTTP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { catalog, check, createGraph, evaluate, managerDialects, managerQuery, Store, type Schema, type Sources } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

const B = { to: 'Branch', via: ['project', 'branch'] }

test('compared with an earlier span given outright, periods matched by their place', () => {
  const v = check(s, { measures: ['Sale.hours'], by: [{ to: 'Month' }], span: { from: '2026-10-01', to: '2026-11-01' }, compare: { span: { from: '2026-09-01', to: '2026-10-01' } } })
  assert.ok(v.ok)
  assert.deepEqual(evaluate(s, I, v.plan).rows, [['2026-10', 6, 23, -17]])
  const bad = check(s, { measures: ['Sale.hours'], by: [{ to: 'Month' }], span: { from: '2026-10-01', to: '2026-11-01' }, compare: { span: { from: '2026-09-15', to: '2026-10-01' } } })
  assert.ok(!bad.ok && bad.rule === 'D6')
})

test('a session step can change the settings, the interventions and the day its answers are given under', async () => {
  const { query, sources } = toSqlite(s, I)
  const g = createGraph({ store: new Store(':memory:'), query, today: () => '2026-10-10' })
  g.defineSchema('b', s, 't'); await g.defineSources('b', sources, 't')
  const sid = g.openSession(null, 'what if')
  const first = await g.step(sid, { question: { measures: ['Sale.hours'], by: [B], span: { previous: 'Month' } } }, { model: 'b' })
  assert.ok(first.answer.ok)
  assert.deepEqual((first.answer as any).result.rows, [['b1', 15], ['b3', 8]])
  const doubled = await g.step(sid, { move: { move: 'intervene', add: [{ on: 'Sale', match: { project: 'j1' }, scale: { hours: 2 } }] } }, { model: 'b' })
  assert.deepEqual((doubled.answer as any).result.rows, [['b1', 30], ['b3', 8]])
  const up = await g.step(sid, { move: { move: 'drill up', target: 0, along: 'state' } }, { model: 'b' })
  assert.deepEqual((up.answer as any).result.rows, [['NSW', 30], ['WA', 8]], 'the intervention carries to the next step')
  const steps = g.store.steps(sid)
  assert.deepEqual(steps.at(-1)!.question.span, { previous: 'Month' }, 'a relative span stays relative in the session')
  const back = await g.step(sid, { move: { move: 'unintervene' } }, { model: 'b' })
  assert.deepEqual((back.answer as any).result.rows, [['NSW', 15], ['WA', 8]])
  const later = await g.step(sid, { move: { move: 'as of', date: '2026-11-15' } }, { model: 'b' })
  assert.deepEqual((later.answer as any).result.rows, [['NSW', 6]], 'the previous month as of 15 November is October')
  const set = await g.step(sid, { move: { move: 'assume', set: { 'surprise threshold': 5 } } }, { model: 'b' })
  assert.equal(g.store.getCall((set.answer as any).callId)!.assumptions!.find((x) => x.name === 'surprise threshold')!.value, 5)
})

test('the catalog lists every fact, entity and calendar briefly', () => {
  const c = catalog(s)
  assert.ok(c.facts.some((f) => f.name === 'Sale' && f.measures.includes('rate (money/h, value-per-unit, weighted average)')))
  assert.ok(c.entities.some((e) => e.name === 'Person' && e.belongs.includes('branch → Branch (changes over time)')))
  assert.deepEqual(c.calendars.find((x) => x.name === 'Day'), { name: 'Day', cuts: 'day', rollsUpTo: ['Month'] })
})

test('a program\'s decisions are recorded with the answer, with how near a threshold was', async () => {
  const schema: Schema = { name: 'p', objects: { Day: { kind: 'calendar', level: 'day' }, Alert: { kind: 'fact', arrows: { day: 'Day' }, measures: { n: { unit: 'alerts', kind: 'flow', aggregate: 'sum' } } } } }
  const g = createGraph({ store: new Store(':memory:'), query: async () => [], today: () => '2026-10-10' })
  g.defineSchema('p', schema, 't')
  g.defineProgram('alerts', { produces: 'Alert', reads: { sources: [], objects: [] }, body: `export default async (ctx) => {
    const late = ctx.decideAt('late enough to alert', 9.5, '>=', ctx.assume('alert after hours', 10), 'hours since the last timesheet')
    ctx.caveat('timesheets are read as of this morning')
    return [{ day: '2026-10-09', n: late ? 1 : 0 }]
  }` }, 't')
  const sources: Sources = { facts: { Alert: { source: '@local', program: 'alerts', arrows: {}, time: 'day', measures: { n: 'n' } } }, entities: {} }
  await g.defineSources('p', sources, 't')
  const r = await g.ask({ measures: ['Alert.n'], span: { from: '2026-10-09', to: '2026-10-10' } }, { model: 'p' })
  assert.ok(r.ok)
  assert.deepEqual(r.result.rows, [[0]])
  assert.ok(r.caveats.includes('alerts: timesheets are read as of this morning'))
  assert.deepEqual(g.store.getCall(r.callId)!.decisions, [{ program: 'alerts', label: 'late enough to alert', took: false, reason: 'hours since the last timesheet', boundary: { value: 9.5, op: '>=', threshold: 10, margin: -0.5 } }])
  assert.equal(g.store.decidingCalls().length, 1)
})

test('the datasource manager over HTTP: rows, rows cut short, and the dialect of each source', async () => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/sources') return res.end(JSON.stringify({ sources: [{ id: 'NS', kind: 'sql', dialect: 'suiteql' }, { id: 'API', kind: 'rest' }, { id: 'LAKE', kind: 'sql', dialect: 'duckdb' }] }))
      const q = JSON.parse(body)
      res.end(JSON.stringify({ rows: [{ id: q.id, policies: q.policies ?? null }], ...(q.sql.includes('big') ? { notes: ['Row limit applied'] } : {}) }))
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  const url = `http://localhost:${(server.address() as any).port}`
  try {
    const query = managerQuery(url)
    const rows = await query('NS', 'SELECT 1', {}, { policies: [{ row: 'x' }] })
    assert.deepEqual(rows, [{ id: 'NS', policies: [{ row: 'x' }] }])
    assert.equal((rows as any).notes, undefined)
    assert.deepEqual((await query('NS', 'SELECT big', {}) as any).notes, ['Row limit applied'])
    const dialects = await managerDialects(url)
    assert.deepEqual(Object.fromEntries(Object.entries(dialects).map(([k, d]) => [k, d.name])), { NS: 'oracle', LAKE: 'duckdb' })
  } finally { server.close() }
})
