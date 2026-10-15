// Who may read through the datasource manager (docs/connectors-plan.md, step 1), against the REAL manager with a stand-in
// source: the engine's own work holds the manager's key; whatever runs for someone holds a ticket the engine signed —
// its policies are the ones applied, the request's are ignored; no ticket, a forged, expired or voided one reads
// nothing; raw reads, registering sources, introspection and the cache are the engine's alone. The data seam agents'
// tools and scripts use sends the ticket kept beside their folder. A child process is never given the keys.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dataSeam } from '../ica/workspace.ts'
import { signTicket } from '@superatom/datasource-manager/ticket'
import { childEnv } from '../child-env.ts'

const MANAGER = fileURLToPath(new URL('../../datasources/manager/src/index.ts', import.meta.url))
const KEY = 'k'.repeat(48)
const home = mkdtempSync(join(tmpdir(), 'seam-'))
const PORT = 41000 + Math.floor(Math.random() * 2000)
const URL_ = `http://127.0.0.1:${PORT}`
let proc: ChildProcess

// The stand-in source: SQL, answering every query with the statement it was sent (what the rewrite made of it).
const BRIDGE = join(home, 'bridge.mjs')
writeFileSync(BRIDGE, `let n = 0; export function createBridge() { return { id: 'TRIPS', kind: 'sql', dialect: 'duckdb', ready: () => true,
  query: async (sql) => { n++; await new Promise((r) => setTimeout(r, 30)); return [{ sent: sql, n }] }, introspect: async () => ({ tables: [{ name: 'trips' }] }) } }`)

