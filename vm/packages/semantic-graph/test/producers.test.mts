// Where rows come from. A program spreads planned hours over working days and a second program builds a forecast on
// the sales it reads; a fact is a statement on another fact. An intervention on sales reaches both. Sources are
// checked when they are defined; a schema that would break a session's question is refused; a replay runs the exact
// program an answer ran, even after the name moved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraph, Store, type Query, type Schema, type Sources } from '../src/index.js'
import { instance as I, schema as base } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

function model() {
  const s: Schema = structuredClone(base)
  s.objects.Planned = { kind: 'fact', arrows: { project: 'Project', day: 'Day' }, measures: { hours: { unit: 'h', kind: 'flow', aggregate: 'sum' } } }
  s.objects.Forecast = { kind: 'fact', arrows: { project: 'Project', day: 'Day' }, measures: { hours: { unit: 'h', kind: 'flow', aggregate: 'sum' } } }
  s.objects.HardSale = { kind: 'fact', arrows: { person: 'Person', project: 'Project', day: 'Day' }, measures: { hours: { unit: 'h', kind: 'flow', aggregate: 'sum' } } }
  const { query, sources } = toSqlite(base, I)
  const src: Sources = structuredClone(sources)
  src.facts.Planned = { source: '@local', program: 'spread plan', arrows: { project: 'project_id' }, time: 'day', measures: { hours: 'hours' } }
  src.facts.Forecast = { source: '@local', program: 'forecast', arrows: { project: 'project_id' }, time: 'day', measures: { hours: 'hours' } }
  src.facts.HardSale = { source: 'DB', sql: `SELECT * FROM {{Sale}} x WHERE x."t:commitment" = 'Hard'`, arrows: { person: 'a:person', project: 'a:project' }, time: 'time', measures: { hours: 'm:hours' } }
  return { s, query, src }
}

// 4 hours a day on j1, Monday to Friday.
const SPREAD = `export default async (ctx, { from, to }) => {
  const rows = []
  for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) < to; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6) rows.push({ project_id: 'j1', day: d.toISOString().slice(0, 10), hours: ctx.assume('planned hours a day', 4) })
  }
  return rows
}`
// Sales so far, by project and day, grown by a tenth.
const FORECAST = `export default async (ctx) => {
  const byKey = new Map()
  for (const r of await ctx.rows('Sale')) { const k = r['a:project'] + '|' + r.time; byKey.set(k, (byKey.get(k) ?? 0) + r['m:hours']) }
  return [...byKey].map(([k, h]) => ({ project_id: k.split('|')[0], day: k.split('|')[1], hours: Math.round(h * 1.1 * 100) / 100 }))
}`

async function setup(wrap?: (q: Query) => Query) {
  const { s, query, src } = model()
  const g = createGraph({ store: new Store(':memory:'), query: wrap ? wrap(query) : query, today: () => '2026-10-10' })
  g.defineSchema('b', s, 't')
  g.defineProgram('spread plan', { produces: 'Planned', reads: { sources: [], objects: [] }, body: SPREAD }, 't')
  g.defineProgram('forecast', { produces: 'Forecast', reads: { sources: [], objects: ['Sale'] }, body: FORECAST }, 't')
  await g.defineSources('b', src, 't')
  return { g, s, src, query }
}
const B = { to: 'Branch', via: ['project', 'branch'] }
const WEEK = { from: '2026-09-07', to: '2026-09-14' }

test('a program produces a fact; its rows join the entities of a SQL source, read here to join', async () => {
  const { g } = await setup()
  const r = await g.ask({ measures: ['Planned.hours', 'Sale.hours'], by: [B], span: WEEK }, { model: 'b' })
  assert.ok(r.ok, (r as any).reason)
  assert.deepEqual(r.result.rows, [['b1', 20, 10], ['b3', null, 8]])
  const c = g.store.getCall(r.callId)!
  assert.ok(c.programs!['spread plan'].startsWith('program:'))
  assert.ok(c.statements.some((x) => x.source === 'program spread plan' && x.rows === 5))
  assert.ok(r.caveats.some((x) => /Planned produced by the program "spread plan" \(5 rows\)/.test(x)))
  const five = await g.ask({ measures: ['Planned.hours'], span: WEEK }, { model: 'b', assume: { 'planned hours a day': 5 } })
  assert.ok(five.ok && five.result.rows[0][0] === 25, 'a program reads settings like anything else')
})

