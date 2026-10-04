// Sessions kept by the platform, end to end in the REAL Durable Objects (Miniflare): a person works in a session through
// the engine's real session seam; every append is pushed up (session-sync.ts) to the session's SessionDO, and the
// person's UserDO indexes it; the person lists and reads it back from the platform without the engine; nobody else can;
// a restart resends everything without a duplicate; a gap is healed; a conflicting entry is refused, never overwritten.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, ProgramStore } from '../../../../vm/packages/programs/src/index.ts'
import { createSessionSeam } from '../../../../vm/apps/engine/session-seam.ts'
import { createSessionSync } from '../../../../vm/apps/engine/session-sync.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const SECRET = 's3cret'
const harness = `
export { ProjectDO } from '../project-do.ts'
export { SessionDO } from '../session-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return stub.fetch(req)
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`

let mf: Miniflare, data: Server
// Inside the package: vitest's module loader imports a built program only from under its root.
const home = mkdtempSync(join(here, '.home-'))
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}
async function socket(hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!
  const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', ...hello }))
  const until = async (pred: (m: any) => boolean, ms = 4000) => {
    const t = Date.now()
    for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error(`nothing matched; got ${JSON.stringify(got.map((x) => x.payload?.t))}`); await new Promise((r) => setTimeout(r, 20)) }
  }
  await until((m) => m.payload?.t === 'welcome')
  return { ws, got, until, send: (m: unknown) => ws.send(JSON.stringify(m)) }
}
let engine: Awaited<ReturnType<typeof socket>>, sync: ReturnType<typeof createSessionSync>
const idle = async () => { for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 30)) } }
const settled = async (session: string, n: number) => {
  for (let i = 0; i < 150; i++) {
    const m = [...engine.got].reverse().find((x) => x.payload?.t === 'session:synced' && x.payload.session === session)
    if (m && m.payload.upto >= n) return m.payload
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error(`session ${session} never reached ${n}`)
}

beforeAll(async () => {
  data = createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rows: [{ trip_no: 'T1', balance: 4 }] })) }) })
  await new Promise<void>((r) => data.listen(0, '127.0.0.1', () => r()))
  buildProgram(fileURLToPath(new URL('../../../../vm/packages/programs/test/fixtures/unsettled-trips', import.meta.url)), new ProgramStore(join(home, 'programs', 'store')))
  mkdirSync(join(home, 'agents'))
  writeFileSync(join(home, 'agents', 'trips.json'), JSON.stringify({ id: 'trips', name: 'Trips', scope: 'global', owner: 'user:b', domain: 'd', programs: ['unsettled-trips'], tools: [], ui: { start: 's' }, ica: 'composer' }))
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, SESSION: { className: 'SessionDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  engine = await socket({ role: 'code-engine', key: 'ek', instanceId: 'e', epoch: 1 })
  sync = createSessionSync({ dir: join(home, 'sessions'), send: (m) => { engine.send(m); return true } })
  const seam = createSessionSeam({ projectDir: home, datasource: `http://127.0.0.1:${(data.address() as any).port}`, log: sync.log, send: (to, msg) => engine.send({ to: { id: to.id, type: to.type }, payload: msg }) })
  engine.ws.addEventListener('message', (e: any) => {
    const m = JSON.parse(String(e.data))
    if (m.payload?.t === 'session:synced') sync.onSynced(m.payload)
    else if (typeof m.payload?.t === 'string' && ['session:open', 'session:intent', 'session:get'].includes(m.payload.t)) void seam.handle(m.payload, m.from)
  })
}, 60_000)
afterAll(async () => { data?.close(); await mf?.dispose(); rmSync(home, { recursive: true, force: true }) })

