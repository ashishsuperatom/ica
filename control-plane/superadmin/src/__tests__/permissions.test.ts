// Who may do what ("Permissions — who may do what", docs/platform-architecture.md): the one table (shared/permissions.ts)
// and its use in the REAL ProjectDO and OrgDO (Miniflare). A viewer looks and never asks; nothing smuggled in parts; no
// one gives more than they hold; a key holds what its maker holds of its scopes, now; an organisation keeps an owner;
// a project appends to the warehouse only where the organisation granted writing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { ORG_ROLES, PROJECT_ROLES, beyond, checkRole, messageNeeds, orgRouteNeeds, projectRouteNeeds } from '../../../shared/permissions'
import { keyCapabilities, scopesGivable } from '../../../shared/agent-scopes'

describe('the table', () => {
  it('built-in roles: an owner alone defines roles; a viewer only looks', () => {
    expect(ORG_ROLES.owner.capabilities).toContain('org.roles')
    expect(ORG_ROLES.admin.capabilities).not.toContain('org.roles')
    expect(ORG_ROLES.member.capabilities).toEqual([])
    expect(PROJECT_ROLES.viewer.capabilities).toEqual(['project.view'])
    expect(PROJECT_ROLES.member.capabilities).not.toContain('project.publish')
  })
  it('custom roles: their level\'s capabilities only, never a built-in id, never org.roles', () => {
    expect(checkRole('org', { name: 'Data engineer', capabilities: ['warehouse.query', 'warehouse.write'] }).role).toMatchObject({ id: 'data-engineer', builtin: false })
    expect(checkRole('org', { name: 'X', capabilities: ['org.roles'] }).problems.join()).toMatch(/only owners/)
    expect(checkRole('org', { name: 'X', capabilities: ['project.ask'] }).problems.join()).toMatch(/no org capability project.ask/)
    expect(checkRole('project', { id: 'admin', name: 'Admin', capabilities: [] }).problems.join()).toMatch(/built-in/)
    expect(beyond(['project.view', 'project.keys'], PROJECT_ROLES.member.capabilities)).toEqual(['project.keys'])
  })
  it('routes and messages: each names what it needs; what nobody named needs the strongest', () => {
    expect(projectRouteNeeds('GET', 'agent-keys')).toBe('project.keys')
    expect(projectRouteNeeds('GET', 'usage')).toBe('project.audit')
    expect(projectRouteNeeds('POST', 'connections')).toBe('project.connect')
    expect(projectRouteNeeds('POST', 'access-domains')).toBe('org-people')
    expect(projectRouteNeeds('POST', 'members')).toBe('internal')
    expect(projectRouteNeeds('GET', 'warehouse/grants')).toBe('internal')
    expect(projectRouteNeeds('POST', 'something-new')).toBe('project.manage')
    expect(orgRouteNeeds('POST', '/warehouse/tables')).toBe('warehouse.manage')
    expect(orgRouteNeeds('POST', '/warehouse/append')).toBe('warehouse.write')
    expect(orgRouteNeeds('GET', '/conversations')).toBe('org.audit')
    expect(orgRouteNeeds('POST', '/somewhere')).toBe('org.roles')
    expect(messageNeeds('analyse')).toBe('project.ask')
    expect(messageNeeds('view:open')).toBe('project.view')
    expect(messageNeeds('term:attach')).toBe('project.manage')
    expect(messageNeeds('no:such')).toBe('project.manage')
  })
  it('keys: a member gives no learning or warehouse writing; a key holds its maker\'s, cut to its scopes', () => {
    const member = PROJECT_ROLES.member.capabilities
    expect(scopesGivable(member)).toEqual(expect.arrayContaining(['sessions', 'ask', 'warehouse']))
    expect(scopesGivable(member)).not.toContain('learn')
    expect(scopesGivable(member)).not.toContain('warehouse-write')
    expect(keyCapabilities(['graph'], PROJECT_ROLES.admin.capabilities).sort()).toEqual(['project.ask', 'project.view'])
    expect(keyCapabilities(['learn'], member)).toEqual(['project.view'])
  })
})

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555', ORG = 'org-perm'
const harness = `
export { ProjectDO } from '../project-do.ts'
export { OrgDO } from '../do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  if (u.pathname.startsWith('/org/')) return env.ORG.get(env.ORG.idFromName('${ORG}')).fetch(new Request('http://do' + u.pathname.slice(4) + u.search, req))
  const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return stub.fetch(req)
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json().catch(() => null) as any } }
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`
  return `${body}.${createHmac('sha256', 's').update(body).digest('base64url')}`
}
/** As the worker calls a DO: who, and what they hold. */
const as = (email: string, caps: readonly string[]) => ({ 'content-type': 'application/json', 'x-sa-actor': JSON.stringify({ kind: 'user', id: email, email }), 'x-sa-caps': JSON.stringify(caps) })

