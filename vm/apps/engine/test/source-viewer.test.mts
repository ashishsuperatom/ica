// The console's explorer of a connected source, at the engine: the warehouse's reads (clients/explore.ts), run through
// the datasource manager with the asker's data access sent along; columns from the index replica; any other kind of
// source, an unknown one, or no asker reads nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataSourceIndex, applyItems } from '@superatom/datasource-index'
import { createSourceViewer } from '../source-viewer.ts'
import { exploreType } from '../../../../clients/explore.ts'

const seen: any[] = []
const manager = createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const b = JSON.parse(body); seen.push(b)
    const rows = /COUNT\(\*\) AS sa_total/.test(b.sql) ? [{ sa_total: 3 }] : [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rows }))
  })
})
await new Promise<void>((r) => manager.listen(0, r))
const index = new DataSourceIndex(join(mkdtempSync(join(tmpdir(), 'sv-')), 'i.sqlite'))
const item = (field: string, type: string | null) => ({ source: 'ERP', table: 'orders', field, type, descSource: null, descHuman: null, descAi: null, optional: null, key: null, references: null, rows: field ? null : 3, enabled: true, enabledBy: 'auto', gone: false, seq: 1 })
applyItems(index, [item('', null), item('id', 'int'), item('name', 'nvarchar')] as any, 1)
const policy = { table: 'orders', predicate: "{t}.region = 'north'" }
const viewer = createSourceViewer({ manager: `http://localhost:${(manager.address() as any).port}`, index, policiesFor: async (who) => (who.email === 'ana@x.com' ? [policy] : []), sourceOf: async (s) => (s === 'ERP' ? { kind: 'sql', dialect: 'mssql' } : s === 'API' ? { kind: 'rest', dialect: null } : null) })
const ana = { userId: 'ana', email: 'ana@x.com' }

test("a table's rows, paged, as the asker may see them: their policies go with every read", async () => {
  const r: any = await viewer.read({ source: 'ERP', request: { table: 'orders', op: 'rows', page: 1, size: 100, q: '', where: [] } }, ana)
  assert.equal(r.error, undefined)
  assert.equal(r.result.rows.length, 2)
  assert.ok(seen.length >= 1 && seen.every((b) => b.id === 'ERP' && JSON.stringify(b.policies) === JSON.stringify([policy])))
  assert.match(seen.at(-1).sql, /ROW_NUMBER\(\) OVER/)
})

test("one person's analysis reads run one at a time, in order", async () => {
  seen.length = 0
  const asks = ['a', 'b'].map(() => viewer.read({ source: 'ERP', request: { table: 'orders', op: 'values', column: 'name', q: '', where: [] } }, ana))
  const out = await Promise.all(asks)
  assert.ok(out.every((r: any) => !r.error))
  assert.equal(seen.length, 2)
})

test("a search is written in the source's own SQL: T-SQL has no ILIKE, its yes is 1, its first rows TOP", async () => {
  seen.length = 0
  await viewer.read({ source: 'ERP', request: { table: 'orders', op: 'rows', page: 1, size: 50, q: 'crm', where: [] } }, ana)
  const sql = seen.map((b) => b.sql).join('\n')
  assert.doesNotMatch(sql, /ILIKE/)
  assert.match(sql, /LOWER\(CAST\(\[name\] AS NVARCHAR\(4000\)\)\) LIKE LOWER\('%crm%'\)/)
  const { dialectOf, ORACLE, TSQL, WAREHOUSE_SQL } = await import('../../../../clients/explore.ts')
  assert.equal(dialectOf('suiteql'), ORACLE); assert.equal(dialectOf('mssql'), TSQL); assert.equal(dialectOf(undefined), WAREHOUSE_SQL)
  assert.equal(TSQL.firstN('SELECT a FROM t', 50), 'SELECT TOP 50 a FROM t')
  assert.equal(ORACLE.firstN('SELECT a FROM t', 50), 'SELECT a FROM t FETCH FIRST 50 ROWS ONLY')
})

test('kinds: a source type read as the explorer reads kinds', () => {
  assert.deepEqual(['int', 'decimal(10,2)', 'datetime2', 'date', 'bit', 'nvarchar(50)'].map(exploreType), ['double', 'double', 'timestamp', 'date', 'boolean', 'string'])
})

test('another kind of source, an unknown one, an unknown table, or no asker reads nothing', async () => {
  assert.match(String((await viewer.read({ source: 'API', request: { table: 'x', op: 'profile' } }, ana)).error), /not built yet/)
  assert.match(String((await viewer.read({ source: 'NOPE', request: { table: 'x', op: 'profile' } }, ana)).error), /no source NOPE/)
  assert.ok((await viewer.read({ source: 'ERP', request: { table: 'nope', op: 'profile' } }, ana)).error)
  seen.length = 0
  assert.ok((await viewer.read({ source: 'ERP', request: { table: 'orders', op: 'profile' } }, {})).error)
  assert.equal(seen.length, 0)
  manager.close()
})
