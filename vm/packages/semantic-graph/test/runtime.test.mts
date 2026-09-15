// The semantic graph running on SQLite with its own memory: definitions by hash and names with history, every answer
// recorded under the nodes it went through, refusals and failures recorded, sources that cut rows short refused,
// entities with repeated keys refused, access passed to the source, series, sessions as trees, bounded memory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraph, Store, type Query, type Schema } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

async function setup(options: { wrap?: (q: Query) => Query; limits?: ConstructorParameters<typeof Store>[1]; instance?: typeof I } = {}) {
  const { query, sources } = toSqlite(s, options.instance ?? I)
  const store = new Store(':memory:', options.limits)
  const g = createGraph({ store, query: options.wrap ? options.wrap(query) : query, today: () => '2026-10-10' })
  g.defineSchema('branches', s, 'test')
  await g.defineSources('branches', sources, 'test')
  return { g, store }
}
const B = { to: 'Branch', via: ['project', 'branch'] }

test('definitions are content: the same schema twice is one; a change moves the name and keeps what it meant', async () => {
  const { g, store } = await setup()
  const again = g.defineSchema('branches', structuredClone(s), 'test')
  assert.equal(again.moved, false)
  const before = Date.now()
  await new Promise((r) => setTimeout(r, 5))
  const changed: Schema = structuredClone(s)
  changed.objects.Branch.names = { Sydney: 'b1', Perth: 'b3' }
  const moved = g.defineSchema('branches', changed, 'test', 'Perth is a name people use')
  assert.equal(moved.moved, true)
  assert.equal(store.history('schema', 'branches').length, 2)
  assert.notEqual(store.resolveAt('schema', 'branches', before), moved.hash)
  assert.throws(() => g.defineSchema('bad', { name: 'bad', objects: { F: { kind: 'fact', arrows: { x: 'Nowhere' } } } }, 'test'), /not well formed/)
})

test('an answer is recorded: question, canonical form, plan, SQL, rows, the day, who, and the nodes it went through', async () => {
  const { g, store } = await setup()
  const a = await g.ask({ measures: ['Sale.hours'], by: [B] }, { model: 'branches', who: { id: 'ana' } })
  assert.ok(a.ok)
  const c = store.getCall(a.callId)!
  assert.deepEqual(c.output && (c.output as any).rows, [['b1', 21], ['b3', 8]])
  assert.equal(c.today, '2026-10-10')
  assert.deepEqual(c.who, { id: 'ana' })
  assert.ok(c.statements.some((x) => /GROUP BY/.test(x.sql)) && c.statements.every((x) => x.ms >= 0))
  for (const n of ['Sale', 'Sale.hours', 'Sale.project', 'Project.branch', 'Branch']) assert.ok(c.nodes.includes(n), n)
  assert.deepEqual(store.callsThrough('Project.branch').map((x) => x.id), [a.callId])
  assert.deepEqual(store.callsThrough('Person.branch'), [])
})

test('a refusal is remembered with its rule; so is a failure', async () => {
  const { g, store } = await setup()
  const r = await g.ask({ measures: ['Sale.hours'], by: [{ to: 'Branch' }] }, { model: 'branches' })
  assert.ok(!r.ok && r.rule === 'A2')
  assert.equal(store.getCall(r.callId)!.refusal!.rule, 'A2')
  assert.equal(store.counts().refused, 1)
})

test('rows a source cut short are never an answer', async () => {
  const { g, store } = await setup({ wrap: (q) => async (...args) => { const rows = await q(...args); Object.defineProperty(rows, 'notes', { value: ['Row limit applied'] }); return rows } })
  const r = await g.ask({ measures: ['Sale.hours'], by: [{ to: 'Month' }] }, { model: 'branches' })
  assert.ok(!r.ok && /stopped at/.test(r.reason))
  assert.ok(store.getCall(r.callId)!.statements.some((x) => x.capped))
})

