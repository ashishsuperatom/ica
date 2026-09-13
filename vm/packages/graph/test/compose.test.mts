// Composition by substitution: a relation program's {{name}} is replaced by that relation's SQL. These tests
// pin what must hold for that to be safe — with a fake source, so they run without a database. The live test at
// the end checks the one thing a fake cannot: that the composed SQL gives the same numbers as the SQL written
// by hand. It runs only when DATASOURCE_URL is set.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, createEngine, type Contract } from '../src/index.ts'

const FLOW_SHAPE = {
  dimensions: { pillar: { column: 'pillar_id', history: 'current' as const }, billable: { column: 'billable', history: 'stable' as const } },
  measures: { hours: { aggregate: 'sum' as const, column: 'hours', unit: 'h', kind: 'flow' as const } },
  time: 'worked_on',
}
const STOCK_SHAPE = {
  dimensions: { pillar: { column: 'pillar_id', history: 'current' as const } },
  measures: { headcount: { aggregate: 'count' as const, unit: 'people', kind: 'stock' as const } },
}
const concept = (name: string, shape: any, source = 'DB'): Contract =>
  ({ name, kind: 'concept', description: 'test', reads: { sources: [source], programs: [] }, params: {}, returns: 'relation', shape })
const composed = (name: string, reads: string[], shape: any = FLOW_SHAPE): Contract =>
  ({ name, kind: 'program', description: 'test', reads: { sources: [], programs: reads }, params: {}, returns: 'relation', shape })

const HOURS_SQL = `export default (ctx, { from, to }) => ({ source: 'DB', sql: 'SELECT worked_on, pillar_id, billable, hours FROM timebill WHERE d >= @from AND d < @to', params: { from, to } })`

function setup() {
  const sent: Array<{ source: string; sql: string; params: any }> = []
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-test-')), 'g.sqlite'))
  const engine = createEngine({
    store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: { DB: 'oracle', OTHER: 'oracle' },
    query: async (source, sql, params = {}) => { sent.push({ source, sql, params }); return [{ hours: 10, headcount: 3, c0: 1 }] },
  })
  return { store, engine, sent, by: { by: 'test' } }
}
const Q = { during: { from: '2026-04-01', to: '2026-07-01' } }

test('a relation built on a relation runs the inner SQL in place of its name', async () => {
  const { engine, sent, by } = setup()
  await engine.define({ body: HOURS_SQL, contract: concept('hours', FLOW_SHAPE) }, by)
  await engine.define({ body: `export default () => ({ sql: "SELECT h.* FROM {{hours}} h WHERE h.billable = 'T'" })`, contract: composed('billable', ['hours']) }, by)
  sent.length = 0
  await engine.call('billable', Q)
  const { sql, params, source } = sent[0]
  assert.equal(source, 'DB')
  assert.ok(sql.includes('FROM timebill'), 'inner SQL is present')
  assert.ok(!sql.includes('{{'), 'no name is left unreplaced')
  assert.ok(sql.includes("h.billable = 'T'"), 'the outer condition is kept')
  assert.equal(params.from, '2026-04-01', 'the inner relation receives the span')
})

test('two levels deep, and the same relation twice, each substituted', async () => {
  const { engine, sent, by } = setup()
  await engine.define({ body: HOURS_SQL, contract: concept('hours', FLOW_SHAPE) }, by)
  await engine.define({ body: `export default () => ({ sql: "SELECT h.* FROM {{hours}} h WHERE h.billable = 'T'" })`, contract: composed('billable', ['hours']) }, by)
  await engine.define({ body: `export default () => ({ sql: "SELECT b.* FROM {{billable}} b WHERE b.pillar_id IN (SELECT x.pillar_id FROM {{billable}} x)" })`, contract: composed('twice', ['billable']) }, by)
  sent.length = 0
  await engine.call('twice', Q)
  assert.equal(sent[0].sql.match(/FROM timebill/g)?.length, 2)
})

test('refused: a name in braces the contract does not declare', async () => {
  const { engine, by } = setup()
  await engine.define({ body: HOURS_SQL, contract: concept('hours', FLOW_SHAPE) }, by)
  await engine.define({ body: HOURS_SQL, contract: concept('other hours', FLOW_SHAPE) }, by)
  await assert.rejects(engine.define({ body: `export default () => ({ sql: 'SELECT * FROM {{other hours}} h' })`, contract: composed('sneaky', ['hours']) }, by),
    /does not declare/)
})

test('refused: building on something that is not a relation', async () => {
  const { engine, by } = setup()
  await engine.define({ body: `export default async (ctx) => ctx.query('DB', 'SELECT 1')`,
    contract: { ...concept('rows', undefined), returns: 'rows', shape: undefined } as Contract }, by)
  await assert.rejects(engine.define({ body: `export default () => ({ sql: 'SELECT * FROM {{rows}} r' })`, contract: composed('on rows', ['rows']) }, by),
    /not a relation/)
})

test('refused: a flow built on a stock', async () => {
  const { engine, by } = setup()
  await engine.define({ body: `export default (ctx, { asAt }) => ({ source: 'DB', sql: 'SELECT pillar_id FROM employee', params: { asAt } })`, contract: concept('people', STOCK_SHAPE) }, by)
  await assert.rejects(engine.define({ body: `export default () => ({ sql: 'SELECT * FROM {{people}} p' })`, contract: composed('mixed', ['people']) }, by),
    /read at different times/)
})

