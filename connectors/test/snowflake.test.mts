// The Snowflake connector against a stand-in for Snowflake's SQL API v2, answering as its documentation shows: a result
// set (200) with resultSetMetaData.rowType and partitionInfo; a statement still running (202, its handle, polled at
// statementStatusUrl); later partitions read with ?partition=n; a failed statement (422) and a refused sign-in (401)
// with Snowflake's error body. REPLAYED (from the documentation) — no Snowflake account was used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync, createHash, verify } from 'node:crypto'
import { checkEngineManifest } from '../src/contract.ts'
import { fixFor } from '../src/setup.ts'
import { createBridge, accountOf } from '../bridges/snowflake/connector.ts'

const manifest = JSON.parse(readFileSync(new URL('../bridges/snowflake/manifest.json', import.meta.url), 'utf8'))
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })
const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))
const col = (name: string, type: string, scale = 0) => ({ name, database: 'ANALYTICS', schema: 'SALES', table: 'T', nullable: true, type, scale, precision: type === 'fixed' ? 38 : null, length: null, byteLength: null, collation: null })
const resultSet = (rowType: unknown[], data: unknown[][], o: { partitions?: number; handle?: string } = {}) => ({
  resultSetMetaData: { numRows: data.length, format: 'jsonv2', rowType, partitionInfo: Array.from({ length: o.partitions ?? 1 }, () => ({ rowCount: data.length, uncompressedSize: 100 })) },
  data, code: '090001', statementStatusUrl: `/api/v2/statements/${o.handle ?? 'h1'}`, requestId: 'r', sqlState: '00000', statementHandle: o.handle ?? 'h1', message: 'Statement executed successfully.', createdOn: 1_700_000_000_000,
})

