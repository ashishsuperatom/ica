// Every person through their own UserDO: the Worker sends a person's sockets there; it links them to the project (one
// link for all their tabs) and gives each tab only what belongs to it — the reply to what it asked, the answers and
// news of the sessions it has open, the logs it attached to — never everything to every tab.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const SECRET = 's3cret'
// The Worker's own routing for /_ws (worker.ts), in small.
const harness = `
import { verifyJwt } from '../auth/tokens.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  if (u.pathname.startsWith('/_ws/')) {
    const token = u.searchParams.get('token')
    if (token) {
      const c = await verifyJwt(token, env.JWT_SECRET)
      if (c?.userId) { const f = new Request(req); f.headers.set('x-sa-project', '${PID}'); f.headers.set('x-sa-claims', JSON.stringify({ userId: c.userId, email: c.email, role: c.role })); return env.USER.get(env.USER.idFromName('user:' + c.userId)).fetch(f) }
    }
    return env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}')).fetch(req)
  }
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}')
  return env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}')).fetch(fwd)
} }`
let mf: Miniflare
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}
async function socket(query: string, hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}?${query}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!; const got: any[] = []; let closed: number | null = null
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
  ws.addEventListener('close', (e: any) => { closed = e.code })
  ws.accept(); ws.send(JSON.stringify({ type: 'hello', ...hello }))
  const until = async (pred: (m: any) => boolean, ms = 3000) => { const t = Date.now(); for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error(`nothing matched; got ${JSON.stringify(got.map((x) => x.payload?.t))}`); await new Promise((r) => setTimeout(r, 15)) } }
  return { ws, got, until, closed: () => closed, send: (m: unknown) => ws.send(JSON.stringify(m)) }
}
const settle = () => new Promise((r) => setTimeout(r, 150))
const tab = async (userId: string, role = 'superadmin') => { const s = await socket(`token=${jwt({ userId, email: `${userId}@x.io`, role })}`, { role: 'runtime' }); return s }

let engine: Awaited<ReturnType<typeof socket>>
beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  engine = await socket('key=ek', { role: 'code-engine', key: 'ek', instanceId: 'e', epoch: 1 })
  await engine.until((m) => m.payload?.t === 'welcome')
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('every person through their UserDO', () => {
  let a1: Awaited<ReturnType<typeof tab>>, a2: Awaited<ReturnType<typeof tab>>, a3: Awaited<ReturnType<typeof tab>>
  it('a person\'s tabs share one link to the project, each welcomed', async () => {
    a1 = await tab('ana'); a2 = await tab('ana'); a3 = await tab('ana')
    const w = await Promise.all([a1, a2, a3].map((t) => t.until((m) => m.payload?.t === 'welcome')))
    expect(new Set(w.map((m) => m.payload.wsId)).size).toBe(1)
    expect(w[0].payload.project.id).toBe(PID)
  })
  it('a reply goes to the tab that asked, and only there', async () => {
    a1.send({ to: { type: 'code-engine' }, payload: { t: 'probe', reqId: 'r1' } })
    const atEngine = await engine.until((m) => m.payload?.t === 'probe')
    expect(atEngine.from.type).toBe('runtime')
    engine.send({ to: { id: atEngine.from.id, type: 'runtime' }, payload: { t: 'probe:reply', reqId: 'r1' } })
    await a1.until((m) => m.payload?.t === 'probe:reply')
    await settle()
    expect(a2.got.some((m) => m.payload?.t === 'probe:reply')).toBe(false)
    expect(a3.got.some((m) => m.payload?.t === 'probe:reply')).toBe(false)
  })
  it('an answer reaches the tab that asked and the tabs with its session open — not the others', async () => {
    a1.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', questionId: 'q1', sessionId: 's1', question: 'why' } })
    const asked = await engine.until((m) => m.payload?.t === 'analyse')
    a2.send({ to: { type: 'code-engine' }, payload: { t: 'session:open', session: 's1', reqId: 'r2' } })   // a2 opens the session
    await engine.until((m) => m.payload?.t === 'session:open')
    engine.send({ to: { id: asked.from.id, type: 'runtime' }, payload: { t: 'analyst:answer', qid: 'q1', sid: 's1', answer: { markdown: 'because' } } })
    await a1.until((m) => m.payload?.t === 'analyst:answer')
    await a2.until((m) => m.payload?.t === 'analyst:answer')
    await settle()
    expect(a3.got.some((m) => m.payload?.t === 'analyst:answer')).toBe(false)
  })
  it('a log reaches the tabs attached to its channel — of those, only one that asked or has its session open', async () => {
    a3.send({ to: { type: 'code-engine' }, payload: { t: 'log:attach', channel: 'composer-log' } })
    a3.send({ to: { type: 'code-engine' }, payload: { t: 'session:open', session: 's1', reqId: 'r3' } })
    a2.send({ to: { type: 'code-engine' }, payload: { t: 'log:attach', channel: 'analyst-log' } })   // another channel
    await settle()
    engine.send({ to: { type: 'log', channel: 'composer-log' }, payload: { t: 'agent:event', qid: 'q1', sid: 's1', lane: 'composer', ev: {} } })
    await a3.until((m) => m.payload?.t === 'agent:event')
    engine.send({ to: { type: 'log', channel: 'composer-log' }, payload: { t: 'agent:event', qid: 'qx', sid: 'other', lane: 'composer', ev: { n: 2 } } })   // another session of hers
    await settle()
    expect(a1.got.some((m) => m.payload?.t === 'agent:event') || a2.got.some((m) => m.payload?.t === 'agent:event')).toBe(false)
    expect(a3.got.filter((m) => m.payload?.t === 'agent:event')).toHaveLength(1)
  })
  it('a terminal reaches the tabs watching it; a reply without a reqId reaches the tab that asked; an error the tab that last sent', async () => {
    a2.send({ to: { type: 'code-engine' }, payload: { t: 'term:attach', which: 'analyst' } })
    const att = await engine.until((m) => m.payload?.t === 'term:attach')
    engine.send({ to: { id: att.from.id, type: 'runtime' }, payload: { t: 'analyst:chunk', text: 'bytes' } })
    await a2.until((m) => m.payload?.t === 'analyst:chunk')
    a3.send({ to: { type: 'code-engine' }, payload: { t: 'sessions:list' } })
    await engine.until((m) => m.payload?.t === 'sessions:list')
    engine.send({ to: { id: att.from.id, type: 'runtime' }, payload: { t: 'sessions:res', sessions: [] } })
    await a3.until((m) => m.payload?.t === 'sessions:res')
    engine.send({ to: { id: att.from.id, type: 'runtime' }, payload: { t: 'error', reason: 'something' } })
    await a3.until((m) => m.payload?.t === 'error')
    await settle()
    expect(a1.got.some((m) => ['analyst:chunk', 'sessions:res', 'error'].includes(m.payload?.t))).toBe(false)
    expect(a3.got.some((m) => m.payload?.t === 'analyst:chunk') || a2.got.some((m) => m.payload?.t === 'sessions:res')).toBe(false)
  })
  it('a person without access is refused', async () => {
    const bo = await tab('bo', 'user')
    for (let i = 0; i < 100 && bo.closed() === null; i++) await new Promise((r) => setTimeout(r, 20))
    expect(bo.closed()).toBe(4003)
  })
  it('the link ends when the person\'s last tab closes', async () => {
    for (const t of [a1, a2, a3]) t.ws.close()
    await engine.until((m) => m.payload?.t === 'connection:leave' && m.payload.type === 'runtime')
  })
})
