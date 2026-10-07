// Each source's index, end to end: the REAL engine module (vm/apps/engine/dsi.ts — replica and builder) against the REAL
// ProjectDO (Miniflare), with a data source manager standing in for the sources. The engine builds and the platform keeps
// it; the replica follows by cursor and find-schema / get-schema read it, leaving out what is disabled or gone; a build
// that stops resumes from the platform's checkpoints; a table that cannot be read is never emptiness; a targeted build
// reads only the tables named; a lost replica is pulled again whole.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createDsi } from '../../../../vm/apps/engine/dsi.ts'
import { INDEXERS } from '../../../../vm/apps/engine/datasource-index/indexer.ts'
import { DataSourceIndex, searchDataSource, getSchema, replicaCursor } from '../../../../vm/packages/datasource-index/src/index.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const SECRET = 's3cret'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
const root = mkdtempSync(join(here, '.dsi-'))
let mf: Miniflare, manager: Server, managerUrl = ''
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}

// THE SOURCES: one source of a kind the test defines; its tables and columns change as the test goes.
const schema: Record<string, string[]> = { orders: ['id', 'total'], customer: ['id', 'name'], lines: ['order_id', 'qty'], broken: ['x'] }
const unreadable = new Set(['broken'])
let reads: string[] = []
let stopAfter = Infinity   // after reading this many tables the source hangs: the engine is stuck, and is replaced
INDEXERS.fake = {
  async listContainers() { return Object.keys(schema) },
  async indexContainer(source, t) {
    if (reads.length >= stopAfter) return new Promise(() => {})
    reads.push(t)
    if (unreadable.has(t)) throw new Error('permission denied')
    return (schema[t] ?? []).map((f) => ({ key: `${source}.${t}.${f}`, source, container: t, field: f, type: 'int' }))
  },
  async rowCounts() { return { orders: 10, customer: 0, lines: 5 } },
}

async function socket(hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}${hello.token ? `?token=${hello.token}` : ''}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!
  const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', ...hello }))
  const until = async (pred: (m: any) => boolean, ms = 10_000) => { const t = Date.now(); for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error(`nothing matched; got ${JSON.stringify(got.map((x) => x.payload?.t).slice(-20))}`); await new Promise((r) => setTimeout(r, 15)) } }
  await until((m) => m.payload?.t === 'welcome')
  let n = 0
  const ask = async (payload: any) => { const reqId = `q${++n}-${Math.random()}`; ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { ...payload, reqId } })); return (await until((m) => m.payload?.reqId === reqId)).payload }
  return { ws, got, until, ask }
}
/** An engine: the real dsi module behind one hub connection, its replica its own file. */
async function engine(name: string, epoch: number) {
  const store = new DataSourceIndex(join(root, name, 'datasource-index.sqlite'))
  const ws = await socket({ role: 'code-engine', key: 'ek', instanceId: name, epoch })
  const logs: string[] = []
  const dsi = createDsi({ store, manager: managerUrl, send: (m) => { try { ws.ws.send(JSON.stringify(m)); return true } catch { return false } }, log: (s) => logs.push(s) })
  ws.ws.addEventListener('message', (e: any) => { const m = JSON.parse(String(e.data)); if (/^(dsi|job):/.test(String(m.payload?.t ?? ''))) dsi.onMessage(m.payload) })
  dsi.welcome()
  return { ws, dsi, store, logs }
}
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms))
const until = async (f: () => boolean, ms = 10_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await settle(30) } }

beforeAll(async () => {
  manager = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c)).on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/sources') return res.end(JSON.stringify({ sources: [{ id: 'SHOP', kind: 'sql', dialect: 'fake', ready: true }] }))
      if (req.url === '/introspect') return res.end(JSON.stringify({ tables: Object.keys(schema).map((name) => ({ name })) }))
      res.end(JSON.stringify({ rows: [] }))
    })
  }).listen(0)
  managerUrl = `http://127.0.0.1:${(manager.address() as any).port}`
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  await mf.dispatchFetch('http://x/do/access', { method: 'POST', body: JSON.stringify({ email: 'admin@test.io', roleId: 'admin' }) })
}, 60_000)
afterAll(async () => { manager?.close(); await mf?.dispose(); rmSync(root, { recursive: true, force: true }) })