// The catalog of one database: two schemas, the keys Snowflake keeps (not enforced).
const COLUMNS_ROWTYPE = ['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'NUMERIC_PRECISION', 'NUMERIC_SCALE', 'IS_NULLABLE', 'COMMENT', 'TABLE_TYPE', 'TABLE_COMMENT', 'ROW_COUNT'].map((n) => col(n, /PRECISION|SCALE|ROW_COUNT/.test(n) ? 'fixed' : 'text'))
let amountType = ['NUMBER', '12', '2']
const catalog = () => [
  ['SALES', 'CUSTOMERS', 'ID', 'NUMBER', '38', '0', 'NO', 'The customer', 'BASE TABLE', 'Everyone who bought', '120'],
  ['SALES', 'CUSTOMERS', 'NAME', 'TEXT', null, null, 'YES', null, 'BASE TABLE', 'Everyone who bought', '120'],
  ['SALES', 'ORDERS', 'ID', 'NUMBER', '38', '0', 'NO', null, 'BASE TABLE', null, '2000'],
  ['SALES', 'ORDERS', 'CUSTOMER_ID', 'NUMBER', '38', '0', 'YES', 'Who ordered', 'BASE TABLE', null, '2000'],
  ['SALES', 'ORDERS', 'AMOUNT', amountType[0], amountType[1], amountType[2], 'YES', null, 'BASE TABLE', null, '2000'],
  ['SALES', 'Open Orders', 'ID', 'NUMBER', '38', '0', 'YES', null, 'VIEW', null, null],
]

function standIn(o: { slow?: boolean; seen?: { url: string; headers: Headers; body: any }[] } = {}) {
  let polls = 0, busy = 0
  return (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url), headers = new Headers(init.headers)
    const body = init.body ? JSON.parse(String(init.body)) : null
    o.seen?.push({ url, headers, body })
    if (u.host !== 'xy12345.eu-west-1.snowflakecomputing.com') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    const auth = headers.get('authorization') ?? ''
    if (!/^Bearer (pat-secret|ey)/.test(auth)) return json({ code: '390303', message: 'Invalid OAuth access token. [1a2b3c]' }, 401)
    if (u.pathname === '/api/v2/statements' && init.method === 'POST') {
      const s = String(body.statement)
      if (/^SELECT CURRENT_USER/.test(s)) return json(resultSet(['user', 'role', 'warehouse', 'database'].map((n) => col(n, 'text')), [['SUPERATOM', 'SUPERATOM_READER', 'COMPUTE_WH', 'ANALYTICS']]))
      if (/FROM nowhere/.test(s)) return json({ code: '002003', sqlState: '42S02', message: "SQL compilation error:\nObject 'NOWHERE' does not exist or not authorized.", statementHandle: 'hx', statementStatusUrl: '/api/v2/statements/hx' }, 422)
      if (/busy/.test(s) && busy++ < 1) return json({ code: '390400', message: 'Too many requests' }, 429, { 'retry-after': '0' })
      if (/FROM orders/i.test(s)) return json({ code: '333334', message: 'Asynchronous execution in progress. Use provided query id to perform query monitoring and management.', statementHandle: 'h-orders', statementStatusUrl: '/api/v2/statements/h-orders' }, 202)
      if (/INFORMATION_SCHEMA\.COLUMNS c JOIN/.test(s)) return json(resultSet(COLUMNS_ROWTYPE, catalog()))
      if (/INFORMATION_SCHEMA\.COLUMNS c WHERE/.test(s)) return json(resultSet(COLUMNS_ROWTYPE.slice(0, 6), catalog().map((r) => r.slice(0, 6))))
      if (/^SHOW PRIMARY KEYS/.test(s)) return json(resultSet(['created_on', 'database_name', 'schema_name', 'table_name', 'column_name', 'key_sequence', 'constraint_name'].map((n) => col(n, 'text')), [['x', 'ANALYTICS', 'SALES', 'CUSTOMERS', 'ID', '1', 'PK1'], ['x', 'ANALYTICS', 'SALES', 'ORDERS', 'ID', '1', 'PK2']]))
      if (/^SHOW IMPORTED KEYS/.test(s)) return json(resultSet(['pk_database_name', 'pk_schema_name', 'pk_table_name', 'pk_column_name', 'fk_database_name', 'fk_schema_name', 'fk_table_name', 'fk_column_name', 'key_sequence'].map((n) => col(n, 'text')), [['ANALYTICS', 'SALES', 'CUSTOMERS', 'ID', 'ANALYTICS', 'SALES', 'ORDERS', 'CUSTOMER_ID', '1']]))
      if (/INFORMATION_SCHEMA\.TABLES t/.test(s)) return json(resultSet([col('s', 'text'), col('n', 'fixed')], body.bindings?.['1']?.value === 'EMPTY' ? [] : [['SALES', '3']]))
      if (/^SELECT 1/.test(s)) return json(resultSet([col('ok', 'fixed')], [['1']]))
    }
    if (u.pathname === '/api/v2/statements/h-orders' && (init.method ?? 'GET') === 'GET') {
      if (u.searchParams.get('partition') === '1') return json({ data: [['3', 'Cleo', '7.00', '19000', '1700000000.000000000', '1700000000.500000000 1440', 'false', '[1,2]']] })
      if (polls++ < 1) return json({ code: '333334', message: 'Asynchronous execution in progress.', statementHandle: 'h-orders', statementStatusUrl: '/api/v2/statements/h-orders' }, 202)
      return json(resultSet([col('ID', 'fixed'), col('NAME', 'text'), col('AMOUNT', 'fixed', 2), col('ORDERED_ON', 'date'), col('AT', 'timestamp_ltz'), col('AT_TZ', 'timestamp_tz'), col('PAID', 'boolean'), col('TAGS', 'variant')],
        [['1', 'Ana', '12.50', '0', '1700000000.123000000', '1700000000.000000000 1500', 'true', '{"a":1}'], ['12345678901234567890', 'Bo', null, '-1', null, null, null, null]], { partitions: 2, handle: 'h-orders' }))
    }
    return json({ code: '000404', message: 'not found' }, 404)
  }) as typeof fetch
}
const SETTINGS = { account: 'https://xy12345.eu-west-1.snowflakecomputing.com/', database: 'ANALYTICS', warehouse: 'COMPUTE_WH', role: 'SUPERATOM_READER' }

test('snowflake: the manifest is sound, every field asked in a proven step', () => {
  assert.deepEqual(checkEngineManifest(manifest), [])
  assert.equal(manifest.dialect, 'snowflake')
})

test('snowflake: whatever is pasted for the account → its host (and the account a key-pair token names)', () => {
  const cases: [string, string, string][] = [
    ['https://xy12345.eu-west-1.snowflakecomputing.com', 'xy12345.eu-west-1.snowflakecomputing.com', 'XY12345'],
    ['xy12345.eu-west-1.snowflakecomputing.com/console', 'xy12345.eu-west-1.snowflakecomputing.com', 'XY12345'],
    ['myorg-myaccount', 'myorg-myaccount.snowflakecomputing.com', 'MYORG-MYACCOUNT'],
    ['MyOrg.My_Account', 'myorg-my-account.snowflakecomputing.com', 'MYORG-MY-ACCOUNT'],
    ['xy12345.us-east-2.aws', 'xy12345.us-east-2.aws.snowflakecomputing.com', 'XY12345'],
    ['xy12345', 'xy12345.snowflakecomputing.com', 'XY12345'],
    ['https://app.snowflake.com/myorg/myaccount/#/homepage', 'myorg-myaccount.snowflakecomputing.com', 'MYORG-MYACCOUNT'],
    ['https://app.snowflake.com/us-east-2.aws/xy12345/worksheets', 'xy12345.us-east-2.aws.snowflakecomputing.com', 'XY12345'],
    ['jdbc:snowflake://myorg-myaccount.privatelink.snowflakecomputing.com/?warehouse=W', 'myorg-myaccount.privatelink.snowflakecomputing.com', 'MYORG-MYACCOUNT'],
  ]
  for (const [given, host, account] of cases) assert.deepEqual(accountOf(given), { host, account }, given)
  assert.throws(() => accountOf('https://example.com'), /not a Snowflake account/)
})

