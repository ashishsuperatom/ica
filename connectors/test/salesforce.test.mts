// The salesforce connector, replayed (from the documentation): a stand-in `fetch` answers as Salesforce's REST API
// documentation shows — the OAuth token endpoint (client credentials), the versions list, describeGlobal and describe
// (If-Modified-Since → 304), SOQL with nextRecordsUrl, the Sforce-Limit-Info header, and its error bodies. No live org.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkEngineManifest } from '../src/contract.ts'
import { fixFor } from '../src/setup.ts'
import { createBridge, myDomain, versionOf, quote, checkSoql } from '../bridges/salesforce/connector.ts'

const manifest = JSON.parse(readFileSync(new URL('../bridges/salesforce/manifest.json', import.meta.url), 'utf8'))
const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))
const BASE = 'https://acme.my.salesforce.com'

const obj = (name: string, more: Record<string, unknown> = {}) => ({ name, label: name, labelPlural: `${name}s`, queryable: true, custom: name.endsWith('__c'), customSetting: false, deprecatedAndHidden: false, layoutable: true, ...more })
const f = (name: string, type: string, more: Record<string, unknown> = {}) => ({ name, label: name, type, nillable: true, filterable: true, referenceTo: [], picklistValues: [], inlineHelpText: null, ...more })

