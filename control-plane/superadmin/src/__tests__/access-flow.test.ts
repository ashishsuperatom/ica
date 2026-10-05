// Data access per reader, end to end through the REAL ProjectDO (Miniflare): an admin writes a row policy naming an
// attribute; an agent's session reads through the engine's real session seam, and the query reaching the datasource
// manager carries exactly that agent's resolved policy; changing the attribute reaches the engine at once (no stale
// cache); removing it denies the table (fail closed); every change is in the audit history.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProgram, ProgramStore } from '../../../../vm/packages/programs/src/index.ts'
import { createSessionSeam } from '../../../../vm/apps/engine/session-seam.ts'
import { createAccess } from '../../../../vm/apps/engine/access.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const harness = `
export { ProjectDO } from '../project-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return stub.fetch(req)
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
const home = mkdtempSync(join(here, '.home-'))
let mf: Miniflare, data: Server
const seen: any[] = []
const call = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x/do${path}`, init); return { status: r.status, body: await r.json() as any } }

async function socket(hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!
  const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', ...hello }))
  const until = async (pred: (m: any) => boolean, ms = 6000) => {
    const t = Date.now()
    for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error(`nothing matched; got ${JSON.stringify(got.map((x) => x.payload?.t))}`); await new Promise((r) => setTimeout(r, 20)) }
  }
  await until((m) => m.payload?.t === 'welcome')
  let n = 0
  const ask = async (payload: any) => { const reqId = `q${++n}-${Math.random()}`; ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { ...payload, reqId } })); return (await until((m) => m.payload?.reqId === reqId)).payload }
  return { ws, got, until, ask }
}

beforeAll(async () => {
  data = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)).on('end', () => { seen.push(JSON.parse(b)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rows: [{ trip_no: 'T1', balance: 2 }] })) }) })
  await new Promise<void>((r) => data.listen(0, '127.0.0.1', () => r()))
  buildProgram(fileURLToPath(new URL('../../../../vm/packages/programs/test/fixtures/unsettled-trips', import.meta.url)), new ProgramStore(join(home, 'programs', 'store')))
  mkdirSync(join(home, 'agents'))
  writeFileSync(join(home, 'agents', 'trips.json'), JSON.stringify({ id: 'trips', name: 'Trips', scope: 'global', owner: 'user:b', domain: 'd', programs: ['unsettled-trips'], tools: [], ui: { start: 's' }, ica: 'composer' }))
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x' } })
  await call('/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  await call('/access', { method: 'POST', body: JSON.stringify({ email: 'admin@test.io', roleId: 'admin' }) })   // the keys' maker administers the project
  const engine = await socket({ role: 'code-engine', key: 'ek', instanceId: 'e', epoch: 1 })
  const access = createAccess({ send: (m) => { engine.ws.send(JSON.stringify(m)); return true } })
  const seam = createSessionSeam({ projectDir: home, datasource: `http://127.0.0.1:${(data.address() as any).port}`, access, send: (to, msg) => engine.ws.send(JSON.stringify({ to: { id: to.id, type: to.type }, payload: msg })) })
  engine.ws.addEventListener('message', (e: any) => {
    const m = JSON.parse(String(e.data)); const t = m.payload?.t
    if (t === 'access:resolved' || t === 'access:changed') access.onMessage(m.payload)
    else if (typeof t === 'string' && t.startsWith('session:')) void seam.handle(m.payload, m.from)
  })
}, 60_000)
afterAll(async () => { data?.close(); await mf?.dispose(); rmSync(home, { recursive: true, force: true }) })

describe('data access per reader', () => {
  let agent: Awaited<ReturnType<typeof socket>>, keyId = ''
  it('a policy and an attribute reach the query the agent\'s program sends', async () => {
    const made = await call('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'reader', scopes: ['sessions'], by: 'admin@test.io' }) })
    keyId = made.body.record.id
    expect((await call('/access-policies', { method: 'POST', body: JSON.stringify({ applies_to: `agent:${keyId}`, source: 'TRIPS', table: 'trips', kind: 'row', predicate: '{t}.branch IN {attr.branches}', by: 'admin@test.io' }) })).status).toBe(201)
    expect((await call('/access-policies', { method: 'POST', body: JSON.stringify({ applies_to: 'everyone', source: 'TRIPS', table: 'trips', kind: 'row', predicate: 'branch = 1', by: 'admin@test.io' }) })).body.error).toMatch(/names the table as \{t\}/)
    expect((await call('/access-attributes', { method: 'PUT', body: JSON.stringify({ subject: `agent:${keyId}`, key: 'branches', value: ['HYDERABAD'], by: 'admin@test.io' }) })).status).toBe(200)
    agent = await socket({ role: 'agent', key: made.body.key })
    await agent.ask({ t: 'session:open', session: 'a1', agent: 'trips' })
    await agent.ask({ t: 'session:intent', session: 'a1', call: { package: 'trips', fn: 'run' }, to: 'current' })
    expect(seen.at(-1).policies).toEqual([{ table: 'trips', predicate: "{t}.branch IN ('HYDERABAD')" }])
  })

  it('a changed attribute reaches the engine at once — nothing stale is applied', async () => {
    await call('/access-attributes', { method: 'PUT', body: JSON.stringify({ subject: `agent:${keyId}`, key: 'branches', value: ['PUNE', "O'HARE"], by: 'admin@test.io' }) })
    await new Promise((r) => setTimeout(r, 150))
    await agent.ask({ t: 'session:intent', session: 'a1', call: { package: 'trips', fn: 'run' }, to: 'current' })
    expect(seen.at(-1).policies).toEqual([{ table: 'trips', predicate: "{t}.branch IN ('PUNE', 'O''HARE')" }])
  })

  it('without the attribute the policy denies the table (fail closed); the history has every change', async () => {
    await call('/access-attributes', { method: 'PUT', body: JSON.stringify({ subject: `agent:${keyId}`, key: 'branches', value: null, by: 'admin@test.io' }) })
    await new Promise((r) => setTimeout(r, 150))
    await agent.ask({ t: 'session:intent', session: 'a1', call: { package: 'trips', fn: 'run' }, to: 'current' })
    expect(seen.at(-1).policies).toEqual([{ table: 'trips', deny: true }])
    const actions = (await call('/audit?limit=100')).body.events.map((e: any) => e.action)
    expect(actions.filter((a: string) => a.startsWith('access-'))).toEqual(['access-attribute.set', 'access-attribute.set', 'access-attribute.set', 'access-policy.create'])
  })
})
