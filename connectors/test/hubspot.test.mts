// The hubspot connector, replayed (from the documentation): a stand-in `fetch` answers as HubSpot's CRM API v3
// documentation shows — properties, schemas, owners, list with paging.next.after, search with filterGroups, v4
// associations, the X-HubSpot-RateLimit-* headers (absent on search answers, as documented), a 429, and its error
// bodies (INVALID_AUTHENTICATION, MISSING_SCOPES). No live account.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkEngineManifest } from '../src/contract.ts'
import { fixFor } from '../src/setup.ts'
import { createBridge } from '../bridges/hubspot/connector.ts'

const manifest = JSON.parse(readFileSync(new URL('../bridges/hubspot/manifest.json', import.meta.url), 'utf8'))
const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))
const TOKEN = 'test-hubspot-token'

const prop = (name: string, type: string, more: Record<string, unknown> = {}) => ({ name, label: name, type, fieldType: type === 'enumeration' ? 'select' : 'text', description: '', groupName: 'info', options: [], hidden: false, calculated: false, ...more })
const PROPS: Record<string, any[]> = {
  contacts: [
    prop('email', 'string', { label: 'Email', description: "A contact's email address" }), prop('firstname', 'string', { label: 'First Name' }),
    prop('lifecyclestage', 'enumeration', { label: 'Lifecycle Stage', fieldType: 'radio', options: [{ value: 'lead', label: 'Lead', hidden: false }, { value: 'customer', label: 'Customer', hidden: false }, { value: 'old', label: 'Old', hidden: true }] }),
    prop('hubspot_owner_id', 'enumeration', { label: 'Contact owner', referencedObjectType: 'OWNER' }),
    prop('associatedcompanyid', 'number', { label: 'Primary Associated Company ID' }), prop('num_notes', 'number', { label: 'Number of sales activities' }),
    prop('hs_is_unworked', 'bool', { label: 'Unworked', fieldType: 'booleancheckbox' }), prop('hs_object_id', 'number', { label: 'Record ID' }),
    prop('createdate', 'datetime', { label: 'Create Date' }), prop('lastmodifieddate', 'datetime', { label: 'Last Modified Date' }), prop('closedate', 'date', { label: 'Close date' }),
    prop('hs_internal_thing', 'string', { hidden: true }),
  ],
  companies: [prop('name', 'string', { label: 'Company name' }), prop('domain', 'string'), prop('hs_lastmodifieddate', 'datetime')],
  deals: [prop('dealname', 'string', { label: 'Deal Name' }), prop('amount', 'number', { label: 'Amount' }), prop('hubspot_owner_id', 'enumeration', { label: 'Deal owner' }), prop('hs_lastmodifieddate', 'datetime')],
  line_items: [prop('name', 'string')], products: [prop('name', 'string'), prop('price', 'number')], quotes: [prop('hs_title', 'string')],
}
const missingScope = (scope: string) => ({ status: 'error', message: "This app hasn't been granted all required scopes to make this call. Read more about required scopes here: https://developers.hubspot.com/scopes.", correlationId: 'c0ffee', errors: [{ message: 'One or more of the following scopes are required.', context: { requiredGranularScopes: [scope] } }], links: { scopes: 'https://developers.hubspot.com/scopes' }, category: 'MISSING_SCOPES' })

