// A project's engine on Fly (fly.ts; docs/deploying-the-engine.md, "On Fly"), through the real ProjectDO (Miniflare) with
// Fly played by a fake that keeps its state: nothing is placed unless the platform allowed the organisation machines on
// Fly, and never more than it allowed; a release Fly's registry does not hold is refused with what to run; placing
// makes the app named after the project, its volume and one machine on the chosen release, and placing again changes
// that machine rather than making another; a release chosen is switched to by swapping the machine's image, and put back
// when the engine does not come up on it; idle, the machine is suspended, then stopped; leaving Fly removes the machine
// and keeps the app and its volume (the data).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { PROJECT_ROLES, orgRouteNeeds, projectRouteNeeds } from '../../../shared/permissions'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555557'
const D1 = 'sha256:' + 'a'.repeat(64), D2 = 'sha256:' + 'b'.repeat(64)
const harness = `
import { ProjectDO as P } from '../project-do.ts'
export class ProjectDO extends P { async sql(q, ...p) { return this.ctx.storage.sql.exec(q, ...p).toArray() } async runAlarm() { await this.alarm() } }
export { OrgDO } from '../do.ts'
export default { async fetch(req, env) {
  if (new URL(req.url).pathname === '/org-fly') return env.ORG.get(env.ORG.idFromName('org-acme')).fetch(new Request('http://do/fly', { method: req.method, body: req.method === 'GET' ? undefined : await req.text() }))
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname === '/sql') { const b = await req.json(); return Response.json(await stub.sql(b.q, ...(b.p ?? []))) }
  if (u.pathname === '/alarm') { await stub.runAlarm(); return Response.json({ ok: true }) }
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`

// Fly, as far as the platform sees it.
const fly = { apps: new Set<string>(), volumes: [] as any[], machines: [] as any[], images: new Set<string>([D1]), calls: [] as string[] }
async function flyApi(req: Request): Promise<Response> {
  const u = new URL(req.url), m = req.method, path = u.pathname.replace(/^\/v1/, '')
  fly.calls.push(`${m} ${path}`)
  const body = m === 'POST' ? await req.json().catch(() => ({})) as any : null
  let x: RegExpMatchArray | null
  if ((x = path.match(/^\/apps\/([^/]+)$/)) && m === 'GET') return fly.apps.has(x[1]!) ? Response.json({ name: x[1] }) : new Response('{}', { status: 404 })
  if (path === '/apps' && m === 'POST') { fly.apps.add(body.app_name); return Response.json({}, { status: 201 }) }
  if ((x = path.match(/^\/apps\/([^/]+)\/volumes$/))) {
    if (m === 'GET') return Response.json(fly.volumes.filter((v) => v.app === x![1]))
    const v = { id: `vol_${fly.volumes.length + 1}`, app: x[1], region: body.region, state: 'created', size_gb: body.size_gb }; fly.volumes.push(v); return Response.json(v)
  }
  if ((x = path.match(/^\/apps\/([^/]+)\/machines$/))) {
    if (m === 'GET') return Response.json(fly.machines.filter((v) => v.app === x![1]))
    const mm = { id: `m${fly.machines.length + 1}`, app: x[1], region: body.region, state: 'started', config: body.config }; fly.machines.push(mm); return Response.json(mm)
  }
  if ((x = path.match(/^\/apps\/([^/]+)\/machines\/([^/]+)(\/(\w+))?$/))) {
    const mm = fly.machines.find((v) => v.id === x![2])
    if (!mm) return new Response('{}', { status: 404 })
    if (m === 'GET') { const now = { ...mm }; if (mm.settle) { mm.state = mm.settle; delete mm.settle } return Response.json(now) }
    // As Fly does (seen 2026-10-15): a machine being replaced reads stopped a moment before it will start — one start refused.
    if (x[4] === 'start' && (mm.state === 'replacing' || mm.refuseStart > 0)) { if (mm.refuseStart > 0) mm.refuseStart--; return new Response('{"error":"failed_precondition: machine getting replaced, refusing to start"}', { status: 412 }) }
    if (m === 'DELETE') { fly.machines = fly.machines.filter((v) => v !== mm); return Response.json({ ok: true }) }
    if (x[4]) { mm.state = ({ suspend: 'suspended', stop: 'stopped', start: 'started' } as any)[x[4]]; return Response.json({ ok: true }) }
    mm.config = body.config; if (mm.state !== 'started') { mm.state = 'replacing'; mm.settle = 'stopped'; mm.refuseStart = 1 } return Response.json(mm)
  }
  return new Response('not here', { status: 404 })
}

