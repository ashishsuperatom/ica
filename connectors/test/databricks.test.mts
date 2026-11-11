// The Databricks connector against a stand-in for the SQL Statement Execution API, answering as its documentation shows:
// a statement done within wait_timeout (SUCCEEDED, manifest.schema and an INLINE JSON_ARRAY result), or still PENDING /
// RUNNING (polled by statement_id); further chunks by next_chunk_index; a failed statement (status FAILED with its error)
// and a refused token (401, error_code and message). REPLAYED (from the documentation) — no Databricks workspace was used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkEngineManifest } from '../src/contract.ts'
import { fixFor } from '../src/setup.ts'
import { createBridge, workspaceOf, warehouseOf } from '../bridges/databricks/connector.ts'

const manifest = JSON.parse(readFileSync(new URL('../bridges/databricks/manifest.json', import.meta.url), 'utf8'))
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))
const HOST = 'dbc-a1b2c3d4-e5f6.cloud.databricks.com'
const done = (id: string, columns: [string, string][], data: unknown[][], o: { next?: number; chunks?: number } = {}) => ({
  statement_id: id, status: { state: 'SUCCEEDED' },
  manifest: { format: 'JSON_ARRAY', schema: { column_count: columns.length, columns: columns.map(([name, type_name], position) => ({ name, type_text: type_name, type_name, position })) }, total_chunk_count: o.chunks ?? 1, total_row_count: data.length, truncated: false },
  result: { chunk_index: 0, row_offset: 0, row_count: data.length, data_array: data, ...(o.next !== undefined ? { next_chunk_index: o.next, next_chunk_internal_link: `/api/2.0/sql/statements/${id}/result/chunks/${o.next}` } : {}) },
})
let amountType = 'decimal(12,2)'
const S = 'STRING'
const COLUMNS: [string, string][] = [['table_schema', S], ['table_name', S], ['column_name', S], ['full_data_type', S], ['is_nullable', S], ['comment', S], ['table_type', S], ['table_comment', S]]
const catalogRows = () => [
  ['sales', 'customers', 'id', 'bigint', 'NO', 'The customer', 'MANAGED', 'Everyone who bought'],
  ['sales', 'customers', 'name', 'string', 'YES', null, 'MANAGED', 'Everyone who bought'],
  ['sales', 'orders', 'id', 'bigint', 'NO', null, 'MANAGED', null],
  ['sales', 'orders', 'customer_id', 'bigint', 'YES', 'Who ordered', 'MANAGED', null],
  ['sales', 'orders', 'amount', amountType, 'YES', null, 'MANAGED', null],
  ['sales', 'Open Orders', 'id', 'bigint', 'YES', null, 'VIEW', null],
]

function standIn(seen: { url: string; method: string; headers: Headers; body: any }[] = []) {
  let polls = 0
  return (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url), headers = new Headers(init.headers), method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : null
    seen.push({ url, method, headers, body })
    if (u.host !== HOST) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    if (headers.get('authorization') !== 'Bearer dapi-secret') return json({ error_code: '401', message: 'Credential was not sent or was of an unsupported type for this API.' }, 401)
    if (u.pathname === '/api/2.0/sql/statements' && method === 'POST') {
      const s = String(body.statement)
      if (body.warehouse_id !== 'abc123def4567890') return json({ error_code: 'RESOURCE_DOES_NOT_EXIST', message: `Warehouse ${body.warehouse_id} does not exist.` }, 404)
      if (/^SELECT current_user\(\)/.test(s)) return json(done('s0', [['user', S], ['catalog', S]], [['superatom@acme.test', body.catalog ?? 'main']]))
      if (/^SELECT current_catalog\(\)/.test(s)) return json(done('s0', [['catalog', S]], [['main']]))
      if (/FROM nowhere/.test(s)) return json({ statement_id: 'sx', status: { state: 'FAILED', error: { error_code: 'BAD_REQUEST', message: '[TABLE_OR_VIEW_NOT_FOUND] The table or view `nowhere` cannot be found. SQLSTATE: 42P01' } } })
      if (/FROM orders/.test(s)) return json({ statement_id: 's1', status: { state: 'PENDING' } })
      if (/information_schema\.columns c JOIN/.test(s)) return json(done('s2', COLUMNS, catalogRows()))
      if (/information_schema\.columns c WHERE/.test(s)) return json(done('s3', COLUMNS.slice(0, 4), catalogRows().map((r) => r.slice(0, 4))))
      if (/information_schema\.table_constraints/.test(s)) return json(done('s4', [['table_schema', S], ['table_name', S], ['column_name', S], ['constraint_type', S], ['ref_catalog', S], ['ref_schema', S], ['ref_table', S], ['ref_column', S]], [
        ['sales', 'customers', 'id', 'PRIMARY KEY', null, null, null, null], ['sales', 'orders', 'id', 'PRIMARY KEY', null, null, null, null], ['sales', 'orders', 'customer_id', 'FOREIGN KEY', 'main', 'sales', 'customers', 'id']]))
      if (/information_schema\.tables t/.test(s)) return json(done('s5', [['s', S], ['n', 'LONG']], body.parameters?.[0]?.value === 'empty' ? [] : [['sales', '3']]))
    }
    if (u.pathname === '/api/2.0/sql/statements/s1') {
      if (polls++ < 1) return json({ statement_id: 's1', status: { state: 'RUNNING' } })
      return json(done('s1', [['id', 'LONG'], ['name', S], ['amount', 'DECIMAL'], ['paid', 'BOOLEAN'], ['day', 'DATE'], ['tags', 'ARRAY'], ['ratio', 'DOUBLE']],
        [['1', 'Ana', '12.50', 'true', '2026-10-01', '["a","b"]', '0.25'], ['9007199254740993', 'Bo', null, 'false', null, null, null]], { next: 1, chunks: 2 }))
    }
    if (u.pathname === '/api/2.0/sql/statements/s1/result/chunks/1') return json({ chunk_index: 1, row_offset: 2, row_count: 1, data_array: [['3', 'Cleo', '7', 'true', '2026-10-03', '[]', '1']] })
    return json({ error_code: 'NOT_FOUND', message: 'not found' }, 404)
  }) as typeof fetch
}
const SETTINGS = { workspace: `https://${HOST}/?o=123#sql`, warehouse: '/sql/1.0/warehouses/abc123def4567890', catalog: 'main' }

