// src/odata.ts, replayed: $metadata as v2 (with SAP's annotations and associations) and v4 (with Core/Common
// annotations, inline and in <Annotations> blocks, inheritance, referential constraints) services write it; reads paged
// by d.__next and @odata.nextLink; filters written as each type asks; the client-credentials token; SAP's CSRF answer;
// the errors' words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attr, clientCredentials, entitiesOf, kids, literal, odataSource, parseXml, readMetadata, serviceRootOf, signerOf, type Signer } from '../src/odata.ts'
import { refusal, saidIn } from '../src/api.ts'
import type { ConnectorContext } from '../src/contract.ts'
import { SAP_V2 } from './odata-fixtures.mts'

const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))
const json = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
const xml = (s: string) => new Response(s, { headers: { 'content-type': 'application/xml' } })
const ctxOf = (fetch: typeof globalThis.fetch, settings: Record<string, any> = {}, secrets: Record<string, string> = {}): ConnectorContext => ({ settings, secrets, fetch, log: () => {} })
const none: Signer = async () => ({})

// A v4 service: a schema with an alias, a base type, an enum and a complex type, inline Core.Description and
// Common.Label in an <Annotations> block (as SAP's and Microsoft's v4 services write them), a navigation property with
// its referential constraint and its binding.
const V4 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:Reference Uri="https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Core.V1.xml"><edmx:Include Namespace="Org.OData.Core.V1" Alias="Core"/></edmx:Reference>
  <edmx:DataServices>
    <Schema Namespace="Shop.Model" Alias="SM" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EnumType Name="Status"><Member Name="Open" Value="0"/><Member Name="Closed" Value="1"/></EnumType>
      <ComplexType Name="Address"><Property Name="City" Type="Edm.String"/></ComplexType>
      <EntityType Name="Thing" Abstract="true">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
        <Property Name="CreatedAt" Type="Edm.DateTimeOffset"/>
      </EntityType>
      <EntityType Name="Customer" BaseType="SM.Thing">
        <Property Name="Name" Type="Edm.String" Nullable="false"><Annotation Term="Core.Description" String="The customer's legal name"/></Property>
        <Property Name="Address" Type="SM.Address"/>
        <Property Name="Tags" Type="Collection(Edm.String)"/>
        <NavigationProperty Name="Orders" Type="Collection(SM.Order)" Partner="Customer"/>
      </EntityType>
      <EntityType Name="Order" BaseType="Shop.Model.Thing">
        <Annotation Term="Core.Description"><String>An order a customer placed</String></Annotation>
        <Property Name="CustomerID" Type="Edm.Int32"/>
        <Property Name="Total" Type="Edm.Decimal" Scale="2"/>
        <Property Name="OrderDate" Type="Edm.Date"/>
        <Property Name="Status" Type="SM.Status"/>
        <Property Name="Ref" Type="Edm.Guid"/>
        <NavigationProperty Name="Customer" Type="SM.Customer" Partner="Orders"><ReferentialConstraint Property="CustomerID" ReferencedProperty="ID"/></NavigationProperty>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Customers" EntityType="SM.Customer"><NavigationPropertyBinding Path="Orders" Target="Orders"/></EntitySet>
        <EntitySet Name="Orders" EntityType="SM.Order"><NavigationPropertyBinding Path="Customer" Target="Customers"/></EntitySet>
      </EntityContainer>
      <Annotations Target="SM.Order/Total"><Annotation Term="com.sap.vocabularies.Common.v1.Label" String="Order total"/><Annotation Term="Core.Description" String="Including tax"/></Annotations>
      <Annotations Target="SM.Container/Customers"><Annotation Term="Common.Label" String="Customers"/></Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

