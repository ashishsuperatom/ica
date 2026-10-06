// Agents, people and the audit history through the REAL ProjectDO in Miniflare (the runtime wrangler uses): an admin
// makes an agent key; an agent connects with it and reaches the engine holding only what it was given, its identity stamped by
// the hub; a person's messages carry their user id too; a revoked key's connection ends; everything — the questions
// asked, the intents, the refusals, the keys made and revoked — is in the append-only audit history.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { HUB_MESSAGES } from '../../../shared/hub-messages'
import { MESSAGE_NEEDS } from '../../../shared/permissions'
import { SESSION_MESSAGES } from '../../../../vm/apps/engine/session-seam.ts'
import { GRAPH_MESSAGES } from '../graph.ts'
import { PROGRAM_MESSAGES } from '../../../../vm/apps/engine/program-seam.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const SECRET = 'test-jwt-secret'

// The DO behind a minimal router: /_ws/<pid> is the hub socket, /do/<path> a call as the worker forwards it.
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req)
  fwd.headers.set('x-sa-project', '${PID}')
  return stub.fetch(fwd)
} }
`

let mf: Miniflare
const call = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x/do${path}`, init); return { status: r.status, body: await r.json() as any } }
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}

/** A socket to the hub, with every payload it receives and how it closed. */
async function connect(hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}${hello.token ? `?token=${hello.token}` : ''}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!
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
  await new Promise((r) => setTimeout(r, 100))
  return { ws, got, until, closedWith, send: (m: unknown) => ws.send(JSON.stringify(m)) }
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await call('/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'engine-key', provider: 'external', name: 'Test project' }) })
  // The keys' maker administers the project (a key acts for its maker, cut to what they hold).
  await call('/access', { method: 'POST', body: JSON.stringify({ email: 'admin@test.io', roleId: 'admin' }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('agent keys, identities and the audit history, in the real ProjectDO', () => {
  let engine: Awaited<ReturnType<typeof connect>>
  let key = '', keyId = ''

  it('an admin makes a key: shown once, kept only as its hash, refused without a capability', async () => {
    engine = await connect({ role: 'code-engine', key: 'engine-key', instanceId: 'i1', epoch: 1 })
    await engine.until((m) => m.payload?.t === 'welcome')
    expect((await call('/agent-keys?by=admin@test.io', { method: 'POST', body: JSON.stringify({ name: 'ci bot', capabilities: [], by: 'admin@test.io' }) })).body.error).toBe('a key needs at least one capability')
    expect((await call('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'ci bot', capabilities: ['nope'], by: 'admin@test.io' }) })).body.error).toBe('a key cannot be given what its maker does not hold: nope')
    const made = await call('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'ci bot', capabilities: ['project.view'], by: 'admin@test.io' }) })
    expect(made.status).toBe(201)
    key = made.body.key; keyId = made.body.record.id
    expect(key).toMatch(new RegExp(`^sak_${PID}_[A-Za-z0-9_-]{43}$`))
    const listed = (await call('/agent-keys')).body.keys
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(key)          // never shown again
    expect(listed[0]).toMatchObject({ id: keyId, name: 'ci bot', capabilities: ['project.view'], made_by_key: null, created_by: 'admin@test.io', revoked_at: null })
  })

  it('a bad key is refused at hello; a good one reaches the engine with what it holds, stamped agent:<keyId>', async () => {
    const bad = await connect({ role: 'agent', key: `sak_${PID}_${'x'.repeat(43)}` })
    expect((await bad.closedWith())?.code).toBe(4001)
    const agent = await connect({ role: 'agent', key })
    await agent.until((m) => m.payload?.t === 'welcome')
    agent.send({ to: { type: 'code-engine' }, payload: { t: 'session:agents', reqId: 'r1' } })
    const atEngine = await engine.until((m) => m.payload?.reqId === 'r1')
    expect(atEngine.from).toMatchObject({ type: 'agent', userId: `agent:${keyId}` })
    // beyond what it holds: refused by the hub, never forwarded
    agent.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: 'what is revenue?', reqId: 'r2' } })
    const refused = await agent.until((m) => m.payload?.reqId === 'r2')
    expect(refused.payload.reason).toBe('analyse needs project.ask, which this key does not hold (or its maker no longer holds)')
    await new Promise((r) => setTimeout(r, 150))
    expect(engine.got.some((m) => m.payload?.reqId === 'r2')).toBe(false)
    // revoked: its open connection ends now
    expect((await call(`/agent-keys/${keyId}?by=admin@test.io`, { method: 'DELETE' })).body.key.revoked_by).toBe('admin@test.io')
    expect((await agent.closedWith())?.code).toBe(4001)
    const again = await connect({ role: 'agent', key })
    expect((await again.closedWith())?.reason).toBe('Invalid agent key: the key was revoked')
  })

  it("a person's messages carry their user id to the engine, and their question is in the history", async () => {
    const person = await connect({ role: 'runtime', token: jwt({ userId: 'user_42', email: 'ana@test.io', role: 'superadmin' }) })
    await person.until((m) => m.payload?.t === 'welcome')
    person.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: 'Which trips are unsettled?', sessionId: 's9', questionId: 'q1' } })
    const atEngine = await engine.until((m) => m.payload?.questionId === 'q1')
    expect(atEngine.from).toMatchObject({ type: 'runtime', userId: 'user_42' })
  })

  it('an agent over HTTP goes the same way as over its socket: scoped, audited, answered (the graph, by the platform)', async () => {
    const made = await call('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'http bot', capabilities: ['project.view', 'project.ask'], by: 'admin@test.io' }) })
    const httpKey = made.body.key
    const post = async (payload: any) => { const r = await mf.dispatchFetch('http://x/do/agent-call', { method: 'POST', headers: { authorization: `Bearer ${httpKey}` }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json() as any } }
    const made1 = await post({ t: 'graph:concept', name: 'http-note', body: { title: 'Note', form: 'text', text: 'made over HTTP' } })
    expect(made1.status).toBe(200)
    expect(made1.body).toMatchObject({ t: 'graph:reply', changed: true })
    expect(made1.body.node.owner).toBe(`agent:${made.body.record.id}`)   // as the key
    expect(made1.body.node.scope).toBe(`user:${made.body.record.id}`)    // an agent never publishes by itself
    expect((await post({ t: 'graph:names', kind: 'concept' })).body.names.map((n: any) => n.name)).toContain('http-note')
    const scoped = await mf.dispatchFetch('http://x/do/agent-call', { method: 'POST', headers: { authorization: `Bearer ${httpKey}` }, body: JSON.stringify({ t: 'term:attach' }) })
    expect(scoped.status).toBe(403)
    expect(((await scoped.json()) as any).reason).toBe('term:attach needs project.manage, which this key does not hold (or its maker no longer holds)')
    const bad = await mf.dispatchFetch('http://x/do/agent-call', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: JSON.stringify({ t: 'graph:domains' }) })
    expect(bad.status).toBe(401)
  })

  it('groups: the hub stamps the groups a sender is in on every message, read each time', async () => {
    const made = await call('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'grouped', capabilities: ['project.view', 'project.ask'], by: 'admin@test.io' }) })
    expect((await call('/groups', { method: 'POST', body: JSON.stringify({ name: 'finance', by: 'admin@test.io' }) })).status).toBe(201)
    expect((await call('/groups', { method: 'POST', body: JSON.stringify({ name: 'Bad Name', by: 'admin@test.io' }) })).body.error).toMatch(/lower-case/)
    const agent = await connect({ role: 'agent', key: made.body.key })
    await agent.until((m) => m.payload?.t === 'welcome')
    // what it sees with: its own scope, then its groups' too — a node of the group shows only once it is in it
    const root = await connect({ role: 'runtime', token: jwt({ userId: 'root', email: 'root@test.io', role: 'superadmin' }) })
    await root.until((m) => m.payload?.t === 'welcome')
    root.send({ to: { type: 'code-engine' }, payload: { t: 'graph:concept', name: 'finance-only', body: { title: 'F', form: 'text', text: 'for finance' }, scope: 'group:finance', reqId: 'r1' } })
    expect((await root.until((m) => m.payload?.reqId === 'r1')).payload.node.scope).toBe('group:finance')
    const sees = async (reqId: string) => { agent.send({ to: { type: 'code-engine' }, payload: { t: 'graph:names', kind: 'concept', reqId } }); return (await agent.until((m) => m.payload?.reqId === reqId)).payload.names.map((n: any) => n.name) }
    expect(await sees('g1')).not.toContain('finance-only')
    await call('/groups/finance/members', { method: 'POST', body: JSON.stringify({ member: `agent:${made.body.record.id}`, by: 'admin@test.io' }) })
    expect(await sees('g2')).toContain('finance-only')
    const groups = (await call('/groups')).body.groups
    expect(groups).toEqual([expect.objectContaining({ name: 'finance', members: [`agent:${made.body.record.id}`] })])
  })

  it('the hub tells the engine who administers the project', async () => {
    const admin = await connect({ role: 'runtime', token: jwt({ userId: 'root', email: 'root@test.io', role: 'superadmin' }) })
    await admin.until((m) => m.payload?.t === 'welcome')
    admin.send({ to: { type: 'code-engine' }, payload: { t: 'session:agents', reqId: 'adm' } })
    expect((await engine.until((m) => m.payload?.reqId === 'adm')).from).toMatchObject({ type: 'runtime', userId: 'root', admin: true, scopes: ['user:root'] })
  })

  it('every message the engine or the platform answers names what it needs (none falls to the default)', () => {
    const unnamed = [...SESSION_MESSAGES, ...GRAPH_MESSAGES, ...PROGRAM_MESSAGES, ...HUB_MESSAGES].filter((t) => !(t in MESSAGE_NEEDS))
    expect(unnamed).toEqual([])
    expect([...GRAPH_MESSAGES].every((t) => (HUB_MESSAGES as readonly string[]).includes(t))).toBe(true)   // the graph: answered by the platform
  })

  it('a key makes keys below it, never more than it holds; revoking it takes its keys with it', async () => {
    const parent = await call('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'builder', capabilities: ['project.view', 'project.ask', 'project.keys'], by: 'admin@test.io' }) })
    const pid = parent.body.record.id
    // the worker sends a key's call as its person, with what the key holds and which key it is
    const asKey = { 'x-sa-actor': JSON.stringify({ kind: 'agent', id: `agent:${pid}`, email: 'admin@test.io' }), 'x-sa-caps': JSON.stringify(['project.view', 'project.ask', 'project.keys']), 'x-sa-key': pid }
    expect((await call('/agent-keys', { method: 'POST', headers: asKey, body: JSON.stringify({ name: 'child', capabilities: ['project.manage'] }) })).body.error).toBe('a key cannot be given what its maker does not hold: project.manage')
    const child = await call('/agent-keys', { method: 'POST', headers: asKey, body: JSON.stringify({ name: 'child', capabilities: ['project.view'] }) })
    expect(child.status).toBe(201)
    expect(child.body.record).toMatchObject({ created_by: 'admin@test.io', made_by_key: pid, capabilities: ['project.view'] })
    const access = async (k: string) => (await call('/key-access', { method: 'POST', body: JSON.stringify({ key: k }) })).body
    expect(await access(child.body.key)).toMatchObject({ ok: true, maker: 'admin@test.io', caps: ['project.view'] })
    const agent = await connect({ role: 'agent', key: child.body.key })
    await agent.until((m) => m.payload?.t === 'welcome')
    expect((await call(`/agent-keys/${pid}?by=admin@test.io`, { method: 'DELETE' })).status).toBe(200)
    expect((await agent.closedWith())?.code).toBe(4001)                                   // its child's connection ends too
    expect(await access(child.body.key)).toMatchObject({ ok: false, reason: 'the key that made it is no longer in force' })
    expect((await (await connect({ role: 'agent', key: child.body.key })).closedWith())?.reason).toBe('Invalid agent key: the key that made it is no longer in force')
  })

  it('the audit history has it all, newest first; a malformed event is refused', async () => {
    const events = (await call('/audit?limit=50')).body.events
    const line = (e: any) => `${e.actor.kind}:${e.actor.id.startsWith('agent:') ? 'agent' : e.actor.id.startsWith('key:') ? 'badkey' : e.actor.id} ${e.via} ${e.action} ${e.outcome}`
    expect(events.map(line).reverse().slice(0, 10)).toEqual([
      // the project set up and the keys' maker given the admin role: the platform's own calls, which succeeded — not kept
      'system:platform system api.post refused',              // a key with no capability, refused
      'system:platform system api.post refused',              // a key with an unknown capability, refused
      'user:admin@test.io admin agent-key.create ok',
      'agent:badkey agent agent.connect refused',
      'agent:agent agent agent.connect ok',
      'agent:agent agent message.session-agents ok',
      'agent:agent agent question.ask refused',
      'user:admin@test.io admin agent-key.revoke ok',
      'agent:badkey agent agent.connect refused',
      'user:user_42 ui question.ask ok',
    ])
    const asked = events.find((e: any) => e.action === 'question.ask' && e.outcome === 'ok')
    expect(asked).toMatchObject({ actor: { email: 'ana@test.io' }, target: 's9', detail: { question: 'Which trips are unsettled?', session: 's9', qid: 'q1' } })
    expect(events.find((e: any) => e.outcome === 'refused' && e.action === 'question.ask').detail.reason).toMatch(/analyse needs project.ask/)
    // append-only, by the database itself
    const r = await call('/audit', { method: 'POST', body: JSON.stringify({ action: 'Bad Action', by: 'x' }) })
    expect(r.status).toBe(400)
  })
})
