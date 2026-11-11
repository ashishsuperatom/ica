// The Amazon Redshift connector. No Redshift cluster was used: its catalog SQL (SVV_TABLES, SVV_COLUMNS, SVV_TABLE_INFO,
// information_schema keys) is checked as text and its rows turned into tables as unit tests — REPLAYED (from the
// documentation). The wire protocol, the read-only transaction, @name binding, value types and the whole catalog path run
// LIVE against the PostgreSQL in Docker (test/live/up.sh, sa-live-postgres), in a database of its own (redshift_sim) where
// views named as Redshift's stand in for them; skipped when that PostgreSQL is not running.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { checkEngineManifest } from '../src/contract.ts'
import { fixFor } from '../src/setup.ts'

const manifest = JSON.parse(readFileSync(new URL('../bridges/redshift/manifest.json', import.meta.url), 'utf8'))
const R: any = await import(new URL('../bridges/redshift/bridge.mjs', import.meta.url).href)
const pg: any = createRequire(new URL('../bridges/redshift/package.json', import.meta.url))('pg')
const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))

test('redshift: the manifest is sound, every field asked in a proven step', () => {
  assert.deepEqual(checkEngineManifest(manifest), [])
  assert.equal(manifest.dialect, 'redshift')
})

test('redshift: whatever is pasted as the address → host, port and database', () => {
  assert.deepEqual(R.endpointOf('examplecluster.abc123xyz789.us-west-2.redshift.amazonaws.com:5439/dev'), { host: 'examplecluster.abc123xyz789.us-west-2.redshift.amazonaws.com', port: 5439, database: 'dev' })
  assert.deepEqual(R.endpointOf('jdbc:redshift://default-workgroup.123456789012.us-east-1.redshift-serverless.amazonaws.com:5440/sales?ssl=true'), { host: 'default-workgroup.123456789012.us-east-1.redshift-serverless.amazonaws.com', port: 5440, database: 'sales' })
  assert.deepEqual(R.endpointOf(' ExampleCluster.abc.eu-west-1.redshift.amazonaws.com '), { host: 'examplecluster.abc.eu-west-1.redshift.amazonaws.com' })
  assert.deepEqual(R.endpointOf('postgresql://ana@host.example:5439/dev'), { host: 'host.example', port: 5439, database: 'dev' })
})

