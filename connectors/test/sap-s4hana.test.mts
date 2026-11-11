// The sap-s4hana connector, replayed (from SAP's documentation: no S/4HANA account here): the system found from what is
// pasted (the sandbox, a Cloud tenant's launchpad, an on-premise gateway, a service's URL); several API services, each
// set named <SERVICE>.<EntitySet>; one the user may not read left out and named by the services check; the sandbox's
// APIKey header; sap-client on every request; SAP's error JSON in words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBridge as sap, servicesOf, systemOf, DEFAULT_SERVICES } from '../bridges/sap-s4hana/connector.ts'
import { SAP_V2 } from './odata-fixtures.mts'

const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))
const json = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })

// API_SALES_ORDER_SRV, abridged: a sales order and its items, joined by their association.
const SALES_ORDER = `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:sap="http://www.sap.com/Protocols/SAPData"><edmx:DataServices m:DataServiceVersion="2.0"><Schema Namespace="API_SALES_ORDER_SRV" xml:lang="en" sap:schema-version="1" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
<EntityType Name="A_SalesOrderType" sap:label="Sales Order"><Key><PropertyRef Name="SalesOrder"/></Key>
<Property Name="SalesOrder" Type="Edm.String" Nullable="false" MaxLength="10" sap:display-format="UpperCase" sap:label="Sales Order" sap:quickinfo="Sales Document"/>
<Property Name="SalesOrderType" Type="Edm.String" MaxLength="4" sap:label="Sales Document Type"/>
<Property Name="SoldToParty" Type="Edm.String" MaxLength="10" sap:label="Sold-to Party"/>
<Property Name="SalesOrderDate" Type="Edm.DateTime" Precision="0" sap:display-format="Date" sap:label="Document Date" sap:quickinfo="Document Date (Date Received/Sent)"/>
<Property Name="TotalNetAmount" Type="Edm.Decimal" Precision="16" Scale="3" sap:unit="TransactionCurrency" sap:label="Net Value" sap:quickinfo="Net Value of the Sales Order in Document Currency"/>
<Property Name="TransactionCurrency" Type="Edm.String" MaxLength="5" sap:label="Document Currency" sap:semantics="currency-code"/>
<NavigationProperty Name="to_Item" Relationship="API_SALES_ORDER_SRV.assoc_SalesOrder_Item" FromRole="FromRole_assoc_SalesOrder_Item" ToRole="ToRole_assoc_SalesOrder_Item"/></EntityType>
<EntityType Name="A_SalesOrderItemType" sap:label="Sales Order Item"><Key><PropertyRef Name="SalesOrder"/><PropertyRef Name="SalesOrderItem"/></Key>
<Property Name="SalesOrder" Type="Edm.String" Nullable="false" MaxLength="10" sap:label="Sales Order"/>
<Property Name="SalesOrderItem" Type="Edm.String" Nullable="false" MaxLength="6" sap:label="Item"/>
<Property Name="Material" Type="Edm.String" MaxLength="40" sap:label="Material"/>
<Property Name="RequestedQuantity" Type="Edm.Decimal" Precision="15" Scale="3" sap:label="Requested Quantity"/>
<NavigationProperty Name="to_SalesOrder" Relationship="API_SALES_ORDER_SRV.assoc_SalesOrder_Item" FromRole="ToRole_assoc_SalesOrder_Item" ToRole="FromRole_assoc_SalesOrder_Item"/></EntityType>
<Association Name="assoc_SalesOrder_Item"><End Type="API_SALES_ORDER_SRV.A_SalesOrderType" Multiplicity="1" Role="FromRole_assoc_SalesOrder_Item"/><End Type="API_SALES_ORDER_SRV.A_SalesOrderItemType" Multiplicity="*" Role="ToRole_assoc_SalesOrder_Item"/>
<ReferentialConstraint><Principal Role="FromRole_assoc_SalesOrder_Item"><PropertyRef Name="SalesOrder"/></Principal><Dependent Role="ToRole_assoc_SalesOrder_Item"><PropertyRef Name="SalesOrder"/></Dependent></ReferentialConstraint></Association>
<EntityContainer Name="API_SALES_ORDER_SRV_Entities" m:IsDefaultEntityContainer="true"><EntitySet Name="A_SalesOrder" EntityType="API_SALES_ORDER_SRV.A_SalesOrderType"/><EntitySet Name="A_SalesOrderItem" EntityType="API_SALES_ORDER_SRV.A_SalesOrderItemType"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`

