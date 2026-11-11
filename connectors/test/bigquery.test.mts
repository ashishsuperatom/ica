// The BigQuery connector against a stand-in for Google's token endpoint and the BigQuery REST API, answering as their
// documentation shows: a JWT-bearer grant (an access token, or invalid_grant); jobs.query (jobComplete false → polled with
// getQueryResults; pageToken → further pages; f/v cells, a TIMESTAMP in microseconds); datasets.list and tables.list
// paged with nextPageToken; tables.get with schema, numRows and tableConstraints; Google's error body. REPLAYED (from the
// documentation) — no Google Cloud project was used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync, verify } from 'node:crypto'
import { checkEngineManifest } from '../src/contract.ts'
import { fixFor } from '../src/setup.ts'
import { createBridge } from '../bridges/bigquery/connector.ts'

const manifest = JSON.parse(readFileSync(new URL('../bridges/bigquery/manifest.json', import.meta.url), 'utf8'))
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))
const gerror = (code: number, message: string, reason: string, status: string) => json({ error: { code, message, errors: [{ message, domain: 'global', reason }], status } }, code)

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY = JSON.stringify({ type: 'service_account', project_id: 'acme-data', private_key_id: 'kid1', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'superatom-reader@acme-data.iam.gserviceaccount.com', client_id: '1', token_uri: 'https://oauth2.googleapis.com/token' })

const API = '/bigquery/v2/projects/acme-data'
let ordersAmountType = 'NUMERIC'
const field = (name: string, type: string, mode = 'NULLABLE', extra: Record<string, unknown> = {}) => ({ name, type, mode, ...extra })
const TABLES: Record<string, any> = {
  customers: { type: 'TABLE', description: 'Everyone who bought', numRows: '120', lastModifiedTime: '1700000000000', schema: { fields: [field('id', 'INTEGER', 'REQUIRED', { description: 'The customer' }), field('name', 'STRING'), field('address', 'RECORD', 'NULLABLE', { fields: [field('city', 'STRING', 'NULLABLE', { description: 'Where they live' }), field('geo', 'RECORD', 'NULLABLE', { fields: [field('lat', 'FLOAT')] })] })] }, tableConstraints: { primaryKey: { columns: ['id'] } } },
  orders: { type: 'TABLE', numRows: '2000', schema: { fields: [field('id', 'INTEGER', 'REQUIRED'), field('customer_id', 'INTEGER'), field('tags', 'STRING', 'REPEATED'), field('lines', 'RECORD', 'REPEATED', { fields: [field('sku', 'STRING')] })] },
    tableConstraints: { primaryKey: { columns: ['id'] }, foreignKeys: [{ name: 'fk_customer', referencedTable: { projectId: 'acme-data', datasetId: 'sales', tableId: 'customers' }, columnReferences: [{ referencingColumn: 'customer_id', referencedColumn: 'id' }] }] } },
  'open-orders': { type: 'VIEW', schema: { fields: [field('id', 'INTEGER')] } },
}