test('snowflake: signs in with a programmatic access token; test() says who, where and with what', async () => {
  const seen: { url: string; headers: Headers; body: any }[] = []
  const b = createBridge({ settings: SETTINGS, secrets: { token: 'pat-secret' }, fetch: standIn({ seen }) })
  assert.equal(b.ready(), true)
  assert.equal(await b.test(), 'signed in as SUPERATOM (role SUPERATOM_READER) on xy12345.eu-west-1.snowflakecomputing.com, warehouse COMPUTE_WH, database ANALYTICS')
  assert.equal(seen[0].headers.get('authorization'), 'Bearer pat-secret')
  assert.equal(seen[0].headers.get('x-snowflake-authorization-token-type'), 'PROGRAMMATIC_ACCESS_TOKEN')
  assert.match(seen[0].url, /^https:\/\/xy12345\.eu-west-1\.snowflakecomputing\.com\/api\/v2\/statements\?requestId=[0-9a-f-]{36}$/)
  assert.deepEqual({ ...seen[0].body, statement: undefined }, { statement: undefined, timeout: 120, database: 'ANALYTICS', warehouse: 'COMPUTE_WH', role: 'SUPERATOM_READER' })
  assert.equal(createBridge({ settings: SETTINGS }).ready(), false)   // no token: not tried
  assert.equal(await b.check('account'), 'found the account at xy12345.eu-west-1.snowflakecomputing.com')
  assert.equal(await b.check('tables'), 'it may read 3 tables (SALES 3)')
})

test('snowflake: signs in with a key pair — an RS256 JWT naming the account, the user and the key\'s fingerprint; a key pasted on one line still read', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const seen: { url: string; headers: Headers; body: any }[] = []
  const b = createBridge({ settings: { ...SETTINGS, auth: 'key-pair', user: 'superatom' }, secrets: { privateKey: pem.replace(/\n/g, ' ') }, fetch: standIn({ seen }) })
  assert.equal(b.ready(), true)
  await b.test()
  assert.equal(seen[0].headers.get('x-snowflake-authorization-token-type'), 'KEYPAIR_JWT')
  const [h, c, s] = seen[0].headers.get('authorization')!.replace(/^Bearer /, '').split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
  const fp = 'SHA256:' + createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  assert.equal(claims.iss, `XY12345.SUPERATOM.${fp}`)
  assert.equal(claims.sub, 'XY12345.SUPERATOM')
  assert.equal(claims.exp - claims.iat, 3600)
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')), 'signed with the private key')
  await b.test()
  assert.equal(seen[1].headers.get('authorization'), seen[0].headers.get('authorization'), 'the token is made once, used until it nears its end')
  assert.match(await failed(createBridge({ settings: { ...SETTINGS, auth: 'key-pair', user: 'u' }, secrets: { privateKey: 'not a key' }, fetch: standIn() }).test()), /private key could not be read/)
})

test('snowflake: a query binds @name as positional bindings, waits while it runs (202, polled), reads every partition, gives plain JSON', async () => {
  const seen: { url: string; headers: Headers; body: any }[] = []
  const b = createBridge({ settings: SETTINGS, secrets: { token: 'pat-secret' }, fetch: standIn({ seen }) })
  const rows = await b.query('SELECT * FROM orders WHERE status = @status AND n > @n OR note = @status AND x = @@not_a_param AND s = @stage;', { status: 'open', n: 5, stage: undefined, extra: true })
  const post = seen[0].body
  assert.equal(post.statement, 'SELECT * FROM orders WHERE status = ? AND n > ? OR note = ? AND x = @@not_a_param AND s = ?')
  assert.deepEqual(post.bindings, { 1: { type: 'TEXT', value: 'open' }, 2: { type: 'FIXED', value: '5' }, 3: { type: 'TEXT', value: 'open' }, 4: { type: 'TEXT', value: null } })
  assert.deepEqual(seen.slice(1).map((x) => new URL(x.url).pathname + new URL(x.url).search), ['/api/v2/statements/h-orders', '/api/v2/statements/h-orders', '/api/v2/statements/h-orders?partition=1'])
  assert.deepEqual(rows, [
    { ID: 1, NAME: 'Ana', AMOUNT: 12.5, ORDERED_ON: '1970-01-01', AT: '2023-11-14T22:13:20.123Z', AT_TZ: '2023-11-14T22:13:20.000Z', PAID: true, TAGS: { a: 1 } },
    { ID: '12345678901234567890', NAME: 'Bo', AMOUNT: null, ORDERED_ON: '1969-12-31', AT: null, AT_TZ: null, PAID: null, TAGS: null },   // too large for a double: kept as text
    { ID: 3, NAME: 'Cleo', AMOUNT: 7, ORDERED_ON: '2022-01-08', AT: '2023-11-14T22:13:20.000Z', AT_TZ: '2023-11-14T22:13:20.500Z', PAID: false, TAGS: [1, 2] },
  ])
  assert.match(await failed(b.query('SELECT @xs', { xs: [1, 2] })), /cannot be bound/)
})

