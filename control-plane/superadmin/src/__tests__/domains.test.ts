// Addresses (<name>.superatom.site) through the REAL GlobalDO (Miniflare): a project claims a free name and releases only
// its own; the platform sees every address and moves or takes back any of them, whoever holds it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const harness = `
export { GlobalDO } from '../global-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  return env.GLOBAL.get(env.GLOBAL.idFromName('global')).fetch(new Request('http://do' + u.pathname + u.search, req))
} }`
let mf: Miniflare
const at = async (path: string, method = 'GET', body?: unknown) => {
  const r = await mf.dispatchFetch(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() as any }
}
const all = async () => (await at('/domains/all')).body.domains.map((d: any) => `${d.subdomain}→${d.projectId}`)

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'], durableObjects: { GLOBAL: { className: 'GlobalDO', useSQLite: true } } })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('addresses', () => {
  it('a project claims a free name; another cannot take it, nor release it', async () => {
    expect((await at('/domains/claim', 'POST', { subdomain: 'acme', projectId: 'p1' })).status).toBe(201)
    expect((await at('/domains/claim', 'POST', { subdomain: 'acme', projectId: 'p2' })).status).toBe(409)
    expect((await at('/domains', 'DELETE', { subdomain: 'acme', projectId: 'p2' })).status).toBe(403)
    expect(await all()).toEqual(['acme→p1'])
  })
  it('the holder releases its own, and then another may claim it', async () => {
    expect((await at('/domains', 'DELETE', { subdomain: 'acme', projectId: 'p1' })).status).toBe(200)
    expect((await at('/domains/claim', 'POST', { subdomain: 'acme', projectId: 'p2' })).status).toBe(201)
    expect(await all()).toEqual(['acme→p2'])
  })
  it('the platform moves any address to another project, and takes any back', async () => {
    expect((await at('/domains/assign', 'PUT', { subdomain: 'acme', projectId: 'p3' })).body.ok).toBe(true)
    expect(await all()).toEqual(['acme→p3'])
    expect((await at('/domains/assign', 'PUT', { subdomain: 'Bad Name', projectId: 'p3' })).status).toBe(400)
    expect((await at('/domains/any', 'DELETE', { subdomain: 'acme' })).status).toBe(200)
    expect(await all()).toEqual([])
  })
})
