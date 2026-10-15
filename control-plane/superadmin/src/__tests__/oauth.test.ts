// OAUTH — "Connect my account" (docs/connectors-plan.md R6) through the REAL Worker, OrgDO, ProjectDO and UserDO, with a
// stand-in for Google's token endpoint: an organisation admin registers the organisation's app (a member cannot; its
// secret never shown); a person starts a sign-in for a per-user connection and is sent to the provider with a signed
// state; the callback refuses a state not made by the platform, and one started in another browser (no cookie); the
// tokens are kept sealed in the person's UserDO; the engine is given an access token with when it ends — renewed when it
// ends soon, and dropped (the person told to connect again) when the provider refuses the refresh.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { sealKeygen } from '../proxy/seal'

const here = fileURLToPath(new URL('.', import.meta.url))
const SECRET = 'oauth-test'
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
const BOSS = jwt({ userId: 'b', email: 'boss@acme.io' }), ANA = jwt({ userId: 'a', email: 'ana@acme.io' })
const as = (token: string, org?: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(org ? { 'x-org-id': org } : {}) })
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json().catch(() => null) as any } }
let org = '', project = '', con = ''

// the stand-in for Google: codes and refresh tokens it knows, and what it was asked
const asked: Record<string, string>[] = []
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`
let nextExpiry = 3600

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], loader: { '.json': 'json' } })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], kvNamespaces: ['DOMAINS', 'CREDENTIALS'], bindings: { JWT_SECRET: SECRET, CREDENTIALS_MASTER_KEY: sealKeygen() },
    outboundService: async (req: any) => {
      const u = new URL(req.url)
      if (u.href !== 'https://oauth2.googleapis.com/token') return new Response('not here', { status: 404 })
      const form = Object.fromEntries(new URLSearchParams(await req.text())); asked.push(form)
      if (form.client_id !== 'cid.apps.googleusercontent.com' || form.client_secret !== 'shh') return Response.json({ error: 'invalid_client' }, { status: 401 })
      if (form.grant_type === 'authorization_code' && form.code === 'good' && form.redirect_uri === 'https://superatom.site/api/oauth/callback')
        return Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: nextExpiry, scope: 'x', id_token: idToken('ana.personal@gmail.com') })
      if (form.grant_type === 'authorization_code' && form.code === 'soon-revoked') return Response.json({ access_token: 'at-x', refresh_token: 'rt-dead', expires_in: 60, id_token: idToken('ana.personal@gmail.com') })
      if (form.grant_type === 'refresh_token' && form.refresh_token === 'rt-1') return Response.json({ access_token: 'at-2', expires_in: 3600 })
      return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 })
    } })
  org = (await at('/api/organizations', { method: 'POST', headers: as(SUPER), body: JSON.stringify({ name: 'Acme', adminEmail: 'boss@acme.io' }) })).body.id
  project = (await at('/api/projects', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ name: 'Alpha', provider: 'external' }) })).body.id
  expect((await at('/api/users', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ email: 'ana@acme.io', role: 'member' }) })).status).toBeLessThan(300)
  expect((await at('/api/assignments', { method: 'POST', headers: as(SUPER, org), body: JSON.stringify({ projectId: project, email: 'ana@acme.io', roleId: 'member' }) })).status).toBeLessThan(300)
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('connect my account (OAuth)', () => {
  let begin = '', state = '', cookie = ''
  it("the organisation's app with Google: set by an organisation admin, never shown back; a member cannot", async () => {
    expect((await at('/api/oauth-apps/google', { method: 'PUT', headers: as(ANA, org), body: JSON.stringify({ clientId: 'x', clientSecret: 'y' }) })).status).toBe(403)
    expect((await at('/api/oauth-apps/google', { method: 'PUT', headers: as(BOSS, org), body: JSON.stringify({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' }) })).status).toBe(200)
    const seen = (await at('/api/oauth-apps', { headers: as(ANA, org) })).body
    expect(seen.apps).toEqual([expect.objectContaining({ provider: 'google', client_id: 'cid.apps.googleusercontent.com', added_by: 'boss@acme.io' })])
    expect(JSON.stringify(seen)).not.toContain('shh')
    expect(seen.callback).toBe('https://superatom.site/api/oauth/callback')
    expect((await at(`/api/oauth-apps/google/client`, { headers: as(BOSS, org) })).status).toBeGreaterThanOrEqual(400)   // the secret: the platform's own only
  })
  it('a Google Sheets connection is read with each person\'s own account; a person starts a sign-in and is sent to Google with a signed state and a cookie', async () => {
    const made = await at(`/api/projects/${project}/connections`, { method: 'POST', headers: as(BOSS), body: JSON.stringify({ connector: 'google-sheets', name: 'SHEETS', values: {} }) })
    expect(made.status, JSON.stringify(made.body)).toBe(201); con = made.body.connection.id
    expect((await at(`/api/projects/${project}/connections`, { headers: as(BOSS) })).body.connections.find((c: any) => c.id === con).auth).toBe('per-user')   // no shared account at all
    const started = await at(`/api/projects/${project}/connections/${con}/oauth/start`, { method: 'POST', headers: as(ANA) })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    begin = started.body.url
    expect(begin).toMatch(/^https:\/\/superatom\.site\/api\/oauth\/begin\?t=/)
    const r = await mf.dispatchFetch(begin.replace('https://superatom.site', 'http://x'), { redirect: 'manual' })
    expect(r.status).toBe(302)
    const to = new URL(r.headers.get('location')!)
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(to.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com')
    expect(to.searchParams.get('redirect_uri')).toBe('https://superatom.site/api/oauth/callback')
    expect(to.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/spreadsheets.readonly')
    expect(to.searchParams.get('access_type')).toBe('offline')
    state = to.searchParams.get('state')!
    cookie = r.headers.get('set-cookie')!.split(';')[0]
    expect(cookie).toMatch(/^sa_oauth=[0-9a-f-]{36}$/)
  })
  it('the callback refuses a state the platform did not make, and one started in another browser; with the cookie, the tokens are kept sealed in her UserDO', async () => {
    const back = (q: Record<string, string>, headers: Record<string, string> = {}) => mf.dispatchFetch(`http://x/api/oauth/callback?${new URLSearchParams(q)}`, { headers })
    const forged = await back({ code: 'good', state: state.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) }, { cookie })
    expect(forged.status).toBe(400); expect(await forged.text()).toMatch(/not one the platform made/)
    const elsewhere = await back({ code: 'good', state })
    expect(elsewhere.status).toBe(400); expect(await elsewhere.text()).toMatch(/not started in this browser/)
    const denied = await back({ error: 'access_denied', state }, { cookie })
    expect(await denied.text()).toMatch(/Google did not connect it: access_denied/)
    const ok = await back({ code: 'good', state }, { cookie })
    const page = await ok.text()
    expect(ok.status, page).toBe(200)
    expect(page).toMatch(/Your Google account \(ana\.personal@gmail\.com\) is connected to SHEETS/)
    expect(ok.headers.get('set-cookie')).toMatch(/sa_oauth=; .*Max-Age=0/)   // used once
    const mine = (await at(`/api/projects/${project}/connections/${con}/my-key`, { headers: as(ANA) })).body
    expect(mine).toEqual({ given: true, account: { provider: 'google', email: 'ana.personal@gmail.com' } })   // whose — never a token
    expect(JSON.stringify(mine)).not.toMatch(/at-1|rt-1/)
    const audit = (await at(`/api/projects/${project}/audit?limit=50`, { headers: as(BOSS) })).body.events
    expect(audit.some((e: any) => e.action === 'connection.my-key.oauth' && e.detail?.account === 'ana.personal@gmail.com')).toBe(true)
  })
  it('the engine gets her access token with when it ends; one ending soon is renewed first; a refused refresh drops it and tells her to connect again', async () => {
    const engineKey = (await at(`/api/projects/${project}/engine-credentials`, { headers: as(BOSS) })).body.engineKey
    const r = await mf.dispatchFetch(`http://x/_ws/${project}?key=${engineKey}`, { headers: { upgrade: 'websocket' } })
    const ws = r.webSocket!; const got: any[] = []
    ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
    ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: engineKey, instanceId: 'oauth', epoch: Date.now() }))
    const until = async (f: (m: any) => boolean) => { for (let i = 0; i < 150 && !got.some(f); i++) await new Promise((res) => setTimeout(res, 20)); return got.find(f)?.payload }
    expect(await until((m) => m.payload?.t === 'welcome')).toBeTruthy()
    const ask = async (email: string, reqId: string) => { ws.send(JSON.stringify({ type: 'connection:person-key', reqId, name: 'SHEETS', email })); return until((m) => m.payload?.reqId === reqId) }
    const first = await ask('ana@acme.io', 'k1')
    expect(first.key.secrets).toEqual({ accessToken: 'at-1' })
    expect(first.key.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000)
    // someone who has not connected theirs: told how
    expect((await ask('boss@acme.io', 'k2'))).toMatchObject({ key: null, error: expect.stringMatching(/has not connected theirs — in the app: Connections → SHEETS → Connect my account/) })
    // connected again with a token that ends in a minute: renewed (the refresh token) before it is handed
    nextExpiry = 60
    const st2 = await at(`/api/projects/${project}/connections/${con}/oauth/start`, { method: 'POST', headers: as(ANA) })
    const r2 = await mf.dispatchFetch(st2.body.url.replace('https://superatom.site', 'http://x'), { redirect: 'manual' })
    const s2 = new URL(r2.headers.get('location')!).searchParams.get('state')!
    expect((await mf.dispatchFetch(`http://x/api/oauth/callback?${new URLSearchParams({ code: 'good', state: s2 })}`, { headers: { cookie: r2.headers.get('set-cookie')!.split(';')[0] } })).status).toBe(200)
    const renewed = await ask('ana@acme.io', 'k3')
    expect(renewed.key.secrets).toEqual({ accessToken: 'at-2' })
    expect(asked.at(-1)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' })
    // the provider refuses the refresh (revoked there): dropped, and she is told to connect again
    const st3 = await at(`/api/projects/${project}/connections/${con}/oauth/start`, { method: 'POST', headers: as(ANA) })
    const r3 = await mf.dispatchFetch(st3.body.url.replace('https://superatom.site', 'http://x'), { redirect: 'manual' })
    const s3 = new URL(r3.headers.get('location')!).searchParams.get('state')!
    expect((await mf.dispatchFetch(`http://x/api/oauth/callback?${new URLSearchParams({ code: 'soon-revoked', state: s3 })}`, { headers: { cookie: r3.headers.get('set-cookie')!.split(';')[0] } })).status).toBe(200)
    // kept sealed in her UserDO, by (project, connection)
    const users = await mf.getDurableObjectNamespace('USER')
    const { personHome, personId } = await import('../../../shared/identity')
    const home = users.get(users.idFromName(personHome(org, await personId('ana@acme.io'))))
    const kept = (await (await home.fetch(`http://do/connection-keys?project=${project}&connection=${con}`)).json() as any).sealed
    expect(kept).toBeTruthy(); expect(kept).not.toContain('rt-dead')
    expect(await ask('ana@acme.io', 'k4')).toMatchObject({ key: null, error: expect.stringMatching(/no longer connected .* connect it again/) })
    expect((await at(`/api/projects/${project}/connections/${con}/my-key`, { headers: as(ANA) })).body).toEqual({ given: false })
    ws.close()
  })
  it('a shared connection, or a connector that signs no one in, does not start a sign-in', async () => {
    const pg = await at(`/api/projects/${project}/connections`, { method: 'POST', headers: as(BOSS), body: JSON.stringify({ connector: 'postgres', name: 'PG', values: { host: 'h', database: 'd', user: 'u', password: 'p' } }) })
    expect((await at(`/api/projects/${project}/connections/${pg.body.connection.id}/oauth/start`, { method: 'POST', headers: as(ANA) })).body.error).toMatch(/one shared key/)
    expect((await at(`/api/projects/${project}/oauth/complete`, { method: 'POST', headers: as(BOSS), body: '{}' })).status).toBeGreaterThanOrEqual(400)   // the platform's own route only
    expect((await mf.dispatchFetch('http://x/api/oauth/begin?t=nonsense')).status).toBe(400)
    // a key given for a source people sign in to: told to connect the account instead
    expect((await at(`/api/projects/${project}/connections/${con}/my-key`, { method: 'PUT', headers: as(ANA), body: JSON.stringify({ values: { accessToken: 'x' } }) })).body.error).toMatch(/not a key — connect it in the app/)
  })
})