test('a statement on another fact, and a program on the rows of another fact: an intervention on sales reaches both', async () => {
  const { g } = await setup()
  const q = { measures: ['HardSale.hours', 'Forecast.hours'], by: [B], span: { from: '2026-09-01', to: '2026-11-01' } }
  const c = await g.counterfactual(q, [{ on: 'Sale', match: { project: 'j1' }, scale: { hours: 2 } }], { model: 'b' })
  assert.ok(c.ok, JSON.stringify((c as any).intervened ?? c.actual))
  assert.deepEqual(c.rows.map((x) => [x.key[0], x.actual, x.intervened]), [['b1', [21, 23.1], [42, 46.2]], ['b3', [null, 8.8], [null, 8.8]]])
})

test('sources are checked when they are defined', async () => {
  const { g, src } = await setup()
  const missingColumn = structuredClone(src); missingColumn.facts.Sale.measures.hours = 'no such column'
  await assert.rejects(g.defineSources('b', missingColumn, 't'), /does not give its declared columns/)
  const circle = structuredClone(src); circle.facts.Sale.sql = 'SELECT * FROM {{HardSale}}'
  await assert.rejects(g.defineSources('b', circle, 't'), /in a circle/)
  const noProgram = structuredClone(src); noProgram.facts.Planned.program = 'nothing'
  await assert.rejects(g.defineSources('b', noProgram, 't'), /"nothing", which does not exist/)
  const wrongProgram = structuredClone(src); wrongProgram.facts.Planned.program = 'forecast'
  await assert.rejects(g.defineSources('b', wrongProgram, 't'), /produces Forecast, not Planned/)
  const noArrow = structuredClone(src); delete (noArrow.facts.Sale.arrows as any).project
  await assert.rejects(g.defineSources('b', noArrow, 't'), /Sale.project has no column/)
})

test('a program is held to what it declares and to its grain', async () => {
  const { g, src } = await setup()
  g.defineProgram('spread plan', { produces: 'Planned', reads: { sources: [], objects: [] }, body: `export default async (ctx) => ctx.query('DB', 'SELECT 1')` }, 't')
  const undeclared = await g.ask({ measures: ['Planned.hours'], span: WEEK }, { model: 'b' })
  assert.ok(!undeclared.ok && /read DB, which it does not declare/.test(undeclared.reason))
  g.defineProgram('spread plan', { produces: 'Planned', reads: { sources: [], objects: [] }, body: `export default async () => [{ project_id: 'j1', day: '2026-09-08', hours: 1 }, { project_id: 'j1', day: '2026-09-08', hours: 2 }]` }, 't')
  const twice = await g.ask({ measures: ['Planned.hours'], span: WEEK }, { model: 'b' })
  assert.ok(!twice.ok && /two rows for project_id j1, day 2026-09-08/.test(twice.reason))
  void src
})

test('an entity read here to join a computed fact is refused if its source holds rows back', async () => {
  const { g } = await setup((q) => async (source, sql, params, options) => { const rows = await q(source, sql, params, options); if (/FROM "Project"/.test(sql) && !/COUNT/.test(sql)) Object.defineProperty(rows, 'notes', { value: ['cut'] }); return rows })
  const r = await g.ask({ measures: ['Planned.hours'], by: [B], span: WEEK }, { model: 'b' })
  assert.ok(!r.ok && /Project: DB stopped at .* cannot be read here/.test(r.reason))
})

test('a schema that would break the question a session is on is refused unless replaced deliberately', async () => {
  const { g, s } = await setup()
  const sid = g.openSession(null, 'by state')
  await g.step(sid, { question: { measures: ['Sale.hours'], by: [{ to: 'State', via: ['project', 'state'] }] } }, { model: 'b' })
  const changed: Schema = structuredClone(s)
  delete changed.objects.Project.arrows!.state
  changed.equations = []
  assert.throws(() => g.defineSchema('b', changed, 't'), /would break what exists[^]*Project.state has no column|would break what exists[^]*session "by state"/)
  assert.doesNotThrow(() => g.defineSchema('b', changed, 't', 'state now comes through the branch', { breaking: true }))
})

test('a replay runs the program version the answer ran, after the name has moved', async () => {
  const { g } = await setup()
  const r = await g.ask({ measures: ['Planned.hours'], span: WEEK }, { model: 'b' })
  assert.ok(r.ok && r.result.rows[0][0] === 20)
  g.defineProgram('spread plan', { produces: 'Planned', reads: { sources: [], objects: [] }, body: SPREAD.replace("ctx.assume('planned hours a day', 4)", '8') }, 't', 'eight hours a day')
  const now = await g.ask({ measures: ['Planned.hours'], span: WEEK }, { model: 'b' })
  assert.ok(now.ok && now.result.rows[0][0] === 40)
  const again = await g.replay(r.callId, { model: 'b' })
  assert.ok(again.same && again.answer.ok && again.answer.result.rows[0][0] === 20)
})
