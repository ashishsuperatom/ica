// The console's viewer of a connected source, at the engine: a table's first rows and its count, read through the
// datasource manager with the asker's data access sent along with both reads; any other kind of source is not guessed at.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createSourceViewer } from '../source-viewer.ts'

const seen: any[] = []
const manager = createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const b = JSON.parse(body); seen.push(b)
    const rows = /COUNT/.test(b.sql) ? [{ n: 3 }] : [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rows }))
  })
})
await new Promise<void>((r) => manager.listen(0, r))
const url = `http://localhost:${(manager.address() as any).port}`
const policy = { table: 'orders', predicate: '{t}.region = \'north\'' }
const viewer = createSourceViewer({ manager: url, policiesFor: async (who) => (who.email === 'ana@x.com' ? [policy] : []), kindOf: async (s) => (s === 'ERP' ? 'sql' : s === 'API' ? 'rest' : null) })
const ana = { userId: 'ana', email: 'ana@x.com' }

test('rows and count, as the asker may see them: their policies go with both reads', async () => {
  const r = await viewer.rows({ source: 'ERP', table: 'orders' }, ana)
  assert.deepEqual(r, { source: 'ERP', table: 'orders', columns: ['id', 'name'], rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], total: 3, limit: 100 })
  assert.deepEqual(seen.map((b) => [b.id, b.sql, b.policies]), [['ERP', 'SELECT * FROM orders LIMIT 100', [policy]], ['ERP', 'SELECT COUNT(*) AS n FROM orders', [policy]]])
})

test('an odd table name is quoted; another kind of source, an unknown one, or no asker reads nothing', async () => {
  seen.length = 0
  await viewer.rows({ source: 'ERP', table: 'Order Lines' }, ana)
  assert.equal(seen[0].sql, 'SELECT * FROM "Order Lines" LIMIT 100')
  assert.match(String((await viewer.rows({ source: 'API', table: 'x' }, ana)).error), /not built yet/)
  assert.match(String((await viewer.rows({ source: 'NOPE', table: 'x' }, ana)).error), /no source NOPE/)
  seen.length = 0
  assert.ok((await viewer.rows({ source: 'ERP', table: 'orders' }, {})).error)
  assert.equal(seen.length, 0)
  manager.close()
})
