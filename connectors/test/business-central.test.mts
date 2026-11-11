// The business-central connector, replayed (from Microsoft's documentation: no Business Central account here): the
// Entra client-credentials token (asked for once, with Business Central's scope), the companies, one company's
// collections as entities, reads paged by @odata.nextLink, filters on GUIDs and dates, and Microsoft's errors in words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBridge as bc, placeOf } from '../bridges/business-central/connector.ts'

const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))
const json = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })

const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47'
const API = `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/production/api/v2.0`
const CRONUS = '6f5b1f5e-4f1a-ef11-9f88-6045bdc8c192', OTHER = '0a7d4c2e-5b1a-ef11-9f88-6045bdc8c192'

// The API's $metadata as Business Central writes it (abridged): Microsoft.NAV, companies the one entity set, each of a
// company's collections a contained navigation property.
const METADATA = `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="Microsoft.NAV" xmlns="http://docs.oasis-open.org/odata/ns/edm">
<EntityType Name="company"><Key><PropertyRef Name="id"/></Key><Property Name="id" Type="Edm.Guid" Nullable="false"/><Property Name="systemVersion" Type="Edm.String"/><Property Name="name" Type="Edm.String" MaxLength="30"/><Property Name="displayName" Type="Edm.String" MaxLength="250"/><Property Name="businessProfileId" Type="Edm.String" MaxLength="250"/>
<NavigationProperty Name="customers" Type="Collection(Microsoft.NAV.customer)" ContainsTarget="true"/><NavigationProperty Name="salesOrders" Type="Collection(Microsoft.NAV.salesOrder)" ContainsTarget="true"/><NavigationProperty Name="generalLedgerEntries" Type="Collection(Microsoft.NAV.generalLedgerEntry)" ContainsTarget="true"/></EntityType>
<EntityType Name="customer"><Key><PropertyRef Name="id"/></Key><Property Name="id" Type="Edm.Guid" Nullable="false"/><Property Name="number" Type="Edm.String" MaxLength="20"/><Property Name="displayName" Type="Edm.String" MaxLength="100"/><Property Name="type" Type="Microsoft.NAV.contactType"/><Property Name="balanceDue" Type="Edm.Decimal" Scale="Variable"/><Property Name="blocked" Type="Edm.String" MaxLength="20"/><Property Name="lastModifiedDateTime" Type="Edm.DateTimeOffset"/></EntityType>
<EntityType Name="salesOrder"><Key><PropertyRef Name="id"/></Key><Property Name="id" Type="Edm.Guid" Nullable="false"/><Property Name="number" Type="Edm.String" MaxLength="20"/><Property Name="orderDate" Type="Edm.Date"/><Property Name="customerId" Type="Edm.Guid"/><Property Name="customerNumber" Type="Edm.String" MaxLength="20"/><Property Name="totalAmountIncludingTax" Type="Edm.Decimal" Scale="Variable"/><Property Name="status" Type="Edm.String"/>
<NavigationProperty Name="customer" Type="Microsoft.NAV.customer"><ReferentialConstraint Property="customerId" ReferencedProperty="id"/></NavigationProperty></EntityType>
<EntityType Name="generalLedgerEntry"><Key><PropertyRef Name="id"/></Key><Property Name="id" Type="Edm.Guid" Nullable="false"/><Property Name="entryNumber" Type="Edm.Int32"/><Property Name="postingDate" Type="Edm.Date"/><Property Name="accountNumber" Type="Edm.String" MaxLength="20"/><Property Name="debitAmount" Type="Edm.Decimal" Scale="Variable"/><Property Name="creditAmount" Type="Edm.Decimal" Scale="Variable"/></EntityType>
<EnumType Name="contactType"><Member Name="Company" Value="0"/><Member Name="Person" Value="1"/></EnumType>
<EntityContainer Name="default"><EntitySet Name="companies" EntityType="Microsoft.NAV.company"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`

