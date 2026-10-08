// The platform's model list through the REAL ProjectDO (Miniflare): its hash is its content's; an engine whose hello names
// another hash (or none) gets the list in its welcome, one already holding it gets only the hash; a profile naming a model
// not in the list is refused when it is saved (the worker's checkProfile). And the engine's side: the list kept in the project's home, a model read
// from it, one not in it refused with how to add it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_MODELS } from '../../../shared/models'
import { checkProfile, modelLists } from '../model-lists'
import { harnessCanUse } from '../../../../vm/packages/agent-contract/contract.mjs'
// @ts-expect-error a plain script
import { hashOf } from '../../../../scripts/models.mjs'
import { initPlatformModels, platformModelsHash, receivePlatformModels, platformModel } from '../../../../vm/apps/engine/ica/platform-models.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare

async function welcome(modelsHash?: string) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!; const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: 'ek', instanceId: `e${Math.random()}`, epoch: Date.now(), ...(modelsHash !== undefined ? { modelsHash } : {}) }))
  for (let i = 0; i < 100 && !got.some((m) => m.payload?.t === 'welcome'); i++) await new Promise((r) => setTimeout(r, 20))
  ws.close()
  return got.find((m) => m.payload?.t === 'welcome').payload
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x' } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('the platform\'s model list', () => {
  it('its hash is its content\'s (changed only with pnpm models)', () => {
    expect(PLATFORM_MODELS.hash).toBe(hashOf(PLATFORM_MODELS.providers))
    // Every model has a name; one pi can run carries pi's description of it (how it is called).
    for (const [provider, models] of Object.entries(PLATFORM_MODELS.providers)) for (const m of models) {
      expect(m.id).toBeTruthy()
      if (harnessCanUse('pi', provider)) expect(m.api, `${provider}/${m.id}`).toBeTruthy()
    }
  })

  it('an engine gets the list in its welcome when its copy is another (or none); one holding it gets only the hash', async () => {
    const fresh = await welcome()
    expect(fresh.models).toEqual(PLATFORM_MODELS)
    expect((await welcome('an-old-hash')).models.providers).toBeDefined()
    expect(await welcome(PLATFORM_MODELS.hash).then((w) => w.models)).toEqual({ hash: PLATFORM_MODELS.hash })
  })

  it('a profile naming a model not in the list is refused when it is saved (checkProfile, over the platform\'s list only)', () => {
    const bad = checkProfile({ agents: { composer: { harness: 'pi', provider: 'opencode-go', model: 'no-such-model' } } }, modelLists())
    expect(bad.problems.join()).toMatch(/opencode-go does not serve no-such-model/)
    const ok = checkProfile({ agents: { composer: { harness: 'pi', provider: 'opencode-go', model: 'gpt-6-luna' }, analyst: { harness: 'claude-code-pty', provider: 'claude-code', model: 'claude-sonnet-5' } } }, modelLists())
    expect(ok.problems).toEqual([])
    expect(Object.keys(modelLists()).sort()).toEqual(Object.keys(PLATFORM_MODELS.providers).sort())
  })

  it('the engine keeps the list in the project\'s home and reads every model from it', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sa-models-')), 'models.json')
    initPlatformModels(file)
    expect(platformModelsHash()).toBe('')
    const [provider, models] = Object.entries(PLATFORM_MODELS.providers)[0]!
    const waiting = platformModel(provider, models[0]!.id, 2000)   // a first start waits for the welcome
    receivePlatformModels({ hash: PLATFORM_MODELS.hash })            // a welcome with only the hash changes nothing
    receivePlatformModels(PLATFORM_MODELS)
    expect((await waiting).id).toBe(models[0]!.id)
    expect(JSON.parse(readFileSync(file, 'utf8')).hash).toBe(PLATFORM_MODELS.hash)
    await expect(platformModel(provider, 'no-such-model')).rejects.toThrow(/not in the platform's model list.*pnpm models add/)
    initPlatformModels(file)                                         // a restart starts on the kept copy
    expect(platformModelsHash()).toBe(PLATFORM_MODELS.hash)
  })
})