/** A HubSpot account as its documentation answers. */
function account() {
  const s = { left: 250_000, searches: [] as any[], lists: [] as URL[], throttled: false }
  const answer = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url), h = new Headers(init.headers), method = init.method ?? 'GET'
    assert.equal(u.origin, 'https://api.hubapi.com')
    const search = u.pathname.endsWith('/search')
    const limits = (): Record<string, string> => (search ? {} : { 'x-hubspot-ratelimit-daily': '250000', 'x-hubspot-ratelimit-daily-remaining': String(--s.left), 'x-hubspot-ratelimit-interval-milliseconds': '10000', 'x-hubspot-ratelimit-max': '190', 'x-hubspot-ratelimit-remaining': '189', 'x-hubspot-ratelimit-secondly': '19', 'x-hubspot-ratelimit-secondly-remaining': '18' })
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json;charset=utf-8', ...limits() } })
    if (h.get('authorization') !== `Bearer ${TOKEN}`) return json({ status: 'error', message: 'Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview', correlationId: 'abc', category: 'INVALID_AUTHENTICATION' }, 401)
    if (u.pathname === '/account-info/v3/details') return json({ portalId: 1234567, accountType: 'STANDARD', timeZone: 'Asia/Kolkata', companyCurrency: 'INR', utcOffset: '+05:30', uiDomain: 'app.hubspot.com', dataHostingLocation: 'na1' })
    const p = /^\/crm\/v3\/properties\/(\w+)$/.exec(u.pathname)
    if (p) {
      if (p[1] === 'tickets') return json(missingScope('tickets'), 403)
      if (p[1] === 'calls') return json(missingScope('crm.objects.calls.read'), 403)
      return PROPS[p[1]] ? json({ results: PROPS[p[1]] }) : json({ status: 'error', message: `Unable to infer object type from: ${p[1]}`, correlationId: 'x', category: 'OBJECT_NOT_FOUND' }, 400)
    }
    if (u.pathname === '/crm/v3/schemas') return json({ results: [{ id: '123', name: 'cars', labels: { singular: 'Car', plural: 'Cars' }, objectTypeId: '2-3456789', fullyQualifiedName: 'p1234567_cars', primaryDisplayProperty: 'vin', properties: [prop('vin', 'string', { label: 'VIN', description: 'The vehicle identification number' }), prop('hs_object_id', 'number'), prop('hs_lastmodifieddate', 'datetime')] }] })
    if (u.pathname === '/crm/v3/owners') return json({ results: [{ id: '42', email: 'ana@x.test', firstName: 'Ana', lastName: 'Rao', userId: 9001, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archived: false, teams: [{ id: '1', name: 'North', primary: true }] }] })
    if (u.pathname === '/crm/v3/objects/contacts/search') {
      assert.equal(method, 'POST')
      if (!s.throttled) { s.throttled = true; return json({ status: 'error', message: 'You have reached your secondly limit.', errorType: 'RATE_LIMIT', correlationId: 'r', policyName: 'SECONDLY' }, 429) }
      const body = JSON.parse(String(init.body)); s.searches.push(body)
      return body.after ? json({ total: 3, results: [{ id: '3', properties: { email: 'c@x.test', num_notes: '0', hs_is_unworked: 'false' } }] })
        : json({ total: 3, results: [{ id: '1', properties: { email: 'a@x.test', num_notes: '3', hs_is_unworked: 'true', firstname: '' } }, { id: '2', properties: { email: 'b@x.test', num_notes: null } }], paging: { next: { after: '2' } } })
    }
    if (u.pathname === '/crm/v3/objects/contacts' || u.pathname === '/crm/v3/objects/2-3456789') {
      s.lists.push(u)
      return u.searchParams.get('after') ? json({ results: [{ id: '3', properties: { email: 'c@x.test', vin: 'V3' }, createdAt: '', updatedAt: '', archived: false }] })
        : json({ results: [{ id: '1', properties: { email: 'a@x.test', vin: 'V1' }, archived: false }, { id: '2', properties: { email: 'b@x.test', vin: 'V2' }, archived: false }], paging: { next: { after: '2', link: `https://api.hubapi.com${u.pathname}?after=2` } } })
    }
    if (u.pathname === '/crm/v3/objects/tickets') return json(missingScope('tickets'), 403)
    if (u.pathname === '/crm/v4/objects/deals/123/associations/companies') return json({ results: [{ toObjectId: 456, associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 5, label: 'Primary' }, { category: 'HUBSPOT_DEFINED', typeId: 341, label: null }] }, { toObjectId: 789, associationTypes: [{ category: 'USER_DEFINED', typeId: 12, label: 'Reseller' }] }] })
    return json({ status: 'error', message: 'Not found', category: 'OBJECT_NOT_FOUND' }, 404)
  }) as typeof fetch
  return { s, fetch: answer }
}

