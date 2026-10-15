// A connection used by a person (the user UI's connection page), against the REAL manager: one kind of connector — an
// API connector here, made on connectors/src/api.ts — tested, described, read and acted on AS THE ONE ASKING (their
// ticket on every read; their own key for a per-user source); an action that changes the other system runs only when a
// person confirmed it, never for an agent; a SQL source is read in its own dialect.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signTicket } from '@superatom/datasource-manager/ticket'

const MANAGER = fileURLToPath(new URL('../../datasources/manager/src/index.ts', import.meta.url))
const KEY = 'c'.repeat(48)
process.env.SA_MANAGER_KEY = KEY
const { createConnectorOps } = await import('../connector-ops.ts')
const home = mkdtempSync(join(tmpdir(), 'ops-'))
const PORT = 43000 + Math.floor(Math.random() * 2000)
const URL_ = `http://127.0.0.1:${PORT}`
let proc: ChildProcess

// An API connector: what it was asked, and as whom (its settings say whose key it holds).
const API = join(home, 'api.mjs')
writeFileSync(API, `export function createBridge({ settings = {} } = {}) { return { id: 'TICKETS', kind: 'api', dialect: 'api', ready: () => true,
  test: async () => 'signed in as ' + (settings.user ?? 'nobody'),
  introspect: async () => ({ tables: [{ name: 'tickets', description: 'Support tickets', columns: [{ name: 'id', type: 'integer' }, { name: 'title', type: 'string' }], filters: ['status'] }],
    actions: [{ name: 'close', label: 'Close a ticket', effect: 'write', confirm: true, input: [{ name: 'id', type: 'integer', required: true }] }, { name: 'lookup', label: 'Look up', effect: 'read', input: [] }] }),
  query: async (text) => { const q = JSON.parse(text); return [{ id: 1, title: 'asked ' + q.entity + ' ' + JSON.stringify(q.filters) + ' limit ' + q.limit, as: settings.user ?? null }] },
  act: async (action, input) => ({ ok: true, message: action + ' ' + JSON.stringify(input) + ' as ' + (settings.user ?? 'nobody') }) } }`)
const SQL = join(home, 'sql.mjs')
writeFileSync(SQL, `export function createBridge() { return { id: 'ERP', kind: 'sql', dialect: 'mssql', ready: () => true, query: async (sql) => [{ sent: sql }], introspect: async () => ({ tables: [] }) } }`)

const sys = (path: string, body: unknown) => fetch(URL_ + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-system': KEY }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>)
const ticketOf = async (from: any) => signTicket(KEY, { principal: `user:${from.email}`, email: from.email, policies: {}, access: -1 })
const ops = createConnectorOps({ manager: URL_, nameOf: (id) => ({ con_t: 'TICKETS', con_e: 'ERP', con_p: 'MINE' } as Record<string, string>)[id] ?? null, ticketOf,
  sourceOf: async (name) => ((await fetch(URL_ + '/sources', { headers: { 'x-sa-system': KEY } }).then((r) => r.json())) as any).sources.find((s: any) => s.id === name) ?? null })
const ana = { type: 'runtime', userId: 'u1', email: 'ana@x.test' }

before(async () => {
  proc = spawn(process.execPath, ['--import', 'tsx', MANAGER], { env: { ...process.env, SA_MANAGER_KEY: KEY, DATASOURCE_PORT: String(PORT), DATASOURCE_DATA_DIR: join(home, 'data') }, stdio: 'ignore' })
  let up = false
  for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(URL_ + '/health')).ok } catch { /* not yet */ } if (!up) await new Promise((r) => setTimeout(r, 100)) }
  assert.ok(up, 'the manager did not start in 30 s')
  assert.equal((await sys('/sources', { id: 'TICKETS', path: API, config: { settings: { user: 'shared' }, secrets: {} } })).ok, true)
  assert.equal((await sys('/sources', { id: 'ERP', path: SQL })).ok, true)
  assert.equal((await sys('/sources', { id: 'MINE', path: API, perUser: true, config: { settings: { user: 'shared' }, secrets: {} } })).ok, true)
})
after(() => { proc?.kill(); rmSync(home, { recursive: true, force: true }) })