function standIn(seen: { url: string; method: string; headers: Headers; body: any }[] = []) {
  let polled = 0
  return (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url), headers = new Headers(init.headers), method = init.method ?? 'GET'
    const body = init.body ? (headers.get('content-type')?.includes('json') ? JSON.parse(String(init.body)) : String(init.body)) : null
    seen.push({ url, method, headers, body })
    if (u.host === 'oauth2.googleapis.com') {
      const form = new URLSearchParams(String(body))
      const [h, c, s] = String(form.get('assertion')).split('.')
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'))) return json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400)
      return json({ access_token: 'ya29.token', expires_in: 3599, token_type: 'Bearer' })
    }
    if (headers.get('authorization') !== 'Bearer ya29.token') return gerror(401, 'Request is missing required authentication credential.', 'required', 'UNAUTHENTICATED')
    const path = u.pathname
    if (path === `${API}/queries` && method === 'POST') {
      const q = String(body.query)
      if (/SESSION_USER/.test(q)) return json({ kind: 'bigquery#queryResponse', schema: { fields: [field('user', 'STRING')] }, jobReference: { projectId: 'acme-data', jobId: 'job_u', location: 'US' }, totalRows: '1', rows: [{ f: [{ v: 'superatom-reader@acme-data.iam.gserviceaccount.com' }] }], jobComplete: true })
      if (/FROM nowhere/.test(q)) return gerror(400, 'Not found: Table acme-data:sales.nowhere was not found in location US', 'notFound', 'NOT_FOUND')
      if (/INFORMATION_SCHEMA\.COLUMNS/.test(q)) {
        const ds = /`acme-data\.(\w+)`/.exec(q)![1]
        const rows = ds === 'sales' ? [['customers', 'id', 'INT64'], ['customers', 'name', 'STRING'], ['customers', 'address', 'STRUCT<city STRING, geo STRUCT<lat FLOAT64>>'], ['orders', 'id', 'INT64'], ['orders', 'amount', ordersAmountType], ['open-orders', 'id', 'INT64']] : [['budget', 'year', 'INT64']]
        return json({ schema: { fields: [field('table_name', 'STRING'), field('column_name', 'STRING'), field('data_type', 'STRING')] }, jobReference: { jobId: `job_is_${ds}`, location: body.location }, rows: rows.map((r) => ({ f: r.map((v) => ({ v })) })), jobComplete: true })
      }
      if (/FROM sales\.orders/.test(q)) return json({ kind: 'bigquery#queryResponse', jobReference: { projectId: 'acme-data', jobId: 'job_o', location: 'EU' }, jobComplete: false })
    }
    if (path === `${API}/queries/job_o` && method === 'GET') {
      if (polled++ < 1) return json({ jobReference: { jobId: 'job_o', location: 'EU' }, jobComplete: false })
      const schema = { fields: [field('id', 'INTEGER'), field('amount', 'NUMERIC'), field('paid', 'BOOLEAN'), field('at', 'TIMESTAMP'), field('day', 'DATE'), field('tags', 'STRING', 'REPEATED'), field('address', 'RECORD', 'NULLABLE', { fields: [field('city', 'STRING')] }), field('big', 'INTEGER')] }
      if (u.searchParams.get('pageToken') === 'p2') return json({ jobReference: { jobId: 'job_o' }, schema, rows: [{ f: [{ v: '3' }, { v: null }, { v: null }, { v: null }, { v: null }, { v: [] }, { v: null }, { v: null }] }], jobComplete: true })
      return json({ jobReference: { jobId: 'job_o' }, schema, totalRows: '3', pageToken: 'p2', jobComplete: true, rows: [
        { f: [{ v: '1' }, { v: '12.5' }, { v: 'true' }, { v: '1700000000123000' }, { v: '2026-10-01' }, { v: [{ v: 'a' }, { v: 'b' }] }, { v: { f: [{ v: 'Pune' }] } }, { v: '9007199254740993' }] },
        { f: [{ v: '2' }, { v: '0.1' }, { v: 'false' }, { v: '0' }, { v: '1999-12-31' }, { v: [] }, { v: null }, { v: '7' }] },
      ] })
    }
    if (path === `${API}/datasets` && method === 'GET') return u.searchParams.get('pageToken') ? json({ datasets: [{ datasetReference: { projectId: 'acme-data', datasetId: 'finance' }, location: 'US' }] }) : json({ datasets: [{ datasetReference: { projectId: 'acme-data', datasetId: 'sales' }, location: 'EU' }], nextPageToken: 'd2' })
    if (path === `${API}/datasets/sales`) return json({ datasetReference: { datasetId: 'sales' }, location: 'EU' })
    if (path === `${API}/datasets/secret`) return gerror(404, 'Not found: Dataset acme-data:secret', 'notFound', 'NOT_FOUND')
    if (path === `${API}/datasets/sales/tables`) return u.searchParams.get('pageToken') ? json({ tables: [{ tableReference: { tableId: 'open-orders' }, type: 'VIEW' }] }) : json({ tables: [{ tableReference: { tableId: 'customers' }, type: 'TABLE' }, { tableReference: { tableId: 'orders' }, type: 'TABLE' }], nextPageToken: 't2', totalItems: 3 })
    if (path === `${API}/datasets/finance/tables`) return json({ tables: [], totalItems: 0 })
    const t = /\/datasets\/sales\/tables\/([^/]+)$/.exec(path)
    if (t && TABLES[decodeURIComponent(t[1])]) return json({ kind: 'bigquery#table', tableReference: { projectId: 'acme-data', datasetId: 'sales', tableId: decodeURIComponent(t[1]) }, ...TABLES[decodeURIComponent(t[1])] })
    return gerror(404, `Not found: ${path}`, 'notFound', 'NOT_FOUND')
  }) as typeof fetch
}

