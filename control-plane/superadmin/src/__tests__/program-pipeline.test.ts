// Programs from source to a running session, through the REAL ProjectDO (Miniflare, R2 in memory): an agent sends a
// program's source; the engine builds it and uploads the bundle; the platform checks it against its hash, keeps it in R2
// and its catalogue as the agent's draft; only its owner publishes it; a second engine that never built it opens a
// session on it — fetched from the platform by name, checked again; a damaged bundle never runs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createProgramSeam } from '../../../../vm/apps/engine/program-seam.ts'
import { createSessionSeam } from '../../../../vm/apps/engine/session-seam.ts'
import { platformOf } from '../../../../vm/apps/engine/platform.ts'
import { createActivities } from '../../../../vm/apps/engine/activity.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const harness = `
export { ProjectDO } from '../project-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return stub.fetch(req)
  const eng = u.pathname.match(/^\\/api\\/engine\\/[0-9a-f-]{36}\\/(.+)$/)
  const path = eng ? '/engine/' + eng[1] : u.pathname.slice(3)
  const fwd = new Request('http://do' + path + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`

// Inside the package: vitest's module loader imports a built program only from under its root.
const root = mkdtempSync(join(here, '.home-'))
const homeA = join(root, 'a'), homeB = join(root, 'b')
let mf: Miniflare, data: Server
const call = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x/do${path}`, init); return r.json() as Promise<any> }

async function socket(hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!
  const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', ...hello }))
  const until = async (pred: (m: any) => boolean, ms = 8000) => {
    const t = Date.now()
    for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error(`nothing matched; got ${JSON.stringify(got.map((x) => x.payload?.t))}`); await new Promise((r) => setTimeout(r, 20)) }
  }
  await until((m) => m.payload?.t === 'welcome')
  let n = 0
  const ask = async (payload: any, to = 'code-engine') => { const reqId = `q${++n}-${Math.random()}`; ws.send(JSON.stringify({ to: { type: to }, payload: { ...payload, reqId } })); return (await until((m) => m.payload?.reqId === reqId)).payload }
  return { ws, got, until, ask }
}

/** An engine: the real program and session seams behind one hub connection, its own home. */
async function engine(home: string, instance: string) {
  const ws = await socket({ role: 'code-engine', key: 'engine-key', instanceId: instance, epoch: Date.now() })
  const platform = platformOf({ hub: `ws://x/_ws/${PID}?key=engine-key`, project: PID, key: 'engine-key', fetch: ((url: any, init: any) => mf.dispatchFetch(url, init)) as any })
  const send = (to: any, msg: any) => ws.ws.send(JSON.stringify({ to: { id: to.id, type: to.type }, payload: msg }))
  const activities = createActivities({ send: (m) => { ws.ws.send(JSON.stringify(m)); return true } })
  const programs = createProgramSeam({ projectDir: home, platform, send, activities })
  const sessions = createSessionSeam({ projectDir: home, datasource: `http://127.0.0.1:${(data.address() as any).port}`, send, ensureProgram: programs.ensure })
  ws.ws.addEventListener('message', (e: any) => {
    const m = JSON.parse(String(e.data)); const t = m.payload?.t
    if (t === 'program:build') void programs.handle(m.payload, m.from)
    else if (typeof t === 'string' && t.startsWith('session:')) void sessions.handle(m.payload, m.from)
  })
  return { ws, programs }
}
const sourceOf = (dir: string) => {
  const out: Record<string, string> = {}
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p).split('\\\\').join('/')] = readFileSync(p, 'utf8') } }
  walk(dir); return out
}
const agentSpec = (home: string) => { mkdirSync(join(home, 'agents'), { recursive: true }); writeFileSync(join(home, 'agents', 'trips.json'), JSON.stringify({ id: 'trips', name: 'Trips', scope: 'global', owner: 'user:b', domain: 'd', programs: ['unsettled-trips'], tools: [], ui: { start: 's' }, ica: 'composer' })) }

beforeAll(async () => {
  data = createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rows: [{ trip_no: 'T1', balance: 9 }] })) }) })
  await new Promise<void>((r) => data.listen(0, '127.0.0.1', () => r()))
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x' } })
  await call('/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'engine-key', provider: 'external', name: 'P' }) })
  await call('/access', { method: 'POST', body: JSON.stringify({ email: 'admin@test.io', roleId: 'admin' }) })   // the keys' maker administers the project
}, 60_000)
afterAll(async () => { data?.close(); await mf?.dispose(); rmSync(root, { recursive: true, force: true }) })

