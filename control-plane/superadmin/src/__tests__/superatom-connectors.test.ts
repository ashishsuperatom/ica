// SUPERATOM'S CONNECTOR REGISTRY (docs/connectors-plan.md 9a/9b) through the REAL Worker, GlobalDO and ProjectDO: only the
// release job (its token) releases a version; it is kept by hash and recorded; every project's catalogue reads it (the
// released manifest and version over the platform's own build); a connection made with it runs that code and is pinned;
// a newer release is offered, never applied on its own; a version stopped by Superatom is not run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { sealKeygen } from '../proxy/seal'

const here = fileURLToPath(new URL('.', import.meta.url))
const SECRET = 'superatom-connectors'
const RELEASE = 'release-token-for-tests'
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
const BOSS = jwt({ userId: 'b', email: 'boss@acme.io' }), DEV = jwt({ userId: 'd', email: 'dev@acme.io' }), MIA = jwt({ userId: 'm', email: 'mia@acme.io' })
const as = (token: string, org?: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(org ? { 'x-org-id': org } : {}) })
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json().catch(() => null) as any } }
let org = '', alpha = '', beta = ''

// one of Superatom's (its id is in the platform's own build): released anew
const manifest = (over: Record<string, unknown> = {}) => ({ id: 'rest-json', title: 'REST JSON', kind: 'api', dialect: 'api', description: 'Any JSON API.', levels: ['project'], identity: ['shared'],
  fields: [{ name: 'baseUrl', label: 'Address', type: 'url', required: true }], ...over })
const code = (v: number) => `export function createBridge() { return { id: 'rest-json', kind: 'api', dialect: 'api', ready: () => true, query: async () => [{ v: ${v} }], introspect: async () => ({ tables: [] }) } }`
const release = (body: unknown, token: string | null = RELEASE) => at('/api/superatom/connectors/release', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
const publish = (token: string, project: string, body: unknown) => at(`/api/projects/${project}/connectors`, { method: 'POST', headers: as(token), body: JSON.stringify(body) })
const catalogue = async (token: string, project: string) => (await at(`/api/projects/${project}/connectors`, { headers: as(token) })).body.connectors as any[]
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('')

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], loader: { '.json': 'json' } })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], kvNamespaces: ['DOMAINS', 'CREDENTIALS'], bindings: { JWT_SECRET: SECRET, CREDENTIALS_MASTER_KEY: sealKeygen(), CONNECTOR_RELEASE_TOKEN: RELEASE } })
  org = (await at('/api/organizations', { method: 'POST', headers: as(SUPER), body: JSON.stringify({ name: 'Acme', adminEmail: 'boss@acme.io' }) })).body.id
  alpha = (await at('/api/projects', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ name: 'Alpha', provider: 'external' }) })).body.id
  beta = (await at('/api/projects', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ name: 'Beta', provider: 'external' }) })).body.id
  for (const [email, role] of [['dev@acme.io', 'admin'], ['mia@acme.io', 'member']]) {
    expect((await at('/api/users', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ email, role: 'member' }) })).status).toBeLessThan(300)
    expect((await at('/api/assignments', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ projectId: alpha, email, roleId: role }) })).status).toBeLessThan(300)
  }
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe("Superatom's connector registry", () => {
  let v1 = '', v2 = '', con = ''
  it('only the release job releases: no token, a wrong one, or a person refused; a manifest that is not sound refused; a version released once', async () => {
    expect((await release({ manifest: manifest(), code: code(1) }, null)).status).toBe(401)
    expect((await release({ manifest: manifest(), code: code(1) }, 'guess')).status).toBe(401)
    expect((await release({ manifest: manifest(), code: code(1) }, SUPER)).status).toBe(401)   // a platform admin's sign-in is not the release token
    expect((await release({ manifest: manifest({ kind: 'nope' }), code: code(1) })).body.error).toMatch(/kind is sql, documents or api/)
    expect((await release({ manifest: manifest({ builtin: true }), code: code(1) })).status).toBe(400)
    const r = await release({ manifest: manifest(), code: code(1), notes: 'first', commit: 'abc123' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    v1 = await sha(code(1)); expect(r.body).toMatchObject({ id: 'rest-json', version: v1 })
    expect((await release({ manifest: manifest(), code: code(1) })).body.already).toBe(true)
  })
  it("every project reads it: the released manifest and version over the platform's own build; a connection made with it runs that code, pinned", async () => {
    const k = (await catalogue(BOSS, alpha)).find((c) => c.id === 'rest-json')
    expect(k).toMatchObject({ version: v1, description: 'Any JSON API.' })
    const made = await at(`/api/projects/${alpha}/connections`, { method: 'POST', headers: as(BOSS), body: JSON.stringify({ connector: 'rest-json', name: 'API', level: 'project', values: { baseUrl: 'https://api.example.com' } }) })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    con = made.body.connection.id
    expect(made.body.connection.bridge).toBe(v1)
  })
  it('a newer release is offered, not applied; update moves it there', async () => {
    expect((await release({ manifest: manifest(), code: code(2), notes: 'second' })).status).toBe(201)
    v2 = await sha(code(2))
    const w = async () => (await at(`/api/projects/${alpha}/workloads`, { headers: as(BOSS) })).body.workloads.find((x: any) => x.id === 'API')
    await new Promise((r) => setTimeout(r, 50))
    const c = (await at(`/api/projects/${alpha}/connections`, { headers: as(BOSS) })).body.connections.find((x: any) => x.id === con)
    expect(c.bridge).toBe(v1)
    // update reads the registry now (whatever a project read before): it runs v2, the one it ran kept for a rollback
    const act = (action: string) => at(`/api/projects/${alpha}/workloads/connection/API/act`, { method: 'POST', headers: as(BOSS), body: JSON.stringify({ action }) })
    expect((await act('update')).body.note).toMatch(new RegExp(`runs ${v2.slice(0, 12)} from now on`))
    expect((await at(`/api/projects/${alpha}/connections`, { headers: as(BOSS) })).body.connections.find((x: any) => x.id === con).bridge).toBe(v2)
    expect((await act('rollback')).status).toBe(200)
    expect(w).toBeTruthy()
  })
})
