// The odata connector, replayed: a v4 service found from an entity set's URL (the paths above it tried), each way of
// signing in, the entity sets a person names, a JSON query with OData's own options, its setup check. Live against the
// public sample services: test/live/odata.live.test.mts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createBridge as odata } from '../bridges/odata/connector.ts'
import { checkEngineManifest } from '../src/contract.ts'

const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))
const json = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })

const METADATA = `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="Demo" xmlns="http://docs.oasis-open.org/odata/ns/edm">
<EntityType Name="Category"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.Int32" Nullable="false"/><Property Name="Name" Type="Edm.String"/><NavigationProperty Name="Products" Type="Collection(Demo.Product)" Partner="Category"/></EntityType>
<EntityType Name="Product"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.Int32" Nullable="false"/><Property Name="Name" Type="Edm.String"><Annotation Term="Org.OData.Core.V1.Description" String="What the product is called"/></Property><Property Name="Price" Type="Edm.Decimal"/><Property Name="CategoryID" Type="Edm.Int32"/>
<NavigationProperty Name="Category" Type="Demo.Category" Partner="Products"><ReferentialConstraint Property="CategoryID" ReferencedProperty="ID"/></NavigationProperty></EntityType>
<EntityContainer Name="DemoService"><EntitySet Name="Categories" EntityType="Demo.Category"><NavigationPropertyBinding Path="Products" Target="Products"/></EntitySet><EntitySet Name="Products" EntityType="Demo.Product"><NavigationPropertyBinding Path="Category" Target="Categories"/></EntitySet></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`

