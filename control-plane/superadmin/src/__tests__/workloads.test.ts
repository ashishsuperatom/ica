// Workloads through the REAL ProjectDO (Miniflare), with a stand-in engine on a real socket: what the engine reports is
// kept, a change of state is an event, an unsound report is refused; a connection wanted but not reported reads pending,
// one running another spec reads "not yet taken"; with no engine every workload reads unknown; an action goes to the
// engine and its answer comes back, audited and an event — and only for whoever holds the action's capability; an aspect
// is looked into the same way; a failed workload is in Attention.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { sealKeygen } from '../proxy/seal'
import { PROJECT_ROLES } from '../../../shared/permissions'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-5555555555d1'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const as = (role: 'admin' | 'member' | 'viewer') => async (path: string, method = 'GET', body?: unknown) => {
  const email = `${role}@x.io`
  const r = await mf.dispatchFetch(`http://x/do${path}`, { method, headers: { 'x-sa-actor': JSON.stringify({ kind: 'user', id: email, email }), 'x-sa-caps': JSON.stringify((PROJECT_ROLES as any)[role].capabilities) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() as any }
}
const admin = as('admin'), viewer = as('viewer')
const wait = async (cond: () => boolean, ms = 3000) => { for (let i = 0; i < ms / 20 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)) }

/** A stand-in engine: connected, answering actions and looks as told. */
async function engine(answer: (m: any) => Record<string, unknown> | null) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!; const got: any[] = []
  ws.addEventListener('message', (e: any) => {
    const m = JSON.parse(String(e.data)); got.push(m)
    const p = m.payload
    if (p?.t === 'workload:act' || p?.t === 'workload:inspect') { const a = answer(p); if (a) ws.send(JSON.stringify({ type: p.t === 'workload:act' ? 'workload:acted' : 'workload:inspected', reqId: p.reqId, ...a })) }
  })
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: 'ek', instanceId: `e${Math.random()}`, epoch: Date.now() }))
  await wait(() => got.some((m) => m.payload?.t === 'welcome'))
  return { ws, got, report: (statuses: unknown[], gone?: unknown[]) => ws.send(JSON.stringify({ type: 'workload:status', statuses, ...(gone ? { gone } : {}) })) }
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x', CREDENTIALS_MASTER_KEY: sealKeygen() } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  const made = await admin('/connections', 'POST', { connector: 'duckdb', name: 'SALES', values: { path: 'sales.duckdb' } })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('workloads', () => {
  let e: Awaited<ReturnType<typeof engine>>
  const one = async (key: string) => (await admin('/workloads')).body.workloads.find((w: any) => `${w.kind}/${w.id}` === key)

  it('a connection wanted and not yet reported reads pending', async () => {
    e = await engine((m) => m.action === 'test' ? { note: 'it answers' } : m.action === 'restart' ? { error: 'the bridge would not load: no driver' } : m.aspect === 'cache' ? { data: { entries: 3, bytes: 900 } } : null)
    const w = await one('connection/SALES')
    expect(w.state).toBe('pending'); expect(w.taken).toBe(false); expect(w.wanted).toMatch(/^[0-9a-f]{8}$/)
  })

  it('what the engine reports is kept; a change of state is an event; an unsound report is refused', async () => {
    const wanted = (await one('connection/SALES')).wanted
    e.report([{ kind: 'connection', id: 'SALES', state: 'starting', spec: wanted }, { kind: 'robot', id: 'x', state: 'ready' }])
    await wait(() => false, 200)
    e.report([{ kind: 'connection', id: 'SALES', state: 'ready', spec: wanted, version: 'abc123', health: { queries: 0 } }])
    await wait(() => false, 200)
    const w = await one('connection/SALES')
    expect(w.state).toBe('ready'); expect(w.taken).toBe(true); expect(w.version).toBe('abc123')
    expect((await admin('/workloads')).body.workloads.some((x: any) => x.kind === 'robot')).toBe(false)
    const ev = (await admin('/workloads/connection/SALES')).body.events.map((x: any) => x.what)
    expect(ev).toEqual(['starting → ready', 'starting (first report)'])
  })

  it('running another spec than wanted reads "not yet taken"', async () => {
    e.report([{ kind: 'connection', id: 'SALES', state: 'ready', spec: '00000000', version: 'abc123' }])
    await wait(() => false, 200)
    expect((await one('connection/SALES')).taken).toBe(false)
  })

  it('an action goes to the engine and its answer comes back — audited, an event; refused without the capability', async () => {
    const ok = await admin('/workloads/connection/SALES/act', 'POST', { action: 'test' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200); expect(ok.body.note).toBe('it answers')
    const bad = await admin('/workloads/connection/SALES/act', 'POST', { action: 'restart' })
    expect(bad.status).toBe(502); expect(bad.body.error).toMatch(/no driver/)
    expect((await viewer('/workloads/connection/SALES/act', 'POST', { action: 'test' })).status).toBe(403)
    expect((await admin('/workloads/connection/SALES/act', 'POST', { action: 'explode' })).body.error).toMatch(/has no action "explode"/)
    const ev = (await admin('/workloads/connection/SALES')).body.events.map((x: any) => `${x.what}|${x.by}`)
    expect(ev.slice(0, 2)).toEqual(['Restart — failed|admin@x.io', 'Test|admin@x.io'])
    const audit = (await admin('/audit?limit=20')).body.events.map((x: any) => x.action)
    expect(audit).toEqual(expect.arrayContaining(['workload.test', 'workload.restart']))
  })

  it('an aspect is looked into through the engine; refused without its capability', async () => {
    const r = await admin('/workloads/connection/SALES/inspect/cache')
    expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.data).toEqual({ entries: 3, bytes: 900 })
    expect((await viewer('/workloads/connection/SALES/inspect/cache')).status).toBe(403)
  })

  it('a failed workload is in Attention', async () => {
    e.report([{ kind: 'connection', id: 'SALES', state: 'failed', error: { what: 'it cannot reach its source', detail: 'ECONNREFUSED 10.0.0.4:1433' } }])
    await wait(() => false, 200)
    const items = (await admin('/attention')).body.items
    expect(items.find((x: any) => x.id === 'workload:connection/SALES')).toMatchObject({ state: 'critical', detail: 'it cannot reach its source' })
  })

  it('with no engine connected every workload reads unknown (what it last said kept beside)', async () => {
    e.ws.close()
    await wait(() => false, 300)
    const w = await one('connection/SALES')
    expect(w.state).toBe('unknown'); expect(w.reported).toBe('failed')
    expect((await admin('/workloads/connection/SALES/act', 'POST', { action: 'test' })).body.error).toMatch(/not connected/)
  })
})
