// One door per person, step 1 (docs/one-door-plan.md): the ProjectDO and the OrgDO decide every request about themselves,
// from their own rows, with the one standing a WebSocket gets too. Through the REAL Worker: each kind of person holds the
// same here whichever way they come; what the Worker is told is only who is asking; headers that say who is asking are
// never taken from outside; and a DO refuses on its own, whatever reached it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { capabilitiesOf, ORG_ROLES, PROJECT_ROLES } from '../../../shared/permissions'
import { personHeaders } from './caller'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '0d000d00-0000-4000-8000-000000000001', ORG = 'org-door'
// The Worker as deployed; /org/* and /pdo/* reach the OrgDO and the ProjectDO directly — the platform's own calls (setup).
const harness = `
import worker from '../worker.ts'
import { personHome, personId } from '../../../shared/identity.ts'
export { OrgDO, ProjectDO, GlobalDO, UserDO } from '../worker.ts'
export default { async fetch(req, env, ctx) {
  const u = new URL(req.url)
  if (u.pathname.startsWith('/org/')) return env.ORG.get(env.ORG.idFromName('${ORG}')).fetch(new Request('http://do' + u.pathname.slice(4) + u.search, req))
  // A person's door, reached directly (as the Worker does, without its own standing question first): /door/<email>/<path>;
  // their UserDO itself, raw: /udo/<email>/<path>.
  for (const [prefix, rawDO] of [['/door/', false], ['/udo/', true]]) if (u.pathname.startsWith(prefix)) {
    const tail = u.pathname.slice(prefix.length), cut = tail.indexOf('/'), email = decodeURIComponent(tail.slice(0, cut)), rest = tail.slice(cut)
    const home = env.USER.get(env.USER.idFromName(personHome('${ORG}', await personId(email))))
    if (rawDO) return home.fetch(new Request('http://do' + rest + u.search, req))
    const f = new Request('http://door/door/project/${PID}' + rest + u.search, req); f.headers.set('x-sa-caller', JSON.stringify({ kind: 'person', email })); return home.fetch(f)
  }
  if (u.pathname.startsWith('/pdo/')) { const f = new Request('http://do' + u.pathname.slice(4) + u.search, req); f.headers.set('x-sa-project', '${PID}'); return env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}')).fetch(f) }
  return worker.fetch(req, env, ctx)
} }`
let mf: Miniflare
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json().catch(() => null) as any } }
const jwt = (email: string, role = 'user') => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, v: 2, userId: `u_${email.replace(/\W/g, "_")}`, email, role })}`
  return `${body}.${createHmac('sha256', 's').update(body).digest('base64url')}`
}
const signedIn = (email: string, role = 'user') => ({ 'content-type': 'application/json', authorization: `Bearer ${jwt(email, role)}`, 'x-org-id': ORG })

async function socket(email: string) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}?token=${jwt(email)}`, { headers: { upgrade: 'websocket' } })
  if (!r.webSocket) throw new Error(`no socket: ${r.status} ${await r.text()}`)
  const ws = r.webSocket!; const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'runtime', token: jwt(email) }))
  await new Promise((r) => setTimeout(r, 200))
  const reply = async (reqId: string) => { for (let i = 0; i < 100; i++) { const m = got.find((x) => x.payload?.reqId === reqId); if (m) return m.payload; await new Promise((r) => setTimeout(r, 20)) } return null }
  return { send: (m: unknown) => ws.send(JSON.stringify(m)), reply, close: () => ws.close() }
}