test('hubspot: the manifest is sound — every field asked in a step, the checks named in the code', async () => {
  assert.deepEqual(checkEngineManifest(manifest), [])
  const hs = createBridge({ secrets: { token: TOKEN }, fetch: account().fetch })
  for (const s of manifest.setup) if (s.check?.kind === 'custom') assert.equal(typeof await hs.check(s.check.name), 'string', s.check.name)
})

test('hubspot: signed in with the private app token; test() says the account and the calls left; a refused token said in words, with its fix', async () => {
  const { fetch } = account()
  const hs = createBridge({ secrets: { token: TOKEN }, fetch })
  assert.ok(hs.ready()); assert.equal(createBridge({}).ready(), false)
  assert.equal(await hs.test(), 'signed in to HubSpot account 1234567 (standard); calls left today: 249,999 of 250,000')
  assert.deepEqual(await hs.budget(), { used: 1, limit: 250000, window: '1 day', burst: { remaining: 189, limit: 190, window: '10 seconds' } })
  const wrong = await failed(createBridge({ secrets: { token: 'pat-na1-old' }, fetch }).test())
  assert.match(wrong, /^the credentials were refused: Authentication credentials not found/)
  assert.match(fixFor(manifest.setup[0], wrong), /HubSpot did not accept the token/)
})

test('hubspot: standard and custom objects with their properties — descriptions, options, owners, keys; what the token may not read said with its scope', async () => {
  const hs = createBridge({ settings: { objects: 'calls' }, secrets: { token: TOKEN }, fetch: account().fetch })
  const d: any = await hs.introspect()
  assert.deepEqual(d.tables.map((t: any) => t.name), ['contacts', 'companies', 'deals', 'line_items', 'products', 'quotes', 'cars', 'owners', 'associations'])
  const contacts = d.tables[0], col = (n: string) => contacts.columns.find((c: any) => c.name === n)
  assert.deepEqual(col('id'), { name: 'id', type: 'string', description: "The record's id (hs_object_id)", key: true, nullable: false })
  assert.equal(col('hs_object_id'), undefined)
  assert.deepEqual(col('email'), { name: 'email', type: 'string', description: "Email — A contact's email address", nullable: true })
  assert.equal(col('lifecyclestage').description, 'Lifecycle Stage — one of: lead, customer')
  assert.equal(col('hubspot_owner_id').references, 'owners.id')
  assert.equal(col('associatedcompanyid').references, 'companies.id')
  assert.deepEqual([col('num_notes').type, col('hs_is_unworked').type, col('createdate').type, col('closedate').type], ['number', 'boolean', 'timestamp', 'date'])
  assert.equal(d.tables.find((t: any) => t.name === 'deals').columns.find((c: any) => c.name === 'hubspot_owner_id').references, 'owners.id')   // by its name
  const cars = d.tables.find((t: any) => t.name === 'cars')
  assert.equal(cars.description.split('.')[0], 'Cars (a custom object)')
  assert.equal(cars.columns.find((c: any) => c.name === 'vin').description, 'VIN — The vehicle identification number')
  assert.match(await hs.check('objects'), /^reads 7 objects: contacts, companies, deals, line_items, products, quotes, cars. Not readable with this token: tickets \(needs the scope tickets\); calls \(needs the scope crm.objects.calls.read\); calls left today: 249,9\d\d of 250,000$/)
  assert.match(await failed(createBridge({ settings: { objects: 'widgets' }, secrets: { token: TOKEN }, fetch: account().fetch }).check('objects')), /no object named widgets/)
  const sig = await hs.signatures()
  assert.deepEqual(Object.keys(sig), d.tables.map((t: any) => t.name))
})

