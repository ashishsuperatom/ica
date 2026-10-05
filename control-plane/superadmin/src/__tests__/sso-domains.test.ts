// Enterprise sign-in, provisioned on first arrival, in the REAL ProjectDO (Miniflare): a project admin lets a verified
// email domain in with a role; a person from that domain connects without being on the access list and is let in with
// that role — the grant recorded in the audit history; someone from another domain is refused; public mail domains and
// whole-domain admins are refused.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const SECRET = 'sso-secret'
const harness = `
export { ProjectDO } from '../project-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return stub.fetch(req)
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const call = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x/do${path}`, init); return { status: r.status, body: await r.json() as any } }
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}
async function connect(token: string) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!
  let closed: any = null, welcomed = false
  ws.addEventListener('message', (e: any) => { if (JSON.parse(String(e.data)).payload?.t === 'welcome') welcomed = true })
  ws.addEventListener('close', (e: any) => { closed = { code: e.code, reason: e.reason } })
  ws.accept(); ws.send(JSON.stringify({ type: 'hello', role: 'runtime', token }))
  for (let i = 0; i < 100 && !welcomed && !closed; i++) await new Promise((r) => setTimeout(r, 20))
  return { welcomed, closed }
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await call('/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('enterprise sign-in by verified domain', () => {
  it('an admin lets a domain in with a role — not a public mail domain, not as admin', async () => {
    expect((await call('/access-domains', { method: 'POST', body: JSON.stringify({ domain: 'gmail.com', by: 'admin@acme.com' }) })).body.error).toMatch(/public mail domain/)
    expect((await call('/access-domains', { method: 'POST', body: JSON.stringify({ domain: 'acme.com', roleId: 'admin', by: 'admin@acme.com' }) })).body.error).toMatch(/as a member at most/)
    expect((await call('/access-domains', { method: 'POST', body: JSON.stringify({ domain: 'acme.com', roleId: 'viewer', by: 'admin@acme.com' }) })).status).toBe(201)
  })
  it('someone from the domain is let in on first arrival with its role, and the grant is recorded; others are refused', async () => {
    expect((await connect(jwt({ userId: 'u1', email: 'Lee@ACME.com' }))).welcomed).toBe(true)
    const access = (await (await mf.dispatchFetch('http://x/do/access')).json() as any).access
    expect(access.find((a: any) => a.email === 'lee@acme.com')).toMatchObject({ role_id: 'viewer', source: 'domain' })
    const out = await connect(jwt({ userId: 'u2', email: 'eve@evil.io' }))
    expect(out.closed?.code).toBe(4003)
    const events = (await call('/audit?limit=50')).body.events
    expect(events.find((e: any) => e.action === 'access.grant')).toMatchObject({ target: 'lee@acme.com', outcome: 'ok', detail: { role: 'viewer' } })
    expect(events.find((e: any) => e.action === 'access-domain.add')).toMatchObject({ target: 'acme.com', actor: { email: 'admin@acme.com' } })
  })
  it('removing the domain lets nobody new in; those already in keep their access until revoked', async () => {
    expect((await call('/access-domains/acme.com?by=admin@acme.com', { method: 'DELETE' })).status).toBe(200)
    expect((await connect(jwt({ userId: 'u3', email: 'new@acme.com' }))).closed?.code).toBe(4003)
    expect((await connect(jwt({ userId: 'u1', email: 'lee@acme.com' }))).welcomed).toBe(true)
  })
})
