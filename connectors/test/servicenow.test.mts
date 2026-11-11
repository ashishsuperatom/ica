// The servicenow connector, replayed (from the documentation): a stand-in `fetch` answers as ServiceNow's Table API
// documentation shows — sys_db_object and sys_dictionary read as tables, encoded queries (sysparm_query), sysparm_fields,
// sysparm_limit/offset with X-Total-Count, values as text, the OAuth token endpoint (/oauth_token.do), the X-RateLimit-*
// headers of a rate limit rule, its error bodies ({"error": {"message", "detail"}, "status": "failure"}), and a
// hibernating instance. No live instance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkEngineManifest } from '../src/contract.ts'
import { fixFor } from '../src/setup.ts'
import { createBridge, instanceUrl, escapeValue } from '../bridges/servicenow/connector.ts'

const manifest = JSON.parse(readFileSync(new URL('../bridges/servicenow/manifest.json', import.meta.url), 'utf8'))
const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))
const BASIC = `Basic ${Buffer.from('superatom.integration:pw').toString('base64')}`
const id = (n: number) => n.toString(16).padStart(32, '0')

// The instance's tables (sys_db_object) and their fields (sys_dictionary), as the Table API gives them with
// sysparm_exclude_reference_link=true: a reference's value is its sys_id; dictionary references and types by name.
const TABLES = [
  { sys_id: id(1), name: 'task', label: 'Task', super_class: '' },
  { sys_id: id(2), name: 'incident', label: 'Incident', super_class: id(1) },
  { sys_id: id(3), name: 'problem', label: 'Problem', super_class: id(1) },
  { sys_id: id(4), name: 'cmdb_ci', label: 'Configuration Item', super_class: '' },
  { sys_id: id(5), name: 'cmdb_ci_hardware', label: 'Hardware', super_class: id(4) },
  { sys_id: id(6), name: 'cmdb_ci_computer', label: 'Computer', super_class: id(5) },
  { sys_id: id(7), name: 'cmdb_ci_server', label: 'Server', super_class: id(6) },
  { sys_id: id(8), name: 'sys_user', label: 'User', super_class: '' },
  { sys_id: id(9), name: 'u_vendor', label: 'Vendor', super_class: '' },
]
const dict = (name: string, element: string, internal_type: string, more: Record<string, string> = {}) => ({ name, element, column_label: element.replace(/_/g, ' '), internal_type, reference: '', mandatory: 'false', primary: 'false', comments: '', ...more })
const DICTIONARY = [
  dict('task', 'sys_id', 'GUID', { column_label: 'Sys ID', primary: 'true' }), dict('task', 'number', 'string', { column_label: 'Number' }),
  dict('task', 'short_description', 'string', { column_label: 'Short description' }), dict('task', 'priority', 'integer', { column_label: 'Priority', comments: '1 is the most urgent' }),
  dict('task', 'active', 'boolean', { column_label: 'Active' }), dict('task', 'assigned_to', 'reference', { column_label: 'Assigned to', reference: 'sys_user' }),
  dict('task', 'opened_at', 'glide_date_time', { column_label: 'Opened' }), dict('task', 'sys_updated_on', 'glide_date_time', { column_label: 'Updated' }),
  dict('incident', 'caller_id', 'reference', { column_label: 'Caller', reference: 'sys_user' }), dict('incident', 'reopen_count', 'integer', { column_label: 'Reopen count' }),
  dict('incident', 'category', 'string', { column_label: 'Category' }),
  dict('problem', 'problem_state', 'integer', { column_label: 'State' }),
  dict('cmdb_ci', 'sys_id', 'GUID', { primary: 'true' }), dict('cmdb_ci', 'name', 'string', { column_label: 'Name' }), dict('cmdb_ci', 'sys_updated_on', 'glide_date_time'),
  dict('cmdb_ci_hardware', 'serial_number', 'string'), dict('cmdb_ci_computer', 'ram', 'integer', { column_label: 'RAM (MB)' }), dict('cmdb_ci_server', 'classification', 'string'),
  dict('sys_user', 'sys_id', 'GUID', { primary: 'true' }), dict('sys_user', 'user_name', 'string', { column_label: 'User ID', mandatory: 'true' }),
  dict('sys_user', 'manager', 'reference', { column_label: 'Manager', reference: id(8) }),   // given as the table's sys_id: named by the connector
  dict('u_vendor', 'sys_id', 'GUID', { primary: 'true' }), dict('u_vendor', 'u_rating', 'decimal', { column_label: 'Rating' }), dict('u_vendor', 'u_since', 'glide_date', { column_label: 'Vendor since' }),
]