test('an API connection: tested, described (its entities and actions), read with a JSON query as the asker', async () => {
  assert.deepEqual(await ops.handle({ t: 'connector:test', connection: 'con_t' }, ana), { t: 'connector:result', result: { ok: true, message: 'signed in as shared' } })
  const d: any = await ops.handle({ t: 'connector:introspect', connection: 'con_t' }, ana)
  assert.deepEqual(d.result.entities, [{ name: 'tickets', description: 'Support tickets', fields: [{ name: 'id', type: 'integer' }, { name: 'title', type: 'string' }], filters: ['status'] }])
  assert.deepEqual(d.result.actions.map((a: any) => a.name), ['close', 'lookup'])
  const r: any = await ops.handle({ t: 'connector:read', connection: 'con_t', entity: 'tickets', filters: { status: 'open', empty: '' }, limit: 5 }, ana)
  assert.equal(r.result.rows[0].title, 'asked tickets {"status":"open"} limit 5')
  assert.match((await ops.handle({ t: 'connector:read', connection: 'nope', entity: 'x' }, ana) as any).reason, /no such connection/)
})

test('an action that changes the other system: only when a person confirmed it — never an agent', async () => {
  assert.match((await ops.handle({ t: 'connector:act', connection: 'con_t', action: 'close', input: { id: 7 } }, ana) as any).reason, /Close a ticket changes TICKETS: a person confirms it before it runs/)
  assert.match((await ops.handle({ t: 'connector:act', connection: 'con_t', action: 'close', input: { id: 7 }, confirmed: true }, { type: 'agent', userId: 'agent:k1' }) as any).reason, /a person confirms it/)
  assert.deepEqual(await ops.handle({ t: 'connector:act', connection: 'con_t', action: 'close', input: { id: 7 }, confirmed: true }, ana), { t: 'connector:result', result: { ok: true, message: 'close {"id":7} as shared' } })
  // a lookup changes nothing: no confirmation asked
  assert.equal((await ops.handle({ t: 'connector:act', connection: 'con_t', action: 'lookup', input: {} }, ana) as any).t, 'connector:result')
  assert.match((await ops.handle({ t: 'connector:act', connection: 'con_t', action: 'explode', confirmed: true }, ana) as any).reason, /no action "explode"/)
  assert.match((await ops.handle({ t: 'connector:act', connection: 'con_e', action: 'x', confirmed: true }, ana) as any).reason, /does no actions/)
})

test('a query of the asker\'s own (sacli datasources query): by the source\'s name, through the checked path (read only), as them; a page, the total, whether it is complete, whether from the cache', async () => {
  const r: any = await ops.handle({ t: 'connector:query', source: 'ERP', sql: 'SELECT name FROM customers' }, ana)
  assert.equal(r.t, 'connector:result', JSON.stringify(r))
  assert.equal(r.result.source, 'ERP'); assert.equal(r.result.page, 1); assert.equal(r.result.total, 1); assert.equal(r.result.complete, true)
  assert.match(r.result.rows[0].sent, /SELECT/i)                                   // what the rewrite made of it ran
  assert.equal((await ops.handle({ t: 'connector:query', source: 'ERP', sql: 'SELECT name FROM customers' }, ana) as any).result.cache.hit, true)
  assert.equal((await ops.handle({ t: 'connector:query', source: 'ERP', sql: 'SELECT name FROM customers', fresh: true }, ana) as any).result.cache.hit, false)
  assert.match((await ops.handle({ t: 'connector:query', source: 'ERP', sql: 'DELETE FROM customers' }, ana) as any).reason, /SELECT|read|not allowed|only/i)   // read only
  assert.match((await ops.handle({ t: 'connector:query', source: 'ERP', sql: '' }, ana) as any).reason, /what to read/)
  assert.match((await ops.handle({ t: 'connector:query', source: 'NOPE', sql: 'SELECT 1' }, ana) as any).reason, /not loaded on the engine/)
})

test('a SQL connection is read in its own dialect (T-SQL: TOP), as the asker', async () => {
  const r: any = await ops.handle({ t: 'connector:read', connection: 'con_e', entity: 'orders', limit: 3 }, ana)
  assert.match(r.result.rows[0].sent, /TOP/i)
})

test("a per-user API connection: read and acted on with the asker's own key — refused, saying how, when they gave none", async () => {
  let serving = true
  const keys: Record<string, any> = { 'ana@x.test': { settings: { user: 'ana' }, secrets: {} } }
  const engine = (async () => { while (serving) {
    const w: any = await fetch(URL_ + '/wants?wait=1', { headers: { 'x-sa-system': KEY } }).then((r) => r.json())
    for (const x of w.wants ?? []) await sys('/person', { source: x.source, person: x.person, config: keys[x.email] ?? null })
  } })()
  try {
    assert.equal((await ops.handle({ t: 'connector:read', connection: 'con_p', entity: 'tickets' }, ana) as any).result.rows[0].as, 'ana')
    assert.match((await ops.handle({ t: 'connector:act', connection: 'con_p', action: 'close', input: { id: 1 }, confirmed: true }, ana) as any).result.message, /as ana$/)
    assert.equal((await ops.handle({ t: 'connector:test', connection: 'con_p' }, ana) as any).result.message, 'signed in as ana')
    const bo: any = await ops.handle({ t: 'connector:read', connection: 'con_p', entity: 'tickets' }, { type: 'runtime', userId: 'u2', email: 'bo@x.test' })
    assert.match(bo.reason, /bo@x\.test has not given theirs — sacli datasources my-key MINE/)
  } finally { serving = false; await engine }
})

