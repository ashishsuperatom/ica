// Each connection in a process of its own (the manager's hosted.ts + host.mjs; docs/connectors-plan.md step 4), against
// the REAL manager: two connections, two processes; a connector that crashes takes only its own call with it — its
// process is started again and the next read works, the other connection never noticing; one that keeps crashing (five
// times in five minutes) is left stopped and says why. A host is given no key.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANAGER = fileURLToPath(new URL('../../datasources/manager/src/index.ts', import.meta.url))
const KEY = 'k'.repeat(48)
const home = mkdtempSync(join(tmpdir(), 'sup-'))
const PORT = 43000 + Math.floor(Math.random() * 2000)
const URL_ = `http://127.0.0.1:${PORT}`
let proc: ChildProcess
// a connector that answers with its own pid, crashes on "CRASH", and tells whether it was given any key
const BRIDGE = join(home, 'b.mjs')
writeFileSync(BRIDGE, `export function createBridge({ settings }) { return { kind: 'documents', dialect: 'none', ready: () => true,
  query: async (q) => { if (q === 'CRASH') process.exit(3); if (q === 'ENV') return [{ keys: Object.keys(process.env).filter((k) => /KEY|SECRET|TOKEN/.test(k)) }]; return [{ pid: process.pid, name: settings.name }] },
  introspect: async () => ({ tables: [] }) } }`)
const sys = (path: string, body?: unknown) => fetch(URL_ + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-sa-system': KEY }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json() as any)
const q = (id: string, sql: string) => sys('/query', { id, sql, raw: true })
const proc_ = async (id: string) => (await sys('/sources')).sources.find((s: any) => s.id === id)?.process
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  proc = spawn(process.execPath, ['--import', 'tsx', MANAGER], { env: { ...process.env, SA_MANAGER_KEY: KEY, DATASOURCE_PORT: String(PORT), DATASOURCE_DATA_DIR: join(home, 'd') }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL_ + '/health')).ok) break } catch { /* not yet */ } await wait(100) }
  for (const id of ['A', 'B']) assert.equal((await sys('/sources', { id, path: BRIDGE, config: { settings: { name: id }, secrets: { password: `secret-${id}` } } })).ok, true)
})
after(() => { proc?.kill(); rmSync(home, { recursive: true, force: true }) })

test('two connections, two processes — neither the manager\'s', async () => {
  const a = (await q('A', 'WHO')).rows[0], b = (await q('B', 'WHO')).rows[0]
  assert.equal(a.name, 'A'); assert.equal(b.name, 'B')
  assert.notEqual(a.pid, b.pid); assert.notEqual(a.pid, proc.pid)
  assert.deepEqual((await q('A', 'ENV')).rows[0].keys, [])   // no key of any kind in a connection's process
})

test('a crash takes only its own call; the process starts again; the other never notices', async () => {
  const before = (await q('A', 'WHO')).rows[0].pid
  const crashed = await q('A', 'CRASH')
  assert.match(String(crashed.error ?? ''), /its process stopped|did not answer|starting again/)
  assert.equal((await q('B', 'WHO')).rows[0].name, 'B')            // B untouched meanwhile
  for (let i = 0; i < 40 && (await proc_('A'))?.state !== 'running'; i++) await wait(100)
  const after = (await q('A', 'WHO')).rows[0]
  assert.equal(after.name, 'A'); assert.notEqual(after.pid, before)
  assert.equal((await proc_('A')).restarts, 1)
})

test('one that keeps crashing is left stopped, and says why', async () => {
  for (let n = 0; n < 6; n++) {
    for (let i = 0; i < 400 && !['running', 'failed'].includes((await proc_('A'))?.state); i++) await wait(100)
    if ((await proc_('A')).state === 'failed') break
    await q('A', 'CRASH'); await wait(50)
  }
  for (let i = 0; i < 100 && (await proc_('A')).state !== 'failed'; i++) await wait(100)
  const p = await proc_('A')
  assert.equal(p.state, 'failed'); assert.match(p.lastError, /stopped 5 times in 5 minutes/)
  assert.match(String((await q('A', 'WHO')).error), /stopped 5 times/)
  assert.equal((await q('B', 'WHO')).rows[0].name, 'B')
  // loaded again on purpose: running again
  assert.equal((await sys('/sources', { id: 'A', path: BRIDGE, config: { settings: { name: 'A' }, secrets: {} } })).ok, true)
  assert.equal((await q('A', 'WHO')).rows[0].name, 'A')
})

test('a connector that becomes ready after it loads (a socket) reads ready without being called', async () => {
  const LATE = join(home, 'late.mjs')
  writeFileSync(LATE, `export function createBridge() { let up = false; setTimeout(() => { up = true }, 500); return { kind: 'documents', dialect: 'none', ready: () => up, query: async () => [], introspect: async () => ({ tables: [] }) } }`)
  assert.equal((await sys('/sources', { id: 'LATE', path: LATE, config: { settings: {}, secrets: {} } })).ok, true)
  const readyOf = async () => (await sys('/sources')).sources.find((s: any) => s.id === 'LATE')?.ready
  assert.equal(await readyOf(), false)
  for (let i = 0; i < 80 && !(await readyOf()); i++) await wait(100)
  assert.equal(await readyOf(), true)
})

test('at most 4 calls at once per connection; the rest wait their turn', async () => {
  const SLOW = join(home, 'slow.mjs')
  writeFileSync(SLOW, `let now = 0, most = 0; export function createBridge() { return { kind: 'documents', dialect: 'none', ready: () => true,
    query: async (q) => { if (q === 'MOST') return [{ most }]; now++; most = Math.max(most, now); await new Promise((r) => setTimeout(r, 150)); now--; return [{ ok: 1 }] }, introspect: async () => ({ tables: [] }) } }`)
  assert.equal((await sys('/sources', { id: 'SLOW', path: SLOW, config: { settings: {}, secrets: {} } })).ok, true)
  const all = await Promise.all(Array.from({ length: 10 }, () => q('SLOW', 'WORK')))
  assert.ok(all.every((r) => r.rows?.[0]?.ok === 1), JSON.stringify(all.find((r) => !r.rows)))
  assert.equal((await q('SLOW', 'MOST')).rows[0].most, 4)
})

test('a source that cannot be reached five times in a row is paused — refused at once, saying until when', async () => {
  const DOWN = join(home, 'down.mjs')
  writeFileSync(DOWN, `export function createBridge() { return { kind: 'documents', dialect: 'none', ready: () => true,
    query: async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432'), { code: 'ECONNREFUSED' }) }, introspect: async () => ({ tables: [] }) } }`)
  assert.equal((await sys('/sources', { id: 'DOWN', path: DOWN, config: { settings: {}, secrets: {} } })).ok, true)
  for (let i = 0; i < 5; i++) assert.match(String((await q('DOWN', 'X')).error), /ECONNREFUSED/)
  const t0 = Date.now()
  assert.match(String((await q('DOWN', 'X')).error), /unavailable — it could not be reached 5 times in a row; tried again at/)
  assert.ok(Date.now() - t0 < 500, 'refused at once')
  const p = await proc_('DOWN')
  assert.ok(p.unavailableUntil > Date.now()); assert.equal(p.calls.errors, 5)   // the refused one never reached its source
})
