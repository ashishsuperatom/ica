// What a project keeps in the shared bucket, through the REAL ProjectDO (Miniflare): every writer records its objects in
// the project's ledger (storage.ts) — bridges, program builds, parcels from the engine and from the platform — so the
// project knows how much it stores, by kind and by person; a person lists and deletes their own, someone who runs the
// project anyone's, and nothing in use is ever deleted. And secrets never take the general path: a connections reply
// far over a frame still goes inline on the engine's socket, never as a parcel.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { sealKeygen } from '../proxy/seal'
import { sha256Hex } from '../files'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const harness = `
import { routeSocket } from '../ws-route.ts'
import { handleObjectRoute } from '../parcels.ts'
import { remoteLedger } from '../storage.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const obj = u.pathname.match(/^\\/api\\/projects\\/([^/]+)\\/objects\\/([a-z]+)\\/(.+)$/)
  if (obj) return handleObjectRoute({ request: req, bucket: env.PACKAGES, secret: env.JWT_SECRET, projectId: obj[1], kind: obj[2], id: decodeURIComponent(obj[3]),
    isEngine: async () => (await stub.fetch('https://do/verify-conn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: (req.headers.get('authorization') || '').replace(/^bearer\\s+/i, '') }) })).ok,
    isMember: async () => null, ledger: remoteLedger(stub, obj[1]) })
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const as = (email: string, caps: string[]) => ({ 'content-type': 'application/json', 'x-sa-actor': JSON.stringify({ kind: 'user', id: email, email }), 'x-sa-caps': JSON.stringify(caps) })
const ADMIN = as('admin@test.io', ['project.view', 'project.manage', 'project.data', 'project.connect']), ANA = as('ana@test.io', ['project.view', 'project.ask'])
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json().catch(() => null) as any } }

async function engineSocket() {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!; const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: 'ek', instanceId: 'e', epoch: 1 }))
  const until = async (pred: (m: any) => boolean, ms = 8000) => { const t = Date.now(); for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error('nothing matched'); await new Promise((r) => setTimeout(r, 15)) } }
  await until((m) => m.payload?.t === 'welcome')
  return { ws, got, until }
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 's', CREDENTIALS_MASTER_KEY: sealKeygen() } })
  await at('/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('what a project keeps in the bucket', () => {
  let conn = '', bridgeKey = '', parcelKey = ''

  it('every writer records what it puts: a person\'s bridge, the engine\'s parcel; the same content counted once', async () => {
    conn = (await at('/do/connections', { method: 'POST', headers: ADMIN, body: JSON.stringify({ connector: 'code', name: 'SRC', values: {} }) })).body.connection.id
    const code = 'export function createBridge() { return { ready: () => true, query: async () => [], introspect: async () => ({ tables: [] }) } }\n'
    const b = await at(`/do/connections/${conn}/bridge`, { method: 'PUT', headers: ADMIN, body: JSON.stringify({ code }) })
    bridgeKey = `bridge/${PID}/${b.body.bridge}`
    const body = JSON.stringify({ t: 'x', rows: Array.from({ length: 500 }, (_, i) => i) })
    const hash = await sha256Hex(new TextEncoder().encode(body))
    parcelKey = `parcel/${PID}/${hash}`
    for (let i = 0; i < 2; i++) expect((await mf.dispatchFetch(`http://x/api/projects/${PID}/objects/parcel/${hash}`, { method: 'PUT', headers: { authorization: 'Bearer ek' }, body })).status).toBe(200)
    const s = (await at('/do/storage?list=1', { headers: ADMIN })).body
    expect(s.list.map((o: any) => [o.kind, o.by]).sort()).toEqual([['bridge', 'admin@test.io'], ['parcel', 'engine']])
    expect(s.objects).toBe(2)
    expect(s.bytes).toBe(new TextEncoder().encode(code).byteLength + new TextEncoder().encode(body).byteLength)
    expect(s.byKind.map((k: any) => k.kind).sort()).toEqual(['bridge', 'parcel'])
  })

  it('a person sees the totals and only their own; listing anyone\'s is for who runs the project', async () => {
    const mine = (await at('/do/storage?list=1', { headers: ANA })).body
    expect(mine.objects).toBe(2)                      // the project's totals
    expect(mine.byPerson).toEqual([])                 // but no one else's
    expect(mine.list).toEqual([])
    expect((await at('/do/storage?list=1&by=engine', { headers: ADMIN })).body.list.map((o: any) => o.key)).toEqual([parcelKey])
  })

  it('nothing in use is deleted; what is not, goes from the bucket and the ledger; not yours is refused', async () => {
    expect((await at('/do/storage', { method: 'DELETE', headers: ANA, body: JSON.stringify({ keys: [parcelKey] }) })).body.refused).toEqual([{ key: parcelKey, why: 'not yours' }])
    const r = (await at('/do/storage', { method: 'DELETE', headers: ADMIN, body: JSON.stringify({ keys: [bridgeKey, parcelKey] }) })).body
    expect(r.removed).toBe(1)
    expect(r.refused).toEqual([{ key: bridgeKey, why: 'in use: a data source runs this bridge' }])
    expect(await (await mf.getR2Bucket('PACKAGES')).head(parcelKey)).toBeNull()
    expect((await at('/do/storage', { headers: ADMIN })).body.objects).toBe(1)
  })

  it('everything of one person\'s, on their asking — what is in use stays', async () => {
    await at(`/do/connections/${conn}`, { method: 'DELETE', headers: ADMIN })   // the source goes: its bridge is no longer in use
    const r = (await at('/do/storage', { method: 'DELETE', headers: ADMIN, body: JSON.stringify({ everything: true }) })).body
    expect(r).toMatchObject({ removed: 1, refused: [] })
    expect((await at('/do/storage', { headers: ADMIN })).body).toMatchObject({ objects: 0, bytes: 0 })
  })

  it('the ledger takes only this project\'s objects, of the kind their key says', async () => {
    expect((await at('/do/storage/add', { method: 'POST', body: JSON.stringify({ rows: [{ key: `parcel/other-project/${'a'.repeat(64)}`, kind: 'parcel', bytes: 1, by: 'x' }] }) })).status).toBe(400)
    expect((await at('/do/storage/add', { method: 'POST', body: JSON.stringify({ rows: [{ key: `programs/${PID}/${'a'.repeat(64)}.json`, kind: 'parcel', bytes: 1, by: 'x' }] }) })).status).toBe(400)
  })

  it('secrets never take the general path: a connections reply far over a frame goes inline, never as a parcel', async () => {
    await at('/do/connections', { method: 'POST', headers: ADMIN, body: JSON.stringify({ connector: 'code', name: 'BIG', values: { secrets: { key: 'k'.repeat(400_000) } } }) })
    const e = await engineSocket()
    e.ws.send(JSON.stringify({ type: 'connections:pull', reqId: 'c1' }))
    const reply = await e.until((m) => m.payload?.reqId === 'c1')
    expect(reply.payload.parcel).toBeUndefined()
    expect(reply.payload.connections.find((c: any) => c.name === 'BIG').secrets.key.length).toBe(400_000)
    expect((await at('/do/storage?list=1&kind=parcel', { headers: ADMIN })).body.list).toEqual([])   // nothing of it went to the bucket
  })
})