// Who is here, and what each must hold — whichever door they come by.
const PEOPLE: [string, readonly string[]][] = [
  ['ashish@superatom.ai', capabilitiesOf('project')],   // the platform's admin
  ['olga@x.io', PROJECT_ROLES.admin.capabilities],      // the organisation's owner, mirrored as an admin
  ['ada@x.io', PROJECT_ROLES.admin.capabilities],
  ['dev@x.io', PROJECT_ROLES.developer.capabilities],
  ['mem@x.io', PROJECT_ROLES.member.capabilities],
  ['vie@x.io', PROJECT_ROLES.viewer.capabilities],
  ['cus@x.io', ['project.view', 'project.data']],       // a role of the project's own
]

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], kvNamespaces: ['DOMAINS', 'CREDENTIALS'], bindings: { JWT_SECRET: 's' } })
  await at('/pdo/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'Door', orgId: ORG }) })
  await at('/org/users', { method: 'POST', headers: { ...personHeaders('ashish@superatom.ai'), 'x-sa-org': ORG }, body: JSON.stringify({ email: 'olga@x.io', role: 'owner' }) })
  for (const e of ['ada', 'dev', 'mem', 'vie', 'cus']) await at('/org/users', { method: 'POST', headers: { ...personHeaders('olga@x.io'), 'x-sa-org': ORG }, body: JSON.stringify({ email: `${e}@x.io` }) })
  await at('/pdo/org-admins', { method: 'POST', body: JSON.stringify({ emails: ['olga@x.io'] }) })
  expect((await at('/pdo/roles', { method: 'POST', headers: personHeaders('olga@x.io'), body: JSON.stringify({ id: 'curator', name: 'Curator', capabilities: ['project.view', 'project.data'] }) })).status).toBe(200)
  for (const [email, roleId] of [['ada@x.io', 'admin'], ['dev@x.io', 'developer'], ['mem@x.io', 'member'], ['vie@x.io', 'viewer'], ['cus@x.io', 'curator']]) await at('/pdo/access', { method: 'POST', body: JSON.stringify({ email, roleId }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('one standing, decided where the facts are', () => {
  it('each kind of person holds the same by the Worker\'s door as the ProjectDO decides it', async () => {
    for (const [email, caps] of PEOPLE) {
      const me = (await at(`/api/projects/${PID}/me`, { headers: signedIn(email) })).body
      expect([...me.capabilities].sort(), email).toEqual([...caps].sort())
      const s = (await at('/pdo/standing', { headers: { 'x-sa-caller': JSON.stringify({ kind: 'person', email }) } })).body
      expect([...s.caps].sort(), email).toEqual([...caps].sort())
    }
    expect((await at(`/api/projects/${PID}/me`, { headers: signedIn('olga@x.io') })).body.level).toBe('org-admin')
    expect((await at(`/api/projects/${PID}/me`, { headers: signedIn('ashish@superatom.ai', 'superadmin') })).body.level).toBe('superadmin')
    expect((await at(`/api/projects/${PID}/me`, { headers: signedIn('stranger@y.io') })).status).toBe(401)
  })

  it('a socket is decided the same: asking needs project.ask — a viewer is refused, a member is not', async () => {
    const vie = await socket('vie@x.io'), mem = await socket('mem@x.io')
    vie.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: 'q', reqId: 'd1' } })
    mem.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: 'q', reqId: 'd2' } })
    expect((await vie.reply('d1'))?.reason).toMatch(/analyse needs project.ask/)
    expect(String((await mem.reply('d2'))?.reason ?? '')).not.toMatch(/needs project.ask/)
    vie.close(); mem.close()
  })

  it('who is asking is never taken from outside: a viewer claiming to be the platform\'s admin is still a viewer', async () => {
    const forged = { ...signedIn('vie@x.io'), 'x-sa-caller': JSON.stringify({ kind: 'person', email: 'ashish@superatom.ai' }), 'x-sa-caps': JSON.stringify(capabilitiesOf('project')) }
    expect((await at(`/api/projects/${PID}/agent-keys`, { method: 'POST', headers: forged, body: JSON.stringify({ name: 'k', capabilities: ['project.view'] }) })).status).toBe(403)
    expect((await at(`/api/projects/${PID}/me`, { headers: forged })).body.level).toBe('member')
    const nobody = { 'content-type': 'application/json', 'x-sa-caller': JSON.stringify({ kind: 'person', email: 'ashish@superatom.ai' }) }
    expect((await at(`/api/projects/${PID}/agent-keys`, { headers: nobody })).status).toBe(401)
  })

  it('the ProjectDO refuses on its own: what a route needs, checked against the caller it is told of', async () => {
    const as = (email: string) => ({ headers: { 'x-sa-caller': JSON.stringify({ kind: 'person', email }) } })
    const keys = await at('/pdo/agent-keys', { method: 'POST', ...as('vie@x.io'), body: JSON.stringify({ name: 'k', capabilities: ['project.view'] }) })
    expect(keys.status).toBe(403)
    expect(keys.body.error).toMatch(/this needs project.keys/)
    expect((await at('/pdo/agent-keys', { ...as('ada@x.io') })).status).toBe(200)
    expect((await at('/pdo/members', { method: 'POST', ...as('ashish@superatom.ai'), body: '{}' })).status).toBe(404)   // never public, whoever asks
    expect((await at('/pdo/agent-keys', { ...as('stranger@y.io') })).status).toBe(401)
  })

  it('a key holds what it was given that its maker holds now — decided in the ProjectDO', async () => {
    const k = await at('/pdo/agent-keys', { method: 'POST', headers: personHeaders('mem@x.io'), body: JSON.stringify({ name: 'mine', capabilities: ['project.view', 'project.ask'] }) })
    expect(k.status).toBe(403)   // a member holds no project.keys
    const own = await at('/pdo/my-key', { method: 'POST', headers: personHeaders('mem@x.io'), body: JSON.stringify({ name: 'mine', capabilities: ['project.view', 'project.ask'] }) })
    expect(own.status).toBe(201)
    const bearer = { authorization: `Bearer ${own.body.key}` }
    expect((await at(`/api/projects/${PID}/me`, { headers: bearer })).body).toMatchObject({ level: 'key', capabilities: ['project.ask', 'project.view'] })
    await at('/pdo/access', { method: 'POST', body: JSON.stringify({ email: 'mem@x.io', roleId: 'viewer' }) })   // the maker demoted
    expect((await at(`/api/projects/${PID}/me`, { headers: bearer })).body.capabilities).toEqual(['project.view'])
    await at('/pdo/access', { method: 'POST', body: JSON.stringify({ email: 'mem@x.io', roleId: 'member' }) })
  })

  it('the organisation decides the same way: what someone holds there is the OrgDO\'s answer', async () => {
    const me = (await at('/api/me', { headers: signedIn('olga@x.io') })).body
    expect(me).toMatchObject({ org: ORG, level: 'org-admin', role: 'owner' })
    expect([...me.capabilities].sort()).toEqual([...ORG_ROLES.owner.capabilities].sort())
    expect((await at('/api/me', { headers: signedIn('mem@x.io') })).body).toMatchObject({ level: 'member', capabilities: [] })
    const asMem = { headers: { 'content-type': 'application/json', 'x-sa-org': ORG, 'x-sa-caller': JSON.stringify({ kind: 'person', email: 'mem@x.io' }) } }
    const k = await at('/org/keys', { method: 'POST', ...asMem, body: JSON.stringify({ name: 'k', capabilities: ['org.billing'] }) })
    expect(k.status).toBe(403)
    expect(k.body.error).toMatch(/this needs org.keys/)
    expect((await at('/api/me', { headers: signedIn('stranger@y.io') })).status).toBe(401)
  })
})