let mf: Miniflare
const call = async (path: string, method = 'GET', body?: unknown) => {
  const r = await mf.dispatchFetch(`http://x/do${path}`, { method, headers: { 'x-sa-actor': JSON.stringify({ kind: 'user', id: 'ops@x.io', email: 'ops@x.io' }), 'x-sa-caps': JSON.stringify(PROJECT_ROLES.admin.capabilities) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() as any }
}
const sql = async (q: string, ...p: unknown[]) => (await mf.dispatchFetch('http://x/sql', { method: 'POST', body: JSON.stringify({ q, p }) })).json() as Promise<any[]>
const alarm = () => mf.dispatchFetch('http://x/alarm')
const allow = async (a: Record<string, unknown>) => (await mf.dispatchFetch('http://x/org-fly', { method: 'PUT', body: JSON.stringify(a) })).json() as Promise<any>
const phase = async () => (await sql('SELECT idle_phase, provider FROM fly_machine'))[0]

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true } }, r2Buckets: ['PACKAGES', 'REGISTRY'],
    bindings: { JWT_SECRET: 'x', FLY_API_TOKEN: 'fly-test', PLATFORM_DOMAIN: 'example.test' },
    outboundService: async (req: any) => {
      const u = new URL(req.url)
      if (u.host === 'api.machines.dev') return flyApi(req)
      if (u.host === 'registry.fly.io') return new Response(null, { status: fly.images.has(u.pathname.split('/').pop()!) ? 200 : 404 })
      if (u.host === 'registry.superatom.ai') return new Response(null, { status: 200 })
      return new Response('not found', { status: 404 })
    },
  })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'Acme Freight', orgId: 'org-acme' }) })
  expect((await call('/engine-release', 'PUT', { digest: D1 })).status).toBe(200)
}, 90_000)
afterAll(async () => { await mf?.dispose() })