test('bigquery: the manifest is sound, every field asked in a proven step', () => {
  assert.deepEqual(checkEngineManifest(manifest), [])
  assert.equal(manifest.dialect, 'bigquery')
})

test('bigquery: signs in as the service account — an RS256 JWT exchanged for a token, kept until it nears its end; test() says who and where', async () => {
  const seen: any[] = []
  const b = createBridge({ secrets: { key: KEY }, fetch: standIn(seen) })
  assert.equal(b.ready(), true)
  assert.equal(await b.test(), 'signed in as superatom-reader@acme-data.iam.gserviceaccount.com on project acme-data')
  assert.equal(seen[0].url, 'https://oauth2.googleapis.com/token')
  assert.equal(seen[0].headers.get('content-type'), 'application/x-www-form-urlencoded')
  const [h, c] = new URLSearchParams(seen[0].body).get('assertion')!.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT', kid: 'kid1' })
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
  assert.equal(claims.iss, 'superatom-reader@acme-data.iam.gserviceaccount.com')
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token')
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/bigquery')
  assert.equal(seen[1].headers.get('authorization'), 'Bearer ya29.token')
  assert.equal(seen[1].body.useLegacySql, false)
  await b.test()
  assert.equal(seen.filter((x) => x.url.includes('oauth2')).length, 1, 'the token is asked for once')
  assert.equal(createBridge({}).ready(), false)
})

test('bigquery: a query sends @name as named parameters, is polled until done, follows pageToken, gives plain JSON', async () => {
  const seen: any[] = []
  const b = createBridge({ settings: { location: 'EU' }, secrets: { key: KEY }, fetch: standIn(seen) })
  const rows = await b.query('SELECT * FROM sales.orders WHERE status = @status AND id IN UNNEST(@ids) AND n > @n AND x = @@session_var;', { status: 'open', ids: [1, 2], n: 2.5, unused: 'x' })
  const post = seen.find((x) => x.method === 'POST' && x.url.endsWith('/queries')).body
  assert.equal(post.query, 'SELECT * FROM sales.orders WHERE status = @status AND id IN UNNEST(@ids) AND n > @n AND x = @@session_var')
  assert.equal(post.parameterMode, 'NAMED')
  assert.equal(post.location, 'EU')
  assert.deepEqual(post.queryParameters, [
    { name: 'status', parameterType: { type: 'STRING' }, parameterValue: { value: 'open' } },
    { name: 'ids', parameterType: { type: 'ARRAY', arrayType: { type: 'INT64' } }, parameterValue: { arrayValues: [{ value: '1' }, { value: '2' }] } },
    { name: 'n', parameterType: { type: 'FLOAT64' }, parameterValue: { value: '2.5' } },
  ])
  const gets = seen.filter((x) => x.url.includes('/queries/job_o')).map((x) => new URL(x.url))
  assert.equal(gets.length, 3)   // polled once more while running, done, then page 2
  for (const g of gets) assert.deepEqual([g.searchParams.get('location'), g.searchParams.get('formatOptions.useInt64Timestamp'), g.searchParams.get('maxResults')], ['EU', 'true', '10000'])
  assert.equal(gets[2].searchParams.get('pageToken'), 'p2')
  assert.deepEqual(rows, [
    { id: 1, amount: 12.5, paid: true, at: '2023-11-14T22:13:20.123Z', day: '2026-10-01', tags: ['a', 'b'], address: { city: 'Pune' }, big: '9007199254740993' },
    { id: 2, amount: 0.1, paid: false, at: '1970-01-01T00:00:00.000Z', day: '1999-12-31', tags: [], address: null, big: 7 },
    { id: 3, amount: null, paid: null, at: null, day: null, tags: [], address: null, big: null },
  ])
  assert.match(await failed(b.query('SELECT @o', { o: { a: 1 } })), /cannot be bound/)
})