/** The service at https://data.example.com/svc/, signing in as `want` asks. */
function service(want: (h: Headers) => boolean) {
  const seen: { url: string; headers: Headers }[] = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers); seen.push({ url, headers: h })
    const u = new URL(url)
    if (url === 'https://login.example.com/oauth2/token') {
      const f = new URLSearchParams(String(init.body))
      return f.get('client_secret') === 'cs' ? json({ access_token: 'at-1', token_type: 'Bearer', expires_in: 3600 }) : json({ error: 'invalid_client', error_description: 'bad secret' }, { status: 401 })
    }
    if (!want(h)) return json({ error: { code: '401', message: 'Authorization has been denied for this request.' } }, { status: 401 })
    if (u.pathname === '/svc/$metadata') return new Response(METADATA, { headers: { 'content-type': 'application/xml' } })
    if (u.pathname === '/svc/Products/$metadata') return json({ error: { code: '', message: "No HTTP resource was found that matches the request URI" } }, { status: 404 })
    if (u.pathname === '/svc/Categories') return json({ '@odata.context': 'https://data.example.com/svc/$metadata#Categories', value: [{ ID: 1, Name: 'Beverages' }] })
    if (u.pathname === '/svc/Products') return json({ '@odata.context': 'https://data.example.com/svc/$metadata#Products', value: [{ ID: 1, Name: 'Chai', Price: 18, CategoryID: 1 }, { ID: 2, Name: 'Chang', Price: 19, CategoryID: 1 }] })
    return json({ error: { code: '', message: 'not found' } }, { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

test('odata: found from an entity set\'s URL, tested with $metadata and one row, described with keys, links and descriptions; signatures per entity set', async () => {
  const s = service(() => true)
  const c = odata({ settings: { url: 'https://data.example.com/svc/Products?$top=5' }, fetch: s.fetch })
  assert.ok(c.ready())
  assert.equal(await c.test(), 'OData v4 service at https://data.example.com/svc/: 2 entity sets; read 1 row of Categories')
  assert.ok(s.seen.some((x) => x.url === 'https://data.example.com/svc/Products/$metadata'))   // tried first, then the path above
  const d: any = await c.introspect()
  assert.deepEqual(d.tables.map((t: any) => t.name), ['Categories', 'Products'])
  assert.deepEqual(d.tables[1].columns, [
    { name: 'ID', type: 'integer', key: true, nullable: false },
    { name: 'Name', type: 'string', description: 'What the product is called', nullable: true },
    { name: 'Price', type: 'number', nullable: true },
    { name: 'CategoryID', type: 'integer', references: 'Categories.ID', nullable: true },
  ])
  assert.match(d.tables[1].description, /Linked: Category → Categories \(one\)/)
  const sig = await c.signatures()
  assert.deepEqual(Object.keys(sig), ['Categories', 'Products'])
  assert.match(c.description, /"filter": "<an OData \$filter>"/)
  assert.match(c.description, /A query is JSON/)
  const rows = await c.query(JSON.stringify({ entity: 'Products', filters: { CategoryID: 1 }, filter: "startswith(Name,'Ch')", select: ['ID', 'Name'], orderby: 'Price desc', limit: 2 }))
  assert.deepEqual(rows.map((r: any) => r.Name), ['Chai', 'Chang'])
  const read = new URL(s.seen.at(-1)!.url)
  assert.equal(read.searchParams.get('$filter'), "(startswith(Name,'Ch')) and CategoryID eq 1")
  assert.equal(read.searchParams.get('$select'), 'ID,Name'); assert.equal(read.searchParams.get('$orderby'), 'Price desc'); assert.equal(read.searchParams.get('$top'), '2')
  assert.match(await failed(c.query(JSON.stringify({ entity: 'Suppliers' }))), /no entity set "Suppliers"/)
  assert.equal(odata({ settings: {} }).ready(), false)
})

test('odata: each way of signing in — basic, an API key in the header named (APIKey by default), an OAuth client (its token kept) — and a refusal in the service\'s words', async () => {
  const basic = service((h) => h.get('authorization') === `Basic ${Buffer.from('reader:pw').toString('base64')}`)
  assert.match(await odata({ settings: { url: 'https://data.example.com/svc/', auth: 'basic', user: 'reader' }, secrets: { password: 'pw' }, fetch: basic.fetch }).test(), /2 entity sets/)
  const key = service((h) => h.get('APIKey') === 'k-1')
  assert.match(await odata({ settings: { url: 'https://data.example.com/svc/', auth: 'api-key' }, secrets: { apiKey: 'k-1' }, fetch: key.fetch }).test(), /2 entity sets/)
  const named = service((h) => h.get('x-api-key') === 'k-2')
  assert.match(await odata({ settings: { url: 'https://data.example.com/svc/', auth: 'api-key', apiKeyHeader: 'x-api-key' }, secrets: { apiKey: 'k-2' }, fetch: named.fetch }).test(), /2 entity sets/)
  const oauth = service((h) => h.get('authorization') === 'Bearer at-1')
  const settings = { url: 'https://data.example.com/svc/', auth: 'oauth-client', tokenUrl: 'https://login.example.com/oauth2/token', clientId: 'ci', scope: 'svc/.default' }
  const c = odata({ settings, secrets: { clientSecret: 'cs' }, fetch: oauth.fetch })
  await c.test(); await c.introspect()
  assert.equal(oauth.seen.filter((x) => x.url.includes('/oauth2/token')).length, 1)   // one token for every call
  assert.match(await failed(odata({ settings, secrets: { clientSecret: 'wrong' }, fetch: oauth.fetch }).test()), /the sign-in at login.example.com was refused \(401\): invalid_client: bad secret/)
  assert.match(await failed(odata({ settings: { url: 'https://data.example.com/svc/', auth: 'basic', user: 'reader' }, secrets: { password: 'nope' }, fetch: basic.fetch }).test()), /the credentials were refused: Authorization has been denied for this request\./)
})

test('odata: the entity sets a person names are the ones read; its check lists them, or names one that is not there', async () => {
  const s = service(() => true)
  const c = odata({ settings: { url: 'https://data.example.com/svc/', entitySets: 'Products' }, fetch: s.fetch })
  assert.deepEqual((await c.introspect()).tables.map((t: any) => t.name), ['Products'])
  assert.equal(await c.check('entity-sets'), '1 entity set to read: Products')
  assert.match(await c.test(), /read 1 row of Products/)
  assert.match(await failed(c.query(JSON.stringify({ entity: 'Categories' }))), /not among the entity sets this connection reads \(Products\)/)
  assert.equal(await odata({ settings: { url: 'https://data.example.com/svc/' }, fetch: s.fetch }).check('entity-sets'), '2 entity sets to read: Categories, Products')
  assert.match(await failed(odata({ settings: { url: 'https://data.example.com/svc/', entitySets: 'Products, Supplier' }, fetch: s.fetch }).check('entity-sets')), /no entity set "Supplier" \(it has: Categories, Products\)/)
})

test('odata: a sign-in page or a web page where $metadata should be is said so', async () => {
  const page = (async () => new Response('<html><body><form>Sign in</form></body></html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch
  assert.match(await failed(odata({ settings: { url: 'https://portal.example.com/odata/' }, fetch: page }).test()), /did not answer with an OData service's \$metadata \(it sent a web page — perhaps a sign-in page\)/)
})

test('odata: its manifest is sound and asks every field in a step', () => {
  const m = JSON.parse(readFileSync(new URL('../bridges/odata/manifest.json', import.meta.url), 'utf8'))
  assert.deepEqual(checkEngineManifest(m), [])
  assert.deepEqual(m.setup.map((s: any) => s.check.kind), ['reach', 'signin', 'custom'])
})