async function socket(hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!; const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', ...hello }))
  await new Promise((r) => setTimeout(r, 150))
  const reply = async (reqId: string) => { for (let i = 0; i < 100; i++) { const m = got.find((x) => x.payload?.reqId === reqId); if (m) return m.payload; await new Promise((r) => setTimeout(r, 20)) } return null }
  return { send: (m: unknown) => ws.send(JSON.stringify(m)), got, reply, close: () => ws.close() }
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 's' } })
  await at('/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P', orgId: ORG }) })
  for (const [email, roleId] of [['admin@x.io', 'admin'], ['mem@x.io', 'member'], ['view@x.io', 'viewer']]) await at('/do/access', { method: 'POST', body: JSON.stringify({ email, roleId }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('in a project', () => {
  it('a viewer opens views and never asks; a member asks and never runs the engine', async () => {
    const engine = await socket({ role: 'code-engine', key: 'ek', instanceId: 'e1', epoch: Date.now() })
    const viewer = await socket({ role: 'runtime', token: jwt({ userId: 'v', email: 'view@x.io', role: 'user' }) })
    viewer.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: 'q', reqId: 'v1' } })
    expect((await viewer.reply('v1'))?.reason).toMatch(/analyse needs project.ask/)
    viewer.send({ to: { type: 'code-engine' }, payload: { t: 'view:open', agent: 'a', reqId: 'v2' } })
    await new Promise((r) => setTimeout(r, 150))
    expect(engine.got.some((m) => m.payload?.reqId === 'v2')).toBe(true)          // reached the engine
    const member = await socket({ role: 'runtime', token: jwt({ userId: 'm', email: 'mem@x.io', role: 'user' }) })
    member.send({ to: { type: 'code-engine' }, payload: { t: 'term:attach', reqId: 'm1' } })
    expect((await member.reply('m1'))?.reason).toMatch(/term:attach needs project.manage/)
    // the engine hears who may publish: an admin may, a member may not
    member.send({ to: { type: 'code-engine' }, payload: { t: 'graph:domains', reqId: 'm2' } })
    const admin = await socket({ role: 'runtime', token: jwt({ userId: 'a', email: 'admin@x.io', role: 'user' }) })
    admin.send({ to: { type: 'code-engine' }, payload: { t: 'graph:domains', reqId: 'a2' } })
    await new Promise((r) => setTimeout(r, 200))
    expect(engine.got.find((m) => m.payload?.reqId === 'm2')?.from.admin).toBeUndefined()
    expect(engine.got.find((m) => m.payload?.reqId === 'a2')?.from.admin).toBe(true)
    for (const s of [engine, viewer, member, admin]) s.close()
  })
  it('a message in parts is checked whole: a member cannot hide an engine command in parts', async () => {
    const engine = await socket({ role: 'code-engine', key: 'ek', instanceId: 'e2', epoch: Date.now() + 1 })
    const member = await socket({ role: 'runtime', token: jwt({ userId: 'm', email: 'mem@x.io', role: 'user' }) })
    const text = JSON.stringify({ t: 'term:attach', reqId: 'p1', pad: 'x'.repeat(50) })
    const half = Math.ceil(text.length / 2)
    member.send({ to: { type: 'code-engine' }, payload: { t: 'part', id: 'z1', part: 0, of: 2, data: text.slice(0, half) } })
    member.send({ to: { type: 'code-engine' }, payload: { t: 'part', id: 'z1', part: 1, of: 2, data: text.slice(half) } })
    expect((await member.reply('p1'))?.reason).toMatch(/term:attach is not allowed/)
    expect(engine.got.some((m) => m.payload?.t === 'part')).toBe(false)
    const ok = JSON.stringify({ t: 'view:open', agent: 'a', reqId: 'p2' })
    member.send({ to: { type: 'code-engine' }, payload: { t: 'part', id: 'z2', part: 1, of: 2, data: ok.slice(10) } })
    member.send({ to: { type: 'code-engine' }, payload: { t: 'part', id: 'z2', part: 0, of: 2, data: ok.slice(0, 10) } })
    await new Promise((r) => setTimeout(r, 200))
    expect(engine.got.filter((m) => m.payload?.t === 'part' && m.payload.id === 'z2').map((m) => m.payload.part)).toEqual([0, 1])   // in order
    engine.close(); member.close()
  })
  it('roles: built-in ones stay as the code says; a custom one holds no more than its maker', async () => {
    expect((await at('/do/roles', { method: 'POST', headers: as('admin@x.io', PROJECT_ROLES.admin.capabilities), body: JSON.stringify({ id: 'viewer', name: 'Viewer', capabilities: ['project.manage'] }) })).body.error).toMatch(/built-in/)
    expect((await at('/do/roles', { method: 'POST', headers: as('p@x.io', ['project.people', 'project.view']), body: JSON.stringify({ name: 'Analyst', capabilities: ['project.view', 'project.ask'] }) })).status).toBe(403)
    const made = await at('/do/roles', { method: 'POST', headers: as('admin@x.io', PROJECT_ROLES.admin.capabilities), body: JSON.stringify({ name: 'Analyst', capabilities: ['project.view', 'project.ask', 'warehouse.use'] }) })
    expect(made.body.role).toMatchObject({ id: 'analyst', capabilities: ['project.view', 'project.ask', 'warehouse.use'] })
    const roles = (await at('/do/roles')).body.roles
    expect(roles.find((r: any) => r.id === 'viewer').capabilities).toEqual(['project.view'])
    expect(roles.map((r: any) => r.id)).toEqual(['admin', 'member', 'viewer', 'analyst'])
    expect((await at('/do/access-domains', { method: 'POST', body: JSON.stringify({ domain: 'acme.com', roleId: 'admin', by: 'admin@x.io' }) })).body.error).toMatch(/member at most/)
  })
  it('keys: no one gives a key more than they hold; a demoted maker takes the key\'s power with them', async () => {
    expect((await at('/do/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'k', scopes: ['learn'], by: 'mem@x.io' }) })).body.error).toMatch(/do not hold: learn/)
    const k = await at('/do/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'k', scopes: ['sessions', 'ask'], by: 'mem@x.io' }) })
    expect(k.status).toBe(201)
    const engine = await socket({ role: 'code-engine', key: 'ek', instanceId: 'e3', epoch: Date.now() + 2 })
    const agent = await socket({ role: 'agent', key: k.body.key })
    agent.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: 'q', reqId: 'k1' } })
    await new Promise((r) => setTimeout(r, 200))
    expect(engine.got.some((m) => m.payload?.reqId === 'k1')).toBe(true)
    await at('/do/access', { method: 'POST', body: JSON.stringify({ email: 'mem@x.io', roleId: 'viewer' }) })   // demoted
    agent.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: 'q', reqId: 'k2' } })
    expect((await agent.reply('k2'))?.reason).toMatch(/maker no longer holds project.ask/)
    await at('/do/access', { method: 'POST', body: JSON.stringify({ email: 'mem@x.io', roleId: 'member' }) })
    engine.close(); agent.close()
  })
  it('the warehouse: a project appends only to a table the organisation granted it to write', async () => {
    const admin = await socket({ role: 'runtime', token: jwt({ userId: 'a', email: 'admin@x.io', role: 'user' }) })
    admin.send({ payload: { t: 'warehouse:append', table: 'trips', rows: [{ id: 1 }], reqId: 'w1' } })
    expect((await admin.reply('w1'))?.reason).toMatch(/may not write trips/)
    expect((await at('/do/warehouse/grants', { method: 'POST', body: JSON.stringify({ table: 'trips', columns: ['id'], write: true, by: 'o@x.io' }) })).body.error).toMatch(/reads all of it/)
    expect((await at('/do/warehouse/grants', { method: 'POST', body: JSON.stringify({ table: 'trips', columns: null, write: true, by: 'o@x.io' }) })).body).toMatchObject({ grant: { trips: null }, writable: ['trips'] })
    const member = await socket({ role: 'runtime', token: jwt({ userId: 'm', email: 'mem@x.io', role: 'user' }) })
    member.send({ payload: { t: 'warehouse:append', table: 'trips', rows: [{ id: 1 }], reqId: 'w2' } })
    expect((await member.reply('w2'))?.reason).toMatch(/warehouse:append needs warehouse.append/)
    admin.close(); member.close()
  })
})