/** A system at `base` answering API_BUSINESS_PARTNER and API_SALES_ORDER_SRV, refusing API_PRODUCT_SRV (no arrangement)
 *  and knowing nothing of the rest, as SAP Gateway answers; `signed` says whether a request is signed in. */
function system(base: string, signed: (h: Headers) => boolean, client?: string) {
  const seen: { url: string; headers: Headers }[] = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers); seen.push({ url, headers: h })
    const u = new URL(url)
    if (client) assert.equal(u.searchParams.get('sap-client'), client, url)
    if (!url.startsWith(base)) return new Response('wrong host', { status: 502 })
    if (!signed(h)) return new Response('<html><head><title>Logon</title></head><body>Logon failed</body></html>', { status: 401, headers: { 'content-type': 'text/html' } })
    const [service, ...rest] = u.pathname.slice(new URL(base).pathname.length + 1).split('/')
    const path = rest.join('/')
    if (service === 'API_PRODUCT_SRV') return json({ error: { code: '/IWFND/MED/170', message: { lang: 'en', value: 'No authorization to access service API_PRODUCT_SRV' } } }, { status: 403 })
    if (path === '$metadata') {
      if (service === 'API_BUSINESS_PARTNER') return new Response(SAP_V2, { headers: { 'content-type': 'application/xml' } })
      if (service === 'API_SALES_ORDER_SRV') return new Response(SALES_ORDER, { headers: { 'content-type': 'application/xml' } })
    }
    if (service === 'API_BUSINESS_PARTNER' && path === 'A_BusinessPartner') return json({ d: { results: [{ __metadata: { type: 'API_BUSINESS_PARTNER.A_BusinessPartnerType' }, BusinessPartner: '1000000', BusinessPartnerFullName: 'Inlandskunde DE 1', CreationDate: '/Date(1471910400000)/' }] } })
    if (service === 'API_SALES_ORDER_SRV' && path === 'A_SalesOrder') {
      return json({ d: { results: [{ __metadata: { id: `${base}/API_SALES_ORDER_SRV/A_SalesOrder('1')`, type: 'API_SALES_ORDER_SRV.A_SalesOrderType' }, SalesOrder: '1', SoldToParty: '17100001', SalesOrderDate: '/Date(1488326400000)/', TotalNetAmount: '52.650', TransactionCurrency: 'USD', to_Item: { __deferred: { uri: 'x' } } }] } })
    }
    return json({ error: { code: '/IWFND/MED/170', message: { lang: 'en', value: `No service found for namespace '', name '${service}', version '0001'` } } }, { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

test('sap-s4hana: the system and its services from what is pasted', () => {
  assert.deepEqual(systemOf('https://sandbox.api.sap.com'), { base: 'https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap', service: null })
  assert.deepEqual(systemOf('https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$top=5'), { base: 'https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap', service: 'API_BUSINESS_PARTNER' })
  assert.deepEqual(systemOf('https://my123456.s4hana.cloud.sap/ui#Shell-home'), { base: 'https://my123456-api.s4hana.cloud.sap/sap/opu/odata/sap', service: null })
  assert.deepEqual(systemOf('my404040-api.s4hana.ondemand.com'), { base: 'https://my404040-api.s4hana.ondemand.com/sap/opu/odata/sap', service: null })
  assert.deepEqual(systemOf('https://sap.example.com:44300/sap/opu/odata/sap/API_SALES_ORDER_SRV/$metadata'), { base: 'https://sap.example.com:44300/sap/opu/odata/sap', service: 'API_SALES_ORDER_SRV' })
  assert.deepEqual(servicesOf({}), DEFAULT_SERVICES)
  assert.deepEqual(servicesOf({ services: 'API_BUSINESS_PARTNER\nhttps://h.example.com/sap/opu/odata/sap/API_SALES_ORDER_SRV/\nAPI_BUSINESS_PARTNER, API_X;v=0002' }), ['API_BUSINESS_PARTNER', 'API_SALES_ORDER_SRV', 'API_X;v=0002'])
  assert.deepEqual(servicesOf({ host: 'https://h.example.com/sap/opu/odata/sap/API_CUSTOM_SRV', services: 'API_BUSINESS_PARTNER' }), ['API_BUSINESS_PARTNER', 'API_CUSTOM_SRV'])
  assert.throws(() => servicesOf({ services: 'API_X <script>' }), /not a service name/)
  assert.throws(() => systemOf(''), /address is needed/)
})

test('sap-s4hana: an on-premise system signed in with basic, sap-client on every call; services read side by side as <SERVICE>.<EntitySet>; one not allowed left out and named by the check', async () => {
  const base = 'https://sap.example.com:44300/sap/opu/odata/sap'
  const sys = system(base, (h) => h.get('authorization') === `Basic ${Buffer.from('SUPERATOM_READ:pw').toString('base64')}`, '100')
  const settings = { host: 'https://sap.example.com:44300', sapClient: '100', auth: 'basic', user: 'SUPERATOM_READ', services: 'API_BUSINESS_PARTNER\nAPI_SALES_ORDER_SRV\nAPI_PRODUCT_SRV\nAPI_NOPE_SRV' }
  const c = sap({ settings, secrets: { password: 'pw' }, fetch: sys.fetch })
  assert.equal(await c.test(), 'signed in: 2 of 4 services answer; read 1 row of API_BUSINESS_PARTNER.A_BusinessPartner')
  const d = await c.introspect()
  assert.deepEqual(d.tables.map((t: any) => t.name), ['API_BUSINESS_PARTNER.A_BusinessPartner', 'API_BUSINESS_PARTNER.A_BusinessPartnerAddress', 'API_BUSINESS_PARTNER.A_BPRole', 'API_SALES_ORDER_SRV.A_SalesOrder', 'API_SALES_ORDER_SRV.A_SalesOrderItem'])
  const so = d.tables[3]
  assert.equal(so.description, 'Sales Order Linked: to_Item → API_SALES_ORDER_SRV.A_SalesOrderItem (many).')
  assert.deepEqual(so.columns.find((x: any) => x.name === 'TotalNetAmount'), { name: 'TotalNetAmount', type: 'number', description: 'Net Value — Net Value of the Sales Order in Document Currency', nullable: true })
  assert.deepEqual(d.tables[4].columns[0], { name: 'SalesOrder', type: 'string', description: 'Sales Order', key: true, references: 'API_SALES_ORDER_SRV.A_SalesOrder.SalesOrder', nullable: false })
  const sigs = await c.signatures()
  assert.ok(sigs['API_SALES_ORDER_SRV.A_SalesOrderItem'])
  const check = await c.check('services')
  assert.match(check, /API_BUSINESS_PARTNER: 3 entity sets; API_SALES_ORDER_SRV: 2 entity sets; API_PRODUCT_SRV: cannot be read — not allowed: No authorization to access service API_PRODUCT_SRV \(\/IWFND\/MED\/170\); API_NOPE_SRV: cannot be read — not found: No service found for namespace '', name 'API_NOPE_SRV'/)
  const rows = await c.query(JSON.stringify({ entity: 'API_SALES_ORDER_SRV.A_SalesOrder', filters: { SoldToParty: '17100001', SalesOrderDate: '2017-03-01' }, filter: 'TotalNetAmount gt 50M', limit: 20 }))
  assert.deepEqual(rows, [{ SalesOrder: '1', SoldToParty: '17100001', SalesOrderDate: '2017-03-01', TotalNetAmount: 52.65, TransactionCurrency: 'USD' }])
  const read = new URL(sys.seen.at(-1)!.url)
  assert.equal(read.pathname, '/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder')
  assert.equal(read.searchParams.get('$filter'), "(TotalNetAmount gt 50M) and SoldToParty eq '17100001' and SalesOrderDate eq datetime'2017-03-01T00:00:00'")
  assert.match(await failed(c.query(JSON.stringify({ entity: 'A_SalesOrder' }))), /an entity is named <SERVICE>\.<EntitySet>/)
  assert.match(await failed(c.query(JSON.stringify({ entity: 'API_SALES_ORDER_SRV.A_Nothing' }))), /no entity set "A_Nothing" \(its entity sets: A_SalesOrder, A_SalesOrderItem\)/)
})

test("sap-s4hana: SAP's sandbox signed in with an API key in the APIKey header; a refused key or user said plainly; no service readable fails the check", async () => {
  const base = 'https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap'
  const sandbox = system(base, (h) => h.get('APIKey') === 'sandbox-key')
  const c = sap({ settings: { host: 'https://sandbox.api.sap.com', auth: 'api-key', services: 'API_BUSINESS_PARTNER' }, secrets: { apiKey: 'sandbox-key' }, fetch: sandbox.fetch })
  assert.match(await c.test(), /^signed in: 1 of 1 service answer/)
  assert.ok(sandbox.seen.every((x) => x.headers.get('authorization') === null))
  // the sandbox's own refusal of a missing key (its gateway's fault JSON)
  const noKey = (async () => json({ fault: { faultstring: 'Failed to resolve API Key variable request.header.apikey', detail: { errorcode: 'steps.oauth.v2.FailedToResolveAPIKey' } } }, { status: 401 })) as typeof fetch
  assert.match(await failed(sap({ settings: { host: 'https://sandbox.api.sap.com', auth: 'api-key', services: 'API_BUSINESS_PARTNER' }, secrets: { apiKey: '' }, fetch: noKey }).test()), /needs the API key/)
  assert.match(await failed(sap({ settings: { host: 'https://sandbox.api.sap.com', auth: 'api-key', services: 'API_BUSINESS_PARTNER' }, secrets: { apiKey: 'x' }, fetch: noKey }).test()), /the credentials were refused: Failed to resolve API Key/)
  // a refused communication user: SAP's logon page, said as a refusal
  const cloud = system('https://my123456-api.s4hana.cloud.sap/sap/opu/odata/sap', () => false)
  const refused = sap({ settings: { host: 'https://my123456.s4hana.cloud.sap', auth: 'basic', user: 'COMM_USER', services: 'API_BUSINESS_PARTNER' }, secrets: { password: 'x' }, fetch: cloud.fetch })
  assert.match(await failed(refused.test()), /the credentials were refused: Logon Logon failed/)
  assert.match(await failed(refused.check('services')), /none of the services can be read\. API_BUSINESS_PARTNER: cannot be read — the credentials were refused/)
  assert.ok(cloud.seen[0].url.startsWith('https://my123456-api.s4hana.cloud.sap/sap/opu/odata/sap/API_BUSINESS_PARTNER/$metadata'))
})

test("sap-s4hana: an OAuth client gets its token from the system's own token endpoint when none is given", async () => {
  const base = 'https://my123456-api.s4hana.cloud.sap/sap/opu/odata/sap'
  const sys = system(base, (h) => h.get('authorization') === 'Bearer sap-token')
  const fetch = (async (url: string, init: RequestInit = {}) => {
    if (url === 'https://my123456-api.s4hana.cloud.sap/sap/bc/sec/oauth2/token') {
      // SAP's endpoint wants the client as basic authentication: the form's client is refused first
      const f = new URLSearchParams(String(init.body)), h = new Headers(init.headers)
      if (f.get('client_id')) return json({ error: 'invalid_client', error_description: 'Client authentication failed' }, { status: 401 })
      return h.get('authorization') === `Basic ${Buffer.from('SUPERATOM:secret').toString('base64')}` ? json({ access_token: 'sap-token', token_type: 'Bearer', expires_in: 43199 }) : json({ error: 'invalid_client' }, { status: 401 })
    }
    return sys.fetch(url, init)
  }) as typeof globalThis.fetch
  const c = sap({ settings: { host: 'https://my123456-api.s4hana.cloud.sap', auth: 'oauth-client', clientId: 'SUPERATOM', services: 'API_BUSINESS_PARTNER' }, secrets: { clientSecret: 'secret' }, fetch })
  assert.match(await c.test(), /signed in: 1 of 1 service answer/)
})
