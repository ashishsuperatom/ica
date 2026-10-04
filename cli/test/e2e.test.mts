// sacli end to end, with nothing faked between the CLI and the engine's sessions: the CLI (built, run as a process)
// → the REAL ProjectDO in Miniflare on a local port → an engine connection running the REAL session seam on a built
// program → a datasource manager answering over HTTP. Also: the key refused, a scope refused, login saving the key
// with mode 600, and the audit history recording all of it.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { buildProgram, ProgramStore } from '../../vm/packages/programs/src/index.ts'
import { createSessionSeam } from '../../vm/apps/engine/session-seam.ts'

const PID = '11111111-2222-3333-4444-555555555555'
const root = fileURLToPath(new URL('../../', import.meta.url))
const bin = join(root, 'cli/dist/sacli.mjs')
const home = mkdtempSync(join(tmpdir(), 'sacli-'))
let mf: Miniflare, hubUrl = '', data: Server, engineWs: WebSocket
let key = '', narrowKey = ''

const sacli = (args: string[], env: Record<string, string> = {}, input?: string) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
  const p = execFile(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH!, SACLI_CONFIG: join(home, 'creds.json'), SACLI_HUB: hubUrl, ...env } }, (e, out, err) => resolve({ code: (e as any)?.code ?? 0, out, err }))
  if (input !== undefined) { p.stdin!.write(input); p.stdin!.end() }
})
const doCall = async (path: string, init?: RequestInit) => (await mf.dispatchFetch(`http://x/do${path}`, init)).json() as Promise<any>

before(async () => {
  // the datasource manager
  data = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)).on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rows: [{ trip_no: 'T1', balance: 5 }, { trip_no: 'T2', balance: 7 }] })) }) })
  await new Promise<void>((r) => data.listen(0, '127.0.0.1', () => r()))
  // a project home with one agent and a built program
  const src = join(root, 'vm/packages/programs/test/fixtures/unsettled-trips')
  buildProgram(src, new ProgramStore(join(home, 'project', 'programs', 'store')))
  mkdirSync(join(home, 'project', 'agents'), { recursive: true })
  writeFileSync(join(home, 'project', 'agents', 'trips.json'), JSON.stringify({ id: 'trips', name: 'Trips', scope: 'global', owner: 'user:builder', domain: 'd', programs: ['unsettled-trips'], tools: [], ui: { start: 'web/Start.tsx' }, ica: 'composer' }))
  // the real ProjectDO, listening
  const harness = `export { ProjectDO } from '../project-do.ts'
export default { async fetch(req, env) { const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return stub.fetch(req)
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd) } }`
  const out = await build({ stdin: { contents: harness, resolveDir: join(root, 'control-plane/superadmin/src/__tests__'), loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0,
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: 'x' } })
  hubUrl = (await mf.ready).href.replace(/^http/, 'ws').replace(/\/$/, '')
  await doCall('/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'engine-key', provider: 'external', name: 'E2E project' }) })
  // the engine: the real session seam behind a hub connection
  const seam = createSessionSeam({ projectDir: join(home, 'project'), datasource: `http://127.0.0.1:${(data.address() as any).port}`, send: (to, msg) => engineWs.send(JSON.stringify({ to: { id: to.id, type: to.type }, payload: msg })) })
  engineWs = new WebSocket(`${hubUrl}/_ws/${PID}`)
  await new Promise((r) => engineWs.addEventListener('open', r, { once: true }))
  engineWs.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (typeof m.payload?.t === 'string' && m.payload.t.startsWith('session:')) void seam.handle(m.payload, m.from) })
  engineWs.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: 'engine-key', instanceId: 'e1', epoch: 1 }))
  await new Promise((r) => setTimeout(r, 300))
  key = (await doCall('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'codex', scopes: ['sessions'], by: 'admin@test.io' }) })).key
  narrowKey = (await doCall('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'asker', scopes: ['ask'], by: 'admin@test.io' }) })).key
}, 120_000)
after(async () => { engineWs?.close(); data?.close(); await mf?.dispose() })

test('login reads the key from stdin, checks it with the hub, and saves it readable only by its owner', async () => {
  const r = await sacli(['login'], {}, key + '\n')
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /logged in to E2E project as profile "default"/)
  const f = join(home, 'creds.json')
  assert.equal(statSync(f).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).profiles.default.key, key)
  const who = await sacli(['whoami'])
  assert.match(who.out, new RegExp(`project  E2E project \\(${PID}\\)`))
  assert.doesNotMatch(who.out, new RegExp(key.slice(-20)))           // masked
})