test('snowflake: introspect gives tables as SCHEMA.TABLE with comments, rows, primary keys and references; mixed-case names quoted', async () => {
  const b = createBridge({ settings: { ...SETTINGS, schemas: 'sales' }, secrets: { token: 'pat-secret' }, fetch: standIn() })
  const d = await b.introspect()
  assert.equal(d.dialect, 'snowflake')
  assert.deepEqual(d.tables.map((t: any) => t.name), ['SALES.CUSTOMERS', 'SALES.ORDERS', 'SALES."Open Orders"'])
  assert.deepEqual(d.tables[0], { name: 'SALES.CUSTOMERS', description: 'Everyone who bought', rows: 120, columns: [
    { name: 'ID', type: 'NUMBER(38,0)', nullable: false, description: 'The customer', key: true },
    { name: 'NAME', type: 'TEXT', nullable: true },
  ] })
  assert.deepEqual(d.tables[1].columns[1], { name: 'CUSTOMER_ID', type: 'NUMBER(38,0)', nullable: true, description: 'Who ordered', references: 'SALES.CUSTOMERS.ID' })
  assert.equal(d.tables[2].rows, undefined)   // a view: no row count
})

test('snowflake: signatures change exactly when a table\'s columns do', async () => {
  const b = createBridge({ settings: SETTINGS, secrets: { token: 'pat-secret' }, fetch: standIn() })
  const before = await b.signatures()
  assert.deepEqual(Object.keys(before), ['SALES.CUSTOMERS', 'SALES.ORDERS', 'SALES."Open Orders"'])
  assert.deepEqual(await b.signatures(), before)
  amountType = ['NUMBER', '14', '4']
  try {
    const after = await b.signatures()
    assert.notEqual(after['SALES.ORDERS'], before['SALES.ORDERS'])
    assert.equal(after['SALES.CUSTOMERS'], before['SALES.CUSTOMERS'])
  } finally { amountType = ['NUMBER', '12', '2'] }
})

test('snowflake: errors say what Snowflake said, and the setup says how to fix them', async () => {
  const b = createBridge({ settings: SETTINGS, secrets: { token: 'pat-secret' }, fetch: standIn() })
  const sqlError = await failed(b.query('SELECT * FROM nowhere'))
  assert.equal(sqlError, "Snowflake: SQL compilation error: Object 'NOWHERE' does not exist or not authorized.")
  assert.equal(b.isTransient(new Error(sqlError)), false)
  const refused = await failed(createBridge({ settings: SETTINGS, secrets: { token: 'wrong' }, fetch: standIn() }).test())
  assert.equal(refused, 'Snowflake refused the sign-in (401 unauthorized): Invalid OAuth access token. [1a2b3c]')
  const signin = manifest.setup.find((s: any) => s.id === 'signin')
  assert.match(fixFor(signin, refused), /refused the token/)
  const lost = await failed(createBridge({ settings: { ...SETTINGS, account: 'xy99999.eu-west-1' }, secrets: { token: 'pat-secret' }, fetch: standIn() }).check('account'))
  assert.match(lost, /could not be reached at xy99999\.eu-west-1\.snowflakecomputing\.com: fetch failed \(ENOTFOUND\)/)
  assert.match(fixFor(manifest.setup[0], lost), /No Snowflake account answers/)
  assert.deepEqual(await b.query('SELECT 1 /* busy */'), [{ ok: 1 }])   // 429 retried
  assert.equal(b.isTransient({ status: 429, message: 'x' }), true)
  const empty = await failed(createBridge({ settings: { ...SETTINGS, schemas: 'empty' }, secrets: { token: 'pat-secret' }, fetch: standIn() }).check('tables'))
  assert.match(fixFor(manifest.setup[2], empty), /may read no table there/)
})
