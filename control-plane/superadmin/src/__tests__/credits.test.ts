// Usage and credits through the REAL ProjectDO, OrgDO and GlobalDO (Miniflare): the platform sets a price list; a
// model call's tokens are recorded by the project, priced, and debited from its organisation; an organisation never
// given credits is not limited; one that has used all its credits is refused new work, with a sentence, recorded.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555', ORG = 'org-test'
const harness = `
export { ProjectDO } from '../project-do.ts'
export { OrgDO } from '../do.ts'
export { GlobalDO } from '../global-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  if (u.pathname.startsWith('/org/')) return env.ORG.get(env.ORG.idFromName('${ORG}')).fetch(new Request('http://do' + u.pathname.slice(4), req))
  if (u.pathname.startsWith('/global/')) return env.GLOBAL.get(env.GLOBAL.idFromName('global')).fetch(new Request('http://do' + u.pathname.slice(7), req))
  const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return stub.fetch(req)
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json() as any } }
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`
  return `${body}.${createHmac('sha256', 's').update(body).digest('base64url')}`
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 's' } })
  await at('/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P', orgId: ORG }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

async function ask(token: string) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!; const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'runtime', token }))
  for (let i = 0; i < 100 && !got.some((m) => m.payload?.t === 'welcome'); i++) await new Promise((r) => setTimeout(r, 20))
  ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: 'q', reqId: 'r1' } }))
  for (let i = 0; i < 50 && !got.some((m) => m.payload?.reqId === 'r1' || m.payload?.source === 'compute'); i++) await new Promise((r) => setTimeout(r, 20))
  return got.find((m) => m.payload?.reqId === 'r1')?.payload ?? got.find((m) => m.payload?.source === 'compute')?.payload
}

describe('usage and credits', () => {
  it('the platform sets prices (every version kept); a call is recorded, priced and debited from the organisation', async () => {
    expect((await at('/global/prices', { method: 'PUT', body: JSON.stringify({ prices: [{ provider: 'opencode-go', model: '*', in_per_million: 2, out_per_million: 8 }], by: 'root@x.io' }) })).status).toBe(200)
    const r = await at('/do/usage', { method: 'POST', body: JSON.stringify({ provider: 'opencode-go', model: 'gpt-6-luna', in: 1_000_000, out: 500_000, ms: 900 }) })
    expect(r.body).toEqual({ ok: true, credits_micro: 6_000_000, priced: true })
    const unpriced = await at('/do/usage', { method: 'POST', body: JSON.stringify({ provider: 'anthropic', model: 'x', in: 10, out: 10 }) })
    expect(unpriced.body.priced).toBe(false)
    const summary = (await at('/do/usage')).body.usage
    expect(summary.find((u: any) => u.provider === 'opencode-go')).toMatchObject({ calls: 1, tokens_in: 1_000_000, tokens_out: 500_000, credits_micro: 6_000_000, unpriced: 0 })
    expect(summary.find((u: any) => u.provider === 'anthropic').unpriced).toBe(1)
    expect((await at('/org/credits')).body).toMatchObject({ plan: false, used_micro: 6_000_000 })
  })
  it('an organisation never given credits is not limited', async () => {
    expect((await ask(jwt({ userId: 'u', email: 'u@x.io', role: 'superadmin' })))?.source).not.toBe('credits')
  })
  it('one on a credit plan that has used them all is refused new work, with a sentence, recorded', async () => {
    await at('/org/credits/grant', { method: 'POST', body: JSON.stringify({ credits: 5, by: 'root@x.io', note: 'trial' }) })
    expect((await at('/org/credits')).body).toMatchObject({ plan: true, granted_micro: 5_000_000, used_micro: 6_000_000, balance_micro: -1_000_000 })
    // the project's cached view of the balance is a minute old at most; a fresh DO reads it now
    const refused = await ask(jwt({ userId: 'u2', email: 'u2@x.io', role: 'superadmin' }))
    expect(refused).toMatchObject({ t: 'error', source: 'credits', reason: 'this organisation has used all its credits — an administrator can add more' })
    const events = (await at('/do/audit?limit=20')).body.events
    expect(events.find((e: any) => e.action === 'question.ask' && e.outcome === 'refused').detail.reason).toMatch(/used all its credits/)
    await at('/org/credits/grant', { method: 'POST', body: JSON.stringify({ credits: 10, by: 'root@x.io' }) })
    expect((await at('/org/credits')).body.balance_micro).toBe(9_000_000)
  })
})
