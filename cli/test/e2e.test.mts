// sacli end to end, with nothing faked between the CLI and the engine's sessions: the CLI (built, run as a process)
// → the REAL ProjectDO in Miniflare on a local port → an engine connection running the REAL session seam on a built
// program → a datasource manager answering over HTTP. Also: the key refused, a capability refused, login saving the key
// with mode 600, and the audit history recording all of it.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, statSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { buildProgram, ProgramStore } from '../../vm/packages/programs/src/index.ts'
import { createSessionSeam } from '../../vm/apps/engine/session-seam.ts'
import { agentsInGraph } from '../../vm/apps/engine/test/graph-agents.ts'
import { sealKeygen } from '../../control-plane/superadmin/src/proxy/seal.ts'

const PID = '11111111-2222-3333-4444-555555555555', ORG = 'org-e2e'
const root = fileURLToPath(new URL('../../', import.meta.url))
const bin = join(root, 'cli/dist/sacli.mjs')
const home = mkdtempSync(join(tmpdir(), 'sacli-'))
let mf: Miniflare, hubUrl = '', data: Server, engineWs: WebSocket
let key = '', narrowKey = '', whKey = '', orgKey = '', builderKey = '', otherProject = ''

const sacli = (args: string[], env: Record<string, string> = {}, input?: string, cwd = home): Promise<{ code: number; out: string; err: string }> => new Promise<{ code: number; out: string; err: string }>((resolve) => {
  const p = execFile(process.execPath, [bin, ...args], { cwd, env: { PATH: process.env.PATH!, SACLI_CONFIG: join(home, 'creds.json'), SACLI_HUB: hubUrl, SACLI_IDLE_MS: '20000', ...env } }, (e, out, err) => resolve({ code: (e as any)?.code ?? 0, out, err }))
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
  agentsInGraph(join(home, 'project'), [{ id: 'trips', name: 'Trips', scope: 'global', owner: 'user:builder', domain: 'd', programs: ['unsettled-trips'], tools: [], ui: { start: 'web/Start.tsx' }, ica: 'composer' }])
  // the real ProjectDO, listening
  const harness = `import worker from '../worker.ts'
export { ProjectDO, OrgDO, GlobalDO, UserDO } from '../worker.ts'
export default { async fetch(req, env, ctx) { const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  // as the worker: an organisation key names its organisation; the OrgDO verifies it
  if (u.pathname === '/api/org-agent') { const key = (req.headers.get('authorization') || '').replace(/^Bearer\\s+/i, ''); const org = (/^sak_org_([0-9a-z-]{1,64})_/.exec(key) || [])[1]; if (!org) return new Response('{}', { status: 401 })
    return env.ORG.get(env.ORG.idFromName(org)).fetch(new Request('http://do/agent', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'x-sa-org': org }, body: await req.text() })) }
  if (u.pathname.startsWith('/api/')) return worker.fetch(req, env, ctx)   // the platform's REST API, as deployed
  if (u.pathname.startsWith('/org/')) return env.ORG.get(env.ORG.idFromName('${ORG}')).fetch(new Request('http://do' + u.pathname.slice(4) + u.search, req))
  if (u.pathname.startsWith('/_ws/')) return stub.fetch(req)
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd) } }`
  const out = await build({ stdin: { contents: harness, resolveDir: join(root, 'control-plane/superadmin/src/__tests__'), loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0,
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, ORG: { className: 'OrgDO', useSQLite: true }, GLOBAL: { className: 'GlobalDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], kvNamespaces: ['DOMAINS', 'CREDENTIALS'], bindings: { JWT_SECRET: 'x', CREDENTIALS_MASTER_KEY: sealKeygen() } })
  hubUrl = (await mf.ready).href.replace(/^http/, 'ws').replace(/\/$/, '')
  await doCall('/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'engine-key', provider: 'external', name: 'E2E project', orgId: ORG }) })
  // the engine: the real session seam behind a hub connection
  const seam = createSessionSeam({ projectDir: join(home, 'project'), datasource: `http://127.0.0.1:${(data.address() as any).port}`, send: (to, msg) => engineWs.send(JSON.stringify({ to: { id: to.id, type: to.type }, payload: msg })) })
  engineWs = new WebSocket(`${hubUrl}/_ws/${PID}`)
  await new Promise((r) => engineWs.addEventListener('open', r, { once: true }))
  engineWs.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (typeof m.payload?.t === 'string' && m.payload.t.startsWith('session:')) void seam.handle(m.payload, m.from) })
  engineWs.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: 'engine-key', instanceId: 'e1', epoch: 1 }))
  await new Promise((r) => setTimeout(r, 300))
  await doCall('/access', { method: 'POST', body: JSON.stringify({ email: 'admin@test.io', roleId: 'admin' }) })   // the keys' maker administers the project
  key = (await doCall('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'codex', capabilities: ['project.view', 'project.ask'], by: 'admin@test.io' }) })).key
  narrowKey = (await doCall('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'asker', capabilities: ['project.ask'], by: 'admin@test.io' }) })).key
  whKey = (await doCall('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'loader', capabilities: ['warehouse.use', 'warehouse.append'], by: 'admin@test.io' }) })).key
  // the organisation: an owner, a project, and a key that manages and reads its warehouse
  const owner = { 'content-type': 'application/json', 'x-sa-actor': JSON.stringify({ kind: 'user', id: 'olga@x.io', email: 'olga@x.io' }), 'x-sa-caps': JSON.stringify(['org.people', 'org.roles', 'org.projects', 'org.billing', 'org.keys', 'org.audit', 'warehouse.manage', 'warehouse.write', 'warehouse.query']), 'x-sa-org': ORG }
  await mf.dispatchFetch('http://x/org/users', { method: 'POST', headers: owner, body: JSON.stringify({ email: 'olga@x.io', role: 'owner' }) })
  builderKey = ((await (await mf.dispatchFetch('http://x/org/keys', { method: 'POST', headers: owner, body: JSON.stringify({ name: 'builder', capabilities: ['org.projects', 'org.keys'] }) })).json()) as any).key
  // a project of the organisation, made as the platform makes one (its engine runs outside: it connects out)
  otherProject = ((await (await mf.dispatchFetch('http://x/api/projects', { method: 'POST', headers: { authorization: `Bearer ${builderKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Loads', provider: 'external' }) })).json()) as any).id
  orgKey = ((await (await mf.dispatchFetch('http://x/org/keys', { method: 'POST', headers: owner, body: JSON.stringify({ name: 'warehouse bot', capabilities: ['warehouse.manage', 'warehouse.query'] }) })).json()) as any).key
}, 120_000)
after(async () => {
  await sacli(['disconnect']); await sacli(['disconnect', '--profile', 'other'])
  engineWs?.close(); data?.close(); await mf?.dispose()
})

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

test('refusals have reasons and exit codes: bad usage 2, a refused key 3, a capability the key lacks 1', async () => {
  const usage = await sacli(['session', 'intent', 'cli-s1'])
  assert.equal(usage.code, 2); assert.match(usage.err, /an intent needs --set\/--add\/--remove, --call or --act/)
  const badKey = await sacli(['agents'], { SACLI_KEY: `sak_${PID}_${'y'.repeat(43)}` })
  assert.equal(badKey.code, 3); assert.match(badKey.err, /Invalid agent key: unknown key/)
  const scope = await sacli(['agents', '--key', narrowKey])
  assert.equal(scope.code, 1); assert.match(scope.err, /session:agents needs project.view, which this key does not hold/)
  const refused = await sacli(['session', 'get', 'nope'])
  assert.equal(refused.code, 1); assert.match(refused.err, /there is no session nope/)
})

test('the audit history recorded the CLI: connections, intents with their ops, refusals', async () => {
  const events = (await doCall('/audit?limit=500')).events.reverse()
  const cli = events.filter((e: any) => e.via === 'agent')
  assert.ok(cli.some((e: any) => e.action === 'agent.connect' && e.outcome === 'refused' && e.detail.reason === 'unknown key'))
  assert.ok(cli.some((e: any) => e.action === 'message.session-intent' && e.target === 'cli-s1' && e.detail.ops?.[0]?.value === 'HYDERABAD'))
  assert.ok(cli.some((e: any) => e.action === 'message.session-agents' && e.outcome === 'refused'))
  assert.ok(events.some((e: any) => e.action === 'agent-key.create' && e.actor.email === 'admin@test.io'))
})

test('one background connection serves every command, reports itself, and disconnects on request', async () => {
  const before = await sacli(['status', '--json'])
  const st = JSON.parse(before.out)
  assert.equal(st.connected, true)                       // the commands above went through it
  assert.ok(st.idleLeftMs > 15_000)                      // each command resets the idle limit (20 s in tests, an hour in use)
  const pid = st.pid
  await sacli(['agents'])
  assert.equal(JSON.parse((await sacli(['status', '--json'])).out).pid, pid)   // the same process, reused
  assert.match((await sacli(['disconnect'])).out, /disconnected/)
  assert.match((await sacli(['status'])).out, /no background connection/)
  const direct = await sacli(['agents', '--no-daemon', '--json'])
  assert.equal(direct.code, 0)
  assert.match((await sacli(['status'])).out, /no background connection/)   // --no-daemon started none
})

test('two projects: a profile each, switched globally or per folder, each with its own connection', async () => {
  // a second project's key, saved as a second profile (here a second key of the same test project stands in for it)
  const second = (await doCall('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'second', capabilities: ['project.view', 'project.ask'], by: 'admin@test.io' }) })).key
  assert.equal((await sacli(['login', '--profile', 'other'], {}, second + '\n')).code, 0)
  const listed = JSON.parse((await sacli(['profiles', '--json'])).out)
  assert.deepEqual(listed.map((r: any) => [r.profile, r.inUse, r.isDefault]), [['default', true, true], ['other', false, false]])
  const dir = mkdtempSync(join(tmpdir(), 'sacli-folder-'))
  assert.match((await sacli(['use', 'other', '--here'], {}, undefined, dir)).out, /this folder now uses "other"/)
  assert.equal(JSON.parse((await sacli(['profiles', '--json'], {}, undefined, dir)).out).find((r: any) => r.inUse).profile, 'other')
  assert.equal(JSON.parse((await sacli(['profiles', '--json'])).out).find((r: any) => r.inUse).profile, 'default')   // elsewhere unchanged
  // each profile its own background connection
  await sacli(['agents'], {}, undefined, dir); await sacli(['agents'])
  const a = JSON.parse((await sacli(['status', '--json'], {}, undefined, dir)).out).pid, b = JSON.parse((await sacli(['status', '--json'])).out).pid
  assert.ok(a && b && a !== b)
  assert.match((await sacli(['use', 'nobody'])).err, /there is no profile "nobody"/)
})

test('the warehouse: a project key appends only where its organisation granted writing; an organisation key grants', async () => {
  const p = await sacli(['warehouse', 'append', 'trips', '--rows', '[{"id":1}]', '--key', whKey, '--no-daemon'])
  assert.equal(p.code, 1); assert.match(p.err, /may not write trips — the organisation grants writing/)
  assert.equal((await sacli(['warehouse', 'append', 'trips', '--rows', 'nope', '--key', whKey, '--no-daemon'])).code, 2)
  assert.match((await sacli(['warehouse', 'create', 't', '--key', whKey, '--no-daemon'])).err, /use an organisation key/)
  // the organisation's key: its tables (none here: no warehouse behind this test), its grants
  const login = await sacli(['login', '--profile', 'org'], {}, orgKey + '\n')
  assert.equal(login.code, 0, login.err); assert.match(login.out, new RegExp(`logged in to organisation ${ORG}`))
  assert.match((await sacli(['warehouse', 'tables', '--profile', 'org'])).out, /the warehouse is not set up/)
  const g = await sacli(['warehouse', 'grant', 'trips', '--project', otherProject, '--write', '--profile', 'org'])
  assert.equal(g.code, 0, g.err); assert.match(g.out, /may read trips and append to it/)
  const listed = await sacli(['warehouse', 'grants', '--project', otherProject, '--profile', 'org', '--json'])
  assert.deepEqual(JSON.parse(listed.out).writable, ['trips'])
  assert.match((await sacli(['warehouse', 'grant', 'trips', '--project', 'nope', '--profile', 'org'])).err, /not in this organisation/)
  const scoped = await sacli(['warehouse', 'append', 'trips', '--rows', '[{"id":1}]', '--profile', 'org'])
  assert.equal(scoped.code, 1); assert.match(scoped.err, /may not warehouse:append/)              // not given it
  assert.match((await sacli(['agents', '--profile', 'org'])).err, /works with sacli projects, keys, api and warehouse/)
  assert.equal((await sacli(['warehouse', 'tables', '--key', `sak_org_${ORG}_${'x'.repeat(43)}`])).code, 3)   // a refused key
})

test('an organisation key: its projects, and keys made below it — saved as a profile, never printed', async () => {
  const login = await sacli(['login', '--profile', 'builder'], {}, builderKey + '\n')
  assert.equal(login.code, 0, login.err)
  assert.match((await sacli(['whoami', '--profile', 'builder'])).out, /holds +org\.keys, org\.projects/)
  const list = await sacli(['projects', 'list', '--profile', 'builder', '--json'])
  assert.equal(list.code, 0, list.err); assert.ok(JSON.parse(list.out).some((p: any) => p.id === otherProject))
  const made = await sacli(['keys', 'create', 'loads agent', '--project', otherProject, '--can', 'project.view,project.keys', '--save-as', 'loads', '--profile', 'builder'])
  assert.equal(made.code, 0, made.err)
  assert.doesNotMatch(made.out, /sak_/)                                                          // saved, never printed
  const keys = JSON.parse((await sacli(['keys', 'list', '--project', otherProject, '--profile', 'builder', '--json'])).out)
  assert.deepEqual(keys.map((k: any) => [k.name, k.capabilities, k.made_by_key?.startsWith('org:')]), [['loads agent', ['project.keys', 'project.view'], true]])
  // the new project key makes keys below itself, never more than it holds
  assert.match((await sacli(['keys', 'create', 'x', '--can', 'project.manage', '--profile', 'loads'])).err, /does not hold: project.manage/)
  const me = JSON.parse((await sacli(['api', 'GET', `/api/projects/${otherProject}/me`, '--profile', 'loads'])).out)
  assert.deepEqual(me.capabilities, ['project.keys', 'project.view'])
  // revoking the organisation key's child takes it away
  assert.equal((await sacli(['keys', 'revoke', keys[0].id, '--project', otherProject, '--profile', 'builder'])).code, 0)
  assert.equal((await sacli(['api', 'GET', `/api/projects/${otherProject}/me`, '--profile', 'loads'])).code, 3)
  assert.match((await sacli(['projects', 'list', '--profile', 'loads'])).err, /organisation key/)
})

test('data sources: made with values from flags, a file of keys (by prefix) and a secret read from a file — never printed', async () => {
  const full = (await doCall('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'data admin', capabilities: ['project.view', 'project.ask', 'project.data', 'project.connect', 'project.manage'], by: 'admin@test.io' }) })).key
  const dir = mkdtempSync(join(tmpdir(), 'sacli-ds-'))
  writeFileSync(join(dir, 'password.txt'), 'pa55-from-file\n')
  writeFileSync(join(dir, 'db.env'), 'DB_HOST=db.example.com\nDB_DATABASE=sales\n# a comment\nDB_USER="reader"\n')
  const made = await sacli(['datasources', 'create', 'SALES', '--connector', 'sqlserver', '--values-file', join(dir, 'db.env'), '--prefix', 'DB_', '--secret', `password=@${join(dir, 'password.txt')}`, '--dialect', 'mssql', '--description', 'the sales database', '--key', full, '--no-daemon'])
  assert.equal(made.code, 0, made.err)
  const shown = await sacli(['datasources', 'show', 'SALES', '--key', full, '--no-daemon', '--json'])
  const c = JSON.parse(shown.out)
  assert.deepEqual(c.settings, { host: 'db.example.com', database: 'sales', user: 'reader' })
  assert.equal(c.dialect, 'mssql'); assert.equal(c.description, 'the sales database'); assert.equal(c.auth, 'shared')
  assert.doesNotMatch(shown.out + made.out, /pa55/)                                         // secrets never come back
  assert.match((await sacli(['datasources', 'create', 'X', '--connector', 'sqlserver', '--set', 'colour=red', '--key', full, '--no-daemon'])).err, /has no field colour \(its fields: host, port, database, user, password\)/)
  const upd = await sacli(['datasources', 'update', 'SALES', '--set', 'port=1444', '--auth', 'per-user', '--key', full, '--no-daemon', '--json'])
  assert.equal(upd.code, 0, upd.err)
  assert.deepEqual(JSON.parse(upd.out), { ...JSON.parse(upd.out), auth: 'per-user', settings: { host: 'db.example.com', database: 'sales', user: 'reader', port: 1444 } })   // the password kept
  assert.equal((await sacli(['datasources', 'my-key', 'SALES', '--set', 'user=ana', '--secret', 'password=hers', '--key', full, '--no-daemon'])).code, 0)
  assert.equal((await sacli(['datasources', 'remove', 'SALES', '--key', full, '--no-daemon'])).code, 0)
  assert.match((await sacli(['datasources', 'list', '--key', full, '--no-daemon'])).out, /no data sources/)
})

test('the index: stats, show (now and as of a time), describe with who wrote it, disable, build and status', async () => {
  const full = (await doCall('/agent-keys', { method: 'POST', body: JSON.stringify({ name: 'index admin', capabilities: ['project.view', 'project.ask', 'project.data', 'project.manage'], by: 'admin@test.io' }) })).key
  engineWs.send(JSON.stringify({ type: 'dsi:plan', source: 'SHOP', phase: 1, tables: ['orders'], complete: true, reqId: 'p1' }))
  engineWs.send(JSON.stringify({ type: 'dsi:put', source: 'SHOP', phase: 1, table: 'orders', fields: [{ name: 'id', type: 'int', key: true }, { name: 'total', type: 'money', description: 'order total' }] }))
  await new Promise((r) => setTimeout(r, 300))
  const before = new Date().toISOString()
  await new Promise((r) => setTimeout(r, 50))
  const run = (...a: string[]) => sacli(['dsi', ...a, '--key', full, '--no-daemon'])
  assert.match((await run('stats')).out, /SHOP\s+1\s+2/)
  assert.match((await run('describe', 'SHOP.orders.total', 'Order value incl. GST')).err, /--by human or --by ai/)
  assert.equal((await run('describe', 'SHOP.orders.total', 'Order value incl. GST', '--by', 'human')).code, 0)
  assert.equal((await run('disable', 'SHOP.orders.id')).code, 0)
  const now = (await run('show', 'SHOP.orders')).out
  assert.match(now, /total\s+money\s+Order value incl. GST/); assert.match(now, /id\s+int\s+key\s+disabled/)
  const then = (await run('show', 'SHOP.orders', '--as-of', before)).out
  assert.match(then, /total\s+money\s+order total/); assert.doesNotMatch(then, /disabled/)
  assert.match((await run('build', 'SHOP', '--tables', 'orders')).out, /asked the engine to build/)
  assert.match((await run('status')).out, /no build has run/)
  const doc = JSON.parse((await run('snapshot')).out)
  assert.equal(doc.sources[0].tables[0].fields.find((f: any) => f.field === 'total').description, 'Order value incl. GST')
})

test('an idle background connection cleans up after itself: the process ends and its socket file is gone', async () => {
  const cfg = join(mkdtempSync(join(tmpdir(), 'sacli-idle-')), 'creds.json')
  const env = { SACLI_CONFIG: cfg, SACLI_KEY: key, SACLI_IDLE_MS: '1500' }
  assert.equal((await sacli(['agents'], env)).code, 0)
  const { pid } = JSON.parse((await sacli(['status', '--json'], env)).out)
  const run = join(cfg, '..', 'run')
  const sockets = () => readdirSync(run).filter((f) => f.endsWith('.sock'))
  assert.equal(sockets().length, 1)
  await new Promise((r) => setTimeout(r, 3500))
  assert.throws(() => process.kill(pid, 0))                // the process is gone
  assert.deepEqual(sockets(), [])                          // and so is its socket
  // a socket left by a killed daemon is not mistaken for a live one
  assert.equal((await sacli(['agents'], env)).code, 0)
  const again = JSON.parse((await sacli(['status', '--json'], env)).out).pid
  process.kill(again, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(sockets().length, 1)                        // left behind by the kill
  assert.equal((await sacli(['agents'], env)).code, 0)     // a fresh daemon takes its place
  await sacli(['disconnect'], env)
})