/** A Salesforce org as its documentation answers. */
function org(o: { secret?: string; used?: number } = {}) {
  const s = { tokens: 0, token: '', used: o.used ?? 25, describes: [] as string[], soql: [] as string[], globalChanged: false, accountExtra: false }
  const objects = [obj('Account'), obj('Contact'), obj('Opportunity'), obj('Task'), obj('Invoice__c', { label: 'Invoice' }), obj('AccountShare'), obj('AccountHistory'), obj('AccountFeed'), obj('AccountChangeEvent'), obj('OpportunityHistory'), obj('ApexClass'), obj('Limits__c', { customSetting: true }), obj('Hidden', { queryable: false })]
  const describe: Record<string, any> = {
    Account: () => ({ name: 'Account', label: 'Account', labelPlural: 'Accounts', custom: false, fields: [
      f('Id', 'id', { label: 'Account ID', nillable: false }),
      f('Name', 'string', { label: 'Account Name', nillable: false }),
      f('Industry', 'picklist', { label: 'Industry', picklistValues: [{ value: 'Energy', active: true }, { value: 'Retail', active: true }, { value: 'Old', active: false }] }),
      f('OwnerId', 'reference', { label: 'Owner ID', referenceTo: ['User'], nillable: false }),
      f('ParentId', 'reference', { label: 'Parent Account ID', referenceTo: ['Account'] }),
      f('AnnualRevenue', 'currency', { label: 'Annual Revenue' }),
      f('NumberOfEmployees', 'int', { label: 'Employees' }),
      f('IsDeleted', 'boolean', { label: 'Deleted', nillable: false }),
      f('BillingAddress', 'address', { label: 'Billing Address', filterable: false }),
      f('Description', 'textarea', { label: 'Account Description', inlineHelpText: 'What the account does, in a sentence', filterable: false }),
      f('Logo', 'base64', { label: 'Logo' }),
      f('CreatedDate', 'datetime', { label: 'Created Date', nillable: false }),
      f('SystemModstamp', 'datetime', { label: 'System Modstamp', nillable: false }),
      ...(s.accountExtra ? [f('Tier__c', 'picklist', { label: 'Tier' })] : []),
    ] }),
    Contact: () => ({ name: 'Contact', label: 'Contact', labelPlural: 'Contacts', fields: [f('Id', 'id', { nillable: false }), f('LastName', 'string'), f('AccountId', 'reference', { label: 'Account ID', referenceTo: ['Account'] })] }),
    Opportunity: () => ({ name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', fields: [f('Id', 'id', { nillable: false }), f('Name', 'string'), f('Amount', 'currency'), f('IsWon', 'boolean'), f('StageName', 'picklist'), f('CloseDate', 'date')] }),
    Task: () => ({ name: 'Task', label: 'Task', labelPlural: 'Tasks', fields: [f('Id', 'id', { nillable: false }), f('WhoId', 'reference', { label: 'Name ID', referenceTo: ['Contact', 'Lead'] })] }),
    Invoice__c: () => ({ name: 'Invoice__c', label: 'Invoice', labelPlural: 'Invoices', custom: true, fields: [f('Id', 'id', { nillable: false }), f('Account__c', 'reference', { label: 'Account', referenceTo: ['Account'] }), f('Total__c', 'double')] }),
    OpportunityHistory: () => ({ name: 'OpportunityHistory', label: 'Opportunity History', fields: [f('Id', 'id', { nillable: false }), f('StageName', 'picklist')] }),
  }
  const answer = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url), h = new Headers(init.headers)
    const json = (v: unknown, status = 200) => new Response(v === null ? null : JSON.stringify(v), { status, headers: { 'content-type': 'application/json;charset=UTF-8', 'sforce-limit-info': `api-usage=${s.used}/15000`, date: 'Wed, 11 Nov 2026 10:00:00 GMT' } })
    assert.equal(u.origin, BASE)
    if (u.pathname === '/services/data/') return json([{ label: "Winter '25", url: '/services/data/v62.0', version: '62.0' }, { label: "Winter '27", url: '/services/data/v66.0', version: '66.0' }])
    if (u.pathname === '/services/oauth2/token') {
      assert.equal(init.method, 'POST'); assert.equal(h.get('content-type'), 'application/x-www-form-urlencoded')
      const body = new URLSearchParams(String(init.body))
      assert.equal(body.get('grant_type'), 'client_credentials'); assert.equal(body.get('client_id'), '3MVG9key')
      if (body.get('client_secret') !== (o.secret ?? 'shh')) return json({ error: 'invalid_client', error_description: 'invalid client credentials' }, 400)
      s.token = `00Dxx!tok${++s.tokens}`
      return json({ access_token: s.token, instance_url: BASE, id: `https://login.salesforce.com/id/00Dxx/005xx`, token_type: 'Bearer', issued_at: '1762855200000', signature: 'sig' })
    }
    if (h.get('authorization') !== `Bearer ${s.token}`) return json([{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }], 401)
    s.used++
    if (u.pathname === '/services/data/v62.0/sobjects') {
      if (h.get('if-modified-since') && !s.globalChanged) return json(null, 304)
      s.globalChanged = false
      return json({ encoding: 'UTF-8', maxBatchSize: 200, sobjects: objects })
    }
    const d = /^\/services\/data\/v62\.0\/sobjects\/(\w+)\/describe$/.exec(u.pathname)
    if (d) {
      s.describes.push(d[1])
      if (!describe[d[1]]) return json([{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }], 404)
      if (h.get('if-modified-since') && !(d[1] === 'Account' && s.accountExtra)) return json(null, 304)
      return json(describe[d[1]]())
    }
    if (u.pathname === '/services/data/v62.0/query') {
      const q = u.searchParams.get('q')!
      s.soql.push(q)
      assert.match(h.get('sforce-query-options') ?? '', /^batchSize=\d+$/)
      if (/FROM Account WHERE/.test(q)) return json({ totalSize: 3, done: false, nextRecordsUrl: '/services/data/v62.0/query/01gD0000002HU6KIAW-2000', records: [
        { attributes: { type: 'Account', url: '/services/data/v62.0/sobjects/Account/001A' }, Id: '001A', Name: "O'Brien Ltd", Owner: { attributes: { type: 'User', url: '/x' }, Name: 'Ana' } },
        { attributes: { type: 'Account', url: '/services/data/v62.0/sobjects/Account/001B' }, Id: '001B', Name: "O'Brien Ltd", Owner: null },
      ] })
      if (/GROUP BY StageName/.test(q)) return json({ totalSize: 2, done: true, records: [{ attributes: { type: 'AggregateResult' }, StageName: 'Closed Won', total: 1200.5 }, { attributes: { type: 'AggregateResult' }, StageName: 'Prospecting', total: 300 }] })
      if (/Contacts\)/.test(q)) return json({ totalSize: 1, done: true, records: [{ attributes: { type: 'Account' }, Name: 'Acme', Contacts: { totalSize: 1, done: true, records: [{ attributes: { type: 'Contact' }, LastName: 'Rao' }] } }] })
      if (/Nope/.test(q)) return json([{ message: "\nSELECT Nope FROM Account\n       ^\nERROR at Row:1:Column:8\nNo such column 'Nope' on entity 'Account'.", errorCode: 'INVALID_FIELD' }], 400)
      return json({ totalSize: 0, done: true, records: [] })
    }
    if (u.pathname === '/services/data/v62.0/query/01gD0000002HU6KIAW-2000') return json({ totalSize: 3, done: true, records: [{ attributes: { type: 'Account' }, Id: '001C', Name: "O'Brien Ltd", Owner: { attributes: { type: 'User' }, Name: 'Ben' } }] })
    return json([{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }], 404)
  }) as typeof fetch
  return { s, fetch: answer }
}