test('hubspot: a filtered read goes through search (EQ, paged by after, retried on 429); an unfiltered one lists with properties=; values typed', async () => {
  const { s, fetch } = account()
  const hs = createBridge({ secrets: { token: TOKEN }, fetch })
  const rows = await hs.query(JSON.stringify({ entity: 'contacts', filters: { lifecyclestage: 'customer', id: 7 }, fields: ['email', 'num_notes', 'hs_is_unworked', 'firstname'], limit: 10 }))
  assert.deepEqual(s.searches[0], { filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }, { propertyName: 'hs_object_id', operator: 'EQ', value: '7' }] }], properties: ['email', 'num_notes', 'hs_is_unworked', 'firstname'], limit: 10 })
  assert.equal(s.searches[1].after, '2')
  assert.deepEqual(rows, [
    { id: '1', email: 'a@x.test', num_notes: 3, hs_is_unworked: true, firstname: null },
    { id: '2', email: 'b@x.test', num_notes: null, hs_is_unworked: null, firstname: null },
    { id: '3', email: 'c@x.test', num_notes: 0, hs_is_unworked: false, firstname: null },
  ])
  // changed since: a GTE filter on the last-modified property, sorted by it
  await hs.query(JSON.stringify({ entity: 'contacts', since: '2026-11-01T00:00:00Z', fields: ['email'] }))
  assert.deepEqual(s.searches.at(-2).filterGroups[0].filters, [{ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(Date.parse('2026-11-01T00:00:00Z')) }])
  // unfiltered: the list API, properties named, paged by after; hidden properties left out when none are named
  const listed = await hs.query(JSON.stringify({ entity: 'contacts', limit: 3 }))
  assert.deepEqual(listed.map((r: any) => r.id), ['1', '2', '3'])
  assert.equal(s.lists[0].searchParams.get('properties'), PROPS.contacts.filter((p) => !p.hidden).map((p) => p.name).join(','))
  assert.equal(s.lists[1].searchParams.get('after'), '2')
  // a custom object, read by its name at its objectTypeId
  await hs.introspect()
  assert.deepEqual((await hs.query(JSON.stringify({ entity: 'cars', fields: ['vin'], limit: 1 }))), [{ id: '1', vin: 'V1' }])
  assert.equal(s.lists.at(-1)!.pathname, '/crm/v3/objects/2-3456789')
  assert.match(await failed(hs.query(JSON.stringify({ entity: 'contacts', filters: { nope: 1 } }))), /contacts has no property nope to filter on/)
  assert.match(await failed(hs.query(JSON.stringify({ entity: 'contacts', fields: ['nope'] }))), /contacts has no property nope/)
})

test('hubspot: owners and associations read; a missing scope said by name', async () => {
  const hs = createBridge({ secrets: { token: TOKEN }, fetch: account().fetch })
  assert.deepEqual(await hs.query(JSON.stringify({ entity: 'owners' })), [{ id: '42', email: 'ana@x.test', first_name: 'Ana', last_name: 'Rao', user_id: 9001, teams: 'North', archived: false, created_at: '2025-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }])
  assert.deepEqual(await hs.query(JSON.stringify({ entity: 'associations', filters: { object: 'deals', id: '123', to: 'companies' } })), [
    { from_object: 'deals', from_id: '123', to_object: 'companies', to_id: '456', labels: 'Primary, hubspot_defined 341' },
    { from_object: 'deals', from_id: '123', to_object: 'companies', to_id: '789', labels: 'Reseller' },
  ])
  assert.match(await failed(hs.query(JSON.stringify({ entity: 'associations', filters: { object: 'deals' } }))), /associations needs filters object, id and to/)
  assert.equal(await failed(hs.query(JSON.stringify({ entity: 'tickets' }))), 'not allowed: the token needs the scope tickets')
  assert.match(await failed(hs.query(JSON.stringify({ entity: 'widgets' }))), /there is no object "widgets" in this HubSpot account/)
})