test('the XML reader: namespaces resolved, entities and CDATA read, comments skipped, a ">" inside a value, a DOCTYPE never expanded, broken XML refused', () => {
  const doc = parseXml(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY boom "BOOM">]><!-- note --><a:root xmlns:a="urn:a" xmlns="urn:d" xmlns:s="urn:s"><item s:label="x &gt; y" name='q "w"'>A &amp; B &#65;&#x42; &boom;<![CDATA[<raw>]]></item><empty/></a:root>`)
  assert.equal(doc.name, 'root'); assert.equal(doc.ns, 'urn:a')
  const [item, empty] = doc.children
  assert.equal(item.ns, 'urn:d'); assert.equal(empty.name, 'empty')
  assert.equal(attr(item, 'label', 'urn:s'), 'x > y'); assert.equal(attr(item, 's:label'), 'x > y'); assert.equal(attr(item, 'name'), 'q "w"')
  assert.equal(item.text, 'A & B AB &boom;<raw>')
  assert.deepEqual(kids(doc, 'item').length, 1)
  assert.throws(() => parseXml('<a><b></a>'), /<\/a> closes <b>/)
  assert.throws(() => parseXml('<a>'), /<a> is not closed/)
  assert.throws(() => parseXml('just text'), /no element/)
})

test('v2 metadata as SAP writes it: labels and quick info as descriptions, keys, a date that is a day, references from the association, unaddressable sets left out, a filter a read must give', () => {
  const m = readMetadata(SAP_V2)
  assert.equal(m.version, 2)
  const es = entitiesOf(m, { prefix: 'API_BUSINESS_PARTNER.' })
  assert.deepEqual(es.map((e) => e.name), ['API_BUSINESS_PARTNER.A_BusinessPartner', 'API_BUSINESS_PARTNER.A_BusinessPartnerAddress', 'API_BUSINESS_PARTNER.A_BPRole'])
  const bp = es[0]
  assert.equal(bp.label, 'Business Partner')
  assert.match(bp.description!, /Linked: to_BusinessPartnerAddress → API_BUSINESS_PARTNER\.A_BusinessPartnerAddress \(many\)/)
  assert.deepEqual(bp.fields[0], { name: 'BusinessPartner', type: 'string', description: 'Business Partner — Business Partner Number', key: true, nullable: false })
  assert.deepEqual(bp.fields.find((f) => f.name === 'CreationDate'), { name: 'CreationDate', type: 'date', description: 'Created On — Date on which the object was created', nullable: true })
  assert.equal(bp.fields.find((f) => f.name === 'LastChangeDateTime')!.type, 'timestamp')
  assert.equal(bp.fields.find((f) => f.name === 'BusinessPartnerIsBlocked')!.type, 'boolean')
  const addr = es[1]
  assert.deepEqual(addr.fields.filter((f) => f.key).map((f) => f.name), ['BusinessPartner', 'AddressID'])
  assert.equal(addr.fields[0].references, 'API_BUSINESS_PARTNER.A_BusinessPartner.BusinessPartner')
  assert.match(es[2].description!, /A read must filter on BusinessPartner\./)
})