describe('in an organisation', () => {
  const OWNER = ORG_ROLES.owner.capabilities, ADMIN = ORG_ROLES.admin.capabilities
  it('people: an admin adds members and admins, never owners; an owner makes owners; the organisation keeps one', async () => {
    expect((await at('/org/users', { method: 'POST', headers: as('root@x.io', OWNER), body: JSON.stringify({ email: 'olga@x.io', role: 'owner' }) })).status).toBe(201)
    expect((await at('/org/users', { method: 'POST', headers: as('olga@x.io', OWNER), body: JSON.stringify({ email: 'adam@x.io', role: 'admin' }) })).status).toBe(201)
    expect((await at('/org/users', { method: 'POST', headers: as('adam@x.io', ADMIN), body: JSON.stringify({ email: 'pat@x.io', role: 'owner' }) })).body.error).toMatch(/do not hold: org.roles/)
    expect((await at('/org/users', { method: 'POST', headers: as('adam@x.io', ADMIN), body: JSON.stringify({ email: 'olga@x.io', role: 'member' }) })).body.error).toMatch(/holds more than you do/)
    expect((await at('/org/users', { method: 'POST', headers: as('adam@x.io', ADMIN), body: JSON.stringify({ email: 'mia@x.io' }) })).body.role).toBe('member')
    expect((await at('/org/users', { method: 'POST', headers: as('olga@x.io', OWNER), body: JSON.stringify({ email: 'olga@x.io', role: 'admin' }) })).body.error).toMatch(/must keep an owner/)
    expect((await at('/org/users', { method: 'DELETE', headers: as('olga@x.io', OWNER), body: JSON.stringify({ email: 'olga@x.io' }) })).body.error).toMatch(/must keep an owner/)
    expect((await at('/org/me?email=mia@x.io')).body).toMatchObject({ member: true, role: 'member', capabilities: [] })
  })
  it('roles: an owner defines a data engineer; a member given it may query and write the warehouse, not manage it', async () => {
    expect((await at('/org/roles', { method: 'POST', headers: as('olga@x.io', OWNER), body: JSON.stringify({ name: 'Data engineer', capabilities: ['warehouse.query', 'warehouse.write'] }) })).status).toBe(201)
    expect((await at('/org/users', { method: 'POST', headers: as('adam@x.io', ADMIN), body: JSON.stringify({ email: 'mia@x.io', role: 'data-engineer' }) })).body.role).toBe('data-engineer')
    expect((await at('/org/me?email=mia@x.io')).body.capabilities).toEqual(['warehouse.query', 'warehouse.write'])
    expect((await at('/org/roles', { method: 'DELETE', headers: as('olga@x.io', OWNER), body: JSON.stringify({ id: 'data-engineer' }) })).body.error).toMatch(/1 person holds/)
    const events = (await at('/org/audit')).body.events.map((e: any) => e.op)
    expect(events).toEqual(expect.arrayContaining(['person.add', 'person.role', 'role.set']))
  })
  it('organisation keys: within the maker\'s capabilities, cut to its scopes, and to what the maker holds now', async () => {
    const mia = as('mia@x.io', ['warehouse.query', 'warehouse.write'])
    expect((await at('/org/keys', { method: 'POST', headers: { ...mia, 'x-sa-org': ORG }, body: JSON.stringify({ name: 'loader', scopes: ['warehouse.manage'] }) })).body.error).toMatch(/do not hold: warehouse.manage/)
    const k = await at('/org/keys', { method: 'POST', headers: { ...mia, 'x-sa-org': ORG }, body: JSON.stringify({ name: 'loader', scopes: ['warehouse.write'] }) })
    expect(k.status).toBe(201)
    expect(k.body.key).toMatch(new RegExp(`^sak_org_${ORG}_`))
    const call = (body: unknown) => at('/org/agent', { method: 'POST', headers: { authorization: `Bearer ${k.body.key}`, 'x-sa-org': ORG }, body: JSON.stringify(body) })
    expect((await call({ t: 'warehouse:query', sql: 'select 1' })).status).toBe(403)               // not its scope
    expect((await call({ t: 'warehouse:create', name: 't', columns: [] })).status).toBe(403)
    const appended = await call({ t: 'warehouse:append', table: 'trips', rows: [{ id: 1 }] })
    expect(appended.status).not.toBe(403)                                                            // allowed; this test has no warehouse behind it
    expect(appended.body.error).toMatch(/not set up/)
    await at('/org/users', { method: 'POST', headers: as('adam@x.io', ADMIN), body: JSON.stringify({ email: 'mia@x.io', role: 'member' }) })   // demoted
    expect((await call({ t: 'warehouse:append', table: 'trips', rows: [{ id: 1 }] })).status).toBe(403)
    expect((await at('/org/agent', { method: 'POST', headers: { authorization: 'Bearer sak_org_other_' + 'x'.repeat(43), 'x-sa-org': ORG }, body: '{}' })).status).toBe(401)
  })
})
