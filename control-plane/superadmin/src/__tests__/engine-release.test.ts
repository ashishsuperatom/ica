// Which release of the engine a project runs (docs/deploying-the-engine.md), through the real ProjectDO (Miniflare): the
// releases read from the registry bucket, a choice made by name and resolved to the digest it names now, a name that is
// not there or an image the registry cannot serve refused with the reason — nothing chosen that a box could not pull.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PROJECT_ROLES } from '../../../shared/permissions'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555556'
const harness = `
export { ProjectDO } from '../project-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: 'sha256:' + '1'.repeat(64), size: 1 }, layers: [] })
const DIGEST = `sha256:${createHash('sha256').update(manifest).digest('hex')}`
let mf: Miniflare
const call = async (path: string, method = 'GET', body?: unknown) => {
  const r = await mf.dispatchFetch(`http://x/do${path}`, { method, headers: { 'x-sa-actor': JSON.stringify({ kind: 'user', id: 'ops@x.io', email: 'ops@x.io' }), 'x-sa-caps': JSON.stringify(PROJECT_ROLES.admin.capabilities) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() as any }
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true } }, r2Buckets: ['PACKAGES', 'REGISTRY'],
    bindings: { JWT_SECRET: 'x' },
    // registry.superatom.ai as boxes see it: the one digest it holds is served, anything else is not.
    outboundService: async (req: any) => {
      const u = new URL(req.url)
      if (u.host === 'registry.superatom.ai' && u.pathname === `/v2/superatom-engine/manifests/${DIGEST}`) return new Response(manifest, { headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' } })
      return new Response('not found', { status: 404 })
    },
  })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  const reg = await mf.getR2Bucket('REGISTRY')
  for (const k of [DIGEST, 'dev-20261010-aaaa1111', 'dev']) await reg.put(`v2/superatom-engine/manifests/${k}`, manifest)
}, 90_000)
afterAll(async () => { await mf?.dispose() })

describe('the engine release a project runs', () => {
  it('lists the releases there are (by name, with the digest each names) and says nothing is chosen yet', async () => {
    const r = await call('/engine-release')
    expect(r.status).toBe(200)
    expect(r.body.desired).toBeNull()
    expect(r.body.online).toBe(false)
    expect(r.body.releases.map((x: any) => x.tag).sort()).toEqual(['dev', 'dev-20261010-aaaa1111'])
    expect(r.body.releases.every((x: any) => x.digest === DIGEST)).toBe(true)
  })
  it('a name that is not there is refused, with the names that are', async () => {
    const r = await call('/engine-release', 'PUT', { tag: 'dev-19990101-nope' })
    expect(r.status).toBe(404)
    expect(r.body.error).toMatch(/there is no release "dev-19990101-nope" — the newest are/)
  })
  it('a digest the registry does not serve is refused: a box could not pull it', async () => {
    const r = await call('/engine-release', 'PUT', { digest: 'sha256:' + 'f'.repeat(64) })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/does not serve/)
  })
  it('a release chosen by name is held as the digest it names, with who chose it; the engine (absent) is told when it comes', async () => {
    const r = await call('/engine-release', 'PUT', { tag: 'dev-20261010-aaaa1111' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.desired).toMatchObject({ digest: DIGEST, tag: 'dev-20261010-aaaa1111', setBy: 'ops@x.io' })
    expect(r.body.delivered).toBe(false)
    expect((await call('/engine-release')).body.desired.digest).toBe(DIGEST)
  })
  it('says nothing is chosen when the body names no release', async () => {
    expect((await call('/engine-release', 'PUT', {})).status).toBe(400)
  })
})

describe('the engine switch, step by step, as the box reports it', () => {
  const step = (body: Record<string, unknown>, key = 'ek') => mf.dispatchFetch('http://x/do/engine-release/progress', { method: 'POST', headers: { 'x-engine-key': key }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  const id = `${DIGEST}@2026-10-10T13:28:00.000Z`
  it('refuses a report without the project\'s engine key', async () => {
    expect((await step({ id, step: 'started', to: DIGEST }, 'wrong')).status).toBe(401)
  })
  it('keeps every step with its time, whole: the page sees the switch so far, and how it ended', async () => {
    expect((await step({ id, step: 'started', to: DIGEST, tag: 'dev-20261010-aaaa1111', from: 'old', at: '2026-10-10T13:28:00.000Z' })).status).toBe(200)
    await step({ id, step: 'pulled', at: '2026-10-10T13:28:20.000Z' })
    let sw = (await call('/engine-release')).body.switch
    expect(sw).toMatchObject({ id, state: 'switching', tag: 'dev-20261010-aaaa1111', startedAt: '2026-10-10T13:28:00.000Z' })
    expect(sw.steps.map((x: any) => x.step)).toEqual(['started', 'pulled'])
    await step({ id, step: 'rolled-back', at: '2026-10-10T13:30:00.000Z', reason: 'the new engine did not reach the platform within 90s', logTail: 'boom' })
    sw = (await call('/engine-release')).body.switch
    expect(sw).toMatchObject({ state: 'rolled-back', endedAt: '2026-10-10T13:30:00.000Z', reason: 'the new engine did not reach the platform within 90s', logTail: 'boom' })
  })
  it('a new switch starts a new record', async () => {
    await step({ id: 'other@2026-10-10T14:00:00.000Z', step: 'started', to: DIGEST, at: '2026-10-10T14:00:00.000Z' })
    const sw = (await call('/engine-release')).body.switch
    expect(sw.steps.map((x: any) => x.step)).toEqual(['started'])
    expect(sw.state).toBe('switching')
  })
  it('refuses a step it does not know', async () => {
    expect((await step({ id, step: 'teleported' })).status).toBe(400)
  })
})