test('databricks: the manifest is sound, every field asked in a proven step', () => {
  assert.deepEqual(checkEngineManifest(manifest), [])
  assert.equal(manifest.dialect, 'databricks')
})

test('databricks: whatever is pasted for the workspace and the warehouse → its address and the warehouse ID', () => {
  assert.deepEqual(workspaceOf(`https://${HOST}/?o=123#sql`), { url: `https://${HOST}` })
  assert.deepEqual(workspaceOf('adb-1234567890123456.7.azuredatabricks.net'), { url: 'https://adb-1234567890123456.7.azuredatabricks.net' })
  assert.deepEqual(workspaceOf(`jdbc:databricks://${HOST}:443/default;transportMode=http;ssl=1;httpPath=/sql/1.0/warehouses/abc123def4567890;AuthMech=3`), { url: `https://${HOST}`, warehouse: 'abc123def4567890' })
  assert.equal(warehouseOf('/sql/1.0/warehouses/abc123def4567890'), 'abc123def4567890')
  assert.equal(warehouseOf('/sql/1.0/endpoints/0123abcd'), '0123abcd')
  assert.equal(warehouseOf(' abc123def4567890 '), 'abc123def4567890')
  assert.throws(() => warehouseOf('my warehouse'), /not a SQL warehouse/)
  assert.throws(() => workspaceOf('not a host'), /not a Databricks workspace/)
})

test('databricks: signs in with its token; test() says who, where and with what; the warehouse may come from a JDBC URL', async () => {
  const seen: any[] = []
  const b = createBridge({ settings: SETTINGS, secrets: { token: 'dapi-secret' }, fetch: standIn(seen) })
  assert.equal(b.ready(), true)
  assert.equal(await b.test(), `signed in as superatom@acme.test on ${HOST}, warehouse abc123def4567890, catalog main`)
  assert.equal(seen[0].url, `https://${HOST}/api/2.0/sql/statements`)
  assert.equal(seen[0].headers.get('authorization'), 'Bearer dapi-secret')
  assert.deepEqual({ ...seen[0].body, statement: undefined }, { statement: undefined, warehouse_id: 'abc123def4567890', catalog: 'main', wait_timeout: '30s', on_wait_timeout: 'CONTINUE', disposition: 'INLINE', format: 'JSON_ARRAY' })
  const jdbc = createBridge({ settings: { workspace: `jdbc:databricks://${HOST}:443/default;httpPath=/sql/1.0/warehouses/abc123def4567890` }, secrets: { token: 'dapi-secret' }, fetch: standIn() })
  assert.equal(jdbc.ready(), true)
  assert.match(await jdbc.test(), /warehouse abc123def4567890/)
  assert.equal(createBridge({ settings: { workspace: HOST }, secrets: { token: 't' } }).ready(), false)   // no warehouse: not tried
  assert.equal(await b.check('workspace'), `found the workspace at ${HOST}, warehouse abc123def4567890`)
  assert.equal(await b.check('tables'), 'it may read 3 tables in main (sales 3)')
})

