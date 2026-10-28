// The intent graph, in the REAL Durable Objects (Miniflare): the engine asks where a question can go and says what happened
// — a node made, a node followed, the way between them counted, its passages kept in its cluster's IntentDO; people read
// the graph and a node; specialised agents are listed with whether each person may use them, and made only by who runs the
// project; a published change marks the nodes linking to it — or to what is made of it — stale.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '44444333-3333-4444-5555-666666666666'
const SECRET = 's3cret'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export { IntentDO } from '../intent-do.ts'
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
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true }, INTENT: { className: 'IntentDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await at('/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  await at('/do/access', { method: 'POST', body: JSON.stringify({ email: 'u1@x.io', roleId: 'admin' }) })   // seated for real (a token's own role counts for nothing)
}, 60_000)
afterAll(async () => { await mf?.dispose() })



const ask = async (e: Awaited<ReturnType<typeof engine>>, msg: Record<string, unknown>) => {
  const reqId = `r${Math.random().toString(36).slice(2, 8)}`
  e.ws.send(JSON.stringify({ ...msg, reqId }))
  return (await e.until((m) => m.payload?.reqId === reqId, String(msg.type))).payload
}
const say = async (p: Awaited<ReturnType<typeof person>>, payload: Record<string, unknown>) => {
  const reqId = `p${Math.random().toString(36).slice(2, 8)}`
  p.ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { ...payload, reqId } }))
  for (let i = 0; i < 200; i++) { const m = p.got.find((x) => x.payload?.reqId === reqId); if (m) return m.payload; await wait() }
  throw new Error(`no reply to ${payload.t}`)
}

