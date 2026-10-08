// The composition graph, held by the platform, through the REAL ProjectDO (Miniflare): people and agents read and change
// it over the hub (governed: owners change, others suggest, owners decide, scopes hide); an engine's replica pulls what
// changed when told, never writes, and is rebuilt when it disagrees; a node an engine generates for a person (an agent
// made from a session) is written by the platform, as them; the console's views are answered by the platform.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createGraphReplica } from '../../../../vm/apps/engine/graph-replica.ts'
import { openStore, compose } from '../../../../vm/packages/composition-graph/src/node.ts'

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
const root = mkdtempSync(join(here, '.home-'))
let mf: Miniflare
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}

async function socket(hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}${hello.token ? `?token=${hello.token}` : ''}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!
  const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', ...hello }))
  const until = async (pred: (m: any) => boolean, ms = 8000) => {
    const t = Date.now()
    for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error(`nothing matched; got ${JSON.stringify(got.map((x) => x.payload?.t))}`); await new Promise((r) => setTimeout(r, 20)) }
  }
  await until((m) => m.payload?.t === 'welcome')
  let n = 0
  const ask = async (payload: any) => { const reqId = `q${++n}-${Math.random()}`; ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { ...payload, reqId } })); return (await until((m) => m.payload?.reqId === reqId)).payload }
  return { ws, got, until, ask }
}

/** An engine: the real graph replica behind one hub connection, its own file. */
async function engine(name: string, epoch: number) {
  const file = join(root, name, 'composition.sqlite')
  const ws = await socket({ role: 'code-engine', key: 'ek', instanceId: name, epoch })
  const logs: string[] = []
  const replica = createGraphReplica({ file, send: (m) => { ws.ws.send(JSON.stringify(m)); return true }, log: (s) => logs.push(s) })
  ws.ws.addEventListener('message', (e: any) => { const m = JSON.parse(String(e.data)); if (String(m.payload?.t ?? '').startsWith('graph:')) replica.onMessage(m.payload) })
  replica.welcome()
  return { ws, replica, file, logs }
}
const settle = () => new Promise((r) => setTimeout(r, 500))

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  await mf.dispatchFetch('http://x/do/access', { method: 'POST', body: JSON.stringify({ email: 'admin@test.io', roleId: 'admin' }) })
  await mf.dispatchFetch('http://x/do/access', { method: 'POST', body: JSON.stringify({ email: 'ana@test.io', roleId: 'member' }) })
}, 60_000)
afterAll(async () => { await mf?.dispose(); rmSync(root, { recursive: true, force: true }) })

const concept = (text: string) => ({ title: 'Settlement', form: 'text', text })

