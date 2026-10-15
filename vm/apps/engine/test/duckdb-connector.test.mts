// The DuckDB connector (connectors/bridges/duckdb) with the real DuckDB driver the manager supplies: a database file (read
// and written), files read as tables (each line of `files` a table — here local CSV and Parquet files, the same path as
// s3://, gs://, az://, https:// minus the network), what it says when a line or a file is wrong, and that only a file is
// written to. Remote storage and MotherDuck are the same code with a secret and an extension (checked live, not here).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const MANAGER = new URL('../../datasources/manager/package.json', import.meta.url).pathname
const duckdb = () => import(pathToFileURL(createRequire(MANAGER).resolve('@duckdb/node-api')).href)
const { createBridge, tablesOf } = await import('../../../../connectors/bridges/duckdb/bridge.mjs' as string)
const dir = mkdtempSync(join(tmpdir(), 'duck-'))

test('a DuckDB file: opened, written by a program, read; a connection made before `source` existed is a file', async () => {
  const b = createBridge({ settings: { path: join(dir, 'app.duckdb') }, drivers: { duckdb } })   // no source: a file
  assert.ok(b.ready())
  await b.query('CREATE TABLE IF NOT EXISTS notes (id INTEGER, text VARCHAR)').catch(() => {})
  assert.deepEqual(await b.append('notes', [{ id: 1, text: 'hello' }]), { rows: 1 })
  assert.deepEqual(await b.query('SELECT text FROM notes WHERE id = @id', { id: 1 }), [{ text: 'hello' }])
  assert.match(await b.test(), /opened .*app\.duckdb/)
  b.close()
})

test('files as tables: each line a table over its files (* reads every match); its test reads each; never written to', async () => {
  writeFileSync(join(dir, 'orders-1.csv'), 'id,amount\n1,10\n2,20\n'); writeFileSync(join(dir, 'orders-2.csv'), 'id,amount\n3,30\n')
  writeFileSync(join(dir, 'customers.csv'), 'id,name\n1,Ana\n')
  const files = `orders ${join(dir, 'orders-*.csv')}\ncustomers ${join(dir, 'customers.csv')}`
  const b = createBridge({ settings: { source: 'files', files, storage: 'public' }, drivers: { duckdb } })
  assert.ok(b.ready())
  assert.equal(await b.test(), 'reads 2 tables: orders, customers')
  assert.deepEqual(await b.query('SELECT sum(amount)::INTEGER AS total FROM orders'), [{ total: 60 }])
  assert.deepEqual((await b.introspect()).tables.map((t: any) => t.name).sort(), ['customers', 'orders'])
  await assert.rejects(b.append('orders', [{ id: 4 }]), /only a DuckDB file is written to/)
  b.close()
  // a file that is not there: the table's line says which
  const missing = createBridge({ settings: { source: 'files', files: `gone ${join(dir, 'nope-*.csv')}`, storage: 'public' }, drivers: { duckdb } })
  await assert.rejects(missing.test(), /No files found|gone/)
  missing.close()
})

test('`files` read a line at a time: a name, then where; a line that is not says how it should be', () => {
  assert.deepEqual(tablesOf('orders s3://b/o/*.parquet\n# a note\n\ncustomers https://x.io/c.csv'), [{ name: 'orders', at: 's3://b/o/*.parquet' }, { name: 'customers', at: 'https://x.io/c.csv' }])
  assert.throws(() => tablesOf('just-a-path.parquet'), /write a table's name, then where its files are/)
  assert.equal(createBridge({ settings: { source: 'files', files: '' } }).ready(), false)
  assert.equal(createBridge({ settings: { source: 'motherduck', database: 'db' }, secrets: {} }).ready(), false)
})