function businessCentral(o: { companies?: { id: string; name: string; displayName: string }[]; app?: 'ok' | 'not-in-bc' } = {}) {
  const seen: { url: string; headers: Headers; body?: string }[] = []
  let tokens = 0
  const companies = o.companies ?? [{ id: CRONUS, name: 'CRONUS USA, Inc.', displayName: 'CRONUS USA, Inc.' }]
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers); seen.push({ url, headers: h, body: init.body ? String(init.body) : undefined })
    if (url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
      const f = new URLSearchParams(String(init.body))
      assert.equal(f.get('grant_type'), 'client_credentials'); assert.equal(f.get('scope'), 'https://api.businesscentral.dynamics.com/.default')
      if (f.get('client_id') !== 'app-id' || f.get('client_secret') !== 'app-secret') return json({ error: 'invalid_client', error_description: "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app 'app-id'. Trace ID: 1 Correlation ID: 2 Timestamp: 2026-11-11 00:00:00Z", error_codes: [7000215] }, { status: 401 })
      return json({ token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: `eyJ.bc.${++tokens}` })
    }
    if (!/^Bearer eyJ\.bc\.([1-9]\d*)$/.test(h.get('authorization') ?? '') || Number(h.get('authorization')!.split('.').pop()) > tokens) return json({ error: { code: 'Authentication_InvalidCredentials', message: 'The server has rejected the client credentials.  CorrelationId:  3' } }, { status: 401 })
    if (o.app === 'not-in-bc') return json({ error: { code: 'Authentication_InvalidCredentials', message: 'The server has rejected the client credentials.  CorrelationId:  4' } }, { status: 401 })
    const u = new URL(url)
    if (url === `${API}/$metadata`) return new Response(METADATA, { headers: { 'content-type': 'application/xml' } })
    if (u.pathname.endsWith('/api/v2.0/companies')) return json({ '@odata.context': `${API}/$metadata#companies`, value: companies.map((c) => ({ ...c, systemVersion: '25.0.23364.24187', businessProfileId: '' })) })
    if (u.pathname.endsWith(`/companies(${CRONUS})/customers`)) {
      const after = u.searchParams.get('$skiptoken')
      const row = (n: string) => ({ '@odata.etag': `W/"JzE5OzE${n}"`, id: `0000000${n}-0000-0000-0000-000000000000`.slice(-36), number: n, displayName: `Customer ${n}`, type: 'Company', balanceDue: 1499.02, blocked: '_x0020_', lastModifiedDateTime: '2026-10-01T10:00:00Z' })
      return after ? json({ value: [row('30000')] }) : json({ '@odata.context': `${API}/$metadata#companies(${CRONUS})/customers`, value: [row('10000'), row('20000')], '@odata.nextLink': `${API}/companies(${CRONUS})/customers?aid=FIN&$skiptoken=20000` })
    }
    if (u.pathname.endsWith(`/companies(${CRONUS})/salesOrders`)) return json({ value: [{ '@odata.etag': 'W/"x"', id: '11111111-0000-0000-0000-000000000000', number: '101001', orderDate: '2026-01-15', customerId: '00000010000', totalAmountIncludingTax: 5512.5, status: 'Open' }] })
    return json({ error: { code: 'BadRequest_NotFound', message: `The request URI is not valid. Since the segment '${u.pathname.split('/').pop()}' refers to a collection, this must be the last segment in the request URI or it must be followed by an function or action that can be bound to it otherwise all intermediate segments must refer to a single resource.` } }, { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, seen, tokens: () => tokens }
}
const settings = { tenant: TENANT, environment: 'production', clientId: 'app-id' }
const secrets = { clientSecret: 'app-secret' }

test('business-central: the tenant, environment and company from what is pasted', () => {
  assert.deepEqual(placeOf({ tenant: 'contoso.onmicrosoft.com' }), { tenant: 'contoso.onmicrosoft.com', environment: 'production', company: '' })
  assert.deepEqual(placeOf({ tenant: `https://businesscentral.dynamics.com/${TENANT}/Sandbox?company=CRONUS%20USA%2C%20Inc.&page=22`, environment: 'production' }), { tenant: TENANT, environment: 'Sandbox', company: 'CRONUS USA, Inc.' })
  assert.deepEqual(placeOf({ tenant: `${API}/companies(${CRONUS})/customers` }), { tenant: TENANT, environment: 'production', company: '' })
  assert.throws(() => placeOf({ tenant: '' }), /tenant is needed/)
  assert.throws(() => placeOf({ tenant: 'not a tenant' }), /is not a tenant/)
})

