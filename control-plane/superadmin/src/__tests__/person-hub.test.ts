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
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  if (u.pathname === '/attach') return env.USER.get(env.USER.idFromName('user:' + JSON.parse(req.headers.get('x-sa-claims')).userId)).fetch(req)   // the Worker's /api/sessions/…/attachments
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
  it('what a device sends right behind its hello waits for the link instead of closing the socket', async () => {
    // The phone sends hello, sync:req and log:attach at once, without waiting for the welcome.
    const r = await mf.dispatchFetch(`http://x/_ws/${PID}?token=${jwt({ userId: 'ios', email: 'ios@x.io', role: 'superadmin' })}`, { headers: { upgrade: 'websocket' } })
    const ws = r.webSocket!; const got: any[] = []; let closed: number | null = null
    ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
    ws.addEventListener('close', (e: any) => { closed = e.code })
    ws.accept()
    ws.send(JSON.stringify({ type: 'hello', role: 'runtime' }))
    ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'sync:req' } }))
    ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'early-probe', reqId: 'early' } }))
    await engine.until((m) => m.payload?.t === 'early-probe')
    await settle()
    expect(closed).toBe(null)
    expect(got.map((m) => m.payload?.t).slice(0, 2)).toEqual(['welcome', 'sync:res'])
    ws.close()
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
  it('a large answer in parts reaches only its asker and session, whole, and lands in the inbox', async () => {
    a1.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', questionId: 'q2', sessionId: 's2', question: 'how much' } })
    const asked = await engine.until((m) => m.payload?.t === 'analyse' && m.payload.questionId === 'q2')
    const body = JSON.stringify({ t: 'analyst:answer', qid: 'q2', sid: 's2', answer: { markdown: 'x'.repeat(3000) } })
    const parts = [body.slice(0, 1500), body.slice(1500)]
    parts.forEach((data, i) => engine.send({ to: { id: asked.from.id, type: 'runtime' }, payload: { t: 'part', id: 'big1', part: i, of: parts.length, data } }))
    await a1.until((m) => m.payload?.t === 'part' && m.payload.part === 1)
    await settle()
    expect(a1.got.filter((m) => m.payload?.t === 'part' && m.payload.id === 'big1')).toHaveLength(2)
    expect(a2.got.some((m) => m.payload?.id === 'big1') || a3.got.some((m) => m.payload?.id === 'big1')).toBe(false)
    // A device that was away pulls it from the person's own inbox — the project is not asked.
    const phone = await tab('ana')
    await phone.until((m) => m.payload?.t === 'welcome')
    const before = engine.got.length
    phone.send({ to: { type: 'code-engine' }, payload: { t: 'sync:req' } })
    const res = await phone.until((m) => m.payload?.t === 'sync:res')
    expect(res.payload.answers.map((x: any) => x.qid)).toEqual(expect.arrayContaining(['q2', 'q1']))
    phone.send({ to: { type: 'code-engine' }, payload: { t: 'answer:get', qid: 'q2' } })
    expect((await phone.until((m) => m.payload?.t === 'answer:res')).payload).toMatchObject({ status: 'ready', question: 'how much' })
    await settle()
    expect(engine.got.slice(before).some((m) => ['sync:req', 'answer:get'].includes(m.payload?.t))).toBe(false)
    phone.ws.close()
  })
  it('a file a person adds goes in through their UserDO: kept by its hash, and only where it is goes on to the engine', async () => {
    const bytes = new TextEncoder().encode('month,budget\nJan,100\n')
    const r = await mf.dispatchFetch(`http://x/attach?project=${PID}&session=s1&name=budget.csv&type=text/csv`, { method: 'POST', body: bytes, headers: { 'x-sa-claims': JSON.stringify({ userId: 'ana', email: 'ana@x.io', role: 'superadmin' }) } })
    expect(r.status).toBe(201)
    const out: any = await r.json()
    expect(out).toMatchObject({ name: 'budget.csv', size: bytes.length })
    const atEngine = await engine.until((m) => m.payload?.t === 'session:attach')
    expect(atEngine.payload).toMatchObject({ session: 's1', name: 'budget.csv', hash: out.hash, size: bytes.length, type: 'text/csv' })
    expect(atEngine.payload.data).toBeUndefined()
    expect(atEngine.from.userId).toBe('ana')
    const kept = await (await mf.getR2Bucket('PACKAGES')).get(`attachments/${PID}/s1/${out.hash}`)
    expect(await kept?.text()).toBe('month,budget\nJan,100\n')
    const bo = await mf.dispatchFetch(`http://x/attach?project=${PID}&session=s9&name=x.csv`, { method: 'POST', body: bytes, headers: { 'x-sa-claims': JSON.stringify({ userId: 'bo', email: 'bo@x.io', role: 'user' }) } })
    expect(bo.status).toBe(403)   // no access to the project: refused before anything is kept
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
