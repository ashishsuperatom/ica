// Many engines, one selected, in the REAL Durable Object (Miniflare): every engine says which engine it is; the first ever
// seen is selected; any number may connect, and only the selected one is the project's engine — a standby hears nothing
// and what it sends is refused; the selection never changes by itself (not when the selected engine is gone and another
// is here), only by an admin, and then every engine is told its part afresh; an engine that does not say who it is is
// turned away.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { projectRouteNeeds } from '../../../shared/permissions.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '22222222-3333-4444-5555-666666666666'
const SECRET = 's3cret'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export { WorldModelDO } from '../world-model-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, v: 2, ...claims })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json() as any } }
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** One engine process: connects, says hello as `engineId`, keeps what it hears and how its socket closed. */
async function engine(engineId: string | undefined, instance = `i-${Math.random().toString(36).slice(2)}`, epoch = Date.now()) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket! as unknown as WebSocket & { accept(): void }
  const got: any[] = []; let closed: number | null = null
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
  ws.addEventListener('close', (e: any) => { closed = e.code })
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: 'ek', ...(engineId ? { engineId } : {}), host: 'box', instanceId: instance, epoch }))
  const until = async (pred: (m: any) => boolean, what = 'a message') => { for (let i = 0; i < 200; i++) { const m = got.find(pred); if (m) return m; await wait() } throw new Error(`${what} never came: ${JSON.stringify(got.map((x) => x.payload?.t))}`) }
  const part = async () => (await until((m) => m.payload?.t === 'welcome' || m.payload?.t === 'standby', 'a welcome or standby')).payload.t as 'welcome' | 'standby'
  return { ws, got, until, part, closed: () => closed }
}
/** A person watching the project, to see which engine their messages reach. */
async function person() {
  const token = jwt({ userId: 'u1', email: 'u1@x.io', role: 'user' })
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}?token=${token}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket! as unknown as WebSocket & { accept(): void }
  const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'runtime', token }))
  for (let i = 0; i < 200 && !got.some((m) => m.payload?.t === 'welcome'); i++) await wait()
  return { ws, got }
}
const select = (id: string) => at('/do/engines/selected', { method: 'PUT', body: JSON.stringify({ id }) })

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true }, WORLD_MODEL: { className: 'WorldModelDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await at('/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  await at('/do/access', { method: 'POST', body: JSON.stringify({ email: 'u1@x.io', roleId: 'admin' }) })   // seated for real (a token's own role counts for nothing)
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('many engines, one selected', () => {
  let a: Awaited<ReturnType<typeof engine>>, b: Awaited<ReturnType<typeof engine>>

  it('an engine that does not say which engine it is is turned away, saying why', async () => {
    const old = await engine(undefined)
    await old.until((m) => m.payload?.t === 'fenced', 'a refusal')
    for (let i = 0; i < 100 && old.closed() === null; i++) await wait()
    expect(old.closed()).toBe(4006)
    expect((await at('/do/engines')).body).toEqual({ selected: null, engines: [] })
  })

  it('the first engine ever seen is selected and welcomed; a second is a standby', async () => {
    a = await engine('eng-aaaaaaaa')
    expect(await a.part()).toBe('welcome')
    b = await engine('eng-bbbbbbbb')
    const standby = (await b.until((m) => m.payload?.t === 'standby')).payload
    expect(standby).toMatchObject({ selected: 'eng-aaaaaaaa' })
    expect(b.got.some((m) => m.payload?.t === 'welcome')).toBe(false)
    const view = (await at('/do/engines')).body
    expect(view.selected).toBe('eng-aaaaaaaa')
    expect(view.engines.map((e: any) => [e.id, e.selected, e.connected, e.host])).toEqual([['eng-aaaaaaaa', true, true, 'box'], ['eng-bbbbbbbb', false, true, 'box']])
  })

  it('only the selected engine is the project\'s: what people send reaches it, never the standby', async () => {
    const p = await person()
    const before = b.got.length
    p.ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'ping-engine', reqId: 'x1' } }))
    await a.until((m) => m.payload?.t === 'ping-engine', 'the person\'s message at the selected engine')
    a.ws.send(JSON.stringify({ type: 'ready', detail: 'ok' }))   // told to everyone in the project — but not to a standby
    for (let i = 0; i < 100 && !p.got.some((m) => m.payload?.t === 'engine:ready'); i++) await wait()
    expect(p.got.some((m) => m.payload?.t === 'engine:ready')).toBe(true)
    await wait(100)
    expect(b.got.slice(before)).toEqual([])
    p.ws.close()
  })

  it('what a standby sends is refused, said so — it writes nothing', async () => {
    b.ws.send(JSON.stringify({ type: 'world:append', reqId: 'w1', entries: [{ at: 1, model: 'm', kind: 'k', data: 1 }] }))
    const r = (await b.until((m) => m.payload?.t === 'standby' && m.payload.reqId === 'w1', 'the refusal')).payload
    expect(r.reason).toMatch(/not the project's selected engine/)
    b.ws.send(JSON.stringify({ type: 'heartbeat', busy: true }))   // keeping its socket alive is allowed, and answered by nothing
    await wait(100)
    expect(b.got.filter((m) => m.payload?.reqId === undefined && m.payload?.t === 'standby')).toHaveLength(1)   // only the first one
  })

  it('the selection never changes by itself: the selected engine gone, the standby still a standby — and when it comes back it is the engine again', async () => {
    a.ws.close(1000, 'restart')
    await wait(100)
    expect((await at('/do/engines')).body.selected).toBe('eng-aaaaaaaa')
    const late = await engine('eng-cccccccc')            // another one arriving meanwhile is a standby too
    expect(await late.part()).toBe('standby')
    late.ws.close()
    a = await engine('eng-aaaaaaaa')                       // the same engine, restarted: a new process, the same id
    expect(await a.part()).toBe('welcome')
  })

  it('an admin switches: every engine is told its part afresh — the chosen one welcomed, the other a standby', async () => {
    const r = await select('eng-bbbbbbbb')
    expect(r.status).toBe(200)
    expect(r.body.selected).toBe('eng-bbbbbbbb')
    for (let i = 0; i < 100 && (a.closed() === null || b.closed() === null); i++) await wait()
    expect([a.closed(), b.closed()]).toEqual([4007, 4007])
    b = await engine('eng-bbbbbbbb'); a = await engine('eng-aaaaaaaa')
    expect(await b.part()).toBe('welcome')
    expect(await a.part()).toBe('standby')
  })

  it('selecting an engine that never connected, or forgetting the selected or a connected one, is refused with the reason', async () => {
    expect((await select('eng-nobody00')).body.error).toMatch(/no engine eng-nobody00 has connected/)
    expect((await at('/do/engines/eng-bbbbbbbb', { method: 'DELETE' })).body.error).toMatch(/the engine the project uses/)
    expect((await at('/do/engines/eng-aaaaaaaa', { method: 'DELETE' })).body.error).toMatch(/connected now/)
    const gone = await at('/do/engines/eng-cccccccc', { method: 'DELETE' })   // seen once, not connected, not selected
    expect(gone.body.engines.map((e: any) => e.id)).toEqual(['eng-bbbbbbbb', 'eng-aaaaaaaa'])
  })

  it('the same engine connecting twice: the newer process takes over its place, never another engine\'s', async () => {
    const again = await engine('eng-aaaaaaaa', 'i-newer', Date.now() + 10_000)
    expect(await again.part()).toBe('standby')
    for (let i = 0; i < 100 && a.closed() === null; i++) await wait()
    expect(a.closed()).toBe(4002)
    expect(b.closed()).toBeNull()                          // the selected engine untouched
    expect((await at('/do/engines')).body.selected).toBe('eng-bbbbbbbb')
  })

  it('which engines there are, and choosing one, is for the people who run the project', () => {
    expect(projectRouteNeeds('GET', 'engines')).toBe('project.manage')
    expect(projectRouteNeeds('PUT', 'engines/selected')).toBe('project.manage')
  })
})
