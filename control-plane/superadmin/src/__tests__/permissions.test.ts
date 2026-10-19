// Who may do what ("Permissions — who may do what", docs/platform-architecture.md): the one table (shared/permissions.ts)
// and its use in the REAL ProjectDO and OrgDO (Miniflare). A viewer looks and never asks; nothing smuggled in parts; no
// one gives more than they hold; a key holds what it was given that its maker holds, now; an organisation keeps an owner;
// a project appends to the warehouse only where the organisation granted writing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { personHeaders, seating, socketQuery } from './caller'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { ORG_ROLES, PROJECT_CAPABILITIES, PROJECT_CAPABILITY_GROUPS, PROJECT_ROLES, beyond, checkRole, keyHolds, messageNeeds, orgRouteNeeds, projectRouteNeeds } from '../../../shared/permissions'

describe('the table', () => {
  it('shows every project capability in exactly one group', () => {
    const grouped = PROJECT_CAPABILITY_GROUPS.flatMap((g) => g.capabilities)
    expect([...grouped].sort()).toEqual(Object.keys(PROJECT_CAPABILITIES).sort())
  })
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
    expect(projectRouteNeeds('GET', 'profile')).toBe('project.view')        // the agent profile: seen in the project,
    expect(projectRouteNeeds('PUT', 'profile')).toBe('project.manage')      // changed by its admin
    expect(projectRouteNeeds('POST', 'verify-model')).toBe('internal')      // never a public key oracle
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
  it('a query of one\'s own on a source is its own capability (it puts load on the client\'s database): admins and developers hold it, members and viewers do not', () => {
    expect(messageNeeds('connector:query')).toBe('project.query')
    expect(PROJECT_ROLES.admin.capabilities).toContain('project.query')
    expect(PROJECT_ROLES.developer.capabilities).toContain('project.query')
    expect(PROJECT_ROLES.member.capabilities).not.toContain('project.query')
  })
  it('changing connectors (their code runs on the engine) is its own capability: the Admin role holds it, a member does not', () => {
    expect(messageNeeds('connector:ask')).toBe('project.connectors')
    expect(PROJECT_ROLES.admin.capabilities).toContain('project.connectors')
    expect(PROJECT_ROLES.member.capabilities).not.toContain('project.connectors')
  })
  it('keys: a key holds what it was given that its maker holds now', () => {
    const member = PROJECT_ROLES.member.capabilities
    expect(beyond(['project.view', 'project.publish'], member)).toEqual(['project.publish'])
    expect(keyHolds(['project.view', 'project.ask'], PROJECT_ROLES.admin.capabilities)).toEqual(['project.view', 'project.ask'])
    expect(keyHolds(['project.view', 'project.ask'], PROJECT_ROLES.viewer.capabilities)).toEqual(['project.view'])
  })
})

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555', ORG = 'org-perm'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { OrgDO } from '../do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  if (u.pathname.startsWith('/org/')) return env.ORG.get(env.ORG.idFromName('${ORG}')).fetch(new Request('http://do' + u.pathname.slice(4) + u.search, req))
  const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json().catch(() => null) as any } }
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, v: 2, ...claims })}`
  return `${body}.${createHmac('sha256', 's').update(body).digest('base64url')}`
}
/** As the worker calls the ProjectDO: who is asking — it decides what their role holds (caller.ts seats them for real). */
const asP = seating((path, init) => mf.dispatchFetch(`http://x/do${path}`, init as any) as any)
/** As the worker calls the OrgDO: who is asking — their role in the organisation decides what they hold. */
const as = (email: string) => personHeaders(email)

