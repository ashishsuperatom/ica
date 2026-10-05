// Cloud connectors through the REAL path (Miniflare): a connection made in the ProjectDO, its connector loaded into a
// Dynamic Worker whose only way out is the ConnectorGateway (credentials added there, other hosts refused), every
// request recorded; an action that changes something waits for a person; code mode reads through the proxy with no
// network of its own.

import { PROJECT_ROLES } from '../../../shared/permissions'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { sealKeygen } from '../proxy/seal'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const harness = `
export { ProjectDO } from '../project-do.ts'
export { ConnectorGateway, ConnectorProxy } from '../connectors/runtime.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const outbound: { url: string; auth: string | null }[] = []
const call = async (path: string, method = 'GET', body?: unknown, admin = true) => {
  const r = await mf.dispatchFetch(`http://x/do${path}`, { method, headers: { 'x-sa-actor': JSON.stringify({ kind: 'user', id: 'admin@x.io', email: 'admin@x.io' }), 'x-sa-caps': JSON.stringify((admin ? PROJECT_ROLES.admin : PROJECT_ROLES.member).capabilities) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() as any }
}
const op = (op: string, payload: Record<string, unknown>, sender: Record<string, unknown> = { type: 'runtime', email: 'admin@x.io', admin: true }) => call('/connector-op', 'POST', { sender: { wsId: 't', ...sender }, op, payload })
let conn = ''

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], workerLoaders: { LOADER: {} },
    bindings: { JWT_SECRET: 'x', CREDENTIALS_MASTER_KEY: sealKeygen() },
    // The outside world, as the gateway reaches it: a small JSON API.
    outboundService: async (req: any) => {
      outbound.push({ url: req.url, auth: req.headers.get('authorization') })
      const u = new URL(req.url)
      if (u.host !== 'api.shop.example') return new Response('no such host', { status: 502 })
      if (req.headers.get('authorization') !== 'Bearer tok-1') return Response.json({ error: 'no key' }, { status: 401 })
      if (u.pathname === '/v1/customers') return Response.json({ data: [{ id: 1, name: 'Acme', city: 'Pune' }, { id: 2, name: 'Beta', city: 'Goa' }] })
      return Response.json({}, { status: 404 })
    },
  })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  const made = await call('/connections', 'POST', { connector: 'rest-json', name: 'shop', level: 'project', values: { baseUrl: 'https://api.shop.example/v1', endpoints: 'customers /customers', token: 'tok-1' } })
  expect(made.status).toBe(201); conn = made.body.connection.id
}, 90_000)
afterAll(async () => { await mf?.dispose() })

describe('cloud connectors, run in a sandbox', () => {
  it('tests, introspects and reads through the gateway — the credential added there, every request recorded', async () => {
    const t = await op('test', { connection: conn })
    expect(t.status, JSON.stringify(t.body)).toBe(200)
    expect(t.body.result).toMatchObject({ ok: true })
    const i = await op('introspect', { connection: conn })
    expect(i.body.result.entities.map((e: any) => e.name)).toEqual(['customers'])
    expect(i.body.result.entities[0].fields.map((f: any) => f.name)).toEqual(['id', 'name', 'city'])
    const r = await op('read', { connection: conn, entity: 'customers', limit: 10 })
    expect(r.body.result.rows.map((x: any) => x.name)).toEqual(['Acme', 'Beta'])
    expect(outbound.every((o) => o.auth === 'Bearer tok-1')).toBe(true)
    await new Promise((res) => setTimeout(res, 200))
    const calls = (await op('calls', { connection: conn })).body.calls
    expect(calls.some((c: any) => c.op === 'read' && c.rows === 2)).toBe(true)
    expect(calls.some((c: any) => c.op === 'http' && c.target === 'GET api.shop.example/v1/customers' && c.status === 200)).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('tok-1')
  })
  it("a personal connection is its owner's; someone else is refused", async () => {
    const mine = await mf.dispatchFetch('http://x/do/connections', { method: 'POST', headers: { 'x-sa-actor': JSON.stringify({ kind: 'user', id: 'ana@x.io', email: 'ana@x.io' }) }, body: JSON.stringify({ connector: 'rest-json', name: 'anas', level: 'user', values: { baseUrl: 'https://api.shop.example/v1', endpoints: 'customers /customers', token: 'tok-1' } }) })
    const id = ((await mine.json()) as any).connection.id
    expect((await op('read', { connection: id, entity: 'customers' }, { type: 'runtime', email: 'bo@x.io' })).body.error).toMatch(/someone else's/)
    expect((await op('read', { connection: id, entity: 'customers' }, { type: 'runtime', email: 'ana@x.io' })).body.result.rows).toHaveLength(2)
  })
  it('code mode: a program reads through the proxy, with no network of its own', async () => {
    const r = await op('run', { code: `const r = await connectors.read('${conn}', { entity: 'customers', limit: 5 }); console.log('got', r.rows.length); return r.rows.map((x) => x.city)` })
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ ok: true, result: ['Pune', 'Goa'], logs: ['got 2'] })
    const net = await op('run', { code: `const res = await fetch('https://api.shop.example/v1/customers'); return res.status` })
    expect(net.body.ok).toBe(false)   // the program cannot reach the network itself
  })
})
