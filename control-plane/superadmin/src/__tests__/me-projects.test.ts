// The iPhone app's project list (GET /api/me/projects) through the REAL Worker: each person sees the projects they may
// reach — by email, the same check as every project request — and nothing else; an organisation where they reach none
// is not listed; superadmin sees every project. (It once looked people up by a Clerk id that is never stored, so
// everyone but superadmin saw nothing.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

const here = fileURLToPath(new URL('.', import.meta.url))
const SECRET = 'me-projects'
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
const as = (token: string, org?: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(org ? { 'x-org-id': org } : {}) })
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json().catch(() => null) as any } }
let org = '', a = '', b = '', made: any = null

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], kvNamespaces: ['DOMAINS', 'CREDENTIALS'], bindings: { JWT_SECRET: SECRET } })
  made = (await at('/api/organizations', { method: 'POST', headers: as(SUPER), body: JSON.stringify({ name: 'Acme', adminEmail: 'boss@acme.io' }) })).body
  org = made.id
  a = (await at('/api/projects', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ name: 'Alpha', provider: 'external' }) })).body.id
  b = (await at('/api/projects', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ name: 'Beta', provider: 'external' }) })).body.id
  expect((await at('/api/users', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ email: 'mia@acme.io', role: 'member' }) })).status).toBeLessThan(300)
  expect((await at('/api/assignments', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ projectId: a, email: 'mia@acme.io', roleId: 'member' }) })).status).toBeLessThan(300)
}, 60_000)
afterAll(async () => { await mf?.dispose() })

const list = async (token: string) => (await at('/api/me/projects', { headers: as(token) })).body as { org: { id: string }; projects: { id: string }[] }[]

describe('a new organisation\'s first admin', () => {
  it('is really added (the platform gives as an owner would), and administers its projects', async () => {
    expect(made.admin).toBe('boss@acme.io')
    expect((await at('/api/me', { headers: as(jwt({ userId: 'x', email: 'boss@acme.io' }), org) })).body).toMatchObject({ org, level: 'org-admin', role: 'admin' })
  })
})

describe('the iPhone app\'s projects', () => {
  it('a member sees the project they are in, not the other one', async () => {
    const got = await list(jwt({ userId: 'clerk-id-never-stored', email: 'Mia@acme.io' }))
    expect(got).toEqual([{ org: { id: org, name: 'Acme' }, projects: [expect.objectContaining({ id: a, name: 'Alpha' })] }])
  })
  it('the organisation\'s admin and superadmin see both; someone outside sees no organisation at all', async () => {
    expect((await list(jwt({ userId: 'x', email: 'boss@acme.io' })))[0].projects.map((p) => p.id).sort()).toEqual([a, b].sort())
    expect((await list(SUPER))[0].projects.map((p) => p.id).sort()).toEqual([a, b].sort())
    expect(await list(jwt({ userId: 'y', email: 'eve@evil.io' }))).toEqual([])
    expect((await at('/api/me/projects')).status).toBe(401)
  })
})
