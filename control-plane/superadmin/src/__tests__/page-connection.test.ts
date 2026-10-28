// A page's connection, in the REAL Durable Objects (Miniflare): its heartbeat is answered without waking the person's hub,
// and a page that reconnects in the middle of a question (its old connection dead) is given the answer on its new one —
// the page, not its socket, is what asked.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { HEARTBEAT, HEARTBEAT_REPLY } from '../../../shared/heartbeat.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '33333333-3333-4444-5555-666666666666'
const SECRET = 's3cret'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
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
async function person(tab?: string) {
  const token = jwt({ userId: 'u1', email: 'u1@x.io', role: 'user' })
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}?token=${token}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket! as unknown as WebSocket & { accept(): void }
  const got: any[] = [], raw: string[] = []
  ws.addEventListener('message', (e: any) => { raw.push(String(e.data)); try { got.push(JSON.parse(String(e.data))) } catch { /* not JSON */ } }); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'runtime', token, ...(tab ? { tab } : {}) }))
  for (let i = 0; i < 200 && !got.some((m) => m.payload?.t === 'welcome'); i++) await wait()
  return { ws, got, raw }
}
beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await at('/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  await at('/do/access', { method: 'POST', body: JSON.stringify({ email: 'u1@x.io', roleId: 'admin' }) })   // seated for real (a token's own role counts for nothing)
}, 60_000)
afterAll(async () => { await mf?.dispose() })


describe("a page's connection", () => {
  it('a heartbeat is answered', async () => {
    const p = await person()
    p.ws.send(HEARTBEAT)
    for (let i = 0; i < 100 && !p.raw.includes(HEARTBEAT_REPLY); i++) await wait()
    expect(p.raw).toContain(HEARTBEAT_REPLY)
    p.ws.close()
  })

  it('a page that reconnects mid-question gets the answer on its new connection', async () => {
    const e = await engine('eng-11111111'); expect(await e.part()).toBe('welcome')
    const first = await person('tab-page-one')
    first.ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'session:intent', session: 's1', kind: 'language', text: 'q', reqId: 'r-1' } }))
    const asked = await e.until((m) => m.payload?.reqId === 'r-1', 'the question at the engine')
    first.ws.close()                                  // the old connection dies…
    const again = await person('tab-page-one')        // …and the same page connects again
    e.ws.send(JSON.stringify({ to: asked.from, payload: { t: 'session:view', reqId: 'r-1', session: 's1' } }))
    for (let i = 0; i < 200 && !again.got.some((m) => m.payload?.reqId === 'r-1'); i++) await wait()
    expect(again.got.some((m) => m.payload?.reqId === 'r-1')).toBe(true)
    again.ws.close(); e.ws.close()
  })

  it('another page of the same person does not get it', async () => {
    const e = await engine('eng-11111111'); expect(await e.part()).toBe('welcome')
    const one = await person('tab-page-aaaa')
    const other = await person('tab-page-bbbb')
    one.ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'session:intent', session: 's2', kind: 'language', text: 'q', reqId: 'r-2' } }))
    const asked = await e.until((m) => m.payload?.reqId === 'r-2', 'the question at the engine')
    e.ws.send(JSON.stringify({ to: asked.from, payload: { t: 'session:view', reqId: 'r-2', session: 's2' } }))
    for (let i = 0; i < 200 && !one.got.some((m) => m.payload?.reqId === 'r-2'); i++) await wait()
    await wait(100)
    expect(one.got.some((m) => m.payload?.reqId === 'r-2')).toBe(true)
    expect(other.got.some((m) => m.payload?.reqId === 'r-2')).toBe(false)
    one.ws.close(); other.ws.close(); e.ws.close()
  })
})
