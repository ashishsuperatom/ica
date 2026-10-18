// The decision memory in the REAL Durable Objects (Miniflare): each intent in a session becomes an experience (the step's
// cues and world, the path taken); a decision state is made only through a named operation, from those experiences; a
// later step in the same situation is recognised — learned · similar, with its paths and their record — and when the
// world has moved, learned · changed; an outcome is recorded; nothing is erased, and the state reads as of any moment.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const SECRET = 's3cret'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export { WorldModelDO } from '../world-model-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  if (u.pathname.startsWith('/decision/')) { const fwd = new Request('http://do' + u.pathname.slice(9) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return env.WORLD_MODEL.get(env.WORLD_MODEL.idFromName('dec:${PID}')).fetch(fwd) }
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
const post = (path: string, body: unknown) => at(path, { method: 'POST', body: JSON.stringify(body) })

/** A session where a person looked at the overruns (the world: overrun = n) and flagged them to the PMO. */
async function sessionWith(id: string, overrun: number) {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 5, 10, 0, s)).toISOString()
  const state = { packages: { pmo: 'sha:1' }, pmo: { view: 'overruns', pillar: 'Retail' }, agent: { question: 'which projects are over budget' } }
  const entries = [
    { t: 'open', at: t(0), session: id, user: 'user:u1', agent: 'portfolio' },
    { t: 'block', at: t(1), id: 'b1', parent: null, state, stateHash: 'h1', intent: null },
    { t: 'answer', at: t(2), answer: { id: 'a1', session: id, block: 'b1', cause: 'i0', stateHash: 'h1', at: t(2), markdown: 'overruns', files: [], blocks: { k: { type: 'kpis', items: [{ label: 'overrun', value: overrun }] } } } },
    { t: 'intent', at: t(3), intent: { id: 'i1', session: id, kind: 'structured', call: { package: 'pmo', fn: 'flag' }, to: 'new', block: 'b1', by: 'user:u1', at: t(3) } },
    { t: 'block', at: t(3), id: 'b2', parent: 'b1', state, stateHash: 'h2', intent: 'i1' },
  ]
  // As the engine sends it: through the hub, kept in the session owner's UserDO.
  engine.send(JSON.stringify({ type: 'session:sync', session: id, from: 0, entries }))
  for (let i = 0; i < 200; i++) { const m = engineGot.find((x) => x.payload?.t === 'session:synced' && x.payload.session === id); if (m) { expect(m.payload.upto).toBe(entries.length); return } await new Promise((r) => setTimeout(r, 20)) }
  throw new Error(`session ${id} never synced`)
}
let engine: WebSocket
const engineGot: any[] = []

