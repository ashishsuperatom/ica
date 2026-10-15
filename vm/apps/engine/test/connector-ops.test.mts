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
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL_ + '/health')).ok) break } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 100)) }
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
