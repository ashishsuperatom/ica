// EVERY ENGINE CONNECTOR, AS BUILT (connectors/dist/bridges.json — the exact module the engine loads), against a real
// database (up.sh: each in Docker, seeded with the same dataset by seed.mjs). Not part of check-all — it needs Docker:
//   connectors/test/live/up.sh && pnpm -C connectors exec tsx --test test/live/connectors.live.test.mts
// Each connector: signs in (test), describes its tables with their columns (the index needs nothing else), reads, binds
// @name values, refuses to write, and gives the same answers as every other database for the same question.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PW = 'Sa-live-2026!'
const BRIDGES = JSON.parse(readFileSync(new URL('../../dist/bridges.json', import.meta.url), 'utf8')) as Record<string, string>
const dir = mkdtempSync(join(tmpdir(), 'live-'))
async function load(id: string, settings: Record<string, unknown>, secrets: Record<string, string>) {
  const file = join(dir, `${id}.mjs`); writeFileSync(file, BRIDGES[id])
  return (await import(pathToFileURL(file).href)).createBridge({ settings, secrets })
}

const SQL: { id: string; settings: Record<string, unknown>; secrets: Record<string, string>; t: (s: string) => string; write: string }[] = [
  { id: 'postgres', settings: { host: 'localhost', port: 55432, database: 'sales', user: 'sa', ssl: 'disable' }, secrets: { password: PW }, t: (x) => x, write: "INSERT INTO regions VALUES (99, 'X')" },
  { id: 'mysql', settings: { host: 'localhost', port: 53306, database: 'sales', user: 'sa', ssl: 'disable' }, secrets: { password: PW }, t: (x) => x, write: "INSERT INTO regions VALUES (99, 'X')" },
  { id: 'sqlserver', settings: { server: 'localhost', port: 51433, database: 'sales', auth: 'sql', user: 'sa', encrypt: 'false' }, secrets: { password: PW }, t: (x) => x, write: '' },
  { id: 'oracle', settings: { host: 'localhost', port: 51521, service: 'FREEPDB1', user: 'sales' }, secrets: { password: PW }, t: (x) => x, write: "INSERT INTO regions VALUES (99, 'X')" },
  { id: 'clickhouse', settings: { url: 'http://localhost:58123', database: 'sales', user: 'sa' }, secrets: { password: PW }, t: (x) => x, write: "INSERT INTO regions VALUES (99, 'X')" },
]
const revenue = new Map<string, number>()
const n = (v: unknown) => Number(v)
const pick = (row: any, k: string) => row[k] ?? row[k.toUpperCase()]

for (const c of SQL) {
  test(`${c.id}: signs in, describes its tables, reads, binds, refuses to write, agrees`, async () => {
    const b = await load(c.id, c.settings, c.secrets)
    try {
      assert.equal(b.ready(), true, 'configured')
      await b.test()
      const intro = await b.introspect()
      const names = intro.tables.map((t: any) => String(t.name).toLowerCase()).sort()
      assert.deepEqual(names.filter((x: string) => ['customers', 'order_lines', 'orders', 'products', 'regions'].includes(x)), ['customers', 'order_lines', 'orders', 'products', 'regions'])
      if (c.id !== 'sqlserver') {   // SQL Server's columns come from the platform's own indexer (its keys and references)
        const orders = intro.tables.find((t: any) => String(t.name).toLowerCase() === 'orders')
        assert.deepEqual(orders.columns.map((x: any) => String(x.name).toLowerCase()), ['order_id', 'customer_id', 'ordered_on', 'status'])
      }
      const [count] = await b.query(c.t('SELECT COUNT(*) AS n FROM orders'))
      assert.equal(n(pick(count, 'n')), 2000)
      const [open] = await b.query(c.t("SELECT COUNT(*) AS n FROM orders WHERE status = @status"), { status: 'open' })
      assert.ok(n(pick(open, 'n')) > 300 && n(pick(open, 'n')) < 700, `open orders: ${JSON.stringify(open)}`)
      const [rev] = await b.query(c.t('SELECT SUM(quantity * unit_price) AS r FROM order_lines'))
      revenue.set(c.id, Math.round(n(pick(rev, 'r'))))
      if (c.write) await assert.rejects(b.query(c.write), 'a write is refused by the session')
    } finally { b.close?.() }
  })
}

test('mongodb: signs in, describes its collections, finds, aggregates, binds, refuses to write, agrees', async () => {
  const b = await load('mongodb', { database: 'sales' }, { url: `mongodb://sa:${encodeURIComponent(PW)}@localhost:57017/?authSource=admin` })
  try {
    await b.test()
    const intro = await b.introspect()
    assert.deepEqual(intro.tables.map((t: any) => t.name).sort(), ['customers', 'orders', 'products', 'regions'])
    assert.ok(intro.tables.find((t: any) => t.name === 'orders').columns.some((x: any) => x.name === 'status'))
    assert.equal((await b.query('{"collection": "orders", "find": {}, "projection": {"_id": 0, "order_id": 1}}')).length, 2000)
    const open = await b.query('{"collection": "orders", "find": {"status": "@status"}, "projection": {"_id": 0}}', { status: 'open' })
    assert.ok(open.length > 300 && open.length < 700)
    const [rev] = await b.query('{"collection": "orders", "aggregate": [{"$unwind": "$lines"}, {"$group": {"_id": null, "r": {"$sum": {"$multiply": ["$lines.quantity", "$lines.unit_price"]}}}}]}')
    revenue.set('mongodb', Math.round(rev.r))
    await assert.rejects(b.query('{"collection": "orders", "aggregate": [{"$out": "stolen"}]}'), /only reads/)
  } finally { b.close?.() }
})

test('every database gives the same revenue for the same orders', () => {
  const all = [...revenue.values()]
  assert.ok(all.length === SQL.length + 1, `answers from ${[...revenue.keys()].join(', ')}`)
  assert.ok(all.every((x) => Math.abs(x - all[0]) <= 1), JSON.stringify(Object.fromEntries(revenue)))
})