test('v4 metadata: inherited keys and properties, an alias resolved, Core.Description and Common.Label inline and in <Annotations>, enum and complex types, a referential constraint through its binding', () => {
  const m = readMetadata(V4)
  assert.equal(m.version, 4)
  const [customers, orders] = entitiesOf(m)
  assert.equal(customers.label, 'Customers')
  assert.deepEqual(customers.fields.map((f) => [f.name, f.type, !!f.key]), [['ID', 'integer', true], ['CreatedAt', 'timestamp', false], ['Name', 'string', false], ['Address', 'json', false], ['Tags', 'json', false]])
  assert.equal(customers.fields[2].description, "The customer's legal name")
  assert.equal(customers.fields[2].nullable, false)
  assert.match(customers.description!, /Orders → Orders \(many\)/)
  assert.match(orders.description!, /^An order a customer placed Linked: Customer → Customers \(one\)\.$/)
  assert.deepEqual(orders.fields.find((f) => f.name === 'CustomerID'), { name: 'CustomerID', type: 'integer', references: 'Customers.ID', nullable: true })
  assert.deepEqual(orders.fields.find((f) => f.name === 'Total'), { name: 'Total', type: 'number', description: 'Order total — Including tax', nullable: true })
  assert.equal(orders.fields.find((f) => f.name === 'OrderDate')!.type, 'date')
  assert.equal(orders.fields.find((f) => f.name === 'Status')!.type, 'string')
  assert.throws(() => readMetadata('<html><body>Sign in</body></html>'), /not an OData service's \$metadata/)
})

test('the service root from what a person pastes', () => {
  assert.equal(serviceRootOf('https://services.odata.org/V4/Northwind/Northwind.svc/Products(1)?$select=Name'), 'https://services.odata.org/V4/Northwind/Northwind.svc/')
  assert.equal(serviceRootOf('https://services.odata.org/V2/Northwind/Northwind.svc/$metadata'), 'https://services.odata.org/V2/Northwind/Northwind.svc/')
  assert.equal(serviceRootOf('https://erp.example.com:44300/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder?$top=1'), 'https://erp.example.com:44300/sap/opu/odata/sap/API_SALES_ORDER_SRV/')
  assert.equal(serviceRootOf('https://erp.example.com/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001/Product'), 'https://erp.example.com/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001/')
  assert.equal(serviceRootOf('https://api.example.com/odata/Orders(42)/Items'), 'https://api.example.com/odata/')   // from the keyed segment on
  assert.equal(serviceRootOf('https://api.example.com/odata/Orders'), 'https://api.example.com/odata/Orders/')       // a plain entity set: the connector tries the paths above
  assert.equal(serviceRootOf('https://api.example.com/odata/$metadata'), 'https://api.example.com/odata/')
  assert.equal(serviceRootOf('https://api.example.com/odata'), 'https://api.example.com/odata/')
  assert.throws(() => serviceRootOf('not a url'), /not a web address/)
  assert.throws(() => serviceRootOf('ftp://x.example.com/'), /not a web address/)
})

test('literals: each value written as its type asks, in v2 and v4; a quote doubled; a value that cannot be its type refused', () => {
  assert.equal(literal("O'Brien", 'Edm.String', 4), "'O''Brien'")
  assert.equal(literal("x' or 1 eq 1 or 'a", 'Edm.String', 2), "'x'' or 1 eq 1 or ''a'")
  assert.equal(literal(5, 'Edm.Int32', 2), '5')
  assert.equal(literal('5', 'Edm.Int64', 2), '5L'); assert.equal(literal('5', 'Edm.Int64', 4), '5')
  assert.equal(literal('12.5', 'Edm.Decimal', 2), '12.5M'); assert.equal(literal(12.5, 'Edm.Decimal', 4), '12.5')
  assert.equal(literal(true, 'Edm.Boolean', 2), 'true')
  assert.equal(literal('2024-01-31', 'Edm.DateTime', 2), "datetime'2024-01-31T00:00:00'")
  assert.equal(literal('2024-01-31T09:30', 'Edm.DateTime', 2), "datetime'2024-01-31T09:30:00'")
  assert.equal(literal('2024-01-31', 'Edm.DateTimeOffset', 4), '2024-01-31T00:00:00Z')
  assert.equal(literal('2024-01-31T09:30:00+05:30', 'Edm.DateTimeOffset', 2), "datetimeoffset'2024-01-31T09:30:00+05:30'")
  assert.equal(literal('2024-01-31', 'Edm.Date', 4), '2024-01-31')
  assert.equal(literal('3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'Edm.Guid', 2), "guid'3f2504e0-4f89-11d3-9a0c-0305e82c3301'")
  assert.equal(literal('3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'Edm.Guid', 4), '3f2504e0-4f89-11d3-9a0c-0305e82c3301')
  assert.equal(literal('Open', 'Shop.Model.Status', 4, new Set(['Shop.Model.Status'])), "Shop.Model.Status'Open'")
  assert.equal(literal(null, 'Edm.String', 4), 'null')
  assert.equal(literal(7, undefined, 4), '7'); assert.equal(literal('seven', undefined, 4), "'seven'")
  assert.throws(() => literal('1 or 1 eq 1', 'Edm.Int32', 4), /not a whole number/)
  assert.throws(() => literal('yes', 'Edm.Boolean', 4), /true or false/)
  assert.throws(() => literal('2024-01-31) or (1 eq 1', 'Edm.Date', 4), /not a date/)
})

test('a v2 read: $filter, $select, $orderby, $top and $format=json in the URL, sap-client on every request, pages followed by d.__next, rows cleaned (/Date()/, decimals, __metadata, deferred links); counted', async () => {
  const seen: string[] = []
  const api = (async (url: string) => {
    seen.push(url)
    const u = new URL(url)
    assert.equal(u.searchParams.get('sap-client'), '100')
    if (u.pathname.endsWith('/$metadata')) return xml(SAP_V2)
    if (u.pathname.endsWith('/A_BPRole/$count')) return new Response('42', { headers: { 'content-type': 'text/plain' } })
    if (u.pathname.endsWith('/A_BPRole')) {
      const row = (n: string) => ({ __metadata: { id: `https://erp.example.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BPRole('${n}')`, type: 'API_BUSINESS_PARTNER.A_BPRoleType' }, BusinessPartner: n, BusinessPartnerRole: 'FLCU01', ValidFrom: '/Date(1704067200000+0000)/', Amount: '1234.500', Counter: '12', Id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', to_Partner: { __deferred: { uri: 'x' } } })
      if (u.searchParams.get('$skiptoken')) return json({ d: { results: [row('3')] } })
      return json({ d: { results: [row('1'), row('2')], __next: 'https://erp.example.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BPRole?sap-client=100&$skiptoken=2' } })
    }
    return json({ error: { code: '/IWBEP/CM_MGW_RT/020', message: { lang: 'en', value: `Resource not found for segment '${u.pathname}'.` } } }, { status: 404 })
  }) as typeof fetch
  const src = odataSource(ctxOf(api), none, { root: 'https://erp.example.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/', params: { 'sap-client': '100' } })
  const r = await src.read('A_BPRole', { entity: 'A_BPRole', filters: { BusinessPartner: "17'00", ValidFrom: '2024-01-01', Amount: [1, 2.5] } as any, query: { filter: "BusinessPartnerRole eq 'FLCU01' or BusinessPartnerRole eq 'FLCU00'", select: ['BusinessPartner', 'Amount'], orderby: 'BusinessPartner desc' }, limit: 10 })
  const first = new URL(seen[1])
  assert.equal(first.searchParams.get('$filter'), "(BusinessPartnerRole eq 'FLCU01' or BusinessPartnerRole eq 'FLCU00') and BusinessPartner eq '17''00' and ValidFrom eq datetimeoffset'2024-01-01T00:00:00Z' and (Amount eq 1M or Amount eq 2.5M)")
  assert.match(seen[1], /\$filter=\(BusinessPartnerRole%20eq%20'FLCU01'/)   // spaces as %20, never +
  assert.equal(first.searchParams.get('$select'), 'BusinessPartner,Amount')
  assert.equal(first.searchParams.get('$orderby'), 'BusinessPartner desc')
  assert.equal(first.searchParams.get('$top'), '10')
  assert.equal(first.searchParams.get('$format'), 'json')
  assert.equal(seen.length, 3)   // metadata, page 1, page 2 (its next link already carried sap-client)
  assert.equal(seen[2], 'https://erp.example.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BPRole?sap-client=100&$skiptoken=2')
  assert.deepEqual(r.rows.map((x) => x.BusinessPartner), ['1', '2', '3'])
  assert.deepEqual(r.rows[0], { BusinessPartner: '1', BusinessPartnerRole: 'FLCU01', ValidFrom: '2024-01-01T00:00:00.000Z', Amount: 1234.5, Counter: 12, Id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
  assert.deepEqual(await src.read('A_BPRole', { entity: 'A_BPRole', filters: { BusinessPartner: '1' }, query: { count: true } }), { rows: [{ count: 42 }], total: 42 })
  assert.match(seen.at(-1)!, /A_BPRole\/\$count\?\$filter=BusinessPartner%20eq%20'1'&sap-client=100$/)
  // names checked against the type; a typo says what there is
  assert.match(await failed(src.read('A_BPRole', { entity: 'A_BPRole', filters: { Nope: 1 } })), /A_BPRoleType has no property "Nope" \(its properties: BusinessPartner, BusinessPartnerRole/)
  assert.match(await failed(src.read('A_BPRole', { entity: 'A_BPRole', query: { orderby: 'Amount; drop' } })), /not an ordering/)
  assert.match(await failed(src.read('A_BPRole', { entity: 'A_BPRole', query: { select: ['a b'] } })), /not a property name/)
  assert.match(await failed(src.read('Nothing', { entity: 'Nothing' })), /no entity set "Nothing" \(its entity sets: A_BusinessPartner, A_BusinessPartnerAddress, A_BPTax, A_BPRole\)/)
})

test('a v4 read: @odata.nextLink (relative, resolved against $metadata) followed to the limit; annotations left out; a cursor or a next link on another host never followed', async () => {
  const seen: string[] = []
  const api = (async (url: string) => {
    seen.push(url)
    const u = new URL(url)
    if (u.pathname === '/odata/$metadata') return xml(V4)
    if (u.pathname === '/odata/Orders') {
      if (u.searchParams.get('$skiptoken') === 'evil') return json({ value: [], '@odata.nextLink': 'https://elsewhere.example.net/steal' })
      const page = Number(u.searchParams.get('$skiptoken') ?? 0)
      return json({ '@odata.context': 'https://shop.example.com/odata/$metadata#Orders', value: [{ '@odata.etag': 'W/"1"', ID: page + 1, Total: 10.5, CustomerID: 7, 'Status@odata.type': '#SM.Status', Status: 'Open' }, { ID: page + 2, Total: 3, CustomerID: 7, Status: 'Closed' }], '@odata.nextLink': `Orders?$skiptoken=${page + 2}` })
    }
    return json({ error: { code: 'NotFound', message: 'no' } }, { status: 404 })
  }) as typeof fetch
  const src = odataSource(ctxOf(api), none, { root: 'https://shop.example.com/odata/' })
  const r = await src.read('Orders', { entity: 'Orders', filters: { CustomerID: 7, Status: 'Open', OrderDate: '2024-01-31' }, limit: 5 })
  assert.equal(new URL(seen[1]).searchParams.get('$filter'), "CustomerID eq 7 and Status eq Shop.Model.Status'Open' and OrderDate eq 2024-01-31")
  assert.equal(new URL(seen[1]).searchParams.get('$format'), null)
  assert.deepEqual(r.rows.map((x) => x.ID), [1, 2, 3, 4, 5])
  assert.deepEqual(r.rows[0], { ID: 1, Total: 10.5, CustomerID: 7, Status: 'Open' })
  assert.equal(r.next, 'https://shop.example.com/odata/Orders?$skiptoken=6')
  assert.match(await failed(src.read('Orders', { entity: 'Orders', cursor: 'https://elsewhere.example.net/odata/Orders' })), /a cursor is a next link this service gave/)
  assert.match(await failed(src.read('Orders', { entity: 'Orders', cursor: 'https://shop.example.com/odata/Orders?$skiptoken=evil' })), /next page is on another host \(elsewhere.example.net\)/)
})

test('client credentials: the token asked for once and kept, renewed when the service refuses it, the client sent as basic when the form is refused', async () => {
  let issued = 0
  const calls: { url: string; body: string; auth: string | null }[] = []
  const api = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers)
    if (url === 'https://login.example.com/token') {
      const body = String(init.body); calls.push({ url, body, auth: h.get('authorization') })
      const form = new URLSearchParams(body)
      if (form.get('client_id') && form.get('client_id') !== 'form-ok') return json({ error: 'invalid_client', error_description: 'Client authentication failed' }, { status: 401 })
      if (!form.get('client_id') && h.get('authorization') !== `Basic ${Buffer.from('basic-only:s3cret').toString('base64')}`) return json({ error: 'invalid_client' }, { status: 401 })
      assert.equal(form.get('grant_type'), 'client_credentials'); assert.equal(form.get('scope'), 'api://x/.default')
      return json({ token_type: 'Bearer', access_token: `tok-${++issued}`, expires_in: 3599 })
    }
    // the service refuses the first token it sees
    return h.get('authorization') === 'Bearer tok-1' ? json({ error: { code: 'InvalidToken', message: 'expired' } }, { status: 401 }) : json({ value: [{ ok: h.get('authorization') }] })
  }) as typeof fetch
  const ctx = ctxOf(api)
  const s = { tokenUrl: 'https://login.example.com/token', clientId: 'form-ok', clientSecret: 's3cret', scope: 'api://x/.default' }
  assert.equal(await clientCredentials(ctx, s), 'tok-1')
  assert.equal(await clientCredentials(ctx, s), 'tok-1'); assert.equal(calls.length, 1)   // kept
  const { odataGet } = await import('../src/odata.ts')
  const sign = signerOf(ctx, { kind: 'oauth-client', ...s })
  assert.equal(JSON.parse((await odataGet(ctx, sign, 'https://svc.example.com/x', 'application/json')).text).value[0].ok, 'Bearer tok-2')   // refused, renewed, read
  // a token endpoint that wants the client as basic authentication
  assert.equal(await clientCredentials(ctxOf(api), { ...s, clientId: 'basic-only' }), 'tok-3')
  assert.equal(calls.at(-1)!.auth, `Basic ${Buffer.from('basic-only:s3cret').toString('base64')}`)
  assert.match(await failed(clientCredentials(ctxOf(api), { ...s, clientId: 'nobody' })), /the sign-in at login.example.com was refused \(401\): Client authentication failed/)
  assert.match(await failed(clientCredentials(ctxOf(api), { ...s, tokenUrl: 'http://login.example.com/token' })), /not an https:\/\/ address/)
})

test("SAP's CSRF answer: a 403 asking for a token, fetched once with its session cookie, then the read again with both", async () => {
  const seen: Headers[] = []
  const api = (async (_url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers); seen.push(h)
    if (h.get('x-csrf-token') === 'Fetch') return new Response('', { headers: [['x-csrf-token', 'tok123'], ['set-cookie', 'SAP_SESSIONID_ABC_100=xyz; path=/; secure; HttpOnly'], ['set-cookie', 'sap-usercontext=sap-client=100; path=/']] })
    if (h.get('x-csrf-token') === 'tok123' && h.get('cookie') === 'SAP_SESSIONID_ABC_100=xyz; sap-usercontext=sap-client=100') return json({ d: { results: [] } })
    return new Response('CSRF token validation failed', { status: 403, headers: { 'x-csrf-token': 'Required' } })
  }) as typeof fetch
  const { odataGet } = await import('../src/odata.ts')
  const ctx = ctxOf(api)
  assert.equal((await odataGet(ctx, signerOf(ctx, { kind: 'basic', user: 'U', password: 'P' }), 'https://erp.example.com/x', 'application/json')).text, '{"d":{"results":[]}}')
  assert.equal(seen.length, 3)
  assert.equal(seen[0].get('authorization'), `Basic ${Buffer.from('U:P').toString('base64')}`)
})

test("errors in the system's words: SAP's error.message.value with its code, OData v4's, OAuth's, an XML error's, an API gateway's", () => {
  assert.equal(saidIn(JSON.stringify({ error: { code: '/IWBEP/CM_MGW_RT/020', message: { lang: 'en', value: "Resource not found for segment 'A_Nope'." }, innererror: { transactionid: 'x' } } })), "Resource not found for segment 'A_Nope'. (/IWBEP/CM_MGW_RT/020)")
  assert.equal(saidIn(JSON.stringify({ error: { code: 'BadRequest_NotFound', message: 'The specified resource was not found.' } })), 'The specified resource was not found. (BadRequest_NotFound)')
  assert.equal(saidIn(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' })), 'AADSTS7000215: Invalid client secret provided.')
  assert.equal(saidIn('<?xml version="1.0"?><error xmlns="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><code>SY/530</code><message xml:lang="en">No authorization to access entity set</message></error>'), 'No authorization to access entity set')
  assert.equal(saidIn(JSON.stringify({ fault: { faultstring: 'Failed to resolve API Key variable request.header.apikey', detail: { errorcode: 'steps.oauth.v2.FailedToResolveAPIKey' } } })), 'Failed to resolve API Key variable request.header.apikey')
  assert.equal(refusal(403, '{"error":{"code":"SY/530","message":{"value":"No authorization"}}}').message, 'not allowed: No authorization (SY/530)')
})