async function socket(hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}${socketQuery(hello)}`, { headers: { upgrade: 'websocket' } })
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
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 's' } })
  await at('/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P', orgId: ORG }) })
  for (const [email, roleId] of [['admin@x.io', 'admin'], ['mem@x.io', 'member'], ['view@x.io', 'viewer']]) await at('/do/access', { method: 'POST', body: JSON.stringify({ email, roleId }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('in a project', () => {
  it('a viewer opens views and never asks; a member asks and never runs the engine', async () => {
    const engine = await socket({ role: 'code-engine', engineId: 'eng-test-0001', key: 'ek', instanceId: 'e1', epoch: Date.now() })
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
    member.send({ to: { type: 'code-engine' }, payload: { t: 'view:open', agent: 'a', reqId: 'm2' } })
    const admin = await socket({ role: 'runtime', token: jwt({ userId: 'a', email: 'admin@x.io', role: 'user' }) })
    admin.send({ to: { type: 'code-engine' }, payload: { t: 'view:open', agent: 'a', reqId: 'a2' } })
    await new Promise((r) => setTimeout(r, 200))
    expect(engine.got.find((m) => m.payload?.reqId === 'm2')?.from.admin).toBeUndefined()
    expect(engine.got.find((m) => m.payload?.reqId === 'a2')?.from.admin).toBe(true)
    for (const s of [engine, viewer, member, admin]) s.close()
  })
  it('a message in parts is checked whole: a member cannot hide an engine command in parts', async () => {
    const engine = await socket({ role: 'code-engine', engineId: 'eng-test-0001', key: 'ek', instanceId: 'e2', epoch: Date.now() + 1 })
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
    expect((await at('/do/roles', { method: 'POST', headers: await asP('admin@x.io', PROJECT_ROLES.admin.capabilities), body: JSON.stringify({ id: 'viewer', name: 'Viewer', capabilities: ['project.manage'] }) })).body.error).toMatch(/built-in/)
    expect((await at('/do/roles', { method: 'POST', headers: await asP('p@x.io', ['project.people', 'project.view']), body: JSON.stringify({ name: 'Analyst', capabilities: ['project.view', 'project.ask'] }) })).status).toBe(403)
    const made = await at('/do/roles', { method: 'POST', headers: await asP('admin@x.io', PROJECT_ROLES.admin.capabilities), body: JSON.stringify({ name: 'Analyst', capabilities: ['project.view', 'project.ask', 'warehouse.use'] }) })
    expect(made.body.role).toMatchObject({ id: 'analyst', capabilities: ['project.view', 'project.ask', 'warehouse.use'] })
    const roles = (await at('/do/roles')).body.roles
    expect(roles.find((r: any) => r.id === 'viewer').capabilities).toEqual(['project.view'])
    expect(roles.map((r: any) => r.id).filter((id: string) => !id.startsWith('t-'))).toEqual(['admin', 'developer', 'member', 'viewer', 'analyst'])   // t-…: the test's own seating
    expect((await at('/do/access-domains', { method: 'POST', body: JSON.stringify({ domain: 'acme.com', roleId: 'admin', by: 'admin@x.io' }) })).body.error).toMatch(/member at most/)
  })
  it('keys: no one gives a key more than they hold; a demoted maker takes the key\'s power with them', async () => {
    expect((await at('/do/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'k', capabilities: ['project.publish'], by: 'mem@x.io' }) })).body.error).toMatch(/does not hold: project.publish/)
    const k = await at('/do/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'k', capabilities: ['project.view', 'project.ask'], by: 'mem@x.io' }) })
    expect(k.status).toBe(201)
    const engine = await socket({ role: 'code-engine', engineId: 'eng-test-0001', key: 'ek', instanceId: 'e3', epoch: Date.now() + 2 })
    const agent = await socket({ role: 'agent', key: k.body.key })
    agent.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: 'q', reqId: 'k1' } })
    for (let t = 0; t < 60 && !engine.got.some((m) => m.payload?.reqId === 'k1'); t++) await new Promise((r) => setTimeout(r, 50))   // delivered, however slow the box
    expect(engine.got.some((m) => m.payload?.reqId === 'k1')).toBe(true)
    await at('/do/access', { method: 'POST', body: JSON.stringify({ email: 'mem@x.io', roleId: 'viewer' }) })   // demoted
    agent.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: 'q', reqId: 'k2' } })
    expect((await agent.reply('k2'))?.reason).toMatch(/analyse needs project.ask, which this key does not hold \(or its maker no longer holds\)/)
    await at('/do/access', { method: 'POST', body: JSON.stringify({ email: 'mem@x.io', roleId: 'member' }) })
    engine.close(); agent.close()
  })
  it('keys between equals: two project admins see each other\'s keys but cannot revoke them; the maker can; someone above both can; a key whose maker holds nothing any more anyone may clear', async () => {
    for (const email of ['pa@x.io', 'pb@x.io']) await at('/do/access', { method: 'POST', body: JSON.stringify({ email, roleId: 'admin' }) })
    await at('/do/access', { method: 'POST', body: JSON.stringify({ email: 'dev@x.io', roleId: 'developer' }) })
    const ADM = PROJECT_ROLES.admin.capabilities
    const roleOf = (by: string) => (by === 'dev@x.io' ? PROJECT_ROLES.developer.capabilities : ADM)   // each as they are seated above
    // an admin makes keys; a developer (no project.keys) has a key of their own (sacli login)
    const make = async (by: string, name: string) => (await at(by === 'dev@x.io' ? '/do/my-key' : '/do/agent-keys', { method: 'POST', headers: await asP(by, roleOf(by)), body: JSON.stringify({ name, capabilities: ['project.view'], by }) })).body.record.id
    const ka = await make('pa@x.io', 'a-loader'), kb = await make('pb@x.io', 'b-loader'), kd = await make('dev@x.io', 'dev-tool')
    const revoke = async (by: string, id: string) => at(`/do/agent-keys/${id}?by=${by}`, { method: 'DELETE', headers: await asP(by, roleOf(by)) })
    const listed = (await at('/do/agent-keys?by=pa@x.io', { headers: await asP('pa@x.io', ADM) })).body.keys
    expect(listed.find((k: any) => k.id === kb)).toMatchObject({ mayRevoke: false, whyNot: expect.stringMatching(/"b-loader" was made by pb@x.io: they hold as much as you do/) })
    expect(listed.find((k: any) => k.id === ka).mayRevoke).toBe(true)
    expect((await revoke('pa@x.io', kb)).body.error).toMatch(/they hold as much as you do — someone above you both does this/)
    expect((await revoke('pa@x.io', kd)).status).toBe(200)               // a developer's: an admin is above
    expect((await revoke('pb@x.io', kb)).status).toBe(200)               // one's own
    expect((await revoke('ashish@superatom.ai', ka)).status).toBe(200)   // the platform's superadmin: above everyone
    // the maker gone (no role here): their key holds nothing — anyone with keys may clear it
    const kx = await make('pa@x.io', 'left-behind')
    await at('/do/access', { method: 'DELETE', body: JSON.stringify({ email: 'pa@x.io' }) })
    expect((await revoke('pb@x.io', kx)).status).toBe(200)
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
  // The organisation's first owner, added by the platform's admin (as when the organisation is made).
  beforeAll(async () => { await at('/org/users', { method: 'POST', headers: personHeaders('ashish@superatom.ai'), body: JSON.stringify({ email: 'root@x.io', role: 'owner' }) }) })
  it('people: an admin adds members, never admins or owners; an owner makes both; two admins leave each other alone; one steps down, never up; the organisation keeps an owner', async () => {
    expect((await at('/org/users', { method: 'POST', headers: as('root@x.io'), body: JSON.stringify({ email: 'olga@x.io', role: 'owner' }) })).status).toBe(201)
    expect((await at('/org/users', { method: 'POST', headers: as('olga@x.io'), body: JSON.stringify({ email: 'adam@x.io', role: 'admin' }) })).status).toBe(201)
    expect((await at('/org/users', { method: 'POST', headers: as('adam@x.io'), body: JSON.stringify({ email: 'pat@x.io', role: 'owner' }) })).body.error).toMatch(/do not hold: org.roles/)
    expect((await at('/org/users', { method: 'POST', headers: as('adam@x.io'), body: JSON.stringify({ email: 'olga@x.io', role: 'member' }) })).body.error).toMatch(/olga@x.io's role: they hold more than you do/)
    // the hierarchy: an admin gives only roles below an admin; two admins leave each other alone — an owner decides
    expect((await at('/org/users', { method: 'POST', headers: as('adam@x.io'), body: JSON.stringify({ email: 'ada@x.io', role: 'admin' }) })).body.error).toMatch(/you give only a role below your own — someone above an admin \(an owner\) gives "admin"/)
    expect((await at('/org/users', { method: 'POST', headers: as('olga@x.io'), body: JSON.stringify({ email: 'ada@x.io', role: 'admin' }) })).status).toBe(201)
    expect((await at('/org/users', { method: 'POST', headers: as('adam@x.io'), body: JSON.stringify({ email: 'ada@x.io', role: 'member' }) })).body.error).toMatch(/ada@x.io's role: they hold as much as you do — someone above you both does this/)
    expect((await at('/org/users', { method: 'DELETE', headers: as('adam@x.io'), body: JSON.stringify({ email: 'ada@x.io' }) })).body.error).toMatch(/removing ada@x.io: they hold as much as you do/)
    expect((await at('/org/users', { method: 'POST', headers: as('ada@x.io'), body: JSON.stringify({ email: 'ada@x.io', role: 'owner' }) })).status).toBe(403)   // never up
    expect((await at('/org/users', { method: 'POST', headers: as('ada@x.io'), body: JSON.stringify({ email: 'ada@x.io', role: 'member' }) })).status).toBe(200)   // down, herself
    expect((await at('/org/users', { method: 'DELETE', headers: as('olga@x.io'), body: JSON.stringify({ email: 'ada@x.io' }) })).status).toBe(200)            // the owner, above
    expect((await at('/org/users', { method: 'POST', headers: as('adam@x.io'), body: JSON.stringify({ email: 'mia@x.io' }) })).body.role).toBe('member')
    await at('/org/users', { method: 'DELETE', headers: personHeaders('ashish@superatom.ai'), body: JSON.stringify({ email: 'root@x.io' }) })   // the first owner leaves: olga is the last
    expect((await at('/org/users', { method: 'POST', headers: as('olga@x.io'), body: JSON.stringify({ email: 'olga@x.io', role: 'admin' }) })).body.error).toMatch(/must keep an owner/)
    expect((await at('/org/users', { method: 'DELETE', headers: as('olga@x.io'), body: JSON.stringify({ email: 'olga@x.io' }) })).body.error).toMatch(/must keep an owner/)
    expect((await at('/org/me?email=mia@x.io')).body).toMatchObject({ member: true, role: 'member', capabilities: [] })
  })
  it('roles: an owner defines a data engineer; a member given it may query and write the warehouse, not manage it', async () => {
    expect((await at('/org/roles', { method: 'POST', headers: as('olga@x.io'), body: JSON.stringify({ name: 'Data engineer', capabilities: ['warehouse.query', 'warehouse.write'] }) })).status).toBe(201)
    expect((await at('/org/users', { method: 'POST', headers: as('adam@x.io'), body: JSON.stringify({ email: 'mia@x.io', role: 'data-engineer' }) })).body.role).toBe('data-engineer')
    expect((await at('/org/me?email=mia@x.io')).body.capabilities).toEqual(['warehouse.query', 'warehouse.write'])
    expect((await at('/org/roles', { method: 'DELETE', headers: as('olga@x.io'), body: JSON.stringify({ id: 'data-engineer' }) })).body.error).toMatch(/1 person holds/)
    const events = (await at('/org/audit')).body.events.map((e: any) => e.op)
    expect(events).toEqual(expect.arrayContaining(['person.add', 'person.role', 'role.set']))
  })
  it('billing details: required fields checked, the latest in force, the change recorded', async () => {
    const put = (body: unknown) => at('/org/billing', { method: 'PUT', headers: as('olga@x.io'), body: JSON.stringify(body) })
    expect((await put({ name: 'Acme' })).body.error).toMatch(/billing email/)
    expect((await put({ name: 'Acme', email: 'ap@acme.com' })).body.error).toMatch(/first line, a city and a country/)
    expect((await put({ name: 'Acme', email: 'ap@acme.com', line1: '1 Main St', city: 'Auckland', country: 'NZ', taxId: 'NZ123' })).body.details).toMatchObject({ name: 'Acme', taxId: 'NZ123' })
    expect((await at('/org/billing')).body.details.city).toBe('Auckland')
    expect((await at('/org/audit')).body.events.map((e: any) => e.op)).toContain('billing.details')
  })
  it('organisation keys: within the maker\'s capabilities, holding what it was given that the maker holds now', async () => {
    const mia = as('mia@x.io')
    // making organisation keys needs org.keys: her role gains it
    await at('/org/roles', { method: 'POST', headers: as('olga@x.io'), body: JSON.stringify({ id: 'data-engineer', name: 'Data engineer', capabilities: ['warehouse.query', 'warehouse.write', 'org.keys'] }) })
    expect((await at('/org/keys', { method: 'POST', headers: { ...mia, 'x-sa-org': ORG }, body: JSON.stringify({ name: 'loader', capabilities: ['warehouse.manage'] }) })).body.error).toMatch(/does not hold: warehouse.manage/)
    const k = await at('/org/keys', { method: 'POST', headers: { ...mia, 'x-sa-org': ORG }, body: JSON.stringify({ name: 'loader', capabilities: ['warehouse.write'] }) })
    expect(k.status).toBe(201)
    expect(k.body.key).toMatch(new RegExp(`^sak_org_${ORG}_`))
    // as the key's person's UserDO passes it on, having checked it: which key, and whose
    const call = (body: unknown) => at('/org/agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-org': ORG, 'x-sa-caller': JSON.stringify({ kind: 'agent', keyId: k.body.record.id, email: 'mia@x.io' }) }, body: JSON.stringify(body) })
    expect((await call({ t: 'warehouse:query', sql: 'select 1' })).status).toBe(403)               // not given it
    expect((await call({ t: 'warehouse:create', name: 't', columns: [] })).status).toBe(403)
    const appended = await call({ t: 'warehouse:append', table: 'trips', rows: [{ id: 1 }] })
    expect(appended.status).not.toBe(403)                                                            // allowed; this test has no warehouse behind it
    expect(appended.body.error).toMatch(/not set up/)
    await at('/org/users', { method: 'POST', headers: as('adam@x.io'), body: JSON.stringify({ email: 'mia@x.io', role: 'member' }) })   // demoted
    expect((await call({ t: 'warehouse:append', table: 'trips', rows: [{ id: 1 }] })).status).toBe(403)
    expect((await at('/org/agent', { method: 'POST', headers: { authorization: 'Bearer sak_org_other_' + 'x'.repeat(43), 'x-sa-org': ORG }, body: '{}' })).status).toBe(401)
  })
})