test('an entity with a repeated key is refused when its source is defined, and again if the data changes after', async () => {
  const { query, sources } = toSqlite(s, I)
  const doubled: Query = async (source, sql, params, options) => query(source, sql.replace(/FROM "Project"/g, 'FROM (SELECT * FROM "Project" UNION ALL SELECT * FROM "Project")'), params, options)
  const store = new Store(':memory:')
  const broken = createGraph({ store, query: doubled, today: () => '2026-10-10' })
  broken.defineSchema('branches', s, 'test')
  await assert.rejects(broken.defineSources('branches', sources, 'test'), /Project is an entity, but its source has 4 rows for 2 keys/)
  await createGraph({ store, query, today: () => '2026-10-10' }).defineSources('branches', sources, 'test')
  const r = await broken.ask({ measures: ['Sale.hours'], by: [B] }, { model: 'branches' })
  assert.ok(!r.ok && /Project has one row per key does not hold/.test(r.reason))
})

test('what the person may read goes with every statement', async () => {
  const seen: unknown[] = []
  const { g } = await setup({ wrap: (q) => async (source, sql, params, options) => { seen.push(options?.policies); return q(source, sql, params, options) } })
  seen.length = 0
  await g.ask({ measures: ['Sale.hours'] }, { model: 'branches', access: { DB: [{ row: 'branch = b1' }] } })
  assert.ok(seen.length && seen.every((p) => JSON.stringify(p) === '[{"row":"branch = b1"}]'))
})

test('answers by month become series; the same question in other words adds to the same series', async () => {
  const { g, store } = await setup()
  const a = await g.ask({ measures: ['Sale.hours'], by: [B, { to: 'Month' }], span: { from: '2026-09-01', to: '2026-10-01' } }, { model: 'branches' })
  const b = await g.ask({ measures: ['Sale.hours'], by: [B, { to: 'Month' }], span: { from: '2026-10-01', to: '2026-11-01' }, order: { by: 'Sale.hours' } }, { model: 'branches' })
  assert.ok(a.ok && b.ok)
  const obs: any = store.db.prepare('SELECT DISTINCT series FROM observation').all()
  assert.equal(obs.length, 1)
  assert.deepEqual(store.series({ series: obs[0].series, group: '["b1"]', output: 'Sale.hours', level: 'Month' }).map((x) => [x.period, x.value]), [['2026-09', 15], ['2026-10', 6]])
})

test('a session is a tree of questions and moves; a refused move is kept but does not become current', async () => {
  const { g, store } = await setup()
  const sid = g.openSession({ id: 'ana' }, 'hours')
  const first = await g.step(sid, { question: { measures: ['Sale.hours'], by: [B] } }, { model: 'branches' })
  const up = await g.step(sid, { move: { move: 'drill up', target: 0, along: 'state' } }, { model: 'branches' })
  assert.ok(up.answer.ok)
  assert.deepEqual((up.answer as any).result.rows, [['NSW', 21], ['WA', 8]])
  const bad = await g.step(sid, { move: { move: 'add measure', measure: 'Budget.budget' } }, { model: 'branches' })
  assert.ok(!bad.answer.ok)
  assert.equal(store.getSession(sid)!.currentStep, up.stepId)
  const branch = await g.step(sid, { move: { move: 'slice', where: { attribute: 'commitment', in: ['Hard'] } }, from: first.stepId }, { model: 'branches' })
  assert.deepEqual((branch.answer as any).result.rows, [['b1', 21]])
  const steps = store.steps(sid)
  assert.deepEqual(steps.map((x) => x.parent), [null, first.stepId, up.stepId, first.stepId])
  assert.equal(store.getCall((branch.answer as any).callId)!.sessionId, sid)
})

test('memory is bounded, and what it lets go of is counted', async () => {
  const { g, store } = await setup({ limits: { keptRows: 1, fullCalls: 2, calls: 3 } })
  const ids: string[] = []
  for (let i = 0; i < 5; i++) ids.push((await g.ask({ measures: ['Sale.hours'], by: [B] }, { model: 'branches' })).callId)
  const kept = store.getCall(ids[4])!.output as any
  assert.equal(kept.rows.length, 1); assert.equal(kept.totalRows, 2); assert.equal(kept.truncated, true)
  assert.deepEqual(store.compact(), { stripped: 1, removed: 2 })
  assert.equal(store.getCall(ids[0]), null)
  assert.equal(store.getCall(ids[2])!.output, null)
  assert.ok(store.getCall(ids[2])!.canonical)
})