describe('sessions kept by the platform', () => {
  let ana: Awaited<ReturnType<typeof socket>>
  it("a person's session reaches the platform as they use it, and they read it back from the platform alone", async () => {
    ana = await socket({ role: 'runtime', token: jwt({ userId: 'ana', email: 'ana@x.io', role: 'superadmin' }) })
    ana.send({ to: { type: 'code-engine' }, payload: { t: 'session:open', session: 's1', agent: 'trips', reqId: 'o' } })
    await ana.until((m) => m.payload?.reqId === 'o')
    ana.send({ to: { type: 'code-engine' }, payload: { t: 'session:intent', session: 's1', call: { package: 'trips', fn: 'run' }, to: 'current', reqId: 'i1' } })
    await ana.until((m) => m.payload?.reqId === 'i1')
    ana.send({ to: { type: 'code-engine' }, payload: { t: 'session:intent', session: 's1', ops: [{ op: 'set', path: 'trips.branch', value: 'PUNE' }], to: 'new', reqId: 'i2' } })
    await ana.until((m) => m.payload?.reqId === 'i2')
    const local = readFileSync(join(home, 'sessions', 's1', 'session.jsonl'), 'utf8').trim().split('\n').length
    expect((await settled('s1', local)).upto).toBe(local)
    ana.send({ payload: { t: 'session:list', reqId: 'l' }, to: { type: 'hub' } })
    const list = await ana.until((m) => m.payload?.reqId === 'l')
    expect(list.payload.sessions).toHaveLength(1)
    expect(list.payload.sessions[0]).toMatchObject({ session: 's1', agent: 'trips', blocks: 2, answers: 3, title: '1 trips are completed but not settled; 4 to settle.' })
    ana.send({ payload: { t: 'session:read', session: 's1', reqId: 'r' }, to: { type: 'hub' } })
    const read = await ana.until((m) => m.payload?.reqId === 'r')
    expect(read.payload.view.user).toBe('user:ana')
    expect(read.payload.view.blocks).toHaveLength(2)
    expect(read.payload.view.state.trips.branch).toBe('PUNE')
  })

  it('nobody else reads it', async () => {
    const bo = await socket({ role: 'runtime', token: jwt({ userId: 'bo', email: 'bo@x.io', role: 'superadmin' }) })
    bo.send({ payload: { t: 'session:read', session: 's1', reqId: 'r' }, to: { type: 'hub' } })
    expect((await bo.until((m) => m.payload?.reqId === 'r')).payload.reason).toBe('session s1 is not yours')
    bo.send({ payload: { t: 'session:list', reqId: 'l' }, to: { type: 'hub' } })
    expect((await bo.until((m) => m.payload?.reqId === 'l')).payload.sessions).toEqual([])
  })

  it('a restart that forgot what was sent resends it all, and the platform keeps one copy', async () => {
    rmSync(join(home, 'sessions', 's1', 'synced.json'))
    const before = engine.got.length
    sync.pushAll()
    for (let i = 0; i < 100 && !engine.got.slice(before).some((m) => m.payload?.t === 'session:synced'); i++) await new Promise((r) => setTimeout(r, 30))
    const again = engine.got.slice(before).find((m) => m.payload?.t === 'session:synced').payload
    const local = readFileSync(join(home, 'sessions', 's1', 'session.jsonl'), 'utf8').trim().split('\n').length
    expect(again.upto).toBe(local)
    ana.send({ payload: { t: 'session:read', session: 's1', reqId: 'r2' }, to: { type: 'hub' } })
    expect((await ana.until((m) => m.payload?.reqId === 'r2')).payload.upto).toBe(local)
  })

  it('a gap is healed: an engine that thinks the platform has more resends from what it really has', async () => {
    const lines = readFileSync(join(home, 'sessions', 's1', 'session.jsonl'), 'utf8')
    mkdirSync(join(home, 'sessions', 's2'))
    writeFileSync(join(home, 'sessions', 's2', 'session.jsonl'), lines.replaceAll('"session":"s1"', '"session":"s2"').replaceAll('"block":"', '"block":"'))
    writeFileSync(join(home, 'sessions', 's2', 'synced.json'), JSON.stringify({ upto: 3 }))   // wrong: the platform has none
    sync.push('s2')
    const n = lines.trim().split('\n').length
    expect((await settled('s2', n)).upto).toBe(n)
  })

  it('a conflicting entry is refused and the platform keeps what it had', async () => {
    engine.send({ type: 'session:sync', session: 's1', from: 0, entries: [{ t: 'open', at: '2026-01-01T00:00:00Z', session: 's1', user: 'user:mallory', agent: 'trips' }] })
    for (let i = 0; i < 100 && !engine.got.some((m) => m.payload?.t === 'session:synced' && m.payload.conflict !== undefined); i++) await new Promise((r) => setTimeout(r, 30))
    const c = engine.got.find((m) => m.payload?.t === 'session:synced' && m.payload.conflict !== undefined).payload
    expect(c.conflict).toBe(0)
    ana.send({ payload: { t: 'session:read', session: 's1', reqId: 'r3' }, to: { type: 'hub' } })
    expect((await ana.until((m) => m.payload?.reqId === 'r3')).payload.view.user).toBe('user:ana')
  })
})