test('bigquery: introspect walks datasets → tables (paged) → schemas: dataset.table names, descriptions, rows, RECORD fields as a.b, keys and references', async () => {
  const b = createBridge({ secrets: { key: KEY }, fetch: standIn() })
  const d = await b.introspect()
  assert.equal(d.dialect, 'bigquery')
  assert.deepEqual(d.tables.map((t: any) => t.name), ['sales.customers', 'sales.orders', '`sales.open-orders`'])
  assert.deepEqual(d.tables[0], { name: 'sales.customers', description: 'Everyone who bought', rows: 120, columns: [
    { name: 'id', type: 'INTEGER', nullable: false, description: 'The customer', key: true },
    { name: 'name', type: 'STRING', nullable: true },
    { name: 'address.city', type: 'STRING', nullable: true, description: 'Where they live' },
    { name: 'address.geo.lat', type: 'FLOAT', nullable: true },
  ] })
  assert.deepEqual(d.tables[1].columns, [
    { name: 'id', type: 'INTEGER', nullable: false, key: true },
    { name: 'customer_id', type: 'INTEGER', nullable: true, references: 'sales.customers.id' },
    { name: 'tags', type: 'ARRAY<STRING>', nullable: true },
    { name: 'lines.sku', type: 'STRING', nullable: true, description: 'Inside a repeated record: read it with UNNEST.' },
  ])
  assert.equal(d.tables[2].rows, undefined)   // a view: no row count
  assert.equal(await b.check('tables'), 'it may read 3 tables (sales 3)')
  const only = createBridge({ settings: { datasets: 'sales' }, secrets: { key: KEY }, fetch: standIn() })
  assert.equal((await only.introspect()).tables.length, 3)
})

test('bigquery: signatures — one INFORMATION_SCHEMA query per dataset, run where the dataset is — change exactly when a table\'s columns do', async () => {
  const seen: any[] = []
  const b = createBridge({ secrets: { key: KEY }, fetch: standIn(seen) })
  const before = await b.signatures()
  assert.deepEqual(Object.keys(before), ['sales.customers', 'sales.orders', '`sales.open-orders`', 'finance.budget'])
  assert.deepEqual(seen.filter((x) => x.method === 'POST' && x.url.endsWith('/queries')).map((x) => x.body.location), ['EU', 'US'])
  ordersAmountType = 'BIGNUMERIC'
  try {
    const after = await b.signatures()
    assert.notEqual(after['sales.orders'], before['sales.orders'])
    assert.equal(after['sales.customers'], before['sales.customers'])
  } finally { ordersAmountType = 'NUMERIC' }
})

test('bigquery: errors say what Google said, and the setup says how to fix them', async () => {
  const b = createBridge({ secrets: { key: KEY }, fetch: standIn() })
  assert.equal(await failed(b.query('SELECT * FROM nowhere')), 'BigQuery answered 400: Not found: Table acme-data:sales.nowhere was not found in location US')
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
  const refused = await failed(createBridge({ secrets: { key: JSON.stringify({ ...JSON.parse(KEY), private_key: other }) }, fetch: standIn() }).test())
  assert.equal(refused, "Google refused the service account's key (superatom-reader@acme-data.iam.gserviceaccount.com): invalid_grant: Invalid JWT Signature.")
  assert.match(fixFor(manifest.setup[0], refused), /Google refused the key/)
  const notJson = await failed(createBridge({ secrets: { key: '{ "type": ' }, fetch: standIn() }).test())
  assert.match(fixFor(manifest.setup[0], notJson), /not a service account's JSON key/)
  const missing = await failed(createBridge({ settings: { datasets: 'secret' }, secrets: { key: KEY }, fetch: standIn() }).check('tables'))
  assert.equal(missing, 'BigQuery found no such thing (404): Not found: Dataset acme-data:secret')
  assert.match(fixFor(manifest.setup[1], missing), /no dataset by one of those names/)
  assert.match(fixFor(manifest.setup[0], 'BigQuery did not allow it (403 forbidden): Access Denied: Project acme-data: User does not have bigquery.jobs.create permission in project acme-data.'), /BigQuery Job User/)
  assert.equal(b.isTransient({ status: 403, code: 'rateLimitExceeded', message: 'Exceeded rate limits' }), true)
  assert.equal(b.isTransient({ status: 400, code: 'invalidQuery', message: 'Syntax error' }), false)
})
