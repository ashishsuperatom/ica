// A project's agent profile, through the real ProjectDO (Miniflare): a change is checked at the door against the agent
// contract and the platform's models — an agent that is not one, a harness that cannot use that account, a model the
// account does not list are refused with the reason, and nothing is saved; a good one is saved and audited.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const P = '11111111-2222-3333-4444-5555555555c1'
let mf: Miniflare
const call = async (method: string, path: string, body?: unknown) => {
  const ns = await mf.getDurableObjectNamespace('PROJECT')
  const r = await ns.get(ns.idFromName(`proj:${P}`)).fetch(`http://do${path}`, { method, headers: { 'content-type': 'application/json', 'x-sa-project': P, 'x-sa-actor': JSON.stringify({ id: 'u1', email: 'admin@x.test' }) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() as any }
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: `export { ProjectDO } from '../project-do.ts'\nexport default { fetch: () => new Response('') }`, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true } }, kvNamespaces: ['CREDENTIALS'], r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x' } })
  await call('POST', '/setup', { apiKey: 'ek', provider: 'external', name: 'p' })
}, 90_000)
afterAll(async () => { await mf?.dispose() })

describe("a project's agent profile", () => {
  it('a good change is saved, and audited', async () => {
    const r = await call('PUT', '/profile', { profile: { agents: { composer: { harness: 'pi', provider: 'openai-codex', model: 'gpt-6-luna' } } } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await call('GET', '/profile')).body.profile.agents.composer.model).toBe('gpt-6-luna')
    const events = (await call('GET', '/audit?limit=20')).body.events ?? []
    expect(events.some((e: any) => e.action === 'profile.change')).toBe(true)
  })
  it('refused with the reason, nothing saved: a harness that cannot use the account', async () => {
    const r = await call('PUT', '/profile', { profile: { agents: { composer: { harness: 'claude-code-pty', provider: 'openai-codex', model: 'gpt-6-luna' } } } })
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/claude-code-pty cannot use openai-codex/)
    expect((await call('GET', '/profile')).body.profile.agents.composer.harness).toBe('pi')
  })
  it('refused: a model the account does not list', async () => {
    const r = await call('PUT', '/profile', { profile: { agents: { composer: { harness: 'pi', provider: 'openrouter', model: 'no-such-model' } } } })
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/openrouter has no model "no-such-model"/)
  })
  it('refused: an agent that is not one, a thinking level that is not one', async () => {
    expect((await call('PUT', '/profile', { profile: { agents: { wizard: { harness: 'pi', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' } } } })).body.error).toMatch(/"wizard" is not an agent/)
    expect((await call('PUT', '/profile', { profile: { agents: { narrator: { harness: 'pi', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', thinking: 'loud' } } } })).body.error).toMatch(/thinking "loud"/)
  })
})
