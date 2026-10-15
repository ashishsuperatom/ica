// The organisation's connectors (docs/connectors-plan.md R3) through the REAL Worker, ProjectDO and OrgDO: whoever may
// change a project's connectors publishes one — no gate — and it is usable at once there and seen by the organisation's
// other projects; a member cannot publish, nor take one of Superatom's names; a new version leaves a connection on the
// one it was given (update is on purpose); an organisation admin blocks one after the fact (its connections are not run,
// it is not offered) — a member cannot; with approval asked for, a new version waits for an admin.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { sealKeygen } from '../proxy/seal'

const here = fileURLToPath(new URL('.', import.meta.url))
const SECRET = 'org-connectors'
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

const manifest = (over: Record<string, unknown> = {}) => ({ id: 'acme-crm', title: 'Acme CRM', kind: 'api', dialect: 'api', description: 'Our CRM.', levels: ['project'], identity: ['shared'],
  fields: [{ name: 'token', label: 'Token', type: 'secret', required: true }], ...over })
const code = (v: number) => `export function createBridge() { return { id: 'acme-crm', kind: 'api', dialect: 'api', ready: () => true, query: async () => [{ v: ${v} }], introspect: async () => ({ tables: [] }) } }`
const publish = (token: string, project: string, body: unknown) => at(`/api/projects/${project}/connectors`, { method: 'POST', headers: as(token), body: JSON.stringify(body) })
const catalogue = async (token: string, project: string) => (await at(`/api/projects/${project}/connectors`, { headers: as(token) })).body.connectors as any[]
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('')

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], loader: { '.json': 'json' } })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], kvNamespaces: ['DOMAINS', 'CREDENTIALS'], bindings: { JWT_SECRET: SECRET, CREDENTIALS_MASTER_KEY: sealKeygen() } })
  org = (await at('/api/organizations', { method: 'POST', headers: as(SUPER), body: JSON.stringify({ name: 'Acme', adminEmail: 'boss@acme.io' }) })).body.id
  alpha = (await at('/api/projects', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ name: 'Alpha', provider: 'external' }) })).body.id
  beta = (await at('/api/projects', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ name: 'Beta', provider: 'external' }) })).body.id
  for (const [email, role] of [['dev@acme.io', 'admin'], ['mia@acme.io', 'member']]) {
    expect((await at('/api/users', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ email, role: 'member' }) })).status).toBeLessThan(300)
    expect((await at('/api/assignments', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ projectId: alpha, email, roleId: role }) })).status).toBeLessThan(300)
  }
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe("the organisation's connectors", () => {
  let v1 = '', con = ''
  it('published from a project by who may change its connectors — no gate; not by a member, not under one of Superatom\'s names, not without a sound manifest', async () => {
    expect((await publish(MIA, alpha, { manifest: manifest(), code: code(1) })).status).toBe(403)
    expect((await publish(DEV, alpha, { manifest: manifest({ id: 'postgres' }), code: code(1) })).body.error).toMatch(/one of Superatom's connectors/)
    expect((await publish(DEV, alpha, { manifest: manifest({ kind: 'nope' }), code: code(1) })).body.error).toMatch(/kind is sql, documents or api/)
    expect((await publish(DEV, alpha, { manifest: manifest(), code: 'export const nothing = 1' })).body.error).toMatch(/exports createBridge/)
    const r = await publish(DEV, alpha, { manifest: manifest(), code: code(1) })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    v1 = await sha(code(1))
    expect(r.body).toMatchObject({ id: 'acme-crm', version: v1, status: 'ready' })
    expect((await publish(DEV, alpha, { manifest: manifest(), code: code(1) })).body.already).toBe(true)   // the same build: nothing new
  })
  it('usable at once in its project, and seen by the organisation\'s others, saying who made it', async () => {
    const here = (await catalogue(DEV, alpha)).find((c) => c.id === 'acme-crm')
    expect(here).toMatchObject({ title: 'Acme CRM', version: v1, org: { madeBy: 'dev@acme.io', fromProject: alpha, blocked: false } })
    expect((await catalogue(BOSS, beta)).some((c) => c.id === 'acme-crm')).toBe(true)
    expect((await catalogue(BOSS, beta)).some((c) => c.id === 'postgres')).toBe(true)   // Superatom's beside it
    const made = await at(`/api/projects/${beta}/connections`, { method: 'POST', headers: as(BOSS), body: JSON.stringify({ connector: 'acme-crm', name: 'CRM', level: 'project', values: { token: 't' } }) })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    con = made.body.connection.id
    expect(made.body.connection.bridge).toBe(v1)                      // its code copied into this project, pinned
  })
  it('a new version leaves the connection on the one it was given', async () => {
    const r = await publish(DEV, alpha, { manifest: manifest(), code: code(2) })
    expect(r.body.status).toBe('ready')
    expect((await catalogue(BOSS, beta)).find((c) => c.id === 'acme-crm').version).toBe(await sha(code(2)))
    const c = (await at(`/api/projects/${beta}/connections`, { headers: as(BOSS) })).body.connections.find((x: any) => x.id === con)
    expect(c.bridge).toBe(v1)
    // its workload says a newer one exists; update moves it (the old kept), rollback moves it back
    const w = async () => (await at(`/api/projects/${beta}/workloads`, { headers: as(BOSS) })).body.workloads.find((x: any) => x.id === 'CRM')
    expect((await w()).newer).toBe((await sha(code(2))).slice(0, 12))
    const act = (action: string) => at(`/api/projects/${beta}/workloads/connection/CRM/act`, { method: 'POST', headers: as(BOSS), body: JSON.stringify({ action }) })
    expect((await act('update')).body.note).toMatch(/runs .* from now on/)
    expect((await w()).newer).toBeUndefined()
    expect((await act('rollback')).status).toBe(200)
    expect((await w()).newer).toMatch(/^[0-9a-f]{12}$/)
    expect((await act('update')).status).toBe(200)
  })
  it("what the consoles read: a project's registry (Superatom's, every organisation version, what runs here), a version's code (who may change connections), where each runs", async () => {
    const reg = (await at(`/api/projects/${beta}/connectors/registry`, { headers: as(BOSS) })).body
    expect(reg.superatom.some((c: any) => c.id === 'postgres' && /^[0-9a-f]{64}$/.test(c.version))).toBe(true)
    expect(reg.organisation.find((c: any) => c.id === 'acme-crm').versions.map((v: any) => v.hash)).toEqual(expect.arrayContaining([v1, await sha(code(2))]))
    expect(reg.connections).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'CRM', connector: 'acme-crm', bridge: await sha(code(2)) })]))
    expect((await at(`/api/projects/${beta}/connectors/acme-crm/code/${v1}`, { headers: as(BOSS) })).body.code).toBe(code(1))
    expect((await at(`/api/projects/${alpha}/connectors/acme-crm/code/${v1}`, { headers: as(MIA) })).status).toBe(403)   // a member: not the code
    expect((await at(`/api/projects/${beta}/connectors/acme-crm/code/${'0'.repeat(64)}`, { headers: as(BOSS) })).status).toBe(404)
    const usage = (await at('/api/connectors/usage', { headers: as(MIA, org) })).body.usage   // anyone in the organisation
    expect(usage.find((u: any) => u.project === beta).connections).toEqual(expect.arrayContaining([{ name: 'CRM', connector: 'acme-crm', bridge: await sha(code(2)), auth: 'shared' }]))
    expect(usage.find((u: any) => u.project === alpha).connections.some((c: any) => c.connector === 'acme-crm')).toBe(false)
    // the platform's view: Superatom's and every organisation's — the superadmin only
    const pf = (await at('/api/platform/connectors', { headers: as(SUPER) })).body
    expect(pf.superatom.some((c: any) => c.id === 'postgres')).toBe(true)
    expect(pf.organisations.find((o: any) => o.id === org).connectors.map((c: any) => c.id)).toContain('acme-crm')
    expect((await mf.dispatchFetch('http://x/api/platform/connectors', { headers: as(BOSS) })).status).toBe(401)
  })
  it('blocked by an organisation admin after the fact: not offered, its connections not run — a member cannot block', async () => {
    expect((await at('/api/connectors/block', { method: 'POST', headers: as(MIA, org), body: JSON.stringify({ id: 'acme-crm' }) })).status).toBe(403)
    expect((await at('/api/connectors/block', { method: 'POST', headers: as(BOSS, org), body: JSON.stringify({ id: 'acme-crm', by: 'someone-else' }) })).status).toBe(200)
    expect((await catalogue(BOSS, beta)).some((c) => c.id === 'acme-crm')).toBe(false)
    const c = (await at(`/api/projects/${beta}/connections`, { headers: as(BOSS) })).body.connections.find((x: any) => x.id === con)
    expect(c.state).toMatch(/not run: Acme CRM is blocked by the organisation/)
    // Running says the same: stopped, and why — never "pending", as if it were about to start
    const w = (await at(`/api/projects/${beta}/workloads`, { headers: as(BOSS) })).body.workloads.find((x: any) => x.id === 'CRM')
    expect(w).toMatchObject({ state: 'stopped', wanted: null, error: { what: 'not run: Acme CRM is blocked by the organisation' } })
    expect((await publish(DEV, alpha, { manifest: manifest(), code: code(3) })).body.error).toMatch(/blocked in this organisation/)
    const reg = (await at('/api/connectors', { headers: as(MIA, org) })).body   // anyone in it sees the registry
    expect(reg.connectors[0]).toMatchObject({ id: 'acme-crm', blocked_by: 'boss@acme.io' })   // who did it: the caller, never the body's word
    expect((await at('/api/connectors/block', { method: 'POST', headers: as(BOSS, org), body: JSON.stringify({ id: 'acme-crm', unblock: true }) })).status).toBe(200)
    expect((await catalogue(BOSS, beta)).some((c) => c.id === 'acme-crm')).toBe(true)
  })
  it('with approval asked for, a new version waits for an admin; approved, it is the current one', async () => {
    expect((await at('/api/connectors/settings', { method: 'PUT', headers: as(BOSS, org), body: JSON.stringify({ approval: true }) })).body.approval).toBe(true)
    const v4 = await sha(code(4))
    expect((await publish(DEV, alpha, { manifest: manifest(), code: code(4) })).body.status).toBe('proposed')
    expect((await catalogue(BOSS, beta)).find((c) => c.id === 'acme-crm').version).toBe(await sha(code(2)))
    expect((await at('/api/connectors/approve', { method: 'POST', headers: as(BOSS, org), body: JSON.stringify({ id: 'acme-crm', hash: v4.slice(0, 12) }) })).status).toBe(200)
    // every project told at once: the other project offers it now
    expect((await catalogue(BOSS, beta)).find((c) => c.id === 'acme-crm').version).toBe(v4)
    const audit = (await at('/api/audit', { headers: as(BOSS, org) })).body.events.map((e: any) => e.op)
    expect(audit).toEqual(expect.arrayContaining(['connector.publish', 'connector.block', 'connector.unblock', 'connector.approval', 'connector.approve']))
  })
  it("the connector agent's draft goes through the same door: published as the person who asked, the connection moved onto it — no route sets a connection's code", async () => {
    await at('/api/connectors/settings', { method: 'PUT', headers: as(BOSS, org), body: JSON.stringify({ approval: false }) })
    const made = await at(`/api/projects/${alpha}/connections`, { method: 'POST', headers: as(BOSS), body: JSON.stringify({ connector: 'code', name: 'CRMX', level: 'project', values: { settings: { baseUrl: 'https://crm.example' }, secrets: { token: 't' } } }) })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const engineKey = (await at(`/api/projects/${alpha}/engine-credentials`, { headers: as(BOSS) })).body.engineKey
    const draft = (n: number) => `export function createBridge({ settings, secrets }) { return { id: 'crmx', kind: 'api', dialect: 'api', ready: () => !!secrets.token, query: async () => [{ n: ${n} }], introspect: async () => ({ tables: [] }) } }`
    const send = (body: unknown) => at(`/api/engine/${alpha}/connectors`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${engineKey}` }, body: JSON.stringify(body) })
    const r = await send({ connection: 'CRMX', code: draft(1), by: 'dev@acme.io' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ id: 'crmx', version: await sha(draft(1)), connection: 'CRMX' })
    const c = (await at(`/api/projects/${alpha}/connections`, { headers: as(BOSS) })).body.connections.find((x: any) => x.name === 'CRMX')
    expect(c).toMatchObject({ connector: 'crmx', bridge: await sha(draft(1)), settings: { baseUrl: 'https://crm.example' } })
    const reg = (await at('/api/connectors', { headers: as(BOSS, org) })).body.connectors.find((x: any) => x.id === 'crmx')
    expect(reg.current).toMatchObject({ published_by: 'dev@acme.io', from_project: alpha })
    expect(reg.current.manifest.fields.map((f: any) => [f.name, f.type])).toEqual([['baseUrl', 'text'], ['token', 'secret']])   // made from the connection's own
    // written again: a new version, the connection moved up to it
    const again = await send({ connection: 'CRMX', code: draft(2), by: 'dev@acme.io' })
    expect(again.body.note).toMatch(/runs [0-9a-f]{12} from now on/)
    expect((await at(`/api/projects/${alpha}/connections`, { headers: as(BOSS) })).body.connections.find((x: any) => x.name === 'CRMX').bridge).toBe(await sha(draft(2)))
    expect((await send({ connection: 'NOPE', code: draft(3) })).status).toBe(404)
    expect((await at(`/api/engine/${alpha}/connectors`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' })).status).toBe(401)
  })
})