test('agents, then a session: open, run, a new block, a branch from the first block, read it back as JSON', async () => {
  const agents = await sacli(['agents', '--json'])
  assert.deepEqual(JSON.parse(agents.out).map((a: any) => a.id), ['trips'])
  const opened = await sacli(['session', 'open', 'trips', '--id', 'cli-s1'])
  assert.equal(opened.code, 0, opened.err)
  assert.match(opened.out, /session cli-s1 · agent trips · 1 block/)
  const ran = await sacli(['session', 'intent', 'cli-s1', '--call', 'trips.run'])
  assert.match(ran.out, /2 trips are completed but not settled; 12 to settle\./)
  assert.match(ran.out, /Trip\s+Balance\n/)
  const hyd = await sacli(['session', 'intent', 'cli-s1', '--set', 'trips.branch=HYDERABAD', '--to', 'new'])
  assert.match(hyd.out, /2 blocks/)
  assert.match(hyd.out, /2 trips at HYDERABAD/)
  const first = JSON.parse((await sacli(['session', 'get', 'cli-s1', '--json'])).out).view.blocks[0].id
  const branch = await sacli(['session', 'intent', 'cli-s1', '--set', 'trips.branch=PUNE', '--block', first])
  assert.match(branch.out, /branch 2 of 2/)
  const view = JSON.parse((await sacli(['session', 'get', 'cli-s1', '--json'])).out).view
  assert.equal(view.user, 'agent:' + JSON.parse(JSON.stringify((await doCall('/agent-keys')).keys.find((k: any) => k.name === 'codex'))).id)
  assert.equal(view.blocks.length, 3)
})

test('refusals have reasons and exit codes: bad usage 2, a refused key 3, a scope the key lacks 1', async () => {
  const usage = await sacli(['session', 'intent', 'cli-s1'])
  assert.equal(usage.code, 2); assert.match(usage.err, /an intent needs --set\/--add\/--remove, --call or --act/)
  const badKey = await sacli(['agents'], { SACLI_KEY: `sak_${PID}_${'y'.repeat(43)}` })
  assert.equal(badKey.code, 3); assert.match(badKey.err, /Invalid agent key: unknown key/)
  const scope = await sacli(['agents', '--key', narrowKey])
  assert.equal(scope.code, 1); assert.match(scope.err, /this key's scopes \(ask\) do not allow session:agents/)
  const refused = await sacli(['session', 'get', 'nope'])
  assert.equal(refused.code, 1); assert.match(refused.err, /there is no session nope/)
})

test('the audit history recorded the CLI: connections, intents with their ops, refusals', async () => {
  const events = (await doCall('/audit?limit=100')).events.reverse()
  const cli = events.filter((e: any) => e.via === 'cli')
  assert.ok(cli.some((e: any) => e.action === 'agent.connect' && e.outcome === 'refused' && e.detail.reason === 'unknown key'))
  assert.ok(cli.some((e: any) => e.action === 'message.session-intent' && e.target === 'cli-s1' && e.detail.ops?.[0]?.value === 'HYDERABAD'))
  assert.ok(cli.some((e: any) => e.action === 'message.session-agents' && e.outcome === 'refused'))
  assert.ok(events.some((e: any) => e.action === 'agent-key.create' && e.actor.email === 'admin@test.io'))
})