describe('a project\'s engine on Fly', () => {
  it('only the platform sets the allowance; a claim is never a public call; placing needs project.manage', () => {
    expect(orgRouteNeeds('PUT', '/fly')).toBe('platform')
    expect(orgRouteNeeds('GET', '/fly')).toBe('org.projects')
    expect(orgRouteNeeds('POST', '/fly/claim')).toBe('internal')
    expect(orgRouteNeeds('POST', '/fly/release')).toBe('internal')
    expect(projectRouteNeeds('PUT', 'engine-place')).toBe('project.manage')
  })

  it('nothing is placed unless the platform allowed the organisation machines on Fly — and never more than it allowed', async () => {
    let r = await call('/engine-place', 'PUT', { region: 'syd' })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/may not run on Fly/)
    await allow({ allowed: true, machines: 0 })
    r = await call('/engine-place', 'PUT', { region: 'syd' })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/all are in use/)
    expect(fly.apps.size).toBe(0)
    expect(await allow({ allowed: true, machines: 1 })).toMatchObject({ allowed: true, machines: 1, used: 0 })
  })

  it('a release Fly\'s registry does not hold is refused, saying how to copy it', async () => {
    fly.images.delete(D1)
    const r = await call('/engine-place', 'PUT', { region: 'syd' })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/copy_to_fly/)
    expect(fly.apps.size).toBe(0)
    fly.images.add(D1)
  })

  it('placing makes superatom-<name>, its volume and one machine on the chosen release; placing again changes that machine', async () => {
    // Last active long ago (the engine ran elsewhere): a new machine is not put to sleep the moment it comes up.
    await sql("UPDATE fly_machine SET idle_phase = 'active', last_active = ?", Date.now() - 5 * 3_600_000)
    const r = await call('/engine-place', 'PUT', { region: 'syd' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.fly).toMatchObject({ app: 'superatom-acme-freight', region: 'syd' })
    const m = fly.machines[0]
    expect(m.config.image).toBe(`registry.fly.io/superatom-engine@${D1}`)
    expect(m.config.env).toMatchObject({ ICA_PROJECT: PID, ICA_KEY: 'ek', ICA_HUB: 'wss://example.test', PROJECT_NAME: 'acme-freight', SA_ENGINE_IMAGE: `registry.fly.io/superatom-engine@${D1}`, SUPERATOM_HOME: '/app/data' })
    expect(m.config.restart).toEqual({ policy: 'always' })
    expect(m.config.mounts).toEqual([{ volume: 'vol_1', path: '/app/data' }])
    expect((await phase()).provider).toBe('fly')
    await alarm()
    expect((await phase()).idle_phase).toBe('active')
    expect(m.state).toBe('started')
    m.state = 'suspended'   // placed again while asleep: it is started
    expect((await call('/engine-place', 'PUT', {})).status).toBe(200)
    expect(fly.machines.length).toBe(1)
    expect(fly.machines[0].state).toBe('started')
    expect(fly.volumes.length).toBe(1)
  })

  it('a release chosen is switched to by swapping the machine\'s image — and put back when the engine does not come up on it', async () => {
    fly.images.add(D2)
    const r = await call('/engine-release', 'PUT', { digest: D2 })
    expect(r.body.fly).toEqual({ ok: true })
    expect(fly.machines[0].config.image).toBe(`registry.fly.io/superatom-engine@${D2}`)
    expect(fly.machines[0].config.env.SA_ENGINE_IMAGE).toBe(`registry.fly.io/superatom-engine@${D2}`)
    let sw = (await call('/engine-release')).body.switch
    expect(sw.state).toBe('switching')
    expect(sw.steps.map((x: any) => x.step)).toEqual(['started', 'started-new', 'waiting'])
    await alarm()   // the deadline, and the engine never reached the hub on it
    sw = (await call('/engine-release')).body.switch
    expect(sw.state).toBe('rolled-back')
    expect(sw.reason).toMatch(/did not reach the platform/)
    expect(fly.machines[0].config.image).toBe(`registry.fly.io/superatom-engine@${D1}`)
  })

  it('awake a whole day after the last work; idle a day it is suspended, idle a week with nobody here, stopped', async () => {
    await sql("UPDATE fly_machine SET idle_phase = 'active', last_active = ?", Date.now() - 23 * 3_600_000)
    await alarm()
    expect((await phase()).idle_phase).toBe('active')
    await sql('UPDATE fly_machine SET last_active = ?', Date.now() - 25 * 3_600_000)
    await alarm()
    expect((await phase()).idle_phase).toBe('suspended')
    expect(fly.machines[0].state).toBe('suspended')
    await sql('UPDATE fly_machine SET last_active = ?', Date.now() - 8 * 24 * 3_600_000)
    await alarm()
    expect((await phase()).idle_phase).toBe('stopped')
    expect(fly.machines[0].state).toBe('stopped')
  })

  it('leaving Fly removes the machine and keeps the app and its volume (the data)', async () => {
    const r = await call('/engine-place', 'DELETE')
    expect(r.body).toMatchObject({ ok: true, kept: { app: 'superatom-acme-freight', volume: 'vol_1' } })
    expect(fly.machines.length).toBe(0)
    expect(fly.volumes.length).toBe(1)
    expect((await phase()).provider).toBe('external')
    expect((await (await mf.dispatchFetch('http://x/org-fly')).json() as any).used).toBe(0)   // its machine given back
  })
})