async function socket(token: string) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}?token=${token}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!; const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'runtime', token }))
  const until = async (pred: (m: any) => boolean) => { for (let i = 0; i < 200; i++) { const m = got.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 20)) } throw new Error(`nothing matched: ${JSON.stringify(got.map((x) => x.payload?.t))}`) }
  await until((m) => m.payload?.t === 'welcome')
  let n = 0
  const ask = async (payload: Record<string, unknown>) => { const reqId = `r${++n}`; ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { ...payload, reqId } })); return (await until((m) => m.payload?.reqId === reqId)).payload }
  return { ws, ask }
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true }, WORLD_MODEL: { className: 'WorldModelDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await at('/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  engine = r.webSocket! as unknown as WebSocket
  engine.addEventListener('message', (e: any) => engineGot.push(JSON.parse(String(e.data)))); (engine as any).accept()
  engine.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: 'ek', instanceId: 'e', epoch: 1 }))
  for (let i = 0; i < 200 && !engineGot.some((m) => m.payload?.t === 'welcome'); i++) await new Promise((r) => setTimeout(r, 20))
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('decision memory', () => {
  let exps: any[] = []
  it('each intent in a session is an experience: the step\'s cues and world, the path taken', async () => {
    await sessionWith('s-1', 11)
    await sessionWith('s-2', 13)
    exps = (await at('/decision/experiences')).body.experiences
    expect(exps).toHaveLength(2)
    const e = exps.find((x: any) => x.session === 's-1')
    expect(e).toMatchObject({ block: 'b1', agent: 'portfolio', scope: 'user:u1', world: { overrun: 11 }, taken: { label: 'ran pmo.flag' }, recognised: null })
    expect(e.cues).toEqual(expect.arrayContaining(['portfolio', 'projects over budget', 'pillar retail', 'view overruns']))
  })

  it('a decision state is made only through a named operation, from experiences; refusals say why', async () => {
    const op = { op: 'create', id: 'overruns', scope: 'global', supports: exps.map((e) => e.id), body: {
      title: 'Projects over budget', description: 'A portfolio review of projects running over budget',
      cues: ['projects over budget', 'view overruns', 'portfolio'],
      paths: [{ id: 'flag', label: 'Flag them to the PMO', reasoning: 'overruns go to the PMO for a recovery plan', intent: { call: { package: 'pmo', fn: 'flag' } } },
              { id: 'pillar', label: 'See them by pillar', reasoning: 'where the overrun sits decides who acts', intent: { ops: [{ op: 'set', path: 'pmo.by', value: 'pillar' }] } }] } }
    expect((await post('/decision/change', { op, by: 'learner', why: 'two reviews took the same path' })).body.written).toEqual([{ id: 'overruns', version: 1 }])
    expect((await post('/decision/change', { op, by: 'learner', why: 'again' })).body.error).toMatch(/already exists/)
    expect((await post('/decision/change', { op: { op: 'reinforce', id: 'nope', supports: ['x'] }, by: 'l', why: 'w' })).body.error).toMatch(/no decision state nope/)
    const st = (await at('/decision/state/overruns')).body.state
    expect(st.body.seen.overrun).toEqual({ min: 11, max: 13, n: 2 })
  })

  it('a later step in the same situation: learned · similar, its paths with their record — over the hub, for the session\'s owner', async () => {
    await sessionWith('s-3', 12)   // recorded as recognised now: its flag counts toward the record
    const u1 = await socket(jwt({ userId: 'u1', email: 'u1@x.io', role: 'superadmin' }))
    const r = await u1.ask({ t: 'decision:paths', session: 's-3', block: 'b1' })
    expect(r.reason ?? r.t).toBe('decision:paths')
    expect(r.mode).toBe('learned-similar')
    expect(r.matches[0]).toMatchObject({ id: 'overruns', title: 'Projects over budget' })
    expect(r.matches[0].paths[0]).toMatchObject({ id: 'flag', record: { taken: 1 } })
    u1.ws.close()
  })

  it('when the world has moved, learned · changed — with what moved', async () => {
    await sessionWith('s-4', 40)
    const u1 = await socket(jwt({ userId: 'u1', email: 'u1@x.io', role: 'superadmin' }))
    const r = await u1.ask({ t: 'decision:paths', session: 's-4', block: 'b1' })
    expect(r.mode).toBe('learned-changed')
    expect(r.why).toMatch(/overrun seen 11–13, now 40/)
    // an outcome: the person records how the step turned out
    expect((await u1.ask({ t: 'decision:outcome', session: 's-3', block: 'b1', outcome: 'succeeded' })).ok).toBe(true)
    u1.ws.close()
  })

  it('a decision recorded is an artifact — what was decided, why, what it rested on — in the register, and the outcome of the steps that led to it', async () => {
    const u1 = await socket(jwt({ userId: 'u1', email: 'u1@x.io', role: 'superadmin' }))
    expect((await u1.ask({ t: 'artifact:record', session: 's-1', block: 'b1', kind: 'decision', body: { decision: 'Flag the overruns to the PMO' } })).reason).toMatch(/says why/)
    const rec = await u1.ask({ t: 'artifact:record', session: 's-1', block: 'b1', kind: 'decision', approval: true,
      body: { decision: 'Flag the overruns to the PMO', options: [{ label: 'Flag' }, { label: 'Wait a month' }], chosen: 'Flag', reasoning: 'two months over budget' } })
    expect(rec.t).toBe('artifact:recorded')
    expect(rec.artifact).toMatchObject({ kind: 'decision', status: 'pending', version: 1, block: 'b1', body: { restsOn: { block: 'b1', world: { overrun: 11 } } } })
    expect((await u1.ask({ t: 'artifact:list', session: 's-1' })).artifacts.map((a: any) => a.title)).toEqual(['Flag the overruns to the PMO'])
    // it waits in the project's Attention, as an approval with where it is
    const att = (await at('/do/attention')).body.items
    expect(att).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'approval', state: 'attention', title: 'Approve: Flag the overruns to the PMO', session: 's-1', artifact: rec.artifact.id })]))
    expect(att.some((x: any) => x.kind === 'engine')).toBe(false)   // the engine that sent the sessions is connected
    const approved = await u1.ask({ t: 'artifact:decide', session: 's-1', id: rec.artifact.id, status: 'approved', note: 'agreed' })   // a superadmin may
    expect(approved.artifact).toMatchObject({ status: 'approved', version: 2, body: { approvals: [{ status: 'approved', note: 'agreed' }] } })
    expect((await u1.ask({ t: 'artifact:get', session: 's-1', id: rec.artifact.id })).versions.map((v: any) => v.status)).toEqual(['pending', 'approved'])
    const reg = await u1.ask({ t: 'decision:register' })
    expect(reg.decisions).toEqual([expect.objectContaining({ session: 's-1', title: 'Flag the overruns to the PMO', status: 'approved', version: 2, agent: 'portfolio' })])
    expect((await at('/do/attention')).body.items.some((i: any) => i.kind === 'approval')).toBe(false)   // decided: no longer waiting
    // the decision memory heard how the step turned out
    const e = (await at('/decision/experiences?session=s-1')).body.experiences[0]
    expect(e.outcomes.map((o: any) => o.outcome)).toEqual(['succeeded'])
    u1.ws.close()
  })

  it('the states read as of any moment; nothing is erased', async () => {
    const before = new Date().toISOString()
    await new Promise((r) => setTimeout(r, 10))
    await post('/decision/change', { op: { op: 'invalidate', id: 'overruns' }, by: 'admin', why: 'the PMO process changed' })
    expect((await at('/decision/states')).body.states).toHaveLength(0)
    expect((await at(`/decision/states?asOf=${encodeURIComponent(before)}`)).body.states.map((s: any) => s.id)).toEqual(['overruns'])
    expect((await at('/decision/state/overruns')).body.versions.map((v: any) => v.op)).toEqual(['create', 'invalidate'])
  })

  it('the first learner: a step people reached again and again becomes a decision state of the paths they took, through the named operations', async () => {
    const r = await post('/decision/learn', {})
    expect(r.body.written).toEqual([expect.objectContaining({ op: 'create', version: 1 })])
    const id = r.body.written[0].id
    const st = (await at(`/decision/state/${encodeURIComponent(id)}`)).body.state
    expect(st.body.paths[0]).toMatchObject({ label: 'Ran pmo.flag', reasoning: 'taken 4 of 4 times from here', intent: { call: { package: 'pmo', fn: 'flag' } } })
    expect(st.supports).toHaveLength(4)
    expect((await post('/decision/learn', {})).body.written).toEqual([])   // nothing new: nothing written
    const u1 = await socket(jwt({ userId: 'u1', email: 'u1@x.io', role: 'superadmin' }))
    expect((await u1.ask({ t: 'decision:paths', session: 's-3', block: 'b1' })).matches.map((m: any) => m.id)).toContain(id)
    u1.ws.close()
  })

  it('the world model journal: every model\'s entries appended all or none, in order, read on from a cursor and by model — never changed', async () => {
    const e = (model: string, kind: string, data: unknown, who?: string) => ({ at: Date.now(), model, kind, data, ...(who ? { who } : {}) })
    const first = await post('/decision/records', { entries: [e('approvals', 'decision', { decisionId: 'd1' }, 'user:ana'), e('awards', 'decision', { decisionId: 'd2' })] })
    expect(first.status).toBe(200)
    const second = await post('/decision/records', { entries: [e('approvals', 'outcome', { decisionId: 'd1', outcome: true })] })
    expect(second.body.last).toBe(first.body.last + 1)
    const all = (await at('/decision/records?since=0')).body
    expect(all.entries.slice(-3).map((x: any) => [x.model, x.kind])).toEqual([['approvals', 'decision'], ['awards', 'decision'], ['approvals', 'outcome']])
    expect(all.entries.slice(-3)[0].who).toBe('user:ana')
    const page = (await at(`/decision/records?since=${first.body.last - 2}&limit=1`)).body
    expect(page.entries.length).toBe(1)
    expect((await at(`/decision/records?since=${page.next}`)).body.entries.length).toBe(2)
    const own = (await at('/decision/records?since=0&model=awards')).body.entries
    expect(own.every((x: any) => x.model === 'awards')).toBe(true)
    // all or none: one bad entry stores nothing
    const before = (await at('/decision/records?since=0')).body.entries.length
    expect((await post('/decision/records', { entries: [e('approvals', 'decision', {}), { model: 'approvals' }] })).status).toBe(400)
    expect((await at('/decision/records?since=0')).body.entries.length).toBe(before)
  })


  it('the engine appends to the journal and reads it back over the hub; a person cannot', async () => {
    const reply = async (msg: Record<string, unknown>) => {
      const reqId = `w${Math.random()}`
      engine.send(JSON.stringify({ ...msg, reqId }))
      for (let i = 0; i < 200; i++) { const m = engineGot.find((x) => x.payload?.reqId === reqId); if (m) return m.payload; await new Promise((r) => setTimeout(r, 20)) }
      throw new Error('no reply')
    }
    const appended = await reply({ type: 'world:append', entries: [{ at: Date.now(), model: 'paths', kind: 'decision', data: { decisionId: 'h1' } }] })
    expect(appended.t).toBe('world:appended')
    const read = await reply({ type: 'world:read', since: appended.last - 1, model: 'paths' })
    expect(read).toMatchObject({ t: 'world:entries', next: appended.last })
    expect(read.entries[0]).toMatchObject({ seq: appended.last, model: 'paths', kind: 'decision', data: { decisionId: 'h1' } })
    expect((await reply({ type: 'world:append', entries: [] })).t).toBe('world:refused')
    // a person's socket: the message is not the engine's, so nothing is written
    const before = (await at('/decision/records?since=0')).body.entries.length
    const ana = await socket(jwt({ userId: 'u2', email: 'u2@x.io', role: 'superadmin' }))
    ana.ws.send(JSON.stringify({ type: 'world:append', reqId: 'x', entries: [{ at: Date.now(), model: 'paths', kind: 'decision', data: {} }] }))
    await new Promise((r) => setTimeout(r, 300))
    expect((await at('/decision/records?since=0')).body.entries.length).toBe(before)
    ana.ws.close()
  })

})
