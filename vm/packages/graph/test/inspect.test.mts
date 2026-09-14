// Checks that need a SQL parser: the same SQLGlot worker the datasource manager rewrites queries with, called
// directly, so these run without a manager or a database.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSql, shutdownPool } from '../../../apps/datasources/manager/src/sqlglot-pool.ts'
import { GraphStore, createEngine, type Contract } from '../src/index.ts'

after(() => shutdownPool())

const shape = {
  dimensions: { pillar: { column: 'pillar_id', history: 'current' as const } },
  measures: { hours: { aggregate: 'sum' as const, column: 'hours', unit: 'h', kind: 'flow' as const } },
  time: 'worked_on',
}
const concept = (name: string): Contract => ({ name, kind: 'concept', description: 't', reads: { sources: ['DB'], programs: [] }, params: {}, returns: 'relation', shape })
const composed = (name: string, reads: string[]): Contract => ({ name, kind: 'program', description: 't', reads: { sources: [], programs: reads }, params: {}, returns: 'relation', shape })

function setup() {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-in-')), 'g.sqlite'))
  return createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: { DB: 'oracle' },
    query: async () => [{}], inspect: (sql, dialect) => analyzeSql(sql, { dialect }) })
}
const HOURS = `export default (ctx, { from, to }) => ({ source: 'DB', sql: "SELECT tb.trandate AS worked_on, e.department AS pillar_id, tb.hours AS hours FROM timebill tb JOIN employee e ON e.id = tb.employee WHERE tb.trandate >= TO_DATE(@from, 'YYYY-MM-DD')", params: { from, to } })`

test('refused: a relation program that reads a table directly', async () => {
  const engine = setup()
  await engine.define({ body: HOURS, contract: concept('hours') }, { by: 'test' })
  await assert.rejects(engine.define({ body: `export default () => ({ sql: "SELECT h.* FROM {{hours}} h JOIN employee e ON e.id = h.pillar_id" })`, contract: composed('sneaky', ['hours']) }, { by: 'test' }),
    /reads employee directly/)
  await engine.define({ body: `export default () => ({ sql: "WITH b AS (SELECT h.* FROM {{hours}} h) SELECT b.* FROM b" })`, contract: composed('fine', ['hours']) }, { by: 'test' })
})

test('refused before running: a shape column the SQL does not output', async () => {
  const engine = setup()
  const wrong = { ...concept('wrong'), shape: { ...shape, measures: { hours: { ...shape.measures.hours, column: 'billed_hours' } } } }
  await assert.rejects(engine.define({ body: HOURS, contract: wrong }, { by: 'test' }), /names "billed_hours", which its SQL does not output/)
})