test('business-central: signed in as the Entra app (one token, Business Central\'s scope), the company found by name, its collections the entities, a read paged by @odata.nextLink', async () => {
  const s = businessCentral()
  const c = bc({ settings: { ...settings, company: 'cronus usa, inc.' }, secrets, fetch: s.fetch })
  assert.ok(c.ready()); assert.equal(bc({ settings: { tenant: TENANT } }).ready(), false)
  assert.equal(await c.check('token'), `Microsoft Entra signed the app in for ${TENANT}`)
  assert.equal(await c.test(), 'signed in to production: 1 company; reading CRONUS USA, Inc.')
  const d: any = await c.introspect()
  assert.deepEqual(d.tables.map((t: any) => t.name), ['companies', 'customers', 'salesOrders', 'generalLedgerEntries'])
  const so = d.tables.find((t: any) => t.name === 'salesOrders')
  assert.deepEqual(so.columns.find((x: any) => x.name === 'customerId'), { name: 'customerId', type: 'string', references: 'customers.id', nullable: true })
  assert.deepEqual(so.columns.find((x: any) => x.name === 'orderDate'), { name: 'orderDate', type: 'date', nullable: true })
  assert.equal(d.tables[1].columns.find((x: any) => x.name === 'type').type, 'string')
  const rows = await c.query(JSON.stringify({ entity: 'customers', limit: 3 }))
  assert.deepEqual(rows.map((r: any) => r.number), ['10000', '20000', '30000'])
  assert.equal('@odata.etag' in rows[0], false)
  assert.ok(s.seen.some((x) => x.url === `${API}/companies(${CRONUS})/customers?aid=FIN&$skiptoken=20000`))
  await c.query(JSON.stringify({ entity: 'salesOrders', filters: { customerId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', orderDate: '2026-01-15', status: 'Open' }, filter: 'totalAmountIncludingTax gt 1000', select: ['number', 'totalAmountIncludingTax'] }))
  const read = new URL(s.seen.at(-1)!.url)
  assert.equal(read.pathname, `/v2.0/${TENANT}/production/api/v2.0/companies(${CRONUS})/salesOrders`)
  assert.equal(read.searchParams.get('$filter'), "(totalAmountIncludingTax gt 1000) and customerId eq 3f2504e0-4f89-11d3-9a0c-0305e82c3301 and orderDate eq 2026-01-15 and status eq 'Open'")
  assert.deepEqual((await c.query(JSON.stringify({ entity: 'companies' }))).map((r: any) => r.name), ['CRONUS USA, Inc.'])
  assert.equal(s.tokens(), 1)   // kept until it expires
  assert.ok(s.seen.filter((x) => !x.url.includes('login.microsoftonline.com')).every((x) => x.headers.get('authorization') === 'Bearer eyJ.bc.1'))
  assert.match(await failed(c.query(JSON.stringify({ entity: 'vendors' }))), /no entity set "vendors" \(its entity sets: customers, salesOrders, generalLedgerEntries\)/)
})

test('business-central: several companies — the test lists them until one is named; the check names the one read, or says it is not there', async () => {
  const s = businessCentral({ companies: [{ id: CRONUS, name: 'CRONUS USA, Inc.', displayName: 'CRONUS USA, Inc.' }, { id: OTHER, name: 'My Company', displayName: 'My Company Ltd' }] })
  assert.equal(await bc({ settings, secrets, fetch: s.fetch }).test(), 'signed in to production: 2 companies: CRONUS USA, Inc., My Company (My Company Ltd)')
  assert.match(await failed(bc({ settings, secrets, fetch: s.fetch }).check('companies')), /the environment has 2 companies; name the one to read: CRONUS USA, Inc., My Company \(My Company Ltd\)/)
  assert.equal(await bc({ settings: { ...settings, company: OTHER }, secrets, fetch: s.fetch }).check('companies'), '2 companies: CRONUS USA, Inc., My Company (My Company Ltd) — reading My Company (My Company Ltd)')
  assert.equal(await bc({ settings: { ...settings, company: 'My Company Ltd' }, secrets, fetch: s.fetch }).check('companies'), '2 companies: CRONUS USA, Inc., My Company (My Company Ltd) — reading My Company (My Company Ltd)')
  assert.match(await failed(bc({ settings: { ...settings, company: 'Nope' }, secrets, fetch: s.fetch }).test()), /there is no company "Nope" here \(its companies: CRONUS USA, Inc., My Company \(My Company Ltd\)\)/)
})

test("business-central: Microsoft's refusals in words — a wrong secret (Entra), an app Business Central does not know yet", async () => {
  const s = businessCentral()
  assert.match(await failed(bc({ settings, secrets: { clientSecret: 'secret-id-not-value' }, fetch: s.fetch }).check('token')), /the sign-in at login.microsoftonline.com was refused \(401\): invalid_client: AADSTS7000215: Invalid client secret provided/)
  const notInBc = businessCentral({ app: 'not-in-bc' })
  assert.match(await failed(bc({ settings, secrets, fetch: notInBc.fetch }).test()), /the credentials were refused: The server has rejected the client credentials\. +CorrelationId: +4 \(Authentication_InvalidCredentials\)/)
  assert.equal(notInBc.tokens(), 2)   // refused once: a new token tried, then said
})