test('redshift: its catalog is read from Redshift\'s own views, narrowed to the schemas asked, its own schemas left out', () => {
  const all = R.CATALOG.columns([])
  assert.match(all, /FROM svv_columns c JOIN svv_tables t ON t\.table_catalog = c\.table_catalog AND t\.table_schema = c\.table_schema AND t\.table_name = c\.table_name/)
  assert.match(all, /c\.remarks/)
  assert.match(all, /t\.remarks AS table_remarks/)
  assert.match(all, /c\.table_schema NOT IN \('pg_catalog', 'information_schema', 'pg_internal', 'pg_automv', 'catalog_history'/)
  assert.match(all, /NOT LIKE 'pg_temp_%'/)
  assert.match(R.CATALOG.columns(['public', 'sales']), /c\.table_schema IN \(\$1, \$2\)/)   // a list of $n: Redshift binds no arrays
  assert.equal(R.CATALOG.rows, 'SELECT "schema" AS table_schema, "table" AS table_name, tbl_rows FROM svv_table_info')
  assert.match(R.CATALOG.signatures([]), /FROM svv_columns c WHERE/)
  assert.match(R.CATALOG.tables(['x']), /has_table_privilege\(quote_ident\(t\.table_schema\) \|\| '\.' \|\| quote_ident\(t\.table_name\), 'SELECT'\)/)
  assert.match(R.CATALOG.keys, /information_schema\.table_constraints tc/)
})

test('redshift: the catalog\'s rows become tables — public\'s by name, others schema.table, with comments, rows, keys and references', () => {
  const col = (s: string, t: string, c: string, type: string, o: Record<string, unknown> = {}) => ({ table_schema: s, table_name: t, column_name: c, data_type: type, character_maximum_length: null, numeric_precision: null, numeric_scale: null, is_nullable: 'YES', remarks: null, table_type: 'BASE TABLE', table_remarks: null, ...o })
  const tables = R.tablesOf([
    col('public', 'regions', 'id', 'integer', { is_nullable: 'NO' }),
    col('sales', 'customers', 'id', 'bigint', { is_nullable: 'NO', table_remarks: 'Everyone who bought' }),
    col('sales', 'customers', 'name', 'character varying', { character_maximum_length: 80, table_remarks: 'Everyone who bought' }),
    col('sales', 'customers', 'region_id', 'integer', { remarks: 'Where they are', table_remarks: 'Everyone who bought' }),
    col('sales', 'customers', 'credit', 'numeric', { numeric_precision: 12, numeric_scale: 2, table_remarks: 'Everyone who bought' }),
    col('Sales', 'Big Orders', 'id', 'bigint'),
  ], [{ table_schema: 'sales', table_name: 'customers', tbl_rows: 120 }], [
    { table_schema: 'sales', table_name: 'customers', column_name: 'id', constraint_type: 'PRIMARY KEY' },
    { table_schema: 'sales', table_name: 'customers', column_name: 'region_id', constraint_type: 'FOREIGN KEY', ref_schema: 'public', ref_table: 'regions', ref_column: 'id' },
  ])
  assert.deepEqual(tables.map((t: any) => t.name), ['regions', 'sales.customers', '"Sales"."Big Orders"'])
  assert.deepEqual(tables[1], { name: 'sales.customers', description: 'Everyone who bought', rows: 120, columns: [
    { name: 'id', type: 'bigint', nullable: false, key: true },
    { name: 'name', type: 'character varying(80)', nullable: true },
    { name: 'region_id', type: 'integer', nullable: true, description: 'Where they are', references: 'regions.id' },
    { name: 'credit', type: 'numeric(12,2)', nullable: true },
  ] })
})

// ── LIVE: the PostgreSQL wire protocol, against the PostgreSQL in Docker ─────────────────────────────────────────────
const PW = 'Sa-live-2026!'
const ADMIN = { host: 'localhost', port: 55432, user: 'sa', password: PW }
async function reachable() {
  const c = new pg.Client({ ...ADMIN, database: 'sales', connectionTimeoutMillis: 3000 })
  try { await c.connect(); return true } catch { return false } finally { await c.end().catch(() => {}) }
}
/** A database of its own, with views named as Redshift's catalog views over PostgreSQL's (search_path finds them). */
async function simulated() {
  const a = new pg.Client({ ...ADMIN, database: 'sales' }); await a.connect()
  try { await a.query('CREATE DATABASE redshift_sim') } catch (e: any) { if (e.code !== '42P04') throw e } finally { await a.end() }
  const c = new pg.Client({ ...ADMIN, database: 'redshift_sim' }); await c.connect()
  await c.query(`
    SELECT pg_advisory_lock(4242);
    CREATE SCHEMA IF NOT EXISTS sim; CREATE SCHEMA IF NOT EXISTS sales;
    CREATE OR REPLACE VIEW sim.svv_tables AS SELECT t.table_catalog::text, t.table_schema::text, t.table_name::text, t.table_type::text,
      obj_description(format('%I.%I', t.table_schema, t.table_name)::regclass, 'pg_class') AS remarks FROM information_schema.tables t WHERE t.table_schema <> 'sim';
    CREATE OR REPLACE VIEW sim.svv_columns AS SELECT c.table_catalog::text, c.table_schema::text, c.table_name::text, c.column_name::text, c.ordinal_position::int, c.column_default::text,
      c.is_nullable::text, c.data_type::text, c.character_maximum_length::int, c.numeric_precision::int, c.numeric_scale::int,
      col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS remarks FROM information_schema.columns c WHERE c.table_schema <> 'sim';
    CREATE OR REPLACE VIEW sim.svv_table_info AS SELECT n.nspname::text AS "schema", c.relname::text AS "table", greatest(c.reltuples, 0)::numeric(38,0) AS tbl_rows
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r';
    ALTER DATABASE redshift_sim SET search_path = public, sim;
    CREATE TABLE IF NOT EXISTS public.regions (id int PRIMARY KEY, name varchar(40));
    CREATE TABLE IF NOT EXISTS sales.customers (id bigint PRIMARY KEY, name varchar(80) NOT NULL, region_id int REFERENCES public.regions(id), credit numeric(12,2), big numeric(30,0), joined date, seen timestamp, seen_tz timestamptz);
    COMMENT ON TABLE sales.customers IS 'Everyone who bought';
    COMMENT ON COLUMN sales.customers.region_id IS 'Where they are';
    INSERT INTO public.regions VALUES (1, 'North'), (2, 'South') ON CONFLICT DO NOTHING;
    INSERT INTO sales.customers VALUES (1, 'Ana', 1, 12.50, 123456789012345678901234567890, '2026-10-01', '2026-10-01 10:30:00', '2026-10-01 10:30:00+05:30'), (2, 'Bo', 2, NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
    ALTER TABLE sales.customers DROP COLUMN IF EXISTS added;
    ANALYZE public.regions; ANALYZE sales.customers;
    SELECT pg_advisory_unlock(4242);`)
  return c
}

test('redshift: LIVE over the PostgreSQL protocol — signs in, binds @name as $n, reads in a read-only transaction, plain values, its catalog, signatures, checks', async (t) => {
  if (!(await reachable())) { t.skip('the PostgreSQL in Docker is not running (connectors/test/live/up.sh)'); return }
  const admin = await simulated()
  const b = R.createBridge({ settings: { host: 'localhost:55432/redshift_sim', user: 'sa', ssl: 'disable', schemas: 'public, sales' }, secrets: { password: PW } })
  try {
    assert.equal(b.ready(), true)
    assert.equal(await b.test(), 'signed in as sa on localhost, database redshift_sim')
    assert.equal(await b.check('endpoint'), 'localhost answers on port 55432')
    assert.equal(await b.check('tables'), 'sa may read 2 tables (public 1, sales 1)')
    const rows = await b.query('SELECT id, name, credit, big, joined, seen, seen_tz FROM sales.customers WHERE id = @id OR (id = @id AND name <> @name) ORDER BY id;', { id: 1, name: 'x', unused: 2 })
    assert.deepEqual(rows, [{ id: 1, name: 'Ana', credit: 12.5, big: '123456789012345678901234567890', joined: '2026-10-01', seen: '2026-10-01T10:30:00', seen_tz: '2026-10-01T05:00:00.000Z' }])
    assert.equal(await failed(b.query("INSERT INTO public.regions VALUES (99, 'X')")), 'Redshift: cannot execute INSERT in a read-only transaction')
    assert.deepEqual(await b.query('SELECT count(*) AS n FROM public.regions'), [{ n: 2 }])   // the connection still reads after a refusal
    const d = await b.introspect()
    assert.deepEqual(d.tables.map((x: any) => x.name), ['regions', 'sales.customers'])
    const customers = d.tables[1]
    assert.equal(customers.description, 'Everyone who bought')
    assert.equal(customers.rows, 2)
    assert.deepEqual(customers.columns.slice(0, 4), [
      { name: 'id', type: 'bigint', nullable: false, key: true },
      { name: 'name', type: 'character varying(80)', nullable: false },
      { name: 'region_id', type: 'integer', nullable: true, description: 'Where they are', references: 'regions.id' },
      { name: 'credit', type: 'numeric(12,2)', nullable: true },
    ])
    const before = await b.signatures()
    assert.deepEqual(Object.keys(before).sort(), ['regions', 'sales.customers'])
    await admin.query('ALTER TABLE sales.customers ADD COLUMN added int')
    const after = await b.signatures()
    assert.notEqual(after['sales.customers'], before['sales.customers'])
    assert.equal(after.regions, before.regions)
    const refused = await failed(R.createBridge({ settings: { host: 'localhost', port: 55432, database: 'redshift_sim', user: 'sa', ssl: 'disable' }, secrets: { password: 'wrong' } }).test())
    assert.match(refused, /password authentication failed/)
    assert.match(fixFor(manifest.setup[1], refused), /refused the user name or the password/)
    const closed = await failed(R.createBridge({ settings: { host: 'localhost', port: 1, user: 'sa' }, secrets: { password: 'x' } }).check('endpoint'))
    assert.match(closed, /could not be reached on port 1: ECONNREFUSED/)
    assert.equal(b.isTransient({ code: 'ECONNRESET', message: 'read ECONNRESET' }), true)
    assert.equal(b.isTransient({ code: '42P01', message: 'Redshift: relation "nowhere" does not exist' }), false)
  } finally {
    await admin.query('ALTER TABLE sales.customers DROP COLUMN IF EXISTS added').catch(() => {})
    await admin.end()
    b.close()
  }
})