describe('the composition graph, held by the platform', () => {
  let bot: Awaited<ReturnType<typeof socket>>, admin: Awaited<ReturnType<typeof socket>>, ana: Awaited<ReturnType<typeof socket>>
  let a: Awaited<ReturnType<typeof engine>>

  it('an agent makes a concept and a domain and joins them — answered by the platform with no engine connected', async () => {
    const key = (await (await mf.dispatchFetch('http://x/do/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'kb', capabilities: ['project.view', 'project.ask'], by: 'admin@test.io' }) })).json() as any).key
    bot = await socket({ role: 'agent', key })
    expect((await bot.ask({ t: 'graph:concept', name: 'settlement', body: concept('A trip is settled when its settlement document exists.'), reason: 'from the data' })).changed).toBe(true)
    expect((await bot.ask({ t: 'graph:domain', name: 'trips', body: { capabilities: [], concepts: [], files: [] } })).node.scope).toBeTruthy()
    expect((await bot.ask({ t: 'graph:join', domain: 'trips', concept: 'settlement' })).node.body.concepts).toEqual(['settlement'])
    expect((await bot.ask({ t: 'graph:compose', domain: 'trips' })).composition.text).toMatch(/A trip is settled when its settlement document exists\./)
    expect((await bot.ask({ t: 'graph:history', name: 'settlement' })).history.map((c: any) => c.reason)).toEqual(['from the data'])
  })

  it('a person suggests, the owner decides; a person does not change what is not theirs; refusals are sentences', async () => {
    admin = await socket({ role: 'runtime', token: jwt({ userId: 'root', email: 'admin@test.io', role: 'user' }) })
    ana = await socket({ role: 'runtime', token: jwt({ userId: 'ana', email: 'ana@test.io', role: 'user' }) })
    const mine = await ana.ask({ t: 'graph:concept', name: 'settlement', body: concept('mine now') })
    expect(mine.t === 'graph:refused' || mine.t === 'error').toBe(true)
    const verdict = await admin.ask({ t: 'graph:decide', id: 99, verdict: 'approved' })
    expect(verdict.reason).toBe('there is no suggestion 99')
    expect((await admin.ask({ t: 'graph:show', name: 'x', asOf: 'yesterday' })).reason).toBe('"yesterday" is not a time')
  })

  it('every project has a default agent from its start: the platform\'s general domain, recorded as the platform\'s change', async () => {
    const general = (await admin.ask({ t: 'graph:show', name: 'general' })).node
    expect(general.body).toMatchObject({ fallback: true, tools: ['sources', 'find-schema', 'get-schema', 'query'], concepts: ['general/answering'] })
    const history = (await admin.ask({ t: 'graph:history', name: 'general' })).history
    expect(history.map((c: any) => [c.by, c.reason])).toEqual([['platform', 'every project has a default agent, for questions no other agent covers']])
    expect((await admin.ask({ t: 'graph:compose', domain: 'general' })).composition.text).toMatch(/\{\{sources\}\}[\s\S]*find-schema/)
  })

  it("the console's views come from the platform: the columns, a node, a domain composed", async () => {
    const cols = await admin.ask({ t: 'inspect:req', view: 'compositionColumns' })
    expect(cols.t).toBe('inspect:res')
    expect(cols.domains.map((d: any) => d.name).sort()).toEqual(['general', 'trips'])   // general: the project's default agent
    expect(cols.atomic.map((c: any) => c.name).sort()).toEqual(['general/answering', 'settlement'])
    expect((await admin.ask({ t: 'inspect:req', view: 'compositionNode', name: 'settlement' })).usedBy).toEqual(['trips'])
    expect((await admin.ask({ t: 'inspect:req', view: 'compositionCompose', domain: 'trips' })).text).toMatch(/settlement document/)
  })

  it('an engine connecting later pulls the whole graph into its replica — the same composition', async () => {
    a = await engine('a', 1)
    await settle()
    const s = openStore(a.file)
    expect(compose(s, 'trips').text).toMatch(/A trip is settled when its settlement document exists\./)
    expect(s.history('settlement').map((c) => c.reason)).toEqual(['from the data'])
    s.close()
  })

  it('a change in the platform reaches the replica: the platform tells it, it pulls', async () => {
    await bot.ask({ t: 'graph:concept', name: 'settlement', body: concept('Settled: a settlement document exists for the trip.'), reason: 'clearer' })
    await settle()
    const s = openStore(a.file)
    expect(s.get<any>('settlement')!.body.text).toBe('Settled: a settlement document exists for the trip.')
    s.close()
  })

  it("the console's sessions come from the platform: from the questions recorded, with what changed in the agent since", async () => {
    a.replica.asked({ session: 's-1', question: 'which trips are settled?', domain: 'trips', how: 'routed' })
    await settle()
    let v = await admin.ask({ t: 'inspect:req', view: 'graphSessions' })
    expect(v.t).toBe('inspect:res')
    expect(v.sessions.map((x: any) => [x.id, x.domain, x.asked, x.moved])).toEqual([['s-1', 'trips', 1, []]])
    await settle()   // the change below lands a moment after the session began
    await bot.ask({ t: 'graph:concept', name: 'settlement', body: concept('A trip is settled once its settlement document is filed.'), reason: 'filed, not just exists' })
    v = await admin.ask({ t: 'inspect:req', view: 'graphSessions' })
    expect(v.sessions[0].moved).toContain('settlement')
  })

  it('a replica that holds what the platform does not is set aside and rebuilt from the platform', async () => {
    const s = openStore(a.file)
    s.put('stray', 'concept', concept('written on the engine by hand'), { by: 'someone' })
    s.close()
    a.replica.welcome()
    await settle()
    expect(a.logs.join('\n')).toMatch(/set aside/)
    const r = openStore(a.file)
    expect(r.get('stray')).toBeNull()
    expect(r.get('settlement')).not.toBeNull()
    r.close()
    expect(readdirSync(join(root, 'a')).some((f) => f.includes('.differs-'))).toBe(true)
  })

  it('a replica whose change log drifted without a conflict is found by its fingerprint and rebuilt', async () => {
    a.logs.length = 0
    const s = openStore(a.file)
    s.db.prepare("UPDATE change SET to_hash = 'edited-by-hand' WHERE id = (SELECT MAX(id) FROM change)").run()   // same count, same cursor
    s.close()
    a.replica.welcome()
    await settle(1200)
    expect(a.logs.join('\n')).toMatch(/its change log differs from the platform's/)
    const r = openStore(a.file)
    expect((r.db.prepare("SELECT COUNT(*) AS n FROM change WHERE to_hash = 'edited-by-hand'").get() as any).n).toBe(0)
    r.close()
  })

  it('a node an engine generates for a person is written by the platform, as them, and comes back to the replica', async () => {
    const results = await a.replica.write({ id: 'user:ana', admin: false, email: 'ana@test.io', scopes: ['user:ana'] }, [
      { name: 'ana-notes', kind: 'concept', body: concept('what ana learned'), reason: 'made from session s1', scope: 'user:ana' },
    ])
    expect(results[0].node.owner).toBe('user:ana')
    await settle()
    const s = openStore(a.file)
    expect(s.get('ana-notes')!.scope).toBe('user:ana')
    s.close()
    // governance holds for an engine's writes too: ana cannot change the agent's concept through one
    await expect(a.replica.write({ id: 'user:ana', admin: false, scopes: ['user:ana'] }, [{ name: 'settlement', kind: 'concept', body: concept('x'), reason: 'y' }])).rejects.toThrow(/suggest the change instead/)
  })
  it('a large graph message, sent in parts, is joined and answered by the platform', async () => {
    const whole = JSON.stringify({ t: 'graph:concept', name: 'long-note', body: concept('x'.repeat(5000)), reqId: 'parts1' })
    const half = Math.ceil(whole.length / 2)
    for (const [i, data] of [whole.slice(0, half), whole.slice(half)].entries()) admin.ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'part', id: 'p1', part: i, of: 2, data } }))
    const r = (await admin.until((m) => m.payload?.reqId === 'parts1')).payload
    expect(r.t).toBe('graph:reply')
    expect(r.node.name).toBe('long-note')
  })

})
