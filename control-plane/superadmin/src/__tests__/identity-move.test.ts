// People are their email (shared/identity.ts): a token carries personId(email), a person's own Durable Object is
// person:<org>:<personId>, and the move (identity-move.ts) brings each old id's work across — in the REAL ProjectDO and
// UserDOs (Miniflare): the dry run changes nothing, the move copies the person's rows into their new home and points
// what is current at the new id, the old home is left as it was, and a second run moves nothing twice.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { personId, personHome } from '../../../shared/identity'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555', ORG = 'org-acme'
// The real objects, with one test-only door each: SQL, to set up the old state as it is in production.
const harness = `
import { ProjectDO as P } from '../project-do.ts'
import { UserDO as U } from '../user-do.ts'
export class ProjectDO extends P { async sql(q, ...p) { return this.ctx.storage.sql.exec(q, ...p).toArray() } async move(dry) { return this.identityMigrate(dry) } }
export class UserDO extends U { async sql(q, ...p) { return this.ctx.storage.sql.exec(q, ...p).toArray() } }
export default { async fetch(req, env) {
  const u = new URL(req.url), b = u.pathname.endsWith('-sql') || u.pathname === '/move' ? await req.json() : null
  if (u.pathname === '/project-sql') return Response.json(await env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}')).sql(b.q, ...(b.p ?? [])))
  if (u.pathname === '/move') return Response.json(await env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}')).move(b.dry))
  if (u.pathname === '/user-sql') return Response.json(await env.USER.get(env.USER.idFromName(b.home)).sql(b.q, ...(b.p ?? [])))
  const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return stub.fetch(req)
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const post = async (path: string, body: unknown) => (await mf.dispatchFetch(`http://x${path}`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<any>
const psql = (q: string, ...p: unknown[]) => post('/project-sql', { q, p })
const usql = (home: string, q: string, ...p: unknown[]) => post('/user-sql', { home, q, p })

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x' } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P', orgId: ORG }) })
  await mf.dispatchFetch('http://x/do/access', { method: 'POST', body: JSON.stringify({ email: 'boss@acme.io', roleId: 'admin' }) })
  // The old state: Mia was user:clerk_dev (the development sign-in) and, since this morning, user:clerk_prod.
  for (const [s, who] of [['s1', 'clerk_dev'], ['s2', 'clerk_dev'], ['s3', 'clerk_prod']]) await psql('INSERT INTO session_owners (session, principal, email, first_seen) VALUES (?, ?, ?, ?)', s, `user:${who}`, 'Mia@Acme.io', '2026-10-01')
  await psql("INSERT INTO programs (hash, name, version, scope, owner, manifest, bytes, built_by, uploaded_at) VALUES (?, 'mine', 1, 'global', 'user:clerk_dev', '{}', 1, 'user:clerk_dev', '2026-10-01')", 'a'.repeat(64))
  await psql("INSERT INTO session_owners (session, principal, email, first_seen) VALUES ('s9', 'user:clerk_ghost', NULL, '2026-10-01')")
  for (const [home, s] of [['user:clerk_dev', 's1'], ['user:clerk_dev', 's2'], ['user:clerk_prod', 's3']]) {
    await usql(home, "INSERT INTO sessions (project, session, agent, title, blocks, answers, created, updated) VALUES (?, ?, 'trips', ?, 1, 1, '2026-10-01', '2026-10-01')", PID, s, `title ${s}`)
    await usql(home, "INSERT INTO session_entries (project, session, seq, entry, at) VALUES (?, ?, 1, '{}', '2026-10-01')", PID, s)
  }
  await usql('user:clerk_dev', "INSERT INTO sessions (project, session, agent, title, blocks, answers, created, updated) VALUES ('another-project', 'x1', 'a', 't', 1, 1, '2026-10-01', '2026-10-01')")
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('people are their email', () => {
  it('an id from the lower-cased email; a home named by organisation and id — the same email in two organisations is two homes', async () => {
    const id = await personId('Mia@Acme.io')
    expect(id).toBe(await personId(' mia@acme.io'))
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(personHome('org-a', id)).not.toBe(personHome('org-b', id))
    await expect(personId('not an address')).rejects.toThrow()
  })

  it('the move: a dry run reports and changes nothing; the move copies, repoints, keeps the old home; never twice', async () => {
    const a = { ask: (p: { dry: boolean }) => post('/move', { dry: p.dry }) }
    const mia = await personId('mia@acme.io'), home = personHome(ORG, mia)
    const dry = await a.ask({ dry: true })
    expect(dry.people).toEqual([expect.objectContaining({ email: 'mia@acme.io', from: expect.arrayContaining(['clerk_dev', 'clerk_prod']), to: mia, sessions: 3, programs: 1 })])
    expect(dry.people[0].rows).toMatchObject({ sessions: 3, session_entries: 3 })
    expect(dry.unmatched).toEqual(['clerk_ghost'])
    expect(await usql(home, 'SELECT * FROM sessions')).toEqual([])
    expect((await psql("SELECT COUNT(*) AS n FROM session_owners WHERE principal LIKE 'user:clerk_%'"))[0].n).toBe(4)

    const done = await a.ask({ dry: false })
    expect(done.people[0]).toMatchObject({ to: mia, rows: { sessions: 3, session_entries: 3 } })
    // Only this project's rows came: the other project's session stays where it was.
    expect((await usql(home, 'SELECT session FROM sessions ORDER BY session')).map((r: any) => r.session)).toEqual(['s1', 's2', 's3'])
    expect((await psql('SELECT principal FROM session_owners WHERE session = ?', 's1'))[0].principal).toBe(`user:${mia}`)
    expect((await psql('SELECT owner FROM programs'))[0].owner).toBe(`user:${mia}`)
    expect((await psql("SELECT principal FROM session_owners WHERE session = 's9'"))[0].principal).toBe('user:clerk_ghost')
    // The old homes are as they were.
    expect((await usql('user:clerk_dev', 'SELECT COUNT(*) AS n FROM sessions'))[0].n).toBe(3)

    const again = await a.ask({ dry: false })
    expect(again.people[0].already).toBe(true)
    expect((await usql(home, 'SELECT COUNT(*) AS n FROM session_entries'))[0].n).toBe(3)
  })
})
