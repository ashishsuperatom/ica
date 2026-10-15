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

test('connections: downloaded, given to the manager in memory, given again, taken away; written ones go up', async () => {
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
  const platform = { fetchBridge: async (h: string) => { assert.equal(h, sha(code)); return code }, uploadBridge: async (n: string, c: string) => { uploaded.push([n, c]); return { name: n, bridge: sha(c), changed: true } } } as any
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
  // a bridge written here (the connector agent) that the platform lacks goes up; one it has does not
  mkdirSync(join(dir, 'NEWSRC')); writeFileSync(join(dir, 'NEWSRC', 'bridge.mjs'), 'export function createBridge() {}')
  await c.uploadWritten()
  assert.deepEqual(uploaded.map(([n]) => n), ['NEWSRC'])
  // how each stands, as its connector's own test says: ready; one that cannot reach its source, degraded with why
  assert.equal(reported.filter((x) => x.id === 'TG').at(-1).state, 'ready')
  c.onMessage({ t: 'connections:list', connections: [{ id: 'con_2', name: 'DOWN', connector: 'code', settings: {}, secrets: {}, bridge: sha(code), spec: 'abcd1234' }] })
  for (let i = 0; i < 250 && reported.filter((x) => x.id === 'DOWN' && x.state === 'degraded').length === 0; i++) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(reported.filter((x) => x.id === 'DOWN').at(-1), { kind: 'connection', id: 'DOWN', state: 'degraded', version: sha(code).slice(0, 12), spec: 'abcd1234', restarts: 0, error: { what: 'it cannot reach its source', detail: 'ECONNREFUSED 10.0.0.9:5432' } })
  } finally { c.close(); server.close() }
})

test("a person's own instance: started for their turn with their key, ended when it changes", async () => {
  const posted: any[] = [], deleted: string[] = []
  const server = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') return res.end(JSON.stringify({ sources: [] }))
    const body = JSON.parse(b || '{}')
    if (req.url === '/test') return res.end(JSON.stringify({ ok: true, tested: true }))
    if (req.method === 'POST') { posted.push(body); return res.end(JSON.stringify({ ok: true })) }
    deleted.push(body.id); res.end(JSON.stringify({ ok: true }))
  }) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const dir = mkdtempSync(join(tmpdir(), 'conn-p-'))
  const platform = { fetchBridge: async () => code } as any
  const sent: any[] = []
  const c = createConnections({ dir, manager: `http://127.0.0.1:${(server.address() as any).port}`, platform, send: (m) => { sent.push(m); return true } })
  try {
    c.onMessage({ t: 'connections:list', connections: [{ id: 'con_9', name: 'CRM', connector: 'postgres', settings: { host: 'db' }, secrets: { password: 'shared' }, bridge: sha(code), auth: 'per-user', spec: 's1' }] })
    for (let i = 0; i < 250 && !posted.some((p) => p.id === 'CRM'); i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(posted.find((p) => p.id === 'CRM').perUser, true)
    const going = c.forPerson('Ana@X.test')
    for (let i = 0; i < 250 && !sent.some((m) => m.type === 'connection:person-key'); i++) await new Promise((r) => setTimeout(r, 20))
    const ask = sent.find((m) => m.type === 'connection:person-key')
    assert.deepEqual({ name: ask.name, email: ask.email }, { name: 'CRM', email: 'Ana@X.test' })
    c.onMessage({ t: 'connection:person-key', reqId: ask.reqId, key: { settings: { user: 'ana' }, secrets: { password: 'hers' } } })
    await going
    const own = posted.find((p) => p.of === 'CRM')
    assert.match(own.id, /^CRM~[0-9a-f]{12}$/)
    assert.deepEqual(own.config, { settings: { host: 'db', user: 'ana' }, secrets: { password: 'hers' } })   // never the shared password
    await c.forPerson('ana@x.test')   // held: not asked again
    assert.equal(sent.filter((m) => m.type === 'connection:person-key').length, 1)
    c.onMessage({ t: 'connections:person-key-changed', name: 'CRM', email: 'ana@x.test' })
    for (let i = 0; i < 100 && !deleted.includes(own.id); i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(deleted.includes(own.id))
  } finally { c.close(); server.close() }
})