describe('every person\'s request through their UserDO (step 2)', () => {
  it('a person\'s project request arrives through their door, and the ProjectDO still decides', async () => {
    const r = await mf.dispatchFetch(`http://x/api/projects/${PID}/agent-keys`, { headers: signedIn('ada@x.io') })
    expect(r.status).toBe(200); await r.text()
    expect(r.headers.get('x-sa-door')).toBe('person')
    const v = await mf.dispatchFetch(`http://x/api/projects/${PID}/agent-keys`, { headers: signedIn('vie@x.io') })
    expect(v.status).toBe(403)                                       // decided by the ProjectDO, behind the door
    expect(v.headers.get('x-sa-door')).toBe('person'); await v.text()
  })

  it('a person\'s organisation request and the organisations list arrive through their door too', async () => {
    const u = await mf.dispatchFetch('http://x/api/users', { headers: signedIn('olga@x.io') })
    expect(u.headers.get('x-sa-door')).toBe('person'); expect(u.status).toBe(200); await u.text()
    const o = await mf.dispatchFetch('http://x/api/organizations', { headers: signedIn('ashish@superatom.ai', 'superadmin') })
    expect(o.headers.get('x-sa-door')).toBe('person'); await o.text()
  })

  it('a key goes straight to its project until keys know their person (step 4) — decided the same', async () => {
    const own = await at('/pdo/my-key', { method: 'POST', headers: personHeaders('ada@x.io'), body: JSON.stringify({ name: 'door', capabilities: ['project.view', 'project.keys'] }) })
    const r = await mf.dispatchFetch(`http://x/api/projects/${PID}/agent-keys`, { headers: { authorization: `Bearer ${own.body.key}` } })
    expect(r.status).toBe(200); await r.text()
    expect(r.headers.get('x-sa-door')).toBeNull()
  })
})

