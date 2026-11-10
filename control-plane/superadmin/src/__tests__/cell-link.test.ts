// A person's cell (user-cell.ts): an engine doing one person's work in a project, linked through the person's door — their
// UserDO checks its key, the project admits it as their cell. Through the REAL ProjectDO and UserDO in Miniflare, routed as
// the Worker routes sockets: a cell is welcomed as an engine is; any number may connect and one is the person's primary;
// a cell without its engine id, or on a key that is not good, is refused; a cell never becomes the project's engine.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac, createHash } from 'node:crypto'
import { sealKeygen } from '../proxy/seal'
import { personHeaders } from './caller'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-5555555555c1'

const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export { GlobalDO } from '../global-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req)
  fwd.headers.set('x-sa-project', '${PID}')
  return env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}')).fetch(fwd)
} }
`
let mf: Miniflare
const call = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x/do${path}`, init); return { status: r.status, body: await r.json() as any } }

/** A person's sign-in, as the Worker checks it (their id: the platform's, from their email). */
const pid = (email: string) => createHash('sha256').update(email).digest('hex').slice(0, 32)
const jwt = (email: string) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, v: 2, userId: pid(email), email, role: 'user' })}`
  return `${body}.${createHmac('sha256', 's').update(body).digest('base64url')}`
}
/** A person's page: their socket through their door, its welcome. */
async function page(email: string) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}?token=${jwt(email)}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!; const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'runtime', token: jwt(email) }))
  const until = async (pred: (m: any) => boolean, ms = 3000) => { const t = Date.now(); for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error(`nothing matched; got ${JSON.stringify(got.map((x) => x.payload?.t))}`); await new Promise((r) => setTimeout(r, 20)) } }
  return { ws, got, until, send: (m: unknown) => ws.send(JSON.stringify(m)) }
}

/** Every cell socket opened (one cell may hold several — a restarted cell reconnects under the same id). */
const opened: { engineId: unknown; ws: WebSocket }[] = []

/** A socket as an engine opens one: a cell through its person's door (?agent=1&person=…, the key in its hello); the
 *  project's engine straight to the project. */
async function connect(hello: Record<string, unknown>) {
  const person = typeof hello.key === 'string' ? hello.key.split('_')[2] : ''
  const q = hello.role === 'cell' ? `?agent=1&person=${person}` : ''
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}${q}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!
  if (hello.role === 'cell') opened.push({ engineId: hello.engineId, ws })
  const got: any[] = []
  let closed: { code: number; reason: string } | null = null
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
  ws.addEventListener('close', (e: any) => { closed = { code: e.code, reason: e.reason } })
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', ...hello }))
  const until = async (pred: (m: any) => boolean, ms = 3000) => {
    const t = Date.now()
    for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error(`nothing matched; got ${JSON.stringify(got.map((x) => x.payload?.t))}`); await new Promise((r) => setTimeout(r, 20)) }
  }
  const closedWith = async (ms = 3000) => { const t = Date.now(); while (!closed) { if (Date.now() - t > ms) return null; await new Promise((r) => setTimeout(r, 20)) } return closed }
  return { ws, got, until, closedWith }
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 's', CREDENTIALS_MASTER_KEY: sealKeygen() } })
  await call('/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'engine-key', provider: 'external', name: 'Cells' }) })
  await call('/access', { method: 'POST', body: JSON.stringify({ email: 'ana@test.io', roleId: 'admin' }) })
  await call('/access', { method: 'POST', body: JSON.stringify({ email: 'bo@test.io', roleId: 'admin' }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe("a person's cell, linked through their door", () => {
  let key = ''
  it('welcomed as an engine is — the project, its profile and release — as the person\'s cell; the first is their primary', async () => {
    key = (await call('/agent-keys', { method: 'POST', body: JSON.stringify({ name: "ana's cell", capabilities: ['project.view', 'project.ask'], by: 'ana@test.io' }) })).body.key
    const a = await connect({ role: 'cell', key, engineId: 'cell-ana-0001', instanceId: 'i1', epoch: 1 })
    const w = (await a.until((m) => m.payload?.t === 'welcome')).payload
    expect(w).toMatchObject({ wsId: 'pc-cell-ana-0001', type: 'cell', project: { id: PID, name: 'Cells' } })
    expect(w).toHaveProperty('release'); expect(w).toHaveProperty('configuration')   // what an engine runs with
    expect(JSON.stringify(w)).not.toContain(key)
    // another of hers waits: one primary per person, as with engines
    const b = await connect({ role: 'cell', key, engineId: 'cell-ana-0002', instanceId: 'i2', epoch: 2 })
    expect((await b.until((m) => m.payload?.t === 'standby')).payload).toMatchObject({ wsId: 'pc-cell-ana-0002', selected: 'cell-ana-0001' })
  })

  it('refused: a cell that does not say which engine it is; one on a key that is not good', async () => {
    expect((await (await connect({ role: 'cell', key })).closedWith())?.code).toBe(4006)
    const bad = await connect({ role: 'cell', key: `sak_${PID}_${'0'.repeat(32)}_${'x'.repeat(43)}`, engineId: 'cell-x-00001' })
    expect((await bad.closedWith())?.code).toBe(4001)
  })

  it("it asks what a cell may — the replicas, and its person's connections without the project's secrets; anything else refused", async () => {
    const admin = (body: unknown) => call('/connections', { method: 'POST', headers: personHeaders('ana@test.io'), body: JSON.stringify(body) })
    expect((await admin({ connector: 'code', name: 'SHARED_DB', values: { settings: { host: 'db' }, secrets: { password: 'shared-pw' } } })).status).toBe(201)
    expect((await admin({ connector: 'code', name: 'PER_PERSON', auth: 'per-user', values: { settings: { host: 'crm' }, secrets: { password: 'indexer-pw' } } })).status).toBe(201)
    const cell = await connect({ role: 'cell', key, engineId: 'cell-ana-0001', instanceId: 'i3', epoch: 3 })
    await cell.until((m) => m.payload?.t === 'welcome')
    const ask = async (msg: Record<string, unknown>) => { cell.ws.send(JSON.stringify(msg)); return (await cell.until((m) => m.payload?.reqId === msg.reqId)).payload }
    const list = await ask({ type: 'connections:pull', reqId: 'c1' })
    expect(list.connections.map((c: any) => c.name)).toEqual(['PER_PERSON'])          // the shared one is not a cell's
    expect(list.connections[0]).toMatchObject({ secrets: {}, personOnly: true })        // the project's secret for it never leaves
    expect(JSON.stringify(list)).not.toMatch(/shared-pw|indexer-pw/)
    expect(await ask({ type: 'dsi:fingerprints', reqId: 'd1' })).toMatchObject({ t: 'dsi:fingerprints', sources: expect.any(Object) })
    expect(await ask({ type: 'graph:fingerprint', reqId: 'g1' })).toMatchObject({ t: 'graph:fingerprint' })
    expect(await ask({ type: 'session:sync', reqId: 's1' })).toMatchObject({ t: 'cell:refused', reason: "session:sync is not a cell's to ask" })
  })

  it("a cell never becomes the project's engine: the project's first engine is still its engine", async () => {
    const engine = await connect({ role: 'code-engine', engineId: 'eng-proj-0001', key: 'engine-key', instanceId: 'e1', epoch: 1 })
    expect((await engine.until((m) => m.payload?.t === 'welcome')).payload).toMatchObject({ type: 'code-engine' })
  })

  it("a conversation started in my cell: its messages go to my cell, its answers come back to me only; another person's never reach it; the page knows whether it runs", async () => {
    const cell = await connect({ role: 'cell', key, engineId: 'cell-ana-0001', instanceId: 'i4', epoch: 4 })
    await cell.until((m) => m.payload?.t === 'welcome')
    const ana = await page('ana@test.io')
    expect((await ana.until((m) => m.payload?.t === 'welcome')).payload.cell).toBe(true)
    ana.send({ to: { type: 'code-engine' }, payload: { t: 'session:start', session: 'ses-cell-1', text: 'hello', kind: 'language', place: 'cell', reqId: 'r1' } })
    const asked = await cell.until((m) => m.payload?.t === 'session:start')
    expect(asked.from).toMatchObject({ type: 'runtime', email: 'ana@test.io' })
    // its answer, to her page
    cell.ws.send(JSON.stringify({ to: { id: asked.from.id, type: 'runtime' }, payload: { t: 'session:started', session: 'ses-cell-1', reqId: 'r1' } }))
    expect((await ana.until((m) => m.payload?.t === 'session:started')).payload.session).toBe('ses-cell-1')
    // the next message of that conversation goes to the cell too, without saying so again
    ana.send({ to: { type: 'code-engine' }, payload: { t: 'session:intent', session: 'ses-cell-1', kind: 'language', text: 'and more', reqId: 'r2' } })
    expect((await cell.until((m) => m.payload?.t === 'session:intent')).payload.text).toBe('and more')
    // someone else's message for it is refused; the cell's words for them are dropped
    const bo = await page('bo@test.io')
    await bo.until((m) => m.payload?.t === 'welcome')
    bo.send({ to: { type: 'code-engine' }, payload: { t: 'session:intent', session: 'ses-cell-1', kind: 'language', text: 'mine?', reqId: 'b1' } })
    expect((await bo.until((m) => m.payload?.reqId === 'b1')).payload.reason).toBe("this conversation runs in another person's cell")
    const boWs = (await bo.until((m) => m.payload?.t === 'welcome')).payload.wsId
    cell.ws.send(JSON.stringify({ to: { id: boWs, type: 'runtime' }, payload: { t: 'session:started', session: 'leak', reqId: 'x' } }))
    await new Promise((r) => setTimeout(r, 300))
    expect(bo.got.some((m) => m.payload?.session === 'leak')).toBe(false)
    // her cell stops (every socket it has): her page is told, and the conversation's next message says so
    for (const c of opened.filter((x) => x.engineId === 'cell-ana-0001')) c.ws.close()
    await ana.until((m) => m.payload?.t === 'cell:status' && m.payload.running === false)
    ana.send({ to: { type: 'code-engine' }, payload: { t: 'session:intent', session: 'ses-cell-1', kind: 'language', text: 'still there?', reqId: 'r3' } })
    expect((await ana.until((m) => m.payload?.reqId === 'r3')).payload.message).toMatch(/Your cell is not running/)
  })
})