test('databricks: a query sends @name as named parameters (:name), is polled while it runs, reads every chunk, gives plain JSON', async () => {
  const seen: any[] = []
  const b = createBridge({ settings: SETTINGS, secrets: { token: 'dapi-secret' }, fetch: standIn(seen) })
  const rows = await b.query('SELECT * FROM orders WHERE status = @status AND n > @n AND m = @n AND j = data:field AND at > @since;', { status: 'open', n: 5, since: new Date('2026-01-01T00:00:00Z'), unused: 1 })
  assert.equal(seen[0].body.statement, 'SELECT * FROM orders WHERE status = :status AND n > :n AND m = :n AND j = data:field AND at > :since')
  assert.deepEqual(seen[0].body.parameters, [{ name: 'status', type: 'STRING', value: 'open' }, { name: 'n', type: 'BIGINT', value: '5' }, { name: 'since', type: 'TIMESTAMP', value: '2026-01-01T00:00:00.000Z' }])
  assert.deepEqual(seen.slice(1).map((x) => new URL(x.url).pathname), ['/api/2.0/sql/statements/s1', '/api/2.0/sql/statements/s1', '/api/2.0/sql/statements/s1/result/chunks/1'])
  assert.deepEqual(rows, [
    { id: 1, name: 'Ana', amount: 12.5, paid: true, day: '2026-10-01', tags: ['a', 'b'], ratio: 0.25 },
    { id: '9007199254740993', name: 'Bo', amount: null, paid: false, day: null, tags: null, ratio: null },
    { id: 3, name: 'Cleo', amount: 7, paid: true, day: '2026-10-03', tags: [], ratio: 1 },
  ])
  await b.query('SELECT 1 FROM orders WHERE x = @x', { x: null })
  assert.deepEqual(seen.filter((x) => x.method === 'POST').at(-1).body.parameters, [{ name: 'x', type: 'STRING' }])   // no value: NULL
  assert.match(await failed(b.query('SELECT @xs', { xs: [1] })), /cannot be bound/)
})

test('databricks: introspect gives schema.table with comments, keys and references from information_schema; names that need it in backticks', async () => {
  const b = createBridge({ settings: { ...SETTINGS, schemas: 'Sales' }, secrets: { token: 'dapi-secret' }, fetch: standIn() })
  const d = await b.introspect()
  assert.equal(d.dialect, 'databricks')
  assert.deepEqual(d.tables.map((t: any) => t.name), ['sales.customers', 'sales.orders', 'sales.`Open Orders`'])
  assert.deepEqual(d.tables[0], { name: 'sales.customers', description: 'Everyone who bought', columns: [
    { name: 'id', type: 'bigint', nullable: false, description: 'The customer', key: true },
    { name: 'name', type: 'string', nullable: true },
  ] })
  assert.deepEqual(d.tables[1].columns[1], { name: 'customer_id', type: 'bigint', nullable: true, description: 'Who ordered', references: 'sales.customers.id' })
})

test('databricks: signatures change exactly when a table\'s columns do; with no catalog named, the session\'s is read', async () => {
  const seen: any[] = []
  const b = createBridge({ settings: { ...SETTINGS, catalog: '' }, secrets: { token: 'dapi-secret' }, fetch: standIn(seen) })
  const before = await b.signatures()
  assert.match(seen.at(-1).body.statement, /FROM main\.information_schema\.columns c WHERE/)
  assert.deepEqual(Object.keys(before), ['sales.customers', 'sales.orders', 'sales.`Open Orders`'])
  amountType = 'decimal(14,4)'
  try {
    const after = await b.signatures()
    assert.notEqual(after['sales.orders'], before['sales.orders'])
    assert.equal(after['sales.customers'], before['sales.customers'])
  } finally { amountType = 'decimal(12,2)' }
})

test('databricks: errors say what Databricks said, and the setup says how to fix them', async () => {
  const b = createBridge({ settings: SETTINGS, secrets: { token: 'dapi-secret' }, fetch: standIn() })
  assert.equal(await failed(b.query('SELECT * FROM nowhere')), 'Databricks: [TABLE_OR_VIEW_NOT_FOUND] The table or view `nowhere` cannot be found. SQLSTATE: 42P01')
  const refused = await failed(createBridge({ settings: SETTINGS, secrets: { token: 'wrong' }, fetch: standIn() }).test())
  assert.equal(refused, 'Databricks refused the sign-in (401 unauthorized): Credential was not sent or was of an unsupported type for this API.')
  assert.match(fixFor(manifest.setup[1], refused), /refused the token/)
  const noWarehouse = await failed(createBridge({ settings: { ...SETTINGS, warehouse: 'ffff' }, secrets: { token: 'dapi-secret' }, fetch: standIn() }).test())
  assert.equal(noWarehouse, 'Databricks found no such thing (404): Warehouse ffff does not exist.')
  assert.match(fixFor(manifest.setup[1], noWarehouse), /no warehouse with that ID/)
  const lost = await failed(createBridge({ settings: { ...SETTINGS, workspace: 'dbc-zzz.cloud.databricks.com' }, secrets: { token: 'dapi-secret' }, fetch: standIn() }).check('workspace'))
  assert.match(fixFor(manifest.setup[0], lost), /No workspace answers/)
  const empty = await failed(createBridge({ settings: { ...SETTINGS, schemas: 'empty' }, secrets: { token: 'dapi-secret' }, fetch: standIn() }).check('tables'))
  assert.match(fixFor(manifest.setup[2], empty), /may read no table there/)
  assert.equal(b.isTransient({ status: 503, message: 'x' }), true)
  assert.equal(b.isTransient({ code: 'TEMPORARILY_UNAVAILABLE', message: 'x' }), true)
  assert.equal(b.isTransient(new Error('[TABLE_OR_VIEW_NOT_FOUND]')), false)
})
