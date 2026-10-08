// sacli warehouse load, reading real files with DuckDB (a CSV, a DuckDB database, an Excel workbook) into a warehouse played
// by a fake that keeps what it was sent: types mapped, names made the warehouse's, integers exact, rows in batches, a table
// already there refused unless --replace or --append, nothing touched when any table cannot be loaded.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { loadFile, warehouseName, warehouseType, xlsxSheets } from '../src/load.ts'

const dir = mkdtempSync(join(tmpdir(), 'sa-load-'))

function warehouse(existing: Record<string, { name: string; type: string }[]> = {}) {
  const tables = new Map<string, { columns: { name: string; type: string }[]; rows: any[]; description?: string }>(Object.entries(existing).map(([n, columns]) => [n, { columns, rows: [] }]))
  const calls: string[] = [], grants: string[] = []
  const call = async (b: any) => {
    calls.push(b.t)
    if (b.t === 'warehouse:tables') return { tables: [...tables].map(([name, t]) => ({ name, columns: t.columns })) }
    if (b.t === 'warehouse:create') { assert.ok(!tables.has(b.name)); tables.set(b.name, { columns: b.columns, rows: [], description: b.description }); return { ok: true } }
    if (b.t === 'warehouse:drop') { tables.delete(b.table); return { ok: true } }
    if (b.t === 'warehouse:append') { tables.get(b.table)!.rows.push(...b.rows); return { rows: b.rows.length } }
    if (b.t === 'warehouse:grant') { grants.push(`${b.project}:${b.table}`); return { ok: true } }
    throw new Error(b.t)
  }
  return { tables, calls, grants, call }
}

test('names and types as the warehouse keeps them', () => {
  assert.equal(warehouseName('Order ID', 'column'), 'order_id')
  assert.equal(warehouseName('PurchaseOrders', 'table'), 'purchase_orders')
  assert.equal(warehouseName('2024 sales', 'table'), 't_2024_sales')
  assert.equal(warehouseName('Ünit Price ($)', 'column'), 'unit_price')
  assert.deepEqual(['BIGINT', 'DECIMAL(12,2)', 'DATE', 'TIMESTAMP WITH TIME ZONE', 'VARCHAR[]', 'BOOLEAN', 'INTEGER'].map((t) => warehouseType(t).type),
    ['long', 'double', 'date', 'timestamptz', 'string', 'boolean', 'int'])
})

test('a DuckDB database: every table (views named only), types mapped, big integers exact, batched', async () => {
  const file = join(dir, 'proc.duckdb')
  const db = await DuckDBInstance.create(file); const c = await db.connect()
  await c.run(`CREATE TABLE "PurchaseOrders" ("PO Number" BIGINT, "Amount" DECIMAL(12,2), "Ordered" DATE, "At" TIMESTAMP, "Tags" VARCHAR[], "Open" BOOLEAN);
    INSERT INTO "PurchaseOrders" SELECT 9007199254740993 + i, i * 1.25, DATE '2024-01-01' + i::INTEGER, TIMESTAMP '2024-01-01 10:00:00' + INTERVAL (i) HOUR, ['a', 'b'], i % 2 = 0 FROM range(5) t(i);
    CREATE TABLE vendors (id INTEGER, name VARCHAR); INSERT INTO vendors VALUES (1, 'Acme'), (2, NULL);
    CREATE VIEW big_orders AS SELECT * FROM "PurchaseOrders" WHERE "Amount" > 2;`)
  c.closeSync(); db.closeSync()
  const w = warehouse(), notes: string[] = []
  const done = await loadFile(file, { project: 'p1', batchRows: 2 }, w.call, (s) => notes.push(s))
  assert.deepEqual(done.map((d) => d.table).sort(), ['purchase_orders', 'vendors'])
  assert.ok(notes.some((n) => /views not loaded.*big_orders/.test(n)))
  const po = w.tables.get('purchase_orders')!
  assert.deepEqual(po.columns, [{ name: 'po_number', type: 'long' }, { name: 'amount', type: 'double' }, { name: 'ordered', type: 'date' }, { name: 'at', type: 'timestamp' }, { name: 'tags', type: 'string' }, { name: 'open', type: 'boolean' }])
  assert.equal(po.rows.length, 5)
  assert.deepEqual(po.rows[0], { po_number: '9007199254740993', amount: 0, ordered: '2024-01-01', at: '2024-01-01T10:00:00.000Z', tags: '["a","b"]', open: true })
  assert.equal(done.find((d) => d.table === 'purchase_orders')!.batches, 3)
  assert.deepEqual(w.grants.sort(), ['p1:purchase_orders', 'p1:vendors'])
  assert.equal(w.tables.get('vendors')!.rows[1].name, null)
  // A view, named, loads too.
  const v = warehouse()
  await loadFile(file, { tables: ['big_orders'] }, v.call, () => {})
  assert.equal(v.tables.get('big_orders')!.rows.length, 3)
})

test('a table already there: refused before anything is done; --replace makes it anew; --append needs the same columns', async () => {
  const file = join(dir, 'Vendors List.csv')
  writeFileSync(file, 'Vendor ID,Name,Rating\n1,Acme,4.5\n2,Globex,3\n')
  const w = warehouse({ vendors_list: [{ name: 'vendor_id', type: 'long' }, { name: 'name', type: 'string' }, { name: 'rating', type: 'double' }] })
  await assert.rejects(loadFile(file, {}, w.call, () => {}), /has a table vendors_list already.*--replace/)
  assert.deepEqual(w.calls, ['warehouse:tables'], 'nothing done')
  await loadFile(file, { append: true }, w.call, () => {})
  assert.equal(w.tables.get('vendors_list')!.rows.length, 2)
  await loadFile(file, { replace: true }, w.call, () => {})
  assert.equal(w.tables.get('vendors_list')!.rows.length, 2)
  assert.ok(w.calls.includes('warehouse:drop'))
  const other = warehouse({ vendors_list: [{ name: 'vendor_id', type: 'string' }] })
  await assert.rejects(loadFile(file, { append: true }, other.call, () => {}), /columns are not the file's/)
})

test('an Excel workbook: each sheet a table, --sheet picks one', async () => {
  const file = join(dir, 'spend.xlsx')
  const db = await DuckDBInstance.create(':memory:'); const c = await db.connect()
  await c.run(`INSTALL excel; LOAD excel; COPY (SELECT 'Acme' AS "Supplier", 120.5 AS "Spend") TO '${file}' (FORMAT xlsx, HEADER true, SHEET 'Q1 Spend')`)
  c.closeSync(); db.closeSync()
  assert.deepEqual(xlsxSheets(file), ['Q1 Spend'])
  const w = warehouse()
  const done = await loadFile(file, {}, w.call, () => {})
  assert.equal(done[0]!.table, 'spend')
  assert.deepEqual(w.tables.get('spend')!.rows, [{ supplier: 'Acme', spend: 120.5 }])
  await assert.rejects(loadFile(file, { sheet: 'Nope' }, warehouse().call, () => {}), /no sheet "Nope".*Q1 Spend/)
})
