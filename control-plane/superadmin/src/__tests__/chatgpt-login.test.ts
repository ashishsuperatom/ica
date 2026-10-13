// A ChatGPT login held and renewed by the platform (proxy/chatgpt-login.ts), through the real proxy, GlobalDO and
// ProjectDO (Miniflare), with ChatGPT's renewal played by a fake that rotates as the real one does (each refresh token
// works once): an engine is handed the current access token and never the refresh token; a login is renewed only when
// due, and ONCE however many engines ask at the same moment; an access token already run out is still renewed; each
// project gets the login of its own group; a login ChatGPT will no longer renew says what to do.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { parseLogin } from '../proxy/chatgpt-login'

const here = fileURLToPath(new URL('.', import.meta.url))
const P1 = '11111111-2222-3333-4444-5555555555a1', P2 = '11111111-2222-3333-4444-5555555555a2'
const harness = `
export { ProjectDO } from '../project-do.ts'
export { GlobalDO } from '../global-do.ts'
import { handleProxyHost } from '../proxy/index.ts'
export default { fetch: (req, env, ctx) => handleProxyHost(req, env, ctx) }`

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (account: string, inMs: number) => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor((Date.now() + inMs) / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: account } })}.sig`
const DAY = 86_400_000

// ChatGPT's token endpoint: a refresh token works once, and is answered with a new access token and a new refresh token.
const chatgpt = { live: new Set<string>(), renewals: 0, n: 0 }
let mf: Miniflare
const key = async (project: string) => {
  const r = await mf.dispatchFetch(`https://proxy.example.test/p/${project}/_key/openai-codex`, { headers: { authorization: 'Bearer ek' } })
  return { status: r.status, body: await r.json() as any }
}
const putVault = async (v: unknown) => (await mf.getKVNamespace('CREDENTIALS')).put('agent-credentials', JSON.stringify(v))
const getVault = async () => JSON.parse(await (await mf.getKVNamespace('CREDENTIALS')).get('agent-credentials') as string)

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true } },
    kvNamespaces: ['CREDENTIALS'], r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x' },
    outboundService: async (req: any) => {
      const u = new URL(req.url)
      if (u.host === 'auth.openai.com' && u.pathname === '/oauth/token') {
        const f = new URLSearchParams(await req.text())
        const rt = f.get('refresh_token')!
        if (f.get('grant_type') !== 'refresh_token' || !chatgpt.live.delete(rt)) return Response.json({ error: { code: 'invalid_refresh_token' } }, { status: 401 })
        chatgpt.renewals++
        await new Promise((r) => setTimeout(r, 50))   // slow enough for callers to arrive meanwhile
        const next = `rt-${++chatgpt.n}`; chatgpt.live.add(next)
        return Response.json({ access_token: jwt(rt.startsWith('rtB') ? 'acct-B' : 'acct-A', 10 * DAY), refresh_token: next, expires_in: 864000 })
      }
      return new Response('not here', { status: 404 })
    },
  })
  for (const p of [P1, P2]) {
    const stub = await mf.getDurableObjectNamespace('PROJECT')
    const s = stub.get(stub.idFromName(`proj:${p}`))
    await s.fetch('http://do/setup', { method: 'POST', headers: { 'x-sa-project': p }, body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: p }) })
  }
}, 90_000)
afterAll(async () => { await mf?.dispose() })

describe('a ChatGPT login, held and renewed by the platform', () => {
  it('a login is entered as `codex login` leaves it, or as its three parts; a bare token is not one', () => {
    const a = jwt('acct-A', DAY)
    expect(parseLogin(JSON.stringify({ tokens: { access_token: a, refresh_token: 'r', account_id: 'acct-A' } }))).toEqual({ access: a, refresh: 'r', accountId: 'acct-A' })
    expect(parseLogin(JSON.stringify({ access: a, refresh: 'r' }))).toEqual({ access: a, refresh: 'r', accountId: 'acct-A' })
    expect(parseLogin(a)).toBeNull()
  })

  it('an engine is handed the current access token — never the refresh token — and nothing is renewed before it is due', async () => {
    chatgpt.live = new Set(['rt-0']); chatgpt.renewals = 0
    const access = jwt('acct-A', 5 * DAY)
    await putVault({ entries: [{ id: 'gpt-a', provider: 'openai-codex', value: JSON.stringify({ access, refresh: 'rt-0' }) }], groups: {} })
    const r = await key(P1)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ keyId: 'gpt-a', key: access, accountId: 'acct-A', login: true })
    expect(JSON.stringify(r.body)).not.toContain('rt-0')
    expect(chatgpt.renewals).toBe(0)
  })

  it('due, it is renewed ONCE however many engines ask at the same moment, and the new refresh token is kept', async () => {
    await putVault({ entries: [{ id: 'gpt-a', provider: 'openai-codex', value: JSON.stringify({ access: jwt('acct-A', DAY), refresh: 'rt-0' }) }], groups: {} })
    const all = await Promise.all([key(P1), key(P1), key(P2)])
    expect(all.map((x) => x.status)).toEqual([200, 200, 200])
    expect(chatgpt.renewals).toBe(1)
    expect(new Set(all.map((x) => x.body.key)).size).toBe(1)
    const kept = JSON.parse((await getVault()).entries[0].value)
    expect(kept.refresh).toBe('rt-1')
    expect((await key(P1)).status).toBe(200)
    expect(chatgpt.renewals).toBe(1)   // good for ten days now: not renewed again
  })

  it('an access token that has already run out is still renewed — the login is good while its refresh token is', async () => {
    chatgpt.live = new Set(['rt-9']); chatgpt.renewals = 0
    await putVault({ entries: [{ id: 'gpt-a', provider: 'openai-codex', value: JSON.stringify({ access: jwt('acct-A', -3 * DAY), refresh: 'rt-9' }) }], groups: {} })
    const r = await key(P1)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(chatgpt.renewals).toBe(1)
  })

  it('each project gets the login of its own group', async () => {
    await putVault({ entries: [
      { id: 'gpt-a', provider: 'openai-codex', value: JSON.stringify({ access: jwt('acct-A', 9 * DAY), refresh: 'rtA' }), groups: ['alpha'] },
      { id: 'gpt-b', provider: 'openai-codex', value: JSON.stringify({ access: jwt('acct-B', 9 * DAY), refresh: 'rtB' }), groups: ['beta'] },
    ], groups: { [P1]: 'alpha', [P2]: 'beta' } })
    expect((await key(P1)).body).toMatchObject({ keyId: 'gpt-a', accountId: 'acct-A' })
    expect((await key(P2)).body).toMatchObject({ keyId: 'gpt-b', accountId: 'acct-B' })
  })

  it('a login ChatGPT will no longer renew says what to do', async () => {
    chatgpt.live = new Set()
    await putVault({ entries: [{ id: 'gpt-a', provider: 'openai-codex', value: JSON.stringify({ access: jwt('acct-A', DAY), refresh: 'rt-revoked' }) }], groups: {} })
    const r = await key(P1)
    expect(r.status).toBe(503)
    expect(r.body.error).toMatch(/could not be renewed.*Sign in again.*Credentials/)
  })
})