test('refused: one statement over two sources', async () => {
  const { engine, by } = setup()
  await engine.define({ body: HOURS_SQL, contract: concept('hours', FLOW_SHAPE) }, by)
  await engine.define({ body: HOURS_SQL.replace("source: 'DB'", "source: 'OTHER'"), contract: concept('remote hours', FLOW_SHAPE, 'OTHER') }, by)
  await assert.rejects(engine.define({ body: `export default () => ({ sql: 'SELECT * FROM {{hours}} a JOIN {{remote hours}} b ON a.pillar_id = b.pillar_id' })`, contract: composed('across', ['hours', 'remote hours']) }, by),
    /one SQL statement cannot read both/)
})

test('refused: a parameter that means different things in two relations', async () => {
  const { engine, by } = setup()
  await engine.define({ body: HOURS_SQL, contract: concept('hours', FLOW_SHAPE) }, by)
  await engine.define({ body: `export default (ctx, { from }) => ({ source: 'DB', sql: 'SELECT worked_on, pillar_id, billable, hours FROM t2 WHERE d >= @from', params: { from: 'last year' } })`, contract: concept('odd hours', FLOW_SHAPE) }, by)
  await assert.rejects(engine.define({ body: `export default () => ({ sql: 'SELECT * FROM {{hours}} a UNION ALL SELECT * FROM {{odd hours}} b' })`, contract: composed('clash', ['hours', 'odd hours']) }, by),
    /means different things/)
})

test('refused: a relation program that names no relation', async () => {
  const { engine, by } = setup()
  await engine.define({ body: HOURS_SQL, contract: concept('hours', FLOW_SHAPE) }, by)
  await assert.rejects(engine.define({ body: `export default () => ({ sql: 'SELECT * FROM timebill' })`, contract: composed('direct', ['hours']) }, by),
    /names no relation/)
})

test('a correction reaches the composed relation, and lineage finds its answers', async () => {
  const { engine, store, sent, by } = setup()
  await engine.define({ body: HOURS_SQL, contract: concept('hours', FLOW_SHAPE) }, by)
  await engine.define({ body: `export default () => ({ sql: "SELECT h.* FROM {{hours}} h WHERE h.billable = 'T'" })`, contract: composed('billable', ['hours']) }, by)
  const wrong = store.resolve('hours')!
  const answer = await engine.call('billable', Q)
  await assert.rejects(engine.define({ body: HOURS_SQL, contract: concept('hours', { ...FLOW_SHAPE, measures: { worked: FLOW_SHAPE.measures.hours } }) }, { ...by, replace: true }),
    /drops the measure "hours"/)
  await engine.define({ body: HOURS_SQL.replace('FROM timebill', 'FROM timebill_actual'), contract: concept('hours', FLOW_SHAPE) }, { ...by, replace: true })
  sent.length = 0
  await engine.call('billable', Q)
  assert.ok(sent[0].sql.includes('FROM timebill_actual'), 'the caller now runs the corrected SQL')
  assert.deepEqual(store.answersThrough(wrong).map((c) => c.id), [answer.callId])
})

test('live: the composed SQL gives the numbers the hand-written SQL gives', { skip: !process.env.DATASOURCE_URL }, async () => {
  const { query } = await import('@superatom/scaffold')
  const { readFileSync } = await import('node:fs')
  const dir = new URL('../examples/capacity/', import.meta.url)
  const load = (d: string) => ({ body: readFileSync(new URL(`${d}/program.mjs`, dir), 'utf8'), contract: JSON.parse(readFileSync(new URL(`${d}/contract.json`, dir), 'utf8')) })
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-live-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), query, dialects: { F5NETSUITE: 'oracle' } })
  await engine.define(load('utilised-hours-corrected'), { by: 'test' })
  await engine.define(load('billable-hours'), { by: 'test' })
  const composedResult: any = (await engine.call('billable hours', { by: ['pillar'], during: { from: '2026-04-01', to: '2026-07-01' } })).value

  const direct = await query('F5NETSUITE', `
    SELECT e.department AS pillar, SUM(TO_NUMBER(tb.hours)) AS hours
      FROM timebill tb JOIN employee e ON e.id = tb.employee
     WHERE tb.isutilized = 'T' AND tb.timetype = 'A' AND tb.isbillable = 'T' AND e.firstname IS NOT NULL
       AND tb.trandate >= TO_DATE('2026-04-01', 'YYYY-MM-DD') AND tb.trandate < TO_DATE('2026-07-01', 'YYYY-MM-DD')
     GROUP BY e.department`)
  const want = new Map(direct.map((r: any) => [String(r.pillar ?? ''), Number(r.hours)]))
  const got = new Map(composedResult.rows.map((r: any) => [String(r.pillar ?? ''), Number(r.hours)]))
  assert.equal(got.size, want.size, 'same pillars')
  for (const [k, v] of want) assert.ok(Math.abs((got.get(k) ?? NaN) - v) < 1e-6, `pillar ${k}: composed ${got.get(k)} · direct ${v}`)
})
