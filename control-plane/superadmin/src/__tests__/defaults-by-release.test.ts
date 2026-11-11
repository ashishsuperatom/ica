// The default concepts travel with the engine's release (platform-types default-concepts.ts): a project's copies change only
// when its engine brings defaults other than those it was last given — never because the platform was deployed. Through
// the REAL ProjectDO and UserDO in Miniflare, restarted on the same storage as a deploy restarts them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS } from '../../../../vm/packages/platform-types/src/default-concepts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-5555555555d1'
const SECRET = 's'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}')
  return env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}')).fetch(fwd)
} }
`
const store = mkdtempSync(join(tmpdir(), 'defaults-'))
let script = ''
let mf: Miniflare | undefined
/** The platform started on the project's storage — again, as a deploy does. */
const start = async () => { await mf?.dispose(); mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'], durableObjectsPersist: store,
  durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } }) }
const call = (path: string, init?: RequestInit) => mf!.dispatchFetch(`http://x/do${path}`, init)
const jwt = (email: string) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, v: 2, userId: email.split('@')[0], email, role: 'user' })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}

/** A socket: the project's engine, or a person's page; its welcome, and what it is answered. */
async function socket(hello: Record<string, unknown>) {
  const q = hello.token ? `?token=${hello.token}` : ''
  const r = await mf!.dispatchFetch(`http://x/_ws/${PID}${q}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!; const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data)))); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', ...hello }))
  const until = async (pred: (p: any) => boolean) => { for (let i = 0; i < 300; i++) { const m = got.find((x) => pred(x.payload ?? {})); if (m) return m.payload; await new Promise((r) => setTimeout(r, 20)) } throw new Error(`nothing matched; got ${JSON.stringify(got.map((x) => x.payload?.t))}`) }
  const welcome = await until((p) => p.t === 'welcome')
  let n = 0
  const ask = async (payload: any) => { const reqId = `q${++n}`; ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { ...payload, reqId } })); return until((p) => p.reqId === reqId) }
  const send = (m: unknown) => ws.send(JSON.stringify(m))
  return { welcome, until, ask, send, close: () => ws.close() }
}
const engine = () => socket({ role: 'code-engine', key: 'engine-key', engineId: 'eng-defaults-01', instanceId: 'i', epoch: Date.now() })
const ana = () => socket({ role: 'runtime', token: jwt('ana@test.io') })
const textOf = async (name: string) => { const p = await ana(); const r = await p.ask({ t: 'graph:show', name }); p.close(); return String(r.node?.body?.text ?? '') }
const apply = async (hash: string, defaults: unknown) => {
  const e = await engine(); e.send({ type: 'defaults:apply', reqId: hash, hash, defaults, release: hash })
  const r = await e.until((p) => p.t === 'defaults:applied'); e.close(); return r
}

beforeAll(async () => {
  script = (await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'] })).outputFiles[0].text
  await start()
  await call('/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'engine-key', provider: 'external', name: 'Defaults' }) })
  await call('/access', { method: 'POST', body: JSON.stringify({ email: 'ana@test.io', roleId: 'admin' }) })
}, 60_000)
afterAll(async () => { await mf?.dispose(); rmSync(store, { recursive: true, force: true }) })

describe("a project's default concepts follow its engine's release, never a platform deploy", () => {
  // an older release's defaults: the same, two texts different
  const say = (name: string, text: string) => (c: (typeof DEFAULTS.concepts)[number]) => (c.name === name && c.body.form === 'text' ? { ...c, body: { ...c.body, text } } : c)
  const older = { ...DEFAULTS, concepts: DEFAULTS.concepts.map(say('answer/tables', 'Tables, as the older release says.')).map(say('answer/units', 'Units, as the older release says.')) }

  it("its engine's defaults are applied as copies when they are not the ones last given; the welcome says which were", async () => {
    expect((await engine()).welcome.defaults).toBeNull()                       // never given any
    expect(await apply('h-older', older)).toMatchObject({ hash: 'h-older', changed: true })
    expect(await textOf('answer/tables')).toBe('Tables, as the older release says.')
    expect((await engine()).welcome.defaults).toBe('h-older')
    const p = await ana()
    expect((await p.ask({ t: 'graph:defaults' })).defaults.concepts.find((c: any) => c.name === 'answer/tables').body.text).toBe('Tables, as the older release says.')   // "the default" here: what it was given
    p.close()
  })

  it('a platform deploy does not rewrite them: the older text stays until its engine brings another', async () => {
    await start()   // deployed again, on the same storage — the platform's own defaults are the newest
    expect(await textOf('answer/tables')).toBe('Tables, as the older release says.')
    expect((await engine()).welcome.defaults).toBe('h-older')
  })

  it('a default a person edited stays theirs when a release brings another; those nobody edited take its text', async () => {
    const p = await ana()
    const units = (await p.ask({ t: 'graph:show', name: 'answer/units' })).node
    expect((await p.ask({ t: 'graph:concept', name: 'answer/units', body: { ...units.body, text: 'Units, our own way.' }, reason: 'ours' })).changed).toBe(true)
    p.close()
    expect(await apply('h-newer', DEFAULTS)).toMatchObject({ hash: 'h-newer', changed: true })
    expect(await textOf('answer/tables')).toBe(DEFAULTS.concepts.find((c) => c.name === 'answer/tables')!.body.form === 'text' ? (DEFAULTS.concepts.find((c) => c.name === 'answer/tables')!.body as any).text : '')
    expect(await textOf('answer/units')).toBe('Units, our own way.')
  })
})