describe('the guard (step 3)', () => {
  const door = (email: string, path: string, init?: RequestInit) => mf.dispatchFetch(`http://x/door/${encodeURIComponent(email)}${path}`, init)
  beforeAll(async () => {
    await at('/org/users', { method: 'POST', headers: { ...personHeaders('olga@x.io'), 'x-sa-org': ORG }, body: JSON.stringify({ email: 'gus@x.io' }) })
    await at('/pdo/access', { method: 'POST', body: JSON.stringify({ email: 'gus@x.io', roleId: 'viewer' }) })
  })

  it('what a fresh copy already refuses stops at the door, in the ProjectDO\'s own words', async () => {
    const r = await mf.dispatchFetch(`http://x/api/projects/${PID}/agent-keys`, { headers: signedIn('gus@x.io') })
    expect(r.status).toBe(403)
    expect(r.headers.get('x-sa-guard')).toBe('refused')   // the Worker's standing question just refreshed the copy
    expect(((await r.json()) as any).error).toBe('this needs project.keys, which your role here does not hold')
  })

  it('a promotion reaches the guard by push — never held back by an old copy', async () => {
    expect((await door('gus@x.io', '/agent-keys')).headers.get('x-sa-guard')).toBe('refused')
    await at('/pdo/access', { method: 'POST', body: JSON.stringify({ email: 'gus@x.io', roleId: 'admin' }) })
    let r = await door('gus@x.io', '/agent-keys')
    for (let i = 0; i < 50 && r.status !== 200; i++) { await new Promise((ok) => setTimeout(ok, 20)); r = await door('gus@x.io', '/agent-keys') }
    expect(r.status).toBe(200); await r.text()
  })

  it('a removal reaches it too; and a stale copy never lets anyone through — the ProjectDO decides again', async () => {
    await at('/pdo/access', { method: 'DELETE', body: JSON.stringify({ email: 'gus@x.io' }) })
    let r = await door('gus@x.io', '/agent-keys')
    for (let i = 0; i < 50 && r.headers.get('x-sa-guard') !== 'refused'; i++) { await new Promise((ok) => setTimeout(ok, 20)); r = await door('gus@x.io', '/agent-keys') }
    expect(r.status).toBe(401); expect(r.headers.get('x-sa-guard')).toBe('refused')
    // a copy that still says admin (as if the removal's push were lost): the guard lets it on, and the ProjectDO refuses it
    await mf.dispatchFetch(`http://x/udo/${encodeURIComponent('gus@x.io')}/door-standing`, { method: 'PUT', body: JSON.stringify({ kind: 'project', id: PID, standing: { ok: true, level: 'project-admin', caps: PROJECT_ROLES.admin.capabilities } }) })
    r = await door('gus@x.io', '/agent-keys')
    expect(r.status).toBe(401); expect(r.headers.get('x-sa-guard')).toBeNull(); await r.text()
  })
})
