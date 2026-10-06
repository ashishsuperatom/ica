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
  const c = createConnections({ dir, manager, platform, send: (m) => { sent.push(m); return true } })
  c.pull()
  assert.deepEqual(sent.at(-1), { type: 'connections:pull' })
  c.onMessage({ t: 'connections:list', connections: [{ id: 'con_1', name: 'TG', connector: 'code', settings: { wsUrl: 'wss://x' }, secrets: { apiKey: 'k' }, bridge: sha(code) }] })
  for (let i = 0; i < 50 && !sources.has('TG'); i++) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(sources.get('TG').config, { settings: { wsUrl: 'wss://x' }, secrets: { apiKey: 'k' } })   // in memory
  assert.equal(readFileSync(join(dir, 'TG', 'bridge.mjs'), 'utf8'), code)
  assert.equal(existsSync(join(dir, 'TG', '.env')), false)                                                    // no secret on disk
  // the platform says it changed → pull again
  c.onMessage({ t: 'connections:changed' }); assert.deepEqual(sent.at(-1), { type: 'connections:pull' })
  // a source the platform no longer has is taken away
  sources.set('OLD', {})
  c.onMessage({ t: 'connections:list', connections: [{ id: 'con_1', name: 'TG', connector: 'code', settings: {}, secrets: {}, bridge: sha(code) }] })
  for (let i = 0; i < 50 && sources.has('OLD'); i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(sources.has('OLD'), false)
  // a bridge written here (the connector agent) that the platform lacks goes up; one it has does not
  mkdirSync(join(dir, 'NEWSRC')); writeFileSync(join(dir, 'NEWSRC', 'bridge.mjs'), 'export function createBridge() {}')
  await c.uploadWritten()
  assert.deepEqual(uploaded.map(([n]) => n), ['NEWSRC'])
  c.close(); server.close()
})