describe('each source\'s index, end to end', () => {
  let a: Awaited<ReturnType<typeof engine>>, admin: Awaited<ReturnType<typeof socket>>

  it('a build that stops resumes from the platform\'s checkpoints, reading nothing twice', async () => {
    const first = await engine('first', 1)
    admin = await socket({ role: 'runtime', token: jwt({ userId: 'adm', email: 'admin@test.io', role: 'user' }) })
    stopAfter = 2
    await admin.ask({ t: 'dsi:build' })
    await until(() => reads.length === 2)
    await settle()
    expect(reads).toEqual(['orders', 'customer'])
    const stuck = (await admin.until((m) => m.payload?.t === 'job:update' && m.payload.job.state === 'running')).payload.job
    // the engine is replaced; its lease is let go (as a stopped heartbeat would, after a minute)
    stopAfter = Infinity; reads = []
    a = await engine('a', 2)
    a.ws.ws.send(JSON.stringify({ type: 'job:end', id: stuck.id, state: 'failed', detail: 'its engine went away' }))
    await settle(300)
    await admin.ask({ t: 'dsi:build' })
    await until(() => a.logs.some((l) => /build done/.test(l)))
    // orders and customer were done; the rest is read now — broken fails (and will be read again next time)
    expect(reads.sort()).toEqual(['broken', 'lines'])
  })

  it('a table that cannot be read is never emptiness: it is not in the index, and the build says so', async () => {
    const stats = (await admin.ask({ t: 'dsi:stats' })).sources.find((s: any) => s.source === 'SHOP')
    expect(stats.phases.find((p: any) => p.phase === 1)).toMatchObject({ planned: 4, failed: 1 })
    expect((await admin.ask({ t: 'dsi:show', source: 'SHOP', table: 'broken' })).items).toEqual([])
    expect(a.logs.some((l) => /1 could not be read \(first: permission denied\)/.test(l))).toBe(true)
  })

  it('the replica follows the platform; find-schema and get-schema read it; phase 2 disabled the empty table', async () => {
    await until(() => replicaCursor(a.store) > 0 && (getSchema(a.store) as any).sources.length > 0)
    await settle()
    expect((getSchema(a.store, 'SHOP') as any).tables.map((t: any) => t.table)).toEqual(['lines', 'orders'])   // customer has no rows: disabled by the build
    expect(searchDataSource(a.store, 'qty').entries.map((e) => e.key)).toEqual(['SHOP.lines.qty'])
  })

  it('a table or a field disabled by a person disappears from find-schema and get-schema; enabled, it is back', async () => {
    await admin.ask({ t: 'dsi:enable', source: 'SHOP', table: 'lines', enabled: false })
    await until(() => !(getSchema(a.store, 'SHOP') as any).tables.some((t: any) => t.table === 'lines'))
    expect(searchDataSource(a.store, 'qty').entries).toEqual([])
    await admin.ask({ t: 'dsi:enable', source: 'SHOP', table: 'lines', enabled: true })
    await admin.ask({ t: 'dsi:enable', source: 'SHOP', table: 'orders', field: 'total', enabled: false })
    await until(() => searchDataSource(a.store, 'qty').entries.length === 1)
    expect((getSchema(a.store, 'SHOP', 'orders') as any).fields.map((f: any) => f.field)).toEqual(['id'])
    await admin.ask({ t: 'dsi:describe', source: 'SHOP', table: 'lines', field: 'qty', text: 'units ordered', by: 'human' })
    await until(() => (getSchema(a.store, 'SHOP', 'lines') as any).fields.find((f: any) => f.field === 'qty').description === 'units ordered')
  })

  it('a targeted build reads only the tables named; a column the source dropped is gone', async () => {
    schema.orders = ['id', 'amount']
    reads = []; a.logs.length = 0
    await admin.until((m) => m.payload?.t === 'job:update' && m.payload.job.state !== 'running')
    await admin.ask({ t: 'dsi:build', tables: { SHOP: ['orders'] } })
    await until(() => a.logs.some((l) => /build done/.test(l)))
    expect(reads).toEqual(['orders'])
    const orders = (await admin.ask({ t: 'dsi:show', source: 'SHOP', table: 'orders' })).items
    expect(orders.map((i: any) => `${i.field}:${i.gone ? 'gone' : 'here'}`)).toEqual([':here', 'amount:here', 'id:here', 'total:gone'])
  })

  it('a lost replica is pulled again whole; a second engine is told the build running and starts none', async () => {
    const b = await engine('b', 3)   // a new engine, empty replica: takes the role, pulls everything
    await until(() => (getSchema(b.store) as any).sources.length === 1)
    expect((getSchema(b.store, 'SHOP', 'lines') as any).fields.map((f: any) => f.field).sort()).toEqual(['order_id', 'qty'])
    // one build at a time: a build already running on the platform's lease — this engine starts none
    const started = await new Promise<any>((resolve) => { b.ws.ws.addEventListener('message', (e: any) => { const m = JSON.parse(String(e.data)); if (m.payload?.reqId === 'lease') resolve(m.payload) }); b.ws.ws.send(JSON.stringify({ type: 'job:start', kind: 'dsi.build', lease: 'dsi', reqId: 'lease' })) })
    expect(started.t).toBe('job:started')
    b.logs.length = 0
    b.dsi.onMessage({ t: 'dsi:build' })
    await until(() => b.logs.some((l) => /already running/.test(l)))
    b.ws.ws.send(JSON.stringify({ type: 'job:end', id: started.job.id, state: 'done' }))
  })
})