describe('programs: source → built → kept → published → running elsewhere', () => {
  let builderKey = '', otherKey = '', hash = ''
  it('an agent sends source; the engine builds and uploads it; the platform keeps it as the agent\'s draft', async () => {
    await engine(homeA, 'a')
    const mk = async (name: string) => (await call('/agent-keys', { method: 'POST', body: JSON.stringify({ name, scopes: ['programs', 'sessions'], by: 'admin@test.io' }) }))
    const k1 = await mk('builder'); builderKey = k1.key
    otherKey = (await mk('other')).key
    const agent = await socket({ role: 'agent', key: builderKey })
    const src = sourceOf(fileURLToPath(new URL('../../../../vm/packages/programs/test/fixtures/unsettled-trips', import.meta.url)))
    const built = await agent.ask({ t: 'program:build', files: src })
    expect(built).toMatchObject({ t: 'program:built', name: 'unsettled-trips', version: 1, added: true })
    hash = built.hash
    const list = await agent.ask({ t: 'program:list' }, 'hub')
    expect(list.programs).toHaveLength(1)
    expect(list.programs[0]).toMatchObject({ hash, name: 'unsettled-trips', owner: `agent:${k1.record.id}`, published_at: null })
    // the same source again is the same program: nothing new kept
    expect((await agent.ask({ t: 'program:build', files: src })).added).toBe(false)
    expect((await agent.ask({ t: 'program:build', files: { ...src, '../x.js': 'x' } })).reason).toMatch(/is not a file of a program's source/)
  })

  it('the build was visible while it ran: its owner saw it start and finish, and can list it; another agent cannot', async () => {
    const owner = await socket({ role: 'agent', key: builderKey })
    const src = sourceOf(fileURLToPath(new URL('../../../../vm/packages/programs/test/fixtures/unsettled-trips', import.meta.url)))
    await owner.ask({ t: 'program:build', files: { ...src, 'doc.md': src['doc.md'] + '\nAgain, to watch it.\n' } })
    await new Promise((r) => setTimeout(r, 100))
    const seen = owner.got.filter((m) => m.payload?.t === 'activity').map((m) => m.payload.activity.state)
    expect(seen).toEqual(['running', 'done'])
    const list = await owner.ask({ t: 'activity:list' }, 'hub')
    expect(list.activities[0]).toMatchObject({ kind: 'program.build', title: 'Building unsettled-trips', state: 'done' })
    const other = await socket({ role: 'agent', key: otherKey })
    expect((await other.ask({ t: 'activity:list' }, 'hub')).activities).toEqual([])
  })

  it('screens load its view from the platform (R2), file by file, without the engine', async () => {
    const r = await mf.dispatchFetch(`http://x/do/programs/${hash}/web/index.js`)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toMatch(/immutable/)
    expect(await r.text()).toMatch(/export function UnsettledTrips/)
    expect((await mf.dispatchFetch(`http://x/do/programs/${hash}/node/index.js`)).status).toBe(404)   // only the React side
  })

  it('only its owner publishes it; both attempts are in the audit history', async () => {
    const other = await socket({ role: 'agent', key: otherKey })
    expect((await other.ask({ t: 'program:publish', hash }, 'hub')).reason).toMatch(/its owner or an admin publishes it/)
    const owner = await socket({ role: 'agent', key: builderKey })
    expect((await owner.ask({ t: 'program:publish', hash }, 'hub')).program.published_at).toBeTruthy()
    expect((await owner.ask({ t: 'program:publish', hash }, 'hub')).reason).toMatch(/was already published/)
    const events = (await call('/audit?limit=100')).events.map((e: any) => `${e.action} ${e.outcome}`)
    expect(events).toContain('program.upload ok')
    expect(events).toContain('program.publish refused')
    expect(events).toContain('program.publish ok')
  })

  it('a second engine that never built it runs a session on it, fetched from the platform by name', async () => {
    agentSpec(homeB)
    const b = await engine(homeB, 'b')
    expect(() => b.programs.store.resolve('unsettled-trips')).toThrow()
    const agent = await socket({ role: 'agent', key: builderKey })
    const opened = await agent.ask({ t: 'session:open', session: 'p1', agent: 'trips' })
    expect(opened.t).toBe('session:view')
    const ran = await agent.ask({ t: 'session:intent', session: 'p1', call: { package: 'trips', fn: 'run' }, to: 'current' })
    expect(ran.result.answer.markdown.split('\n')[0]).toBe('1 trips are completed but not settled; 9 to settle.')
    expect(b.programs.store.resolve('unsettled-trips')).toBe(hash)
    expect(b.programs.store.verify(hash)).toBe(true)
  })

  it('a damaged bundle in storage is refused on the way out, never run', async () => {
    const bucket = await mf.getR2Bucket('PACKAGES')
    const key = `programs/${PID}/${hash}.json`
    const b = JSON.parse(await (await bucket.get(key))!.text())
    b.files['node/index.js'] += '\n// changed in storage'
    await bucket.put(key, JSON.stringify(b))
    const r = await mf.dispatchFetch(`http://x/api/engine/${PID}/programs/${hash}`, { headers: { authorization: 'Bearer engine-key' } })
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).error).toMatch(/changed or damaged/)
    const nokey = await mf.dispatchFetch(`http://x/api/engine/${PID}/programs/${hash}`, { headers: { authorization: 'Bearer wrong' } })
    expect(nokey.status).toBe(401)
  })
})