const settings = { domain: 'https://acme.lightning.force.com/lightning/page/home', clientId: '3MVG9key', objects: 'OpportunityHistory' }

test('salesforce: My Domain and the API version parsed from what a person pastes', () => {
  assert.equal(myDomain('https://acme.lightning.force.com/lightning/page/home'), BASE)
  assert.equal(myDomain('acme.my.salesforce.com'), BASE)
  assert.equal(myDomain('ACME'), BASE)
  assert.equal(myDomain('https://acme.my.salesforce-setup.com/lightning/setup/SetupOneHome/home'), BASE)
  assert.equal(myDomain('acme--uat.sandbox.lightning.force.com'), 'https://acme--uat.sandbox.my.salesforce.com')
  assert.equal(myDomain('acme--uat.sandbox'), 'https://acme--uat.sandbox.my.salesforce.com')
  assert.throws(() => myDomain('login.salesforce.com'), /cannot sign in an app with client credentials/)
  assert.throws(() => myDomain('https://example.com'), /not a Salesforce My Domain/)
  assert.equal(versionOf(''), '62.0'); assert.equal(versionOf('v66.0'), '66.0'); assert.equal(versionOf('63'), '63.0')
  assert.throws(() => versionOf('latest'), /not a Salesforce API version/)
})

test('salesforce: the manifest is sound — every field asked in a step, the checks named in the code', async () => {
  assert.deepEqual(checkEngineManifest(manifest), [])
  const sf = createBridge({ settings, secrets: { clientSecret: 'shh' }, fetch: org().fetch })
  for (const s of manifest.setup) if (s.check?.kind === 'custom') assert.equal(typeof await sf.check(s.check.name), 'string', s.check.name)
})

test('salesforce: signed in by client credentials; test() says what it reached and the budget; a refused secret said in words, with its fix', async () => {
  const { s, fetch } = org()
  const sf = createBridge({ settings, secrets: { clientSecret: 'shh' }, fetch })
  assert.ok(sf.ready())
  assert.equal(createBridge({ settings: { domain: 'acme' } }).ready(), false)
  assert.equal(await sf.check('domain'), 'acme.my.salesforce.com answers, with API v62.0 (its newest: v66.0)')
  assert.match(await failed(createBridge({ settings: { ...settings, apiVersion: '40.0' }, secrets: { clientSecret: 'shh' }, fetch }).check('domain')), /no API version 40.0 \(it has 62.0 to 66.0\)/)
  assert.equal(await sf.test(), 'signed in to acme.my.salesforce.com (API v62.0): 6 objects to read (13 the user may see in all); API calls used in the last 24 hours: 26 of 15,000')
  assert.deepEqual(await sf.budget(), { used: 26, limit: 15000, window: '24 hours' })
  assert.equal(s.tokens, 1)
  const wrong = await failed(createBridge({ settings, secrets: { clientSecret: 'nope' }, fetch: org().fetch }).test())
  assert.equal(wrong, 'Salesforce refused the sign-in (invalid_client: invalid client credentials)')
  const step = manifest.setup.find((x: any) => x.id === 'signin')
  assert.match(fixFor(step, wrong), /Consumer Secret does not belong to that Consumer Key/)
})

