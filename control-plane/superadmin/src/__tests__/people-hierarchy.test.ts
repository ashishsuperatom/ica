// The hierarchy between people (shared/permissions.ts compare) through the REAL Worker, ProjectDO and OrgDO: two project
// admins leave each other alone — neither demotes, removes nor makes another admin; an organisation admin, above both,
// does; one steps down, never up. Two organisation admins cannot revoke each other's organisation keys; an owner can.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { sealKeygen } from '../proxy/seal'

const here = fileURLToPath(new URL('.', import.meta.url))
const SECRET = 'people-hierarchy'
const harness = `
import worker from '../worker.ts'
export { OrgDO, ProjectDO, GlobalDO, UserDO } from '../worker.ts'
export default worker`
let mf: Miniflare
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, v: 2, ...claims })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}
const SUPER = jwt({ userId: 'u0', email: 'ashish@superatom.ai', role: 'superadmin' })
const BOSS = jwt({ userId: 'b', email: 'boss@acme.io' }), PA = jwt({ userId: 'pa', email: 'pa@acme.io' }), PB = jwt({ userId: 'pb', email: 'pb@acme.io' }), ADA = jwt({ userId: 'ad', email: 'ada@acme.io' })
const as = (token: string, org?: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(org ? { 'x-org-id': org } : {}) })
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json().catch(() => null) as any } }
let org = '', alpha = ''


beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], loader: { '.json': 'json' } })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], kvNamespaces: ['DOMAINS', 'CREDENTIALS'], bindings: { JWT_SECRET: SECRET, CREDENTIALS_MASTER_KEY: sealKeygen() } })
  org = (await at('/api/organizations', { method: 'POST', headers: as(SUPER), body: JSON.stringify({ name: 'Acme', adminEmail: 'boss@acme.io' }) })).body.id
  alpha = (await at('/api/projects', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ name: 'Alpha', provider: 'external' }) })).body.id
  for (const email of ['pa@acme.io', 'pb@acme.io', 'dee@acme.io']) expect((await at('/api/users', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ email, role: 'member' }) })).status).toBeLessThan(300)
  for (const email of ['pa@acme.io', 'pb@acme.io']) expect((await at('/api/assignments', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ projectId: alpha, email, roleId: 'admin' }) })).status).toBeLessThan(300)
}, 60_000)
afterAll(async () => { await mf?.dispose() })

const assign = (token: string, email: string, roleId: string) => at('/api/assignments', { method: 'POST', headers: as(token, org), body: JSON.stringify({ projectId: alpha, email, roleId }) })
const unassign = (token: string, email: string) => at('/api/assignments', { method: 'DELETE', headers: as(token, org), body: JSON.stringify({ projectId: alpha, email }) })

describe('people at the same level', () => {
  it('two project admins: neither demotes nor removes the other, nor makes a third admin — each gives roles below their own', async () => {
    expect((await assign(PA, 'pb@acme.io', 'member')).body.error).toMatch(/pb@acme.io's role there: they hold as much as you do — someone above you both does this/)
    expect((await unassign(PA, 'pb@acme.io')).body.error).toMatch(/removing pb@acme.io: they hold as much as you do/)
    expect((await assign(PA, 'dee@acme.io', 'admin')).body.error).toMatch(/you give only a role below your own/)
    expect((await assign(PA, 'dee@acme.io', 'developer')).status).toBeLessThan(300)
    expect((await assign(PA, 'dee@acme.io', 'member')).status).toBeLessThan(300)        // a developer is below an admin
    expect((await unassign(PA, 'dee@acme.io')).status).toBeLessThan(300)
  })
  it('an organisation admin, above both, decides; one steps down, never up', async () => {
    expect((await assign(BOSS, 'pb@acme.io', 'developer')).status).toBeLessThan(300)
    expect((await assign(PB, 'pb@acme.io', 'admin')).body.error).toMatch(/step down, never up|cannot give what you do not hold/)
    expect((await assign(PB, 'pb@acme.io', 'viewer')).status).toBeLessThan(300)
    expect((await unassign(BOSS, 'pa@acme.io')).status).toBeLessThan(300)
  })
  it("two organisation admins cannot revoke each other's organisation keys; the owner above them can", async () => {
    expect((await at('/api/users', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ email: 'ada@acme.io', role: 'admin' }) })).status).toBeLessThan(300)
    const k = await at('/api/keys', { method: 'POST', headers: as(ADA, org), body: JSON.stringify({ name: 'ada loader', capabilities: ['warehouse.query'] }) })
    expect(k.status, JSON.stringify(k.body)).toBe(201)
    const id = k.body.record.id
    const seen = (await at('/api/keys', { headers: as(BOSS, org) })).body.keys.find((x: any) => x.id === id)
    expect(seen).toMatchObject({ mayRevoke: false, whyNot: expect.stringMatching(/they hold as much as you do/) })
    expect((await at(`/api/keys/${id}`, { method: 'DELETE', headers: as(BOSS, org) })).body.error).toMatch(/they hold as much as you do/)
    expect((await at(`/api/keys/${id}`, { method: 'DELETE', headers: as(SUPER, org) })).status).toBe(200)
  })
})