describe('the intent graph', () => {
  let e: Awaited<ReturnType<typeof engine>>
  let first = '', second = ''
  it('a first question makes a node: kept in its cluster, indexed, its passage counted', async () => {
    e = await engine('eng-11111111'); expect(await e.part()).toBe('welcome')
    const ctx = await ask(e, { type: 'intent:context', at: null, text: 'which RFQs are open', caps: ['project.ask'], scopes: ['user:u1'] })
    expect(ctx.t).toBe('intent:context'); expect(ctx.here).toBe(null); expect(ctx.total).toBe(0)
    expect(ctx.agents).toEqual([])   // project.ask alone holds neither the builder (project.develop) nor the connector
    const r = await ask(e, { type: 'intent:record', node: null, body: { title: 'Open RFQs', intent: 'Which RFQs are still open', links: [{ kind: 'domain', name: 'Procurement' }] }, from: null, session: 's1', block: 'b1', question: 'which RFQs are open', answer: '28 are open', who: 'user:u1', scope: 'user:u1', how: 'made' })
    expect(r.t).toBe('intent:recorded'); first = r.node.id
    expect(first).toMatch(/^procurement-[a-z0-9]+$/); expect(r.node.passages).toBe(1)
  })
  it('a next question follows to another node: the way between them counted, per scope', async () => {
    const made = await ask(e, { type: 'intent:record', node: null, body: { title: 'Bids for an RFQ', intent: 'The bids received for one RFQ', links: [{ kind: 'domain', name: 'Procurement' }] }, from: first, session: 's1', block: 'b2', question: 'bids for RFQ-1', answer: 'three bids', who: 'user:u1', scope: 'user:u1', how: 'made' })
    second = made.node.id
    await ask(e, { type: 'intent:record', node: first, from: null, session: 's2', block: 'b1', question: 'open RFQs please', answer: '28', who: 'user:u1', scope: 'user:u1', how: 'followed' })
    await ask(e, { type: 'intent:record', node: second, from: first, session: 's2', block: 'b2', question: 'bids for RFQ-2', answer: 'two bids', who: 'user:u1', scope: 'user:u1', how: 'followed' })
    const ctx = await ask(e, { type: 'intent:context', at: first, text: 'show me the bids for RFQ-9', caps: [], scopes: ['user:u1'] })
    expect(ctx.here.id).toBe(first)
    expect(ctx.next.map((n: any) => [n.id, n.count])).toEqual([[second, 2]])
  })
  it('people read the graph and a node: its passages, ways out and versions', async () => {
    const p = await person()
    const g = await say(p, { t: 'intent:graph' })
    expect(g.nodes.map((n: any) => n.id).sort()).toEqual([first, second].sort())
    expect(g.edges).toEqual([expect.objectContaining({ from: first, to: second, count: 2, scope: 'user:u1' })])
    const n = await say(p, { t: 'intent:node', id: first })
    expect(n.node.passages).toBe(2); expect(n.passages.map((x: any) => x.question)).toEqual(['open RFQs please', 'which RFQs are open'])
    expect(n.versions).toHaveLength(1); expect(n.edges[0].to).toBe(second)
    p.ws.close()
  })
  it('specialised agents: listed with whether one may use each; made by who runs the project, never over Superatom\'s own', async () => {
    const p = await person()
    const l = await say(p, { t: 'agents:list' })
    expect(l.agents.map((a: any) => [a.name, a.builtin, a.allowed])).toEqual([['builder', true, true], ['connector', true, true]])   // u1 is the project's admin
    const bad = await say(p, { t: 'agents:save', spec: { name: 'builder', title: 'x', description: 'x', instructions: 'x', needs: 'project.ask', harness: 'claude-code' } })
    expect(bad.reason).toMatch(/Superatom's own/)
    const ok = await say(p, { t: 'agents:save', spec: { name: 'report-writer', title: 'Report writer', description: 'Writes reports', instructions: 'Write the report.', needs: 'project.ask', harness: 'claude-code' } })
    expect(ok.saved).toBe('report-writer')
    const spec = await ask(e, { type: 'intent:agent', name: 'report-writer' })
    expect(spec.agent).toEqual(expect.objectContaining({ name: 'report-writer', instructions: 'Write the report.', needs: 'project.ask' }))
    const ctx = await ask(e, { type: 'intent:context', at: null, text: 'a report', caps: ['project.ask'], scopes: ['user:u1'] })
    expect(ctx.agents.map((a: any) => a.name)).toEqual(['report-writer'])
    p.ws.close()
  })
  it('a node that does not exist is refused, saying so', async () => {
    const r = await ask(e, { type: 'intent:record', node: 'procurement-zzzzzz9', from: null, session: 's', question: 'q', answer: 'a', who: 'user:u1', scope: 'user:u1', how: 'followed' })
    expect(r.t).toBe('intent:refused'); expect(r.reason).toMatch(/no intent node/)
  })
  it('a published change to a concept marks every node linking to it — or to the domain made of it — stale', async () => {
    const p = await person()
    const c = await say(p, { t: 'graph:concept', name: 'open-rfq', body: { title: 'Open RFQ', form: 'text', text: 'An RFQ is open when it is in negotiation.' }, reason: 'test' })
    expect(c.reason).toBeUndefined()
    const d = await say(p, { t: 'graph:domain', name: 'Procurement', body: { title: 'Procurement', capabilities: ['rfq'], concepts: ['open-rfq'], files: [] }, reason: 'test' })
    expect(d.reason).toBeUndefined()
    expect((await say(p, { t: 'graph:version', message: 'first' })).version).toBeTruthy()
    const lone = await ask(e, { type: 'intent:record', node: null, body: { title: 'Open RFQ meaning', intent: 'What counts as an open RFQ', links: [{ kind: 'concept', name: 'open-rfq' }] }, from: null, session: 's3', question: 'what is open', answer: 'in negotiation', who: 'user:u1', scope: 'user:u1', how: 'made' })
    await say(p, { t: 'graph:concept', name: 'open-rfq', body: { title: 'Open RFQ', form: 'text', text: 'An RFQ is open when it is in negotiation or sent.' }, reason: 'sent counts too' })
    expect((await say(p, { t: 'graph:version', message: 'second' })).version).toBeTruthy()
    let g: any
    for (let i = 0; i < 100; i++) { g = await say(p, { t: 'intent:graph' }); if (g.nodes.every((n: any) => n.stale)) break; await wait(50) }
    expect(g.nodes.map((n: any) => [n.id, !!n.stale]).sort()).toEqual([[first, true], [second, true], [lone.node.id, true]].sort())
    expect((await say(p, { t: 'intent:node', id: first })).node.stale).toMatch(/open-rfq/)
    p.ws.close()
  })
})