test("a setup step's check (/trial): the connector loaded with the values given so far in a process of its own, signed in, closed — never a source", async () => {
  assert.deepEqual(await sys('/trial', { path: API, config: { settings: { user: 'ana' }, secrets: {} } }), { ok: true, said: 'signed in as ana' })
  // one of the connector's own checks, in its code: what it found, or what is wrong
  const own = join(home, 'own.mjs'); writeFileSync(own, `export function createBridge({ settings = {} } = {}) { return { id: 'X', kind: 'api', ready: () => true, check: async (n) => { if (n === 'tables') { if (!settings.ok) throw new Error('permission denied: may read no table'); return 'may read 3 tables' } throw new Error('there is no check ' + n) } } }`)
  assert.deepEqual(await sys('/trial', { path: own, config: { settings: { ok: true } }, check: 'tables' }), { ok: true, said: 'may read 3 tables' })
  assert.match((await sys('/trial', { path: own, config: {}, check: 'tables' })).error, /may read no table/)
  assert.match((await sys('/trial', { path: own, config: {}, check: 'nope' })).error, /no check nope/)
  const broken = join(home, 'broken.mjs'); writeFileSync(broken, `export function createBridge() { throw new Error('password authentication failed for user "x"') }`)
  const r = await sys('/trial', { path: broken, config: {} })
  assert.equal(r.ok, false); assert.match(r.error, /password authentication failed/)
  const sources = ((await fetch(URL_ + '/sources', { headers: { 'x-sa-system': KEY } }).then((x) => x.json())) as any).sources.map((s: any) => s.id)
  assert.ok(!sources.some((id: string) => id.startsWith('~trial')), 'a trial is never a source')
  assert.equal((await fetch(URL_ + '/trial', { method: 'POST', body: JSON.stringify({ path: API }) })).status, 401)   // the engine's only
})

test("a source that is not SQL, explored: its rows held by the manager as the reader's, explored in DuckDB's SQL — one SELECT, nothing else reachable", async () => {
  const ticket = await ticketOf(ana)
  const snap = (body: Record<string, unknown>) => fetch(URL_ + '/snapshot', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-ticket': ticket }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }))
  const n = await snap({ id: 'TICKETS', entity: 'tickets', sql: 'SELECT count(*)::INTEGER AS n FROM t' })
  assert.deepEqual([n.rows, n.sample], [[{ n: 1 }], { rows: 1, complete: true }])
  assert.match((await snap({ id: 'TICKETS', entity: 'tickets', sql: "SELECT title FROM t" })).rows[0].title, /asked tickets/)
  assert.ok((await snap({ id: 'TICKETS', entity: 'tickets', sql: "SELECT * FROM read_csv('/etc/hosts')" })).error, 'nothing outside its rows is reachable')
  assert.equal((await snap({ id: 'TICKETS', entity: 'tickets', sql: 'DROP TABLE t' })).status, 400)
  assert.equal((await snap({ id: 'TICKETS', entity: 'tickets', sql: 'SELECT 1; SELECT 2' })).status, 400)
  assert.equal((await snap({ id: 'ERP', entity: 'x', sql: 'SELECT 1' })).status, 400)   // a SQL source is read in its own SQL
  // the console's explorer reads it so, through the engine
  const { createSourceViewer } = await import('../source-viewer.ts')
  const viewer = createSourceViewer({ manager: URL_, index: null as any, policiesFor: async () => [], ticketOf, sourceOf: async (s) => (s === 'TICKETS' ? { kind: 'api', dialect: 'api' } : null) })
  const r: any = await viewer.read({ source: 'TICKETS', request: { table: 'tickets', op: 'rows', page: 1, size: 50, q: '', where: [] } }, ana)
  assert.equal(r.error, undefined, r.error); assert.equal(r.result.rows.length, 1); assert.deepEqual(r.sample, { rows: 1, complete: true })
})