test('salesforce: objects from describeGlobal without plumbing (named ones added); fields from describe with labels, help, keys, references, nullable', async () => {
  const { s, fetch } = org()
  const sf = createBridge({ settings, secrets: { clientSecret: 'shh' }, fetch })
  assert.equal(await sf.check('objects'), '6 objects to read: Account, Contact, Opportunity, Task, Invoice__c, OpportunityHistory; API calls used in the last 24 hours: 26 of 15,000')
  const d: any = await sf.introspect()
  assert.deepEqual(d.tables.map((t: any) => t.name), ['Account', 'Contact', 'Opportunity', 'Task', 'Invoice__c', 'OpportunityHistory'])
  const account = d.tables[0], col = (n: string) => account.columns.find((c: any) => c.name === n)
  assert.equal(account.description, 'Accounts.')
  assert.deepEqual(col('Id'), { name: 'Id', type: 'string', description: 'Account ID', key: true, nullable: false })
  assert.deepEqual(col('OwnerId'), { name: 'OwnerId', type: 'string', description: 'Owner ID', references: 'User.Id', nullable: false })
  assert.equal(col('ParentId').references, 'Account.Id')
  assert.equal(col('Industry').description, 'Industry — one of: Energy, Retail')
  assert.equal(col('Description').description, 'Account Description — What the account does, in a sentence')
  assert.deepEqual([col('AnnualRevenue').type, col('NumberOfEmployees').type, col('IsDeleted').type, col('BillingAddress').type, col('CreatedDate').type], ['number', 'integer', 'boolean', 'json', 'timestamp'])
  const task = d.tables.find((t: any) => t.name === 'Task').columns.find((c: any) => c.name === 'WhoId')
  assert.deepEqual(task, { name: 'WhoId', type: 'string', description: 'Name ID — points to one of: Contact, Lead', nullable: true })   // polymorphic: no single reference
  assert.equal(d.tables.find((t: any) => t.name === 'Invoice__c').description, 'Invoices (a custom object).')
  // describes are kept: a second look asks describeGlobal if-modified-since (304) and describes nothing again
  const described = s.describes.length
  assert.equal(described, 6)
  const sig = await sf.signatures()
  assert.equal(s.describes.length, described)
  // the org changes: describeGlobal answers again, each describe is revalidated, and only Account's signature moves
  s.globalChanged = true; s.accountExtra = true
  const after = await sf.signatures()
  assert.notEqual(after.Account, sig.Account)
  assert.equal(after.Contact, sig.Contact)
})