const call = (path: string, o: { system?: boolean; ticket?: string; method?: string; body?: unknown } = {}) =>
  fetch(URL_ + path, { method: o.method ?? (o.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(o.system ? { 'x-sa-system': KEY } : {}), ...(o.ticket ? { 'x-sa-ticket': o.ticket } : {}) }, ...(o.body ? { body: JSON.stringify(o.body) } : {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() as any }))
const ana = (over: Record<string, unknown> = {}) => signTicket(KEY, { principal: 'user:ana', email: 'ana@x.test', policies: {}, access: -1, ...over })
const DENY = [{ table: 'trips', deny: true }]

before(async () => {
  proc = spawn(process.execPath, ['--import', 'tsx', MANAGER], { env: { ...process.env, SA_MANAGER_KEY: KEY, DATASOURCE_PORT: String(PORT), DATASOURCE_DATA_DIR: join(home, 'data-dir') }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { try { if ((await fetch(URL_ + '/health')).ok) break } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 100)) }
  const r = await call('/sources', { system: true, body: { id: 'TRIPS', path: BRIDGE } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
})
after(() => { proc?.kill(); rmSync(home, { recursive: true, force: true }) })

test('the manager does not start without its key', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', MANAGER], { env: { ...process.env, SA_MANAGER_KEY: '', DATASOURCE_PORT: String(PORT + 1) }, encoding: 'utf8', timeout: 20_000 })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /SA_MANAGER_KEY is not set/)
})

test('no ticket, a forged one, an expired one: nothing is read', async () => {
  assert.equal((await call('/query', { body: { id: 'TRIPS', sql: 'SELECT * FROM trips' } })).status, 401)
  assert.equal((await call('/sources')).status, 401)
  const forged = signTicket('f'.repeat(48), { principal: 'user:ana', policies: {}, access: -1 })
  const r = await call('/query', { ticket: forged, body: { id: 'TRIPS', sql: 'SELECT * FROM trips' } })
  assert.equal(r.status, 401); assert.match(r.body.error, /no valid data access ticket/)
  const expired = signTicket(KEY, { principal: 'user:ana', policies: {}, access: -1, exp: Date.now() - 1000 })
  assert.match((await call('/query', { ticket: expired, body: { id: 'TRIPS', sql: 'SELECT * FROM trips' } })).body.error, /expired/)
  // a ticket edited by its holder (another person's name in it) no longer matches its signature
  const [v, , sig] = ana().split('.')
  const edited = `${v}.${Buffer.from(JSON.stringify({ principal: 'user:boss', policies: {}, access: -1, exp: Date.now() + 60_000 })).toString('base64url')}.${sig}`
  assert.equal((await call('/query', { ticket: edited, body: { id: 'TRIPS', sql: 'SELECT * FROM trips' } })).status, 401)
})

test("a ticket's policies are applied; the request's are ignored", async () => {
  const ok = await call('/query', { ticket: ana(), body: { id: 'TRIPS', sql: 'SELECT * FROM trips', policies: DENY } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))   // a policy in the request does not bind (nor would one that loosens)
  const denied = await call('/query', { ticket: ana({ policies: { TRIPS: DENY } }), body: { id: 'TRIPS', sql: 'SELECT * FROM trips', policies: [] } })
  assert.equal(denied.status, 403, JSON.stringify(denied.body))
  const row = await call('/query', { ticket: ana({ policies: { TRIPS: [{ table: 'trips', predicate: "{t}.branch = 'PUNE'" }] } }), body: { id: 'TRIPS', sql: 'SELECT * FROM trips', fresh: true } })
  assert.equal(row.status, 200, JSON.stringify(row.body))
  assert.match(row.body.rows[0].sent, /PUNE/)
})

test("raw reads, registering sources, introspection and the cache are the engine's alone", async () => {
  assert.equal((await call('/query', { ticket: ana(), body: { id: 'TRIPS', sql: 'SELECT 1', raw: true } })).status, 403)
  assert.equal((await call('/query', { system: true, body: { id: 'TRIPS', sql: 'SELECT 1', raw: true } })).status, 200)
  assert.equal((await call('/sources', { ticket: ana(), body: { id: 'EVIL', path: BRIDGE } })).status, 403)
  assert.equal((await call('/sources', { ticket: ana(), method: 'DELETE', body: { id: 'TRIPS' } })).status, 403)
  assert.equal((await call('/introspect', { ticket: ana(), body: { id: 'TRIPS' } })).status, 403)
  assert.equal((await call('/cache', { ticket: ana() })).status, 403)
  assert.equal((await call('/access', { ticket: ana(), body: { version: 99 } })).status, 403)
  assert.equal((await call('/sources', { ticket: ana() })).status, 200)   // listing what there is to read: anyone with a ticket
})

test('an access change voids every ticket signed before it', async () => {
  const old = ana({ access: 4 })
  assert.equal((await call('/query', { ticket: old, body: { id: 'TRIPS', sql: 'SELECT * FROM trips' } })).status, 200)
  assert.equal((await call('/access', { system: true, body: { version: 5 } })).status, 200)
  const r = await call('/query', { ticket: old, body: { id: 'TRIPS', sql: 'SELECT * FROM trips' } })
  assert.equal(r.status, 401); assert.match(r.body.error, /your data access changed/)
  assert.equal((await call('/query', { ticket: ana({ access: 5 }), body: { id: 'TRIPS', sql: 'SELECT * FROM trips' } })).status, 200)
})

test("the data seam sends the ticket kept beside the folder; none, or unchecked: nothing is read", async () => {
  mkdirSync(join(home, 'w', 'data'), { recursive: true })
  writeFileSync(join(home, 'w', 'data', 'query.mjs'), dataSeam(URL_))
  const seam = await import(pathToFileURL(join(home, 'w', 'data', 'query.mjs')).href)
  const was = process.env.SA_TICKET; delete process.env.SA_TICKET
  try {
    await assert.rejects(seam.query('TRIPS', 'SELECT * FROM trips'), /carries no data access ticket/)
    writeFileSync(join(home, 'w', '.ticket'), 'unchecked')
    await assert.rejects(seam.query('TRIPS', 'SELECT * FROM trips'), /could not be checked/)
    writeFileSync(join(home, 'w', '.ticket'), ana({ access: 5, policies: { TRIPS: DENY } }))
    await assert.rejects(seam.query('TRIPS', 'SELECT * FROM trips'), /not allowed to read/)
    assert.deepEqual([...seam.denied()], ['trips.trips'])   // the index tools hide what the ticket denies
    writeFileSync(join(home, 'w', '.ticket'), ana({ access: 5 }))
    assert.equal((await seam.query('TRIPS', 'SELECT * FROM trips')).length, 1)
    assert.ok((await seam.sources()).some((s: any) => s.id === 'TRIPS'))
  } finally { if (was !== undefined) process.env.SA_TICKET = was }
})

test("a child process is never given the engine's keys", () => {
  process.env.SA_MANAGER_KEY = KEY; process.env.ICA_KEY = 'engine-key'; process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok'
  const env = childEnv({ SA_TICKET: 't' })
  assert.equal(env.SA_MANAGER_KEY, undefined); assert.equal(env.ICA_KEY, undefined); assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.equal(env.SA_TICKET, 't'); assert.ok(env.PATH)
})

test('the cache: a result reused; maxAge 0 reads afresh; a connection loaded again never reads the old one; five at once read once', async () => {
  const t = ana({ access: 5 })
  const read = (sql: string, extra: Record<string, unknown> = {}) => call('/query', { ticket: t, body: { id: 'TRIPS', sql, ...extra } }).then((r) => r.body)
  const a = await read('SELECT * FROM trips WHERE x = 1')
  assert.equal(a.cache.hit, false)
  const b = await read('SELECT * FROM trips WHERE x = 1')
  assert.equal(b.cache.hit, true); assert.equal(b.rows[0].n, a.rows[0].n)
  assert.equal((await read('SELECT * FROM trips WHERE x = 1', { maxAge: 0 })).cache.hit, false)
  // the same source loaded again with other settings: a new generation, so a fresh read
  assert.equal((await call('/sources', { system: true, body: { id: 'TRIPS', path: BRIDGE, config: { settings: { v: 2 }, secrets: {} } } })).status, 200)
  assert.equal((await read('SELECT * FROM trips WHERE x = 1')).cache.hit, false)
  // five at once: one read of the source
  const five = await Promise.all(Array.from({ length: 5 }, () => read('SELECT * FROM trips WHERE x = 2')))
  assert.equal(new Set(five.map((r) => r.rows[0].n)).size, 1)
})
