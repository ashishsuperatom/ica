// Everyone's development environments for the people who run a project (the console's list), through the real ProjectDO
// (Miniflare): every person's environment is listed with what it changes; one deleted by an administrator is gone from
// the list (its builds let go on the engine); the routes need project.manage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { PROJECT_ROLES, projectRouteNeeds } from '../../../shared/permissions'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-5555555555d1'
const harness = `
import { ProjectDO as P } from '../project-do.ts'
export class ProjectDO extends P { async sql(q, ...p) { return this.ctx.storage.sql.exec(q, ...p).toArray() } }
export default { async fetch(req, env) {
  const u = new URL(req.url), stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname === '/sql') { const b = await req.json(); return Response.json(await stub.sql(b.q, ...(b.p ?? []))) }
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const call = async (path: string, method = 'GET') => {
  const r = await mf.dispatchFetch(`http://x/do${path}`, { method, headers: { 'x-sa-actor': JSON.stringify({ kind: 'user', id: 'boss@x.io', email: 'boss@x.io' }), 'x-sa-caps': JSON.stringify(PROJECT_ROLES.admin.capabilities) } })
  return { status: r.status, body: await r.json() as any }
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x' } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P', orgId: 'o' }) })
  const t = Date.now()
  for (const [id, name, owner, status, names] of [['dv_a', 'pmo-green', 'mia@x.io', 'attached', '["program pmo-health"]'], ['dv_b', 'try-map', 'raj@x.io', 'detached', '[]']])
    await mf.dispatchFetch('http://x/sql', { method: 'POST', body: JSON.stringify({ q: 'INSERT INTO dev_envs (id, name, owner, status, names, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?)', p: [id, name, owner, status, names, t, t] }) })
}, 90_000)
afterAll(async () => { await mf?.dispose() })

describe('development environments in the console', () => {
  it('needs project.manage', () => {
    expect(projectRouteNeeds('GET', 'dev-envs')).toBe('project.manage')
    expect(projectRouteNeeds('DELETE', 'dev-envs')).toBe('project.manage')
  })
  it('lists everyone\'s, with what each changes; one deleted by an administrator is gone', async () => {
    const before = await call('/dev-envs')
    expect(before.body.envs.map((e: any) => [e.name, e.owner, e.status, e.names])).toEqual(expect.arrayContaining([['pmo-green', 'mia@x.io', 'attached', ['program pmo-health']], ['try-map', 'raj@x.io', 'detached', []]]))
    expect((await call('/dev-envs?id=dv_a', 'DELETE')).status).toBe(200)
    expect((await call('/dev-envs')).body.envs.map((e: any) => e.name)).toEqual(['try-map'])
    expect((await call('/dev-envs?id=nope', 'DELETE')).status).toBe(400)
  })
})