/** A ServiceNow instance as its documentation answers. */
function instance(o: { hibernating?: boolean } = {}) {
  const s = { reads: [] as URLSearchParams[], tokens: 0, token: '', left: 5000 }
  const answer = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url), h = new Headers(init.headers)
    const json = (v: unknown, status = 200, more: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json;charset=UTF-8', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(--s.left), 'x-ratelimit-reset': '1762858800', ...more } })
    if (o.hibernating) return new Response('<html><body>Your instance is hibernating. <a href="https://developer.servicenow.com">Wake it</a></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    assert.equal(u.origin, 'https://acme.service-now.com')
    if (u.pathname === '/oauth_token.do') {
      const b = new URLSearchParams(String(init.body))
      assert.equal(b.get('grant_type'), 'client_credentials')
      if (b.get('client_id') !== 'cid' || b.get('client_secret') !== 'csecret') return json({ error_description: 'access_denied', error: 'server_error' }, 401)
      s.token = `tok${++s.tokens}`
      return json({ access_token: s.token, scope: 'useraccount', token_type: 'Bearer', expires_in: 1799 })
    }
    const auth = h.get('authorization')
    if (auth !== BASIC && auth !== `Bearer ${s.token}`) return json({ error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' }, status: 'failure' }, 401)
    const t = /^\/api\/now\/table\/(\w+)$/.exec(u.pathname)
    if (!t) return json({ error: { message: 'Requested URI does not represent any resource', detail: null }, status: 'failure' }, 400)
    const q = u.searchParams, query = q.get('sysparm_query') ?? '', limit = Number(q.get('sysparm_limit') ?? 10000), offset = Number(q.get('sysparm_offset') ?? 0)
    s.reads.push(q)
    const page = (rows: any[]) => json({ result: rows.slice(offset, offset + limit) }, 200, { 'x-total-count': String(rows.length) })
    if (t[1] === 'sys_db_object') {
      const names = /^nameIN([^^]+)/.exec(query)?.[1].split(','), ids = /^sys_idIN([^^]+)/.exec(query)?.[1].split(',')
      return page(TABLES.filter((x) => names?.includes(x.name) || ids?.includes(x.sys_id)))
    }
    if (t[1] === 'sys_dictionary') {
      assert.match(query, /\^elementISNOTEMPTY\^active=true\^ORDERBYsys_id$/)
      const names = /^nameIN([^^]+)/.exec(query)![1].split(',')
      return page(DICTIONARY.filter((d) => names.includes(d.name)))
    }
    if (t[1] === 'sys_user' && query === 'sys_id=javascript:gs.getUserID()') return page([{ user_name: 'superatom.integration', name: 'Superatom Integration' }])
    if (t[1] === 'problem') return json({ error: { message: 'User Not Authorized', detail: 'Read ACL on problem denied' }, status: 'failure' }, 403)
    if (t[1] === 'incident') {
      if (q.get('sysparm_display_value') === 'true') return page([{ sys_id: 'i1', number: 'INC0010001', priority: '1 - Critical', active: 'true', assigned_to: 'Ana Rao', reopen_count: '' }])
      if (query.startsWith('ORDERBYsys_id') && limit + offset > 3) return page(Array.from({ length: 1002 }, (_, i) => ({ sys_id: `i${i}`, number: `INC${i}` })))
      return page([
        { sys_id: 'i1', number: 'INC0010001', priority: '1', active: 'true', assigned_to: '5137153cc611227c000bbd1bd8cd2005', reopen_count: '', opened_at: '2026-11-01 09:00:00', short_description: 'Email ^ down' },
        { sys_id: 'i2', number: 'INC0010002', priority: '2', active: 'false', assigned_to: '', reopen_count: '1', opened_at: '2026-11-02 10:30:00', short_description: 'VPN' },
      ])
    }
    return page([{ sys_id: 'x1' }])
  }) as typeof fetch
  return { s, fetch: answer }
}

const settings = { instance: 'https://acme.service-now.com/now/nav/ui/classic/params/target/incident_list.do', user: 'superatom.integration', tables: 'u_vendor' }

test('servicenow: the instance parsed from what a person pastes; asleep, it says so', async () => {
  assert.equal(instanceUrl(settings.instance), 'https://acme.service-now.com')
  assert.equal(instanceUrl('acme'), 'https://acme.service-now.com')
  assert.equal(instanceUrl('ACME.service-now.com'), 'https://acme.service-now.com')
  assert.equal(instanceUrl('https://itsm.example.com/'), 'https://itsm.example.com')   // a custom domain, as it is
  assert.throws(() => instanceUrl(''), /give the instance/)
  assert.throws(() => instanceUrl('not a host!'), /not an instance's address/)
  assert.equal(await createBridge({ settings, secrets: { password: 'pw' }, fetch: instance().fetch }).check('instance'), 'acme.service-now.com answers')
  const asleep = await failed(createBridge({ settings, fetch: instance({ hibernating: true }).fetch }).check('instance'))
  assert.match(fixFor(manifest.setup[0], asleep), /The instance is asleep/)
})

test('servicenow: the manifest is sound — every field asked in a step, the checks named in the code', async () => {
  assert.deepEqual(checkEngineManifest(manifest), [])
  const sn = createBridge({ settings, secrets: { password: 'pw' }, fetch: instance().fetch })
  assert.equal(typeof await sn.check('instance'), 'string')
  assert.match(await failed(sn.check('nothing')), /no check nothing/)
})

test('servicenow: basic sign-in; test() says who it is and the rate limit left; a refused password said in words, with its fix', async () => {
  const { fetch } = instance()
  const sn = createBridge({ settings, secrets: { password: 'pw' }, fetch })
  assert.ok(sn.ready())
  assert.equal(await sn.test(), 'signed in to acme.service-now.com as superatom.integration (Superatom Integration); calls left this hour: 4,999 of 5,000')
  assert.deepEqual(await sn.budget(), { used: 1, limit: 5000, window: '1 hour' })
  const wrong = await failed(createBridge({ settings, secrets: { password: 'nope' }, fetch }).test())
  assert.equal(wrong, 'the credentials were refused: User Not Authenticated (Required to provide Auth information)')
  assert.match(fixFor(manifest.setup.find((x: any) => x.id === 'signin'), wrong), /refused that user ID or password/)
  assert.match(await failed(createBridge({ settings: { instance: 'acme' }, fetch }).test()), /give the integration user's name and password/)
})

test('servicenow: OAuth client credentials — a token kept until refused, then fetched once more; a refused client said once, in words', async () => {
  const { s, fetch } = instance()
  const oauth = { instance: 'acme', auth: 'oauth', clientId: 'cid' }
  const sn = createBridge({ settings: oauth, secrets: { clientSecret: 'csecret' }, fetch })
  assert.match(await sn.test(), /^signed in to acme.service-now.com as superatom.integration/)
  await sn.query(JSON.stringify({ entity: 'u_vendor', limit: 1 }))
  assert.equal(s.tokens, 1)
  s.token = 'expired-on-the-instance'
  await sn.query(JSON.stringify({ entity: 'u_vendor', limit: 1 }))
  assert.equal(s.tokens, 2)
  const bad = instance()
  const refused = await failed(createBridge({ settings: oauth, secrets: { clientSecret: 'wrong' }, fetch: bad.fetch }).test())
  assert.equal(refused, 'ServiceNow refused the sign-in (server_error: access_denied)')
  assert.equal(bad.s.tokens, 0)
  assert.match(fixFor(manifest.setup.find((x: any) => x.id === 'signin'), refused), /refused the OAuth application/)
})

test('servicenow: tables from sys_db_object along their parents, fields from sys_dictionary — labels, keys, references, mandatory, types', async () => {
  const sn = createBridge({ settings, secrets: { password: 'pw' }, fetch: instance().fetch })
  const d: any = await sn.introspect()
  assert.deepEqual(d.tables.map((t: any) => t.name), ['incident', 'problem', 'task', 'cmdb_ci', 'cmdb_ci_server', 'sys_user', 'u_vendor'])
  const incident = d.tables[0], col = (t: any, n: string) => t.columns.find((c: any) => c.name === n)
  assert.match(incident.description, /^Incident \(extends task\)\./)
  assert.deepEqual(incident.columns.map((c: any) => c.name), ['sys_id', 'number', 'short_description', 'priority', 'active', 'assigned_to', 'opened_at', 'sys_updated_on', 'caller_id', 'reopen_count', 'category'])
  assert.deepEqual(col(incident, 'sys_id'), { name: 'sys_id', type: 'string', description: 'Sys ID', key: true, nullable: false })
  assert.deepEqual(col(incident, 'assigned_to'), { name: 'assigned_to', type: 'string', description: 'Assigned to', references: 'sys_user.sys_id', nullable: true })
  assert.equal(col(incident, 'priority').description, 'Priority — 1 is the most urgent')
  assert.deepEqual([col(incident, 'priority').type, col(incident, 'active').type, col(incident, 'opened_at').type], ['integer', 'boolean', 'timestamp'])
  const server = d.tables.find((t: any) => t.name === 'cmdb_ci_server')!
  assert.deepEqual(server.columns.map((c: any) => c.name), ['sys_id', 'name', 'sys_updated_on', 'serial_number', 'ram', 'classification'])   // three parents up
  const user = d.tables.find((t: any) => t.name === 'sys_user')
  assert.equal(col(user, 'manager').references, 'sys_user.sys_id')
  assert.equal(col(user, 'user_name').nullable, false)
  const vendor = d.tables.find((t: any) => t.name === 'u_vendor')
  assert.deepEqual([col(vendor, 'u_rating').type, col(vendor, 'u_since').type], ['number', 'date'])
  const sig = await sn.signatures()
  assert.deepEqual(Object.keys(sig), d.tables.map((t: any) => t.name))
  // the check reads a row of each: the tables it may read, those it may not, those not on the instance
  const said = await sn.check('tables')
  assert.match(said, /^reads 6 tables: incident, task, cmdb_ci, cmdb_ci_server, sys_user, u_vendor\. Not allowed: problem \(not allowed: User Not Authorized \(Read ACL on problem denied\)\)\. Not on this instance: change_request, /)
  const named = await failed(createBridge({ settings: { ...settings, tables: 'u_missing' }, secrets: { password: 'pw' }, fetch: instance().fetch }).check('tables'))
  assert.equal(named, 'no table named u_missing that this user may see')
  assert.match(fixFor(manifest.setup.find((x: any) => x.id === 'tables'), named), /That table is not on this instance/)
})

test('servicenow: a read is an encoded query — filters escaped and joined with a query of its own, ordered, paged by offset; values typed', async () => {
  const { s, fetch } = instance()
  const sn = createBridge({ settings, secrets: { password: 'pw' }, fetch })
  const rows = await sn.query(JSON.stringify({ entity: 'incident', filters: { active: true, priority: 1, short_description: 'Email ^ down' }, query: 'category=network^ORpriority=2', fields: ['sys_id', 'number', 'priority', 'active', 'assigned_to', 'reopen_count', 'opened_at', 'short_description'], limit: 10 }))
  const read = s.reads.at(-1)!
  assert.equal(read.get('sysparm_query'), 'active=true^priority=1^short_description=Email ^^ down^category=network^ORpriority=2^ORDERBYsys_id')
  assert.equal(read.get('sysparm_fields'), 'sys_id,number,priority,active,assigned_to,reopen_count,opened_at,short_description')
  assert.deepEqual([read.get('sysparm_display_value'), read.get('sysparm_exclude_reference_link'), read.get('sysparm_limit'), read.get('sysparm_offset')], ['false', 'true', '10', '0'])
  assert.deepEqual(rows[0], { sys_id: 'i1', number: 'INC0010001', priority: 1, active: true, assigned_to: '5137153cc611227c000bbd1bd8cd2005', reopen_count: null, opened_at: '2026-11-01 09:00:00', short_description: 'Email ^ down' })
  assert.deepEqual([rows[1].active, rows[1].assigned_to, rows[1].reopen_count], [false, null, 1])
  assert.equal(escapeValue('a^b^^c'), 'a^^b^^^^c')
  // changed since: by sys_updated_on, as the Table API writes times (UTC)
  await sn.query(JSON.stringify({ entity: 'incident', since: '2026-11-01T05:30:00+05:30', fields: ['sys_id'] }))
  assert.equal(s.reads.at(-1)!.get('sysparm_query'), 'sys_updated_on>2026-11-01 00:00:00^ORDERBYsys_updated_on^ORDERBYsys_id')
  // past a page: offset paging until the limit
  const many = await sn.query(JSON.stringify({ entity: 'incident', limit: 1500, fields: ['sys_id'] }))
  assert.equal(many.length, 1002)
  assert.deepEqual(s.reads.slice(-2).map((q) => [q.get('sysparm_limit'), q.get('sysparm_offset')]), [['1000', '0'], ['500', '1000']])
  // a condition naming a field the table lacks would be ignored by ServiceNow (every row read): refused here
  assert.equal(await failed(sn.query(JSON.stringify({ entity: 'incident', query: 'active=true^nonsense=1' }))), 'incident has no field nonsense (in "nonsense=1")')
  assert.match(await failed(sn.query(JSON.stringify({ entity: 'incident', query: 'ORDERBYDESCnonsense' }))), /incident has no field nonsense/)
  await sn.query(JSON.stringify({ entity: 'incident', query: 'caller_id.email=a@x.test^ORDERBYDESCopened_at', limit: 1 }))   // dot-walked, and its own order kept
  assert.equal(s.reads.at(-1)!.get('sysparm_query'), 'caller_id.email=a@x.test^ORDERBYDESCopened_at')
  assert.match(await failed(sn.query(JSON.stringify({ entity: 'incident', filters: { active: true }, query: 'priority=1^NQpriority=2' }))), /cannot be joined with filters/)
  assert.match(await failed(sn.query(JSON.stringify({ entity: 'incident', filters: { number: 'javascript:gs.getUserID()' } }))), /a script condition goes in "query"/)
  assert.match(await failed(sn.query(JSON.stringify({ entity: 'incident', filters: { 'active=true^ORnumber': 'x' } }))), /incident has no field active=true\^ORnumber to filter on/)
  assert.match(await failed(sn.query(JSON.stringify({ entity: 'nope' }))), /there is no table "nope" this user may read/)
  assert.equal(await failed(sn.query(JSON.stringify({ entity: 'problem' }))), 'not allowed: User Not Authorized (Read ACL on problem denied)')
  // display values, when the connection asks for them: as ServiceNow shows them, not typed
  const shown = await createBridge({ settings: { ...settings, displayValue: 'true' }, secrets: { password: 'pw' }, fetch }).query(JSON.stringify({ entity: 'incident', limit: 1 }))
  assert.deepEqual(shown, [{ sys_id: 'i1', number: 'INC0010001', priority: '1 - Critical', active: 'true', assigned_to: 'Ana Rao', reopen_count: null }])
})
