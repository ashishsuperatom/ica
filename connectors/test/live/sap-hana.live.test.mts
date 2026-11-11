// The SAP HANA connector against a real HANA — HANA express in Docker on the forge (~/connector-labs/hana: started and
// seeded there, with a read-only user made as the connector's setup tells people to). Skipped where it is not running.
//   node ~/connector-labs/hana/seed.mjs   then   pnpm exec tsx --test test/live/sap-hana.live.test.mts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// the connector's own module, as the engine loads it
const { createBridge } = await import(new URL('../../bridges/sap-hana/bridge.mjs', import.meta.url).href) as { createBridge: (o: unknown) => any }
const lab = join(homedir(), 'connector-labs', 'hana', 'lab.env')
const skip = existsSync(lab) ? false : 'HANA express is not running here (~/connector-labs/hana)'
const settings = { host: '127.0.0.1', port: 39041, tls: 'off', user: 'SUPERATOM_TEST', schemas: 'SALES' }
const secrets = { password: 'Read-Only-Lab-1' }
/** HANA as its administrator — to change a table under the connector, as a person would. */
async function asAdmin(sql: string) {
  const hdb = createRequire(new URL('../../bridges/sap-hana/package.json', import.meta.url))('hdb')
  const c = hdb.createClient({ host: '127.0.0.1', port: 39041, user: 'SYSTEM', password: readFileSync(lab, 'utf8').match(/HANA_PASSWORD=(.*)/)![1].trim() })
  await new Promise<void>((r, j) => c.connect((e: any) => (e ? j(e) : r())))
  await new Promise<void>((r, j) => c.exec(sql, (e: any) => (e ? j(e) : r())))
  c.disconnect()
}

test('signed in as a read-only user; what it may read, counted', { skip }, async () => {
  const b = createBridge({ settings, secrets })
  try {
    assert.equal(await b.test(), 'signed in as SUPERATOM_TEST on 127.0.0.1')
    assert.match(await b.check('tables'), /^SUPERATOM_TEST may read 5 tables and views \(SALES 5\)$/)
  } finally { b.close() }
})

test("described from HANA's own catalog: comments, keys, foreign keys, row counts; a view too", { skip }, async () => {
  const b = createBridge({ settings, secrets })
  try {
    const d = await b.introspect()
    const t = (n: string) => d.tables.find((x: any) => x.name === n)
    assert.deepEqual(d.tables.map((x: any) => x.name).sort(), ['SALES.CUSTOMERS', 'SALES.OPEN_ORDERS', 'SALES.ORDERS', 'SALES.ORDER_LINES', 'SALES.PRODUCTS'])
    assert.equal(t('SALES.CUSTOMERS').description, 'Who buys from us')
    assert.equal(t('SALES.CUSTOMERS').rows, 3)
    assert.deepEqual(t('SALES.CUSTOMERS').columns.find((c: any) => c.name === 'CREDIT_LIMIT'), { name: 'CREDIT_LIMIT', type: 'DECIMAL', nullable: true, description: 'The most a customer may owe, in EUR' })
    assert.deepEqual(t('SALES.CUSTOMERS').columns.find((c: any) => c.name === 'ID'), { name: 'ID', type: 'INTEGER', nullable: false, key: true })
    assert.equal(t('SALES.ORDERS').columns.find((c: any) => c.name === 'CUSTOMER_ID').references, 'SALES.CUSTOMERS.ID')
    const lines = t('SALES.ORDER_LINES').columns
    assert.deepEqual(lines.filter((c: any) => c.key).map((c: any) => c.name), ['ORDER_ID', 'LINE'])
    assert.equal(lines.find((c: any) => c.name === 'PRODUCT_ID').references, 'SALES.PRODUCTS.ID')
    assert.ok(t('SALES.OPEN_ORDERS').columns.some((c: any) => c.name === 'CUSTOMER'))
  } finally { b.close() }
})

test('a query: values bound by name, decimals as numbers, a code with leading zeros kept as text, dates as text', { skip }, async () => {
  const b = createBridge({ settings, secrets })
  try {
    const rows = await b.query('SELECT ID, NAME, CREDIT_LIMIT, CODE FROM SALES.CUSTOMERS WHERE CITY = @city ORDER BY ID LIMIT 10', { city: 'Pune' })
    assert.deepEqual(rows, [{ ID: 1, NAME: 'Acme Steel', CREDIT_LIMIT: 50000, CODE: '00123' }, { ID: 3, NAME: 'Cedar Mills', CREDIT_LIMIT: null, CODE: '00789' }])
    const [o] = await b.query('SELECT ORDERED_ON, STATUS FROM SALES.ORDERS WHERE ID = @id AND STATUS = @s', { id: 11, s: 'open' })
    assert.equal(o.STATUS, 'open'); assert.match(String(o.ORDERED_ON), /^2026-10-20/)
    const [s] = await b.query('SELECT SUM(L.QUANTITY * P.PRICE) AS TOTAL FROM SALES.ORDER_LINES L JOIN SALES.PRODUCTS P ON P.ID = L.PRODUCT_ID WHERE L.ORDER_ID = @o', { o: 10 })
    assert.equal(s.TOTAL, 40 * 640.25 + 5 * 88.9)
  } finally { b.close() }
})

test('when a table changes, its signature does — and only its own', { skip }, async () => {
  const b = createBridge({ settings, secrets })
  try {
    const before = await b.signatures()
    await asAdmin('ALTER TABLE SALES.PRODUCTS ADD (UNIT NVARCHAR(8))')
    const after = await b.signatures()
    assert.notEqual(after['SALES.PRODUCTS'], before['SALES.PRODUCTS'])
    assert.equal(after['SALES.CUSTOMERS'], before['SALES.CUSTOMERS'])
    await asAdmin('ALTER TABLE SALES.PRODUCTS DROP (UNIT)')
    assert.equal((await b.signatures())['SALES.PRODUCTS'], before['SALES.PRODUCTS'])
  } finally { b.close() }
})

test('it only reads: a write is refused by HANA; a wrong password is said plainly', { skip }, async () => {
  const b = createBridge({ settings, secrets })
  try { await assert.rejects(() => b.query("UPDATE SALES.CUSTOMERS SET CITY = 'X'"), /insufficient privilege|not authorized/i) } finally { b.close() }
  const wrong = createBridge({ settings, secrets: { password: 'nope' } })
  try { await assert.rejects(() => wrong.test(), /authentication failed/i) } finally { wrong.close() }
})
