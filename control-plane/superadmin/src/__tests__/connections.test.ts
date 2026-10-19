// Connections through the REAL ProjectDO (Miniflare): forms checked against their connector; secrets sealed with the
// master key and never shown; shared connections only by admins, personal ones by anyone for themselves; the engine
// gets a connection's secrets over its socket — a personal one only for its owner; every change audited.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seating } from './caller'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { sealKeygen } from '../proxy/seal'
import { PROJECT_ROLES } from '../../../shared/permissions'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const harness = `
import { routeSocket } from '../ws-route.ts'
import { handleObjectRoute } from '../parcels.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const obj = u.pathname.match(/^\\/api\\/projects\\/([^/]+)\\/objects\\/([a-z]+)\\/(.+)$/)
  if (obj) return handleObjectRoute({ request: req, bucket: env.PACKAGES, secret: env.JWT_SECRET, projectId: obj[1], kind: obj[2], id: decodeURIComponent(obj[3]),
    isEngine: async () => (await stub.fetch('https://do/verify-conn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: (req.headers.get('authorization') || '').replace(/^bearer\\s+/i, '') }) })).ok,
    isMember: async () => false })
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
// As the worker calls the DO: who is asking — the DO decides what their role holds (shared/permissions.ts).
const seat = seating((path, init) => mf.dispatchFetch(`http://x/do${path}`, init as any) as any)
const call = (email: string, caps: readonly string[]) => async (path: string, method = 'GET', body?: unknown) => {
  const r = await mf.dispatchFetch(`http://x/do${path}`, { method, headers: await seat(email, caps), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: r.status, body: await r.json() as any }
}
const as = (email: string, admin = false) => call(email, (admin ? PROJECT_ROLES.admin : PROJECT_ROLES.member).capabilities)
const admin = as('admin@x.io', true), ana = as('ana@x.io'), bo = as('bo@x.io')

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x', CREDENTIALS_MASTER_KEY: sealKeygen() } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

async function engineAsk(msg: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!; const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', engineId: 'eng-test-0001', key: 'ek', instanceId: `e${Math.random()}`, epoch: Date.now() }))
  for (let i = 0; i < 100 && !got.some((m) => m.payload?.t === 'welcome'); i++) await new Promise((r) => setTimeout(r, 20))
  ws.send(JSON.stringify({ type: 'connection:get', reqId: 'c1', ...msg }))
  for (let i = 0; i < 100 && !got.some((m) => m.payload?.t === 'connection:got'); i++) await new Promise((r) => setTimeout(r, 20))
  ws.close(); return got.find((m) => m.payload?.t === 'connection:got').payload
}

describe('connections', () => {
  let shared = '', mine = ''
  it('forms are checked against their connector; a shared connection is an admin\'s to make', async () => {
    // the catalogue: the free-form source and every connector (one kind, each from its manifest) — the platform's own never offered
    expect((await admin('/connectors')).body.connectors.map((c: any) => c.id)).toEqual(['code', 'clickhouse', 'duckdb', 'github', 'google-sheets', 'mcp-server', 'mongodb', 'mysql', 'netsuite', 'oracle', 'postgres', 'rest-json', 'sqlserver'])
    // a field asked for only when another has a value: SQL Server's login for auth sql, its service principal for entra
    expect((await admin('/connections', 'POST', { connector: 'sqlserver', name: 'mss', values: { server: 's', database: 'd', auth: 'sql' } })).body.error).toBe('User is required; Password is required')
    expect((await admin('/connections', 'POST', { connector: 'sqlserver', name: 'mss', values: { server: 's', database: 'd', auth: 'entra', user: 'x' } })).body.error).toBe('Tenant ID is required; Client ID is required; Client secret is required')
    expect((await admin('/connections', 'POST', { connector: 'postgres', name: 'warehouse', values: { host: 'db', database: 'x' } })).body.error).toBe('User is required; Password is required')
    expect((await admin('/connections', 'POST', { connector: 'mcp-server', name: 'tools', values: { url: 'not a url' } })).body.error).toBe('Server URL is a URL (http or https)')
    expect((await ana('/connections', 'POST', { connector: 'postgres', name: 'warehouse', level: 'project', values: { host: 'db', database: 'x', user: 'u', password: 'p' } })).status).toBe(403)
    const r = await admin('/connections', 'POST', { connector: 'postgres', name: 'warehouse', values: { host: 'db', port: 5432, database: 'sales', user: 'reader', password: 's3cret!' } })
    expect(r.status).toBe(201); shared = r.body.connection.id
    expect(JSON.stringify(r.body)).not.toContain('s3cret!')
  })
  it('a person connects their own; they see shared ones and theirs, never a secret, never another\'s', async () => {
    const r = await ana('/connections', 'POST', { connector: 'rest-json', name: 'my crm', level: 'user', values: { baseUrl: 'https://crm.example.com', endpoints: 'customers /customers', token: 'tok-ana' } })
    expect(r.status).toBe(201); mine = r.body.connection.id
    const anaSees = (await ana('/connections')).body.connections
    expect(anaSees.map((c: any) => c.name).sort()).toEqual(['SA-WAREHOUSE', 'my crm', 'warehouse'])
    expect(JSON.stringify(anaSees)).not.toMatch(/tok-ana|s3cret/)
    expect((await bo('/connections')).body.connections.map((c: any) => c.name).sort()).toEqual(['SA-WAREHOUSE', 'warehouse'])
    expect((await bo(`/connections/${mine}`, 'DELETE')).status).toBe(403)
  })
  it('SA-WAREHOUSE is in every project, the platform\'s own: its bridge the platform\'s, never connected, changed or removed by people', async () => {
    const list = (await admin('/connections')).body.connections
    const saw = list.find((c: any) => c.name === 'SA-WAREHOUSE')
    expect(saw).toMatchObject({ connector: 'sa-warehouse', level: 'project' })
    expect(saw.bridge).toMatch(/^[0-9a-f]{64}$/)
    expect((await admin('/connections')).body.connections.filter((c: any) => c.connector === 'sa-warehouse')).toHaveLength(1)   // made once
    expect((await admin('/connectors')).body.connectors.some((c: any) => c.id === 'sa-warehouse')).toBe(false)
    expect((await admin('/connections', 'POST', { connector: 'sa-warehouse', name: 'another' })).body.error).toMatch(/in every project already/)
    expect((await admin(`/connections/${saw.id}`, 'DELETE')).body.error).toMatch(/platform's own source/)
    expect((await admin(`/connections/${saw.id}`, 'PATCH', { description: 'x' })).body.error).toMatch(/platform's own source/)
    // The engine's bridge asks with the engine's key: the tables this project was granted (none here, no warehouse set up).
    const tables = await mf.dispatchFetch('http://x/do/engine/sa-warehouse/tables', { headers: { authorization: 'Bearer ek' } })
    expect(tables.status).not.toBe(401)
    expect((await mf.dispatchFetch('http://x/do/engine/sa-warehouse/tables', { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await mf.dispatchFetch('http://x/do/engine/sa-warehouse/query', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })).status).toBe(401)
  })
  it('the engine gets the secrets when it runs a connection — a personal one only for its owner', async () => {
    const s = await engineAsk({ id: shared })
    expect(s.connection).toMatchObject({ connector: 'postgres', settings: { host: 'db', port: 5432, database: 'sales', user: 'reader' }, secrets: { password: 's3cret!' } })
    expect((await engineAsk({ id: mine, email: 'bo@x.io', principal: 'user:bo' })).error).toBe(`connection ${mine} is someone else's`)
    expect((await engineAsk({ id: mine, email: 'ana@x.io', principal: 'user:ana' })).connection.secrets).toEqual({ token: 'tok-ana' })
  })
  it('a code connection lives here: the engine downloads it (bridge, settings, secrets) and is told when it changes; it sets no code itself', async () => {
    const made = await admin('/connections', 'POST', { connector: 'code', name: 'TOTALGROUP', values: { settings: { wsUrl: 'wss://db.example' }, secrets: { apiKey: 'k-123' } } })
    expect(made.status).toBe(201)
    // the engine, connected: pulls its code connections, and hears when they change
    const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
    const ws = r.webSocket!; const got: any[] = []
    ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
    ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', engineId: 'eng-test-0001', key: 'ek', instanceId: 'pull', epoch: Date.now() }))
    const until = async (t: string, n = 1) => { for (let i = 0; i < 150 && got.filter((m) => m.payload?.t === t).length < n; i++) await new Promise((res) => setTimeout(res, 20)); return got.filter((m) => m.payload?.t === t)[n - 1]?.payload }
    await until('welcome')
    ws.send(JSON.stringify({ type: 'connections:pull' }))
    const list = (await until('connections:list')).connections
    expect(list.find((c: any) => c.name === 'TOTALGROUP')).toMatchObject({ connector: 'code', settings: { wsUrl: 'wss://db.example' }, secrets: { apiKey: 'k-123' }, bridge: null })
    expect(list.some((c: any) => c.name === 'warehouse')).toBe(true)        // a shared code connection (postgres)
    expect(list.some((c: any) => c.name === 'my crm')).toBe(false)          // a personal API one is not the engine's to run
    // the code the engine runs comes only from a connector (the one door): there is no route for it to set a bridge
    expect((await mf.dispatchFetch('http://x/do/engine/connections/TOTALGROUP', { method: 'PUT', headers: { authorization: 'Bearer ek' }, body: JSON.stringify({ bridge: 'x' }) })).status).toBe(404)
    // the engine says what the source is, and how it runs (its workload): the platform's connection shows it ready
    ws.send(JSON.stringify({ type: 'sources:report', sources: [{ id: 'TOTALGROUP', kind: 'sql', dialect: 'mssql', description: 'SQL Server' }] }))
    ws.send(JSON.stringify({ type: 'workload:status', statuses: [{ kind: 'connection', id: 'TOTALGROUP', state: 'ready' }] }))
    await new Promise((res) => setTimeout(res, 150))
    const seen = (await bo('/connections')).body.connections
    // no code yet: the connector agent writes it, and it reaches the connection as a published connector's version
    expect(seen.find((c: any) => c.name === 'TOTALGROUP')).toMatchObject({ origin: 'platform', runnable: true, state: 'no code yet' })
    ws.close(); await new Promise((res) => setTimeout(res, 150))
    expect((await bo('/connections')).body.connections.find((c: any) => c.name === 'TOTALGROUP')).toMatchObject({ runnable: false })
    expect(JSON.stringify(seen)).not.toContain('k-123')
    expect(seen.some((c: any) => c.origin === 'engine')).toBe(false)        // one list: the platform's
  })

  it('a connection moved onto another connector runs its version, pinned (the one it ran kept for a rollback); its values read again against that form; no bridge set by hand', async () => {
    const made = await admin('/connections', 'POST', { connector: 'postgres', name: 'PG2', values: { host: 'db', database: 'd', user: 'u', password: 'p', schemas: 'public' } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.connection.id, was = made.body.connection.bridge
    expect((await admin(`/connections/${id}/bridge`, 'PUT', { code: 'export function createBridge(){ return {} }' })).status).toBe(404)
    const moved = await admin(`/connections/${id}`, 'PATCH', { connector: 'mysql' })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(moved.body.connection).toMatchObject({ connector: 'mysql', settings: { host: 'db', database: 'd', user: 'u' } })   // schemas: not a field of MySQL's
    expect(moved.body.connection.bridge).not.toBe(was)
    expect((await admin(`/connections/${id}`, 'PATCH', { connector: 'nope' })).body.error).toMatch(/no connector nope/)
    expect((await admin(`/connections/${id}`, 'PATCH', { connector: 'mcp-server' })).body.error).toMatch(/do not fit MCP server: Server URL is required/)
  })
  it('a connection moved onto another connector, or a source of written code made, only by who may change connectors — not a member, not who manages data alone', async () => {
    const dataOnly = call('dee@x.io', [...PROJECT_ROLES.member.capabilities, 'project.data'])
    const fab = await admin('/connections', 'POST', { connector: 'sqlserver', name: 'FAB2', values: { server: 's', database: 'D', auth: 'entra', tenantId: 't', clientId: 'c', clientSecret: 'x' } })
    expect(fab.status).toBe(201)
    expect((await ana(`/connections/${fab.body.connection.id}`, 'PATCH', { connector: 'postgres' })).status).toBe(403)
    expect((await dataOnly(`/connections/${fab.body.connection.id}`, 'PATCH', { connector: 'postgres' })).status).toBe(403)
    expect((await dataOnly('/connections', 'POST', { connector: 'code', name: 'MINE', values: {} })).status).toBe(403)
    expect((await dataOnly('/connections', 'POST', { connector: 'sqlserver', name: 'FAB3', values: { server: 's', database: 'D', auth: 'entra', tenantId: 't', clientId: 'c', clientSecret: 'x' } })).status).toBe(201)   // a ready connector: settings only
    expect((await admin(`/connections/${fab.body.connection.id}`, 'PATCH', { connector: 'sqlserver' })).status).toBe(200)   // the same: its values kept
  })
  it("a person's own key: given to the engine for their turn, split by the connector's fields; none for someone without; never for a shared one; the engine told when it changes", async () => {
    const made = await admin('/connections', 'POST', { connector: 'postgres', name: 'crm', values: { host: 'db', database: 'crm', user: 'indexer', password: 'idx' } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect((await admin(`/connections/${made.body.connection.id}`, 'PATCH', { auth: 'per-user' })).status).toBe(200)
    const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
    const ws = r.webSocket!; const got: any[] = []
    ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
    ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', engineId: 'eng-test-0001', key: 'ek', instanceId: 'pk', epoch: Date.now() }))
    const until = async (f: (m: any) => boolean) => { for (let i = 0; i < 150 && !got.some(f); i++) await new Promise((res) => setTimeout(res, 20)); return got.find(f)?.payload }
    await until((m) => m.payload?.t === 'welcome')
    expect((await ana(`/connections/${made.body.connection.id}/my-key`, 'GET')).body).toEqual({ given: false })
    expect((await ana(`/connections/${made.body.connection.id}/my-key`, 'PUT', { values: { user: 'ana', password: 'p-ana' } })).body).toEqual({ saved: true })
    expect((await ana(`/connections/${made.body.connection.id}/my-key`, 'GET')).body).toEqual({ given: true })   // whether — never the key
    expect(await until((m) => m.payload?.t === 'connections:person-key-changed')).toMatchObject({ name: 'crm', email: 'ana@x.io' })
    const ask = async (name: string, email: string, reqId: string) => { ws.send(JSON.stringify({ type: 'connection:person-key', reqId, name, email })); return until((m) => m.payload?.reqId === reqId) }
    // kept in HER UserDO, by (project, connection), sealed — never in the project's own storage
    const { personHome, personId } = await import('../../../shared/identity')
    const users = await mf.getDurableObjectNamespace('USER')
    const home = users.get(users.idFromName(personHome(null, await personId('ana@x.io'))))
    const held = await (await home.fetch(`http://do/connection-keys?project=${PID}&connection=${made.body.connection.id}`)).json() as any
    expect(held.sealed).toBeTruthy(); expect(held.sealed).not.toContain('p-ana')
    expect((await (await home.fetch(`http://do/connection-keys?project=another&connection=${made.body.connection.id}`)).json() as any).sealed).toBeNull()
    expect((await ask('crm', 'ANA@x.io', 'k1')).key).toEqual({ settings: { user: 'ana' }, secrets: { password: 'p-ana' } })
    expect((await ask('crm', 'bo@x.io', 'k2')).key).toBeNull()
    expect((await ask('warehouse', 'ana@x.io', 'k3')).error).toMatch(/one shared key/)
    // the engine's list says which reads with each person's own key
    ws.send(JSON.stringify({ type: 'connections:pull' }))
    expect((await until((m) => m.payload?.t === 'connections:list')).connections.find((c: any) => c.name === 'crm').auth).toBe('per-user')
    // she removes it: gone from her UserDO, the engine told
    got.length = 0
    expect((await ana(`/connections/${made.body.connection.id}/my-key`, 'DELETE')).body).toEqual({ removed: true })
    expect((await ana(`/connections/${made.body.connection.id}/my-key`, 'GET')).body).toEqual({ given: false })
    expect(await until((m) => m.payload?.t === 'connections:person-key-changed')).toMatchObject({ name: 'crm', email: 'ana@x.io' })
    expect((await ask('crm', 'ana@x.io', 'k4')).key).toBeNull()
    ws.close()
    expect((await admin('/audit?limit=50')).body.events.some((e: any) => e.action === 'connection.person-key')).toBe(true)
  })
  it('every change is audited, without the secrets', async () => {
    await ana(`/connections/${mine}`, 'DELETE')
    const events = (await admin('/audit?limit=50')).body.events
    const actions = events.map((e: any) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['connection.create', 'connection.remove', 'connection.open']))
    expect(JSON.stringify(events)).not.toMatch(/s3cret|tok-ana/)
  })
})

describe('one kind of connector: an API is an engine connector too', () => {
  it('its form from its manifest, secrets sealed apart, its version the hash of its build', async () => {
    const { CONNECTORS, connectorById, checkConnection } = await import('../../../shared/connectors')
    const gh = connectorById('github')!
    expect(gh).toMatchObject({ kind: 'rest', dialect: 'api', bridge: 'github', icon: 'mdi:github' })
    expect(gh.version).toMatch(/^[0-9a-f]{64}$/)
    expect(CONNECTORS.filter((c) => c.kind === 'rest').map((c) => c.id)).toEqual(['github', 'google-sheets', 'mcp-server', 'rest-json'])
    const r = checkConnection(gh, { token: 'ghp_x', owner: 'acme' })
    expect(r.problems).toEqual([])
    expect(r.secrets).toEqual({ token: 'ghp_x' })
    expect(r.settings).toEqual({ owner: 'acme' })
    expect(checkConnection(gh, {}).problems).toEqual(['Access token is required'])
  })
})
