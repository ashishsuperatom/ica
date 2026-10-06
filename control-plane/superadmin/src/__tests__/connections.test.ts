// Connections through the REAL ProjectDO (Miniflare): forms checked against their connector; secrets sealed with the
// master key and never shown; shared connections only by admins, personal ones by anyone for themselves; the engine
// gets a connection's secrets over its socket — a personal one only for its owner; every change audited.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { sealKeygen } from '../proxy/seal'
import { PROJECT_ROLES } from '../../../shared/permissions'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
// As the worker calls the DO: who, and what their role holds (shared/permissions.ts).
const as = (email: string, admin = false) => async (path: string, method = 'GET', body?: unknown) => {
  const r = await mf.dispatchFetch(`http://x/do${path}`, { method, headers: { 'x-sa-actor': JSON.stringify({ kind: 'user', id: email, email }), 'x-sa-caps': JSON.stringify((admin ? PROJECT_ROLES.admin : PROJECT_ROLES.member).capabilities) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() as any }
}
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
  ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: 'ek', instanceId: `e${Math.random()}`, epoch: Date.now() }))
  for (let i = 0; i < 100 && !got.some((m) => m.payload?.t === 'welcome'); i++) await new Promise((r) => setTimeout(r, 20))
  ws.send(JSON.stringify({ type: 'connection:get', reqId: 'c1', ...msg }))
  for (let i = 0; i < 100 && !got.some((m) => m.payload?.t === 'connection:got'); i++) await new Promise((r) => setTimeout(r, 20))
  ws.close(); return got.find((m) => m.payload?.t === 'connection:got').payload
}

describe('connections', () => {
  let shared = '', mine = ''
  it('forms are checked against their connector; a shared connection is an admin\'s to make', async () => {
    expect((await admin('/connectors')).body.connectors.map((c: any) => c.id)).toEqual(['netsuite', 'code', 'sqlserver', 'postgres', 'github', 'mcp-server', 'rest-json'])
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
    expect(anaSees.map((c: any) => c.name).sort()).toEqual(['my crm', 'warehouse'])
    expect(JSON.stringify(anaSees)).not.toMatch(/tok-ana|s3cret/)
    expect((await bo('/connections')).body.connections.map((c: any) => c.name)).toEqual(['warehouse'])
    expect((await bo(`/connections/${mine}`, 'DELETE')).status).toBe(403)
  })
  it('the engine gets the secrets when it runs a connection — a personal one only for its owner', async () => {
    const s = await engineAsk({ id: shared })
    expect(s.connection).toMatchObject({ connector: 'postgres', settings: { host: 'db', port: 5432, database: 'sales', user: 'reader' }, secrets: { password: 's3cret!' } })
    expect((await engineAsk({ id: mine, email: 'bo@x.io', principal: 'user:bo' })).error).toBe(`connection ${mine} is someone else's`)
    expect((await engineAsk({ id: mine, email: 'ana@x.io', principal: 'user:ana' })).connection.secrets).toEqual({ token: 'tok-ana' })
  })
  it('a code connection lives here: the engine downloads it (bridge, settings, secrets) and is told when it changes; a bridge it writes comes up', async () => {
    const made = await admin('/connections', 'POST', { connector: 'code', name: 'TOTALGROUP', values: { settings: { wsUrl: 'wss://db.example' }, secrets: { apiKey: 'k-123' } } })
    expect(made.status).toBe(201)
    // the engine, connected: pulls its code connections, and hears when they change
    const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
    const ws = r.webSocket!; const got: any[] = []
    ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
    ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: 'ek', instanceId: 'pull', epoch: Date.now() }))
    const until = async (t: string, n = 1) => { for (let i = 0; i < 150 && got.filter((m) => m.payload?.t === t).length < n; i++) await new Promise((res) => setTimeout(res, 20)); return got.filter((m) => m.payload?.t === t)[n - 1]?.payload }
    await until('welcome')
    ws.send(JSON.stringify({ type: 'connections:pull' }))
    const list = (await until('connections:list')).connections
    expect(list.find((c: any) => c.name === 'TOTALGROUP')).toMatchObject({ connector: 'code', settings: { wsUrl: 'wss://db.example' }, secrets: { apiKey: 'k-123' }, bridge: null })
    expect(list.some((c: any) => c.name === 'warehouse')).toBe(true)        // a shared code connection (postgres)
    expect(list.some((c: any) => c.name === 'my crm')).toBe(false)          // a personal API one is not the engine's to run
    // a bridge written on the engine goes up to the connection of its name; the engine is told to pull again
    const code = 'export function createBridge({ settings, secrets }) { return { id: "tg", kind: "sql", ready: () => !!secrets.apiKey } }'
    const up = await mf.dispatchFetch('http://x/do/engine/connections/TOTALGROUP', { method: 'PUT', headers: { authorization: 'Bearer ek' }, body: JSON.stringify({ bridge: code }) })
    const ub = await up.json() as any
    expect(ub).toMatchObject({ name: 'TOTALGROUP', changed: true })
    expect(await until('connections:changed')).toBeTruthy()
    expect(await (await mf.dispatchFetch(`http://x/do/engine/bridges/${ub.bridge}`, { headers: { authorization: 'Bearer ek' } })).text()).toBe(code)
    expect((await mf.dispatchFetch(`http://x/do/engine/bridges/${ub.bridge}`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    ws.send(JSON.stringify({ type: 'connections:pull' }))
    expect((await until('connections:list', 2)).connections.find((c: any) => c.name === 'TOTALGROUP').bridge).toBe(ub.bridge)
    // the engine says how it runs: the platform's connection shows it ready
    ws.send(JSON.stringify({ type: 'sources:report', sources: [{ id: 'TOTALGROUP', kind: 'sql', dialect: 'mssql', description: 'SQL Server', ready: true }] }))
    await new Promise((res) => setTimeout(res, 150)); ws.close()
    const seen = (await bo('/connections')).body.connections
    expect(seen.find((c: any) => c.name === 'TOTALGROUP')).toMatchObject({ runs: 'code', origin: 'platform', runnable: true, source: { dialect: 'mssql' } })
    expect(JSON.stringify(seen)).not.toContain('k-123')
    expect(seen.some((c: any) => c.origin === 'engine')).toBe(false)        // one list: the platform's
  })

  it('every change is audited, without the secrets', async () => {
    await ana(`/connections/${mine}`, 'DELETE')
    const events = (await admin('/audit?limit=50')).body.events
    const actions = events.map((e: any) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['connection.create', 'connection.remove', 'connection.open']))
    expect(JSON.stringify(events)).not.toMatch(/s3cret|tok-ana/)
  })
})

describe('cloud connectors in the one catalog', () => {
  it('lists every built connector as a connection to make, its form from its manifest, secrets sealed apart', async () => {
    const { CONNECTORS, connectorById, checkConnection } = await import('../../../shared/connectors')
    const gh = connectorById('github')!
    expect(gh.runs).toBe('cloud')
    expect(gh.icon).toBe('mdi:github')
    expect(gh.offers).toEqual({ data: true, actions: true })
    expect(CONNECTORS.some((c) => c.id === 'mcp-server' && c.kind === 'mcp')).toBe(true)
    const r = checkConnection(gh, { token: 'ghp_x', owner: 'acme' })
    expect(r.problems).toEqual([])
    expect(r.secrets).toEqual({ token: 'ghp_x' })
    expect(r.settings).toEqual({ owner: 'acme' })
    expect(checkConnection(gh, {}).problems).toEqual(['Access token is required'])
  })
})
