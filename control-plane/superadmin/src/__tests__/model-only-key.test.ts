// The model-only key (agent-contract modelOnlyKeyOf), through the real proxy and ProjectDO (Miniflare): agents are given
// it instead of the engine's key. It proves the project at the model proxy and the tunnel; the hub's door (what an engine
// connects with, and is sent connections' secrets through) refuses it; a key derived from another project's, or from no
// key, proves nothing; rotating the engine key rotates it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { modelOnlyKeyOf } from '../../../../vm/packages/agent-contract/contract.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const P1 = '11111111-2222-3333-4444-5555555555b1', P2 = '11111111-2222-3333-4444-5555555555b2'
const harness = `
export { ProjectDO } from '../project-do.ts'
export { GlobalDO } from '../global-do.ts'
import { handleProxyHost } from '../proxy/index.ts'
export default { fetch: (req, env, ctx) => handleProxyHost(req, env, ctx) }`

let mf: Miniflare
const stub = async (p: string) => { const ns = await mf.getDurableObjectNamespace('PROJECT'); return ns.get(ns.idFromName(`proj:${p}`)) }
const verify = async (p: string, key: string) => (await mf.dispatchFetch(`https://proxy.example.test/p/${p}/_verify`, { headers: { authorization: `Bearer ${key}` } })).status
const hub = async (p: string, key: string) => (await (await stub(p)).fetch('http://do/verify-conn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })).status

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true } },
    kvNamespaces: ['CREDENTIALS'], r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x' } })
  for (const [p, k] of [[P1, 'sk-proj-one'], [P2, 'sk-proj-two']]) {
    await (await stub(p)).fetch('http://do/setup', { method: 'POST', headers: { 'x-sa-project': p }, body: JSON.stringify({ apiKey: k, provider: 'external', name: p }) })
  }
}, 90_000)
afterAll(async () => { await mf?.dispose() })

describe('the model-only key', () => {
  it('proves the project at the model proxy, as the engine key does', async () => {
    expect(await verify(P1, 'sk-proj-one')).toBe(200)
    expect(await verify(P1, await modelOnlyKeyOf('sk-proj-one'))).toBe(200)
  })
  it("is refused at the hub's door — an agent cannot connect as the engine", async () => {
    expect(await hub(P1, 'sk-proj-one')).toBe(200)
    expect(await hub(P1, await modelOnlyKeyOf('sk-proj-one'))).toBe(401)
  })
  it("proves nothing for another project, or when made up", async () => {
    expect(await verify(P2, await modelOnlyKeyOf('sk-proj-one'))).toBe(401)
    expect(await verify(P1, 'sk-proj-m-madeup')).toBe(401)
  })
  it('rotates with the engine key', async () => {
    const r: any = await (await (await stub(P1)).fetch('http://do/keys/add', { method: 'POST', headers: { 'x-sa-project': P1 } })).json()
    expect(r.apiKey).toMatch(/^sk-proj-/)
    expect(await verify(P1, await modelOnlyKeyOf(r.apiKey))).toBe(200)   // the new key's works at once
    expect(await verify(P1, await modelOnlyKeyOf('sk-proj-one'))).toBe(200)   // and the old one's until that key is dropped
  })
})
