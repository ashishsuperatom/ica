// The project's connections on the engine (connections.ts): downloaded from the platform and given to the data source
// manager with their settings and secrets in memory; given again when the manager lost them; a source the platform no
// longer has is taken away; a bridge written here goes up to the platform.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createConnections } from '../connections.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const code = 'export function createBridge(c) { return { id: "x", kind: "sql", ready: () => true } }'

test('connections: downloaded, given to the manager in memory, given again, taken away; what the connector agent wrote published through the one door, as who asked', async () => {
  // a stand-in data source manager
  let sources = new Map<string, any>()
  const server = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET') return res.end(JSON.stringify({ sources: [...sources.keys()].map((id) => ({ id, kind: 'sql', ready: true })) }))
      const body = JSON.parse(b || '{}')
      if (req.method === 'POST' && req.url === '/test') return res.end(JSON.stringify({ ok: body.id !== 'DOWN', tested: true, ...(body.id === 'DOWN' ? { error: 'ECONNREFUSED 10.0.0.9:5432' } : {}) }))
      if (req.method === 'POST') { sources.set(body.id, body); return res.end(JSON.stringify({ ok: true })) }
      sources.delete(body.id); res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const manager = `http://127.0.0.1:${(server.address() as any).port}`
  const dir = mkdtempSync(join(tmpdir(), 'conn-'))
  const uploaded: [string, string][] = []
  const platform = { fetchBridge: async (h: string) => { assert.equal(h, sha(code)); return code }, publishDraft: async (n: string, c: string, m: unknown, by: string | null) => { uploaded.push([n, c, by] as any); return { id: n.toLowerCase(), version: sha(c), status: 'ready' } } } as any
  const sent: any[] = []
  const reported: any[] = []
  const workloads = { set: (x: any) => reported.push(x), get: () => undefined, gone: () => {}, onAct: () => {}, onInspect: () => {} } as any
  const c = createConnections({ dir, manager, platform, workloads, send: (m) => { sent.push(m); return true } })
  try {
  c.pull()
  assert.deepEqual(sent.at(-1), { type: 'connections:pull' })
  c.onMessage({ t: 'connections:list', connections: [{ id: 'con_1', name: 'TG', connector: 'code', settings: { wsUrl: 'wss://x' }, secrets: { apiKey: 'k' }, bridge: sha(code) }] })
  for (let i = 0; i < 250 && !sources.has('TG'); i++) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(sources.get('TG').config, { settings: { wsUrl: 'wss://x' }, secrets: { apiKey: 'k' } })   // in memory
  assert.equal(readFileSync(join(dir, 'TG', 'bridge.mjs'), 'utf8'), code)
  assert.equal(existsSync(join(dir, 'TG', '.env')), false)                                                    // no secret on disk
  // the platform says it changed → pull again
  c.onMessage({ t: 'connections:changed' }); assert.deepEqual(sent.at(-1), { type: 'connections:pull' })
  // a source the platform no longer has is taken away
  sources.set('OLD', {})
  c.onMessage({ t: 'connections:list', connections: [{ id: 'con_1', name: 'TG', connector: 'code', settings: {}, secrets: {}, bridge: sha(code) }] })
  for (let i = 0; i < 250 && sources.has('OLD'); i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(sources.has('OLD'), false)
  // code written here (the connector agent) that its connection does not run is published, as who asked; the code a
  // connection runs already is not
  mkdirSync(join(dir, 'NEWSRC')); writeFileSync(join(dir, 'NEWSRC', 'bridge.mjs'), 'export function createBridge() {}')
  await c.publishWritten('ana@x.test')
  assert.deepEqual(uploaded.map((u: any) => [u[0], u[2]]), [['NEWSRC', 'ana@x.test']])
  // how each stands, as its connector's own test says: ready; one that cannot reach its source, degraded with why
  // (the list above changed its settings, so it was loaded again: ready once that is done)
  for (let i = 0; i < 250 && reported.filter((x) => x.id === 'TG').at(-1)?.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(reported.filter((x) => x.id === 'TG').at(-1).state, 'ready')
  c.onMessage({ t: 'connections:list', connections: [{ id: 'con_2', name: 'DOWN', connector: 'code', settings: {}, secrets: {}, bridge: sha(code), spec: 'abcd1234' }] })
  for (let i = 0; i < 250 && reported.filter((x) => x.id === 'DOWN' && x.state === 'degraded').length === 0; i++) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(reported.filter((x) => x.id === 'DOWN').at(-1), { kind: 'connection', id: 'DOWN', state: 'degraded', version: sha(code).slice(0, 12), spec: 'abcd1234', restarts: 0, error: { what: 'it cannot reach its source', detail: 'ECONNREFUSED 10.0.0.9:5432' } })
  } finally { c.close(); server.close() }
})

test("a person's own key: fetched when the manager says a read of theirs needs it, handed over as their values over the connection's settings (never its shared secrets); none given said so; their key changed, their client forgotten", async () => {
  const posted: any[] = [], given: any[] = [], forgot: any[] = []
  let wants: any[] = [{ source: 'CRM', person: 'a1b2c3d4e5f6', email: 'Ana@X.test' }, { source: 'CRM', person: '0123456789ab', email: 'bo@x.test' }]
  const server = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url?.startsWith('/wants')) { const w = wants; wants = []; return setTimeout(() => res.end(JSON.stringify({ wants: w })), w.length ? 0 : 200) }
    if (req.method === 'GET') return res.end(JSON.stringify({ sources: [] }))
    const body = JSON.parse(b || '{}')
    if (req.url === '/test') return res.end(JSON.stringify({ ok: true, tested: true }))
    if (req.url === '/person') { given.push(body); return res.end(JSON.stringify({ ok: true })) }
    if (req.url === '/person/forget') { forgot.push(body); return res.end(JSON.stringify({ ok: true })) }
    if (req.method === 'POST') { posted.push(body); return res.end(JSON.stringify({ ok: true })) }
    res.end(JSON.stringify({ ok: true }))
  }) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const dir = mkdtempSync(join(tmpdir(), 'conn-p-'))
  const platform = { fetchBridge: async () => code } as any
  const sent: any[] = []
  const c = createConnections({ dir, manager: `http://127.0.0.1:${(server.address() as any).port}`, platform, send: (m) => {
    sent.push(m)
    // the platform: Ana gave her key, Bo none
    if (m.type === 'connection:person-key') setTimeout(() => c.onMessage({ t: 'connection:person-key', reqId: m.reqId, key: String(m.email).toLowerCase() === 'ana@x.test' ? { settings: { user: 'ana' }, secrets: { password: 'hers' } } : null }), 5)
    return true
  } })
  try {
    c.onMessage({ t: 'connections:list', connections: [{ id: 'con_9', name: 'CRM', connector: 'postgres', settings: { host: 'db' }, secrets: { password: 'shared' }, bridge: sha(code), auth: 'per-user', spec: 's1' }] })
    for (let i = 0; i < 250 && given.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(posted.find((p) => p.id === 'CRM').perUser)                    // loaded once, as itself: no instance per person
    assert.equal(posted.filter((p) => p.id !== 'CRM').length, 0)
    assert.deepEqual(sent.filter((m) => m.type === 'connection:person-key').map((m) => [m.name, m.email]), [['CRM', 'Ana@X.test'], ['CRM', 'bo@x.test']])
    const ana = given.find((g) => g.person === 'a1b2c3d4e5f6'), bo = given.find((g) => g.person === '0123456789ab')
    assert.deepEqual(ana, { source: 'CRM', person: 'a1b2c3d4e5f6', config: { settings: { host: 'db', user: 'ana' }, secrets: { password: 'hers' } } })   // never the shared password
    assert.deepEqual(bo, { source: 'CRM', person: '0123456789ab', config: null })
    c.onMessage({ t: 'connections:person-key-changed', name: 'CRM', email: 'ana@x.test' })
    for (let i = 0; i < 100 && !forgot.length; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(forgot[0].source, 'CRM'); assert.match(forgot[0].person, /^[0-9a-f]{12}$/)
  } finally { c.close(); server.close() }
})