test('salesforce: a filtered read is SOQL with each value quoted as its type; nextRecordsUrl followed; parents flattened; raw SOQL read; errors in words', async () => {
  const { s, fetch } = org()
  const sf = createBridge({ settings, secrets: { clientSecret: 'shh' }, fetch })
  const rows = await sf.query(JSON.stringify({ entity: 'Account', filters: { Name: "O'Brien Ltd", NumberOfEmployees: '50', IsDeleted: false, Industry: null }, fields: ['Id', 'Name', 'Owner.Name'], limit: 10 }))
  assert.equal(s.soql.at(-1), "SELECT Id, Name, Owner.Name FROM Account WHERE Name = 'O\\'Brien Ltd' AND NumberOfEmployees = 50 AND IsDeleted = FALSE AND Industry = null LIMIT 10")
  assert.deepEqual(rows, [{ Id: '001A', Name: "O'Brien Ltd", 'Owner.Name': 'Ana' }, { Id: '001B', Name: "O'Brien Ltd", Owner: null }, { Id: '001C', Name: "O'Brien Ltd", 'Owner.Name': 'Ben' }])
  // no fields named: every field but a file's body
  await sf.query(JSON.stringify({ entity: 'Account', filters: { Name: 'x' } }))
  assert.match(s.soql.at(-1)!, /^SELECT Id, Name, Industry, OwnerId, ParentId, AnnualRevenue, NumberOfEmployees, IsDeleted, BillingAddress, Description, CreatedDate, SystemModstamp FROM Account WHERE Name = 'x' LIMIT 100$/)
  // changed since: by SystemModstamp, in order
  await sf.query(JSON.stringify({ entity: 'Account', since: '2026-11-01T00:00:00Z', fields: ['Id'] }))
  assert.equal(s.soql.at(-1), 'SELECT Id FROM Account WHERE SystemModstamp > 2026-11-01T00:00:00Z ORDER BY SystemModstamp LIMIT 100')
  // a value is never text pasted into SOQL
  assert.equal(quote("a'b\\c\nd"), "'a\\'b\\\\c\\nd'")
  assert.match(await failed(sf.query(JSON.stringify({ entity: 'Account', filters: { NumberOfEmployees: '50 OR Name != null' } }))), /NumberOfEmployees is a number, not "50 OR Name != null"/)
  assert.match(await failed(sf.query(JSON.stringify({ entity: 'Account', filters: { 'Name = 1 OR Id': 'x' } }))), /Account has no field Name = 1 OR Id to filter on/)
  assert.match(await failed(sf.query(JSON.stringify({ entity: 'Account', filters: { Description: 'x' } }))), /cannot be filtered on in SOQL/)
  assert.match(await failed(sf.query(JSON.stringify({ entity: 'Account', fields: ['Nope'] }))), /Account has no field Nope/)
  assert.match(await failed(sf.query(JSON.stringify({ entity: 'Nothing__c' }))), /there is no object "Nothing__c" this user may read/)
  // raw SOQL: read as given (aggregates and child records too); only SELECT, and nothing that marks records
  assert.deepEqual(await sf.query(JSON.stringify({ soql: 'SELECT StageName, SUM(Amount) total FROM Opportunity GROUP BY StageName' })), [{ StageName: 'Closed Won', total: 1200.5 }, { StageName: 'Prospecting', total: 300 }])
  assert.deepEqual(await sf.query(JSON.stringify({ soql: 'SELECT Name, (SELECT LastName FROM Contacts) FROM Account' })), [{ Name: 'Acme', Contacts: [{ LastName: 'Rao' }] }])
  assert.match(await failed(sf.query(JSON.stringify({ soql: 'DELETE FROM Account' }))), /only reads: a query starts with SELECT/)
  assert.throws(() => checkSoql('SELECT Id FROM Account FOR VIEW'), /FOR VIEW/)
  assert.equal(await failed(sf.query(JSON.stringify({ soql: 'SELECT Nope FROM Account' }))), "the other system answered 400: SELECT Nope FROM Account\n       ^\nERROR at Row:1:Column:8\nNo such column 'Nope' on entity 'Account'. (INVALID_FIELD)")
  assert.match(sf.description, /\{"soql": "SELECT/)
})

test('salesforce: a token is kept until refused, then fetched once more; describing stops before the budget kept for questions', async () => {
  const { s, fetch } = org()
  const sf = createBridge({ settings, secrets: { clientSecret: 'shh' }, fetch })
  await sf.test()
  await sf.query(JSON.stringify({ soql: 'SELECT Id FROM Contact' }))
  assert.equal(s.tokens, 1)
  s.token = 'revoked'   // the org ends the session
  await sf.query(JSON.stringify({ soql: 'SELECT Id FROM Contact' }))
  assert.equal(s.tokens, 2)
  // an org with nearly all its daily calls used: describing for the index stops, saying why
  const low = org({ used: 14_900 })
  const busy = createBridge({ settings: { ...settings, reserve: '10' }, secrets: { clientSecret: 'shh' }, fetch: low.fetch })
  const why = await failed(busy.introspect())
  assert.match(why, /has used 14,901 of its 15,000 API calls in the last 24 hours; describing more objects now would spend the 10% kept for questions/)
  assert.equal(low.s.describes.length, 0)
  assert.match(fixFor(manifest.setup.find((x: any) => x.id === 'objects'), why), /nearly used its daily API calls/)
})
