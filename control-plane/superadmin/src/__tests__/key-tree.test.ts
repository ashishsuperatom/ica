// The key tree through the REAL Worker (worker.ts in Miniflare): an organisation's key, made by a person, makes a
// project and that project's keys; a project key makes keys below it, never more than it holds; a key reaches only the
// keys below it; when a key goes, every key it made goes with it; no key makes an organisation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { ORG_ROLES } from '../../../shared/permissions'

const here = fileURLToPath(new URL('.', import.meta.url))
const ORG = 'org-tree'
// The Worker as deployed; /org/* reaches the OrgDO directly, as the console's own calls would after sign-in.
const harness = `
import worker from '../worker.ts'
export { OrgDO, ProjectDO, GlobalDO, UserDO } from '../worker.ts'
export default { async fetch(req, env, ctx) {
  const u = new URL(req.url)
  if (u.pathname.startsWith('/org/')) return env.ORG.get(env.ORG.idFromName('${ORG}')).fetch(new Request('http://do' + u.pathname.slice(4) + u.search, req))
  return worker.fetch(req, env, ctx)
} }`
let mf: Miniflare
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json().catch(() => null) as any } }
const as = (email: string, caps: readonly string[]) => ({ 'content-type': 'application/json', 'x-sa-org': ORG, 'x-sa-actor': JSON.stringify({ kind: 'user', id: email, email }), 'x-sa-caps': JSON.stringify(caps) })
const bearer = (key: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` })

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], kvNamespaces: ['DOMAINS', 'CREDENTIALS'], bindings: { JWT_SECRET: 's' } })
  // A person owns the organisation (people make organisations and their first keys).
  expect((await at('/org/users', { method: 'POST', headers: as('root@x.io', ORG_ROLES.owner.capabilities), body: JSON.stringify({ email: 'olga@x.io', role: 'owner' }) })).status).toBe(201)
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('one key tree, through the Worker', () => {
  let orgKey = '', orgKeyId = '', project = '', projKey = '', projKeyId = '', childKey = '', childKeyId = ''

  it('a person makes an organisation key; it holds what it was given that they hold', async () => {
    const made = await at('/org/keys', { method: 'POST', headers: as('olga@x.io', ORG_ROLES.owner.capabilities), body: JSON.stringify({ name: 'builder', capabilities: ['org.projects', 'org.keys'] }) })
    expect(made.status).toBe(201)
    orgKey = made.body.key; orgKeyId = made.body.record.id
    expect((await at('/api/me', { headers: bearer(orgKey) })).body).toMatchObject({ org: ORG, level: 'key', capabilities: ['org.keys', 'org.projects'] })
  })

  it('no key makes an organisation; a key outside its organisation is refused', async () => {
    expect((await at('/api/organizations', { method: 'POST', headers: bearer(orgKey), body: JSON.stringify({ name: 'mine' }) })).status).toBe(401)
    expect((await at('/api/me', { headers: { ...bearer(orgKey), 'x-org-id': 'someone-else' } })).status).toBe(401)
  })

  it('the organisation key makes a project and, there, a project key holding what it gives', async () => {
    const p = await at('/api/projects', { method: 'POST', headers: bearer(orgKey), body: JSON.stringify({ name: 'Made by a key', provider: 'external' }) })
    expect(p.status).toBe(201)
    project = p.body.id
    expect((await at('/api/projects', { headers: bearer(orgKey) })).body.map((x: any) => x.id)).toContain(project)
    expect((await at(`/api/projects/${project}/me`, { headers: bearer(orgKey) })).body).toMatchObject({ level: 'key', capabilities: expect.arrayContaining(['project.keys', 'project.manage']) })
    const k = await at(`/api/projects/${project}/agent-keys`, { method: 'POST', headers: bearer(orgKey), body: JSON.stringify({ name: 'project builder', capabilities: ['project.view', 'project.ask', 'project.keys'] }) })
    expect(k.status).toBe(201)
    projKey = k.body.key; projKeyId = k.body.record.id
    expect(k.body.record).toMatchObject({ created_by: 'olga@x.io', made_by_key: `org:${orgKeyId}` })
    expect((await at(`/api/projects/${project}/me`, { headers: bearer(projKey) })).body).toMatchObject({ level: 'key', capabilities: ['project.ask', 'project.keys', 'project.view'] })
  })

  it('storage at every level: the organisation, each project, each person — and each person in each project', async () => {
    const body = JSON.stringify({ t: 'x', n: [1, 2, 3] })
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, '0')).join('')
    expect((await mf.dispatchFetch(`http://x/api/projects/${project}/objects/parcel/${hash}`, { method: 'PUT', headers: bearer(projKey), body })).status).toBe(200)
    const billing = (await at('/org/keys', { method: 'POST', headers: as('olga@x.io', ORG_ROLES.owner.capabilities), body: JSON.stringify({ name: 'billing', capabilities: ['org.billing'] }) })).body.key
    const r = (await at('/api/storage', { headers: bearer(billing) })).body
    expect(r.bytes).toBe(body.length)
    expect(r.projects).toEqual([expect.objectContaining({ project, objects: 1, bytes: body.length })])
    expect(r.people).toEqual([{ by: 'olga@x.io', objects: 1, bytes: body.length, projects: [expect.objectContaining({ project, objects: 1, bytes: body.length })] }])   // a key's upload is its person's
    expect((await at('/api/storage', { headers: bearer(orgKey) })).status).toBe(403)   // the organisation key without org.billing
  })

  it('a project key makes keys below it, never more than it holds, and reaches only those', async () => {
    expect((await at(`/api/projects/${project}/agent-keys`, { method: 'POST', headers: bearer(projKey), body: JSON.stringify({ name: 'x', capabilities: ['project.manage'] }) })).status).toBe(403)
    const c = await at(`/api/projects/${project}/agent-keys`, { method: 'POST', headers: bearer(projKey), body: JSON.stringify({ name: 'reader', capabilities: ['project.view'] }) })
    expect(c.status).toBe(201)
    childKey = c.body.key; childKeyId = c.body.record.id
    expect(c.body.record.made_by_key).toBe(projKeyId)
    expect((await at(`/api/projects/${project}/agent-keys`, { headers: bearer(childKey) })).status).toBe(403)   // it does not hold project.keys
    // a sibling made by the organisation key is not below the project key
    const sib = await at(`/api/projects/${project}/agent-keys`, { method: 'POST', headers: bearer(orgKey), body: JSON.stringify({ name: 'sibling', capabilities: ['project.view'] }) })
    expect((await at(`/api/projects/${project}/agent-keys/${sib.body.record.id}`, { method: 'DELETE', headers: bearer(projKey) })).body.error).toBe('a key revokes only the keys below it')
    // a project's key reaches no other project, and no organisation route
    expect((await at('/api/me', { headers: bearer(projKey) })).status).toBe(401)
  })

  it('a removed project\'s keys hold nothing; restored, they hold again', async () => {
    const del = await at('/api/projects', { method: 'DELETE', headers: bearer(orgKey), body: JSON.stringify({ id: project }) })
    expect(del.status).toBe(200)
    expect((await at(`/api/projects/${project}/me`, { headers: bearer(childKey) })).status).toBe(401)
    expect((await at('/api/projects', { method: 'PUT', headers: bearer(orgKey), body: JSON.stringify({ id: project }) })).status).toBe(200)
    expect((await at(`/api/projects/${project}/me`, { headers: bearer(childKey) })).status).toBe(200)
  })

  it('when the organisation key goes, every key below it goes too', async () => {
    expect((await at(`/api/projects/${project}/me`, { headers: bearer(childKey) })).status).toBe(200)
    expect((await at(`/org/keys/${orgKeyId}`, { method: 'DELETE', headers: as('olga@x.io', ORG_ROLES.owner.capabilities) })).status).toBe(200)
    for (const k of [orgKey, projKey, childKey]) expect((await at(`/api/projects/${project}/me`, { headers: bearer(k) })).status).toBe(401)
    expect((await at('/api/me', { headers: bearer(orgKey) })).status).toBe(401)
  })
})
