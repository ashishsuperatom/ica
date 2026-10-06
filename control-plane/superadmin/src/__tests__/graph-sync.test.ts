// The composition graph kept by the platform, through the REAL ProjectDO (Miniflare): an agent changes the
// graph through one engine and the records reach the platform; a second engine with an empty graph is rebuilt from it —
// the same composition, owners and history — and carries on; a forged record is refused and pushing stops.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createGraphSeam } from '../../../../vm/apps/engine/graph-seam.ts'
import { createGraphSync } from '../../../../vm/apps/engine/graph-sync.ts'
import { Store, compose } from '../../../../vm/packages/composition-graph/src/index.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const harness = `
export { ProjectDO } from '../project-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return stub.fetch(req)
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
const root = mkdtempSync(join(here, '.home-'))
let mf: Miniflare

async function socket(hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
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

/** An engine: the real graph seam and graph sync behind one hub connection, its own graph file. */
async function engine(name: string, epoch: number) {
  const file = join(root, `${name}.sqlite`)
  const ws = await socket({ role: 'code-engine', key: 'ek', instanceId: name, epoch })
  const logs: string[] = []
  const sync = createGraphSync({ file, send: (m) => { ws.ws.send(JSON.stringify(m)); return true }, log: (s) => logs.push(s) })
  const seam = createGraphSeam({ projectDir: root, file, send: (to, msg) => { ws.ws.send(JSON.stringify({ to: { id: to.id, type: to.type }, payload: msg })); if (msg.t === 'graph:reply') sync.push() } })
  ws.ws.addEventListener('message', (e: any) => {
    const m = JSON.parse(String(e.data)); const t = m.payload?.t
    if (t === 'graph:cursor' || t === 'graph:synced' || t === 'graph:batch') sync.onMessage(m.payload)
    else if (typeof t === 'string' && t.startsWith('graph:')) void seam.handle(m.payload, m.from)
  })
  sync.welcome()
  return { ws, sync, file, logs }
}
const settle = () => new Promise((r) => setTimeout(r, 400))
const cursor = async () => (await (await mf.dispatchFetch('http://x/do/noop')).text(), null)

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x' } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  await mf.dispatchFetch('http://x/do/access', { method: 'POST', body: JSON.stringify({ email: 'admin@test.io', roleId: 'admin' }) })   // the keys' maker administers the project
  void cursor
}, 60_000)
afterAll(async () => { await mf?.dispose(); rmSync(root, { recursive: true, force: true }) })

describe('the composition graph kept by the platform', () => {
  let a: Awaited<ReturnType<typeof engine>>, key = ''
  it('changes made through one engine reach the platform', async () => {
    a = await engine('a', 1)
    key = (await (await mf.dispatchFetch('http://x/do/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'kb', scopes: ['graph'], by: 'admin@test.io' }) })).json() as any).key
    const agent = await socket({ role: 'agent', key })
    await agent.ask({ t: 'graph:concept', name: 'settlement', body: { title: 'Settlement', form: 'text', text: 'A trip is settled when its settlement document exists.' }, reason: 'from the data' })
    await agent.ask({ t: 'graph:concept', name: 'ageing', body: { title: 'Ageing', form: 'bullets', items: ['days since the invoice', 'counted from its date'] } })
    await agent.ask({ t: 'graph:domain', name: 'trips', body: { capabilities: [], concepts: ['settlement'], files: [] } })
    await agent.ask({ t: 'graph:join', domain: 'trips', concept: 'ageing' })
    await settle()
    const synced = [...a.ws.got].reverse().find((m) => m.payload?.t === 'graph:synced')
    expect(synced.payload.cursor.change).toBe(4)
  })

  it('an engine with an empty graph is rebuilt from the platform, and carries on', async () => {
    const b = await engine('b', 2)
    await settle()
    expect(b.logs.join('\n')).toMatch(/rebuilt from the platform/)
    const sa = new Store(a.file), sb = new Store(b.file)
    expect(compose(sb, 'trips').text).toBe(compose(sa, 'trips').text)
    expect(sb.names()).toEqual(sa.names())
    expect(sb.history('settlement')).toEqual(sa.history('settlement'))
    expect(sb.get('trips')!.owner).toMatch(/^agent:/)
    sa.close(); sb.close()
    // it carries on: a change made through it reaches the platform after what was there
    const agent = await socket({ role: 'agent', key })
    await agent.ask({ t: 'graph:leave', domain: 'trips', concept: 'ageing' })
    await settle()
    expect([...b.ws.got].reverse().find((m) => m.payload?.t === 'graph:synced').payload.cursor.change).toBe(5)
  })

  it('an engine that fell behind catches up from the platform', async () => {
    // a copy of engine a's graph as it was before the last change, as a restored backup would be
    const behind = new Store(join(root, 'd.sqlite')), sa = new Store(a.file)
    const { applyReplica, replicaSince, START } = await import('../../../../vm/packages/composition-graph/src/index.ts')
    applyReplica(behind, replicaSince(sa, START, 1000))
    behind.close(); sa.close()
    const d = await engine('d', 4)
    await settle()
    expect(d.logs.join('\n')).toMatch(/behind the platform — catching up/)
    const sd = new Store(d.file)
    expect((sd.get('trips')!.body as any).concepts).toEqual(['settlement'])          // the leave made through b arrived
    sd.close()
  })

  it('a record that differs from the platform\'s is refused, and pushing stops', async () => {
    const forged = new Store(join(root, 'c.sqlite'))
    forged.put('settlement', 'concept', { title: 'X', form: 'text', text: 'forged' }, { by: 'user:mallory' })
    forged.close()
    const c = await engine('c', 5)
    await settle()
    expect(c.sync.stopped).toBe(true)
    expect(c.logs.join('\n')).toMatch(/the platform has a different record \(change 1 differs/)
  })
})
