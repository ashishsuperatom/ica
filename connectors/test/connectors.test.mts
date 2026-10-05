import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkManifest, type Manifest } from '../src/contract.ts'
import { gatewayFetch, allowedHosts, type CallRecord } from '../src/gateway.ts'
import { runOp } from '../src/sandbox.ts'
import github from '../catalog/github/server.ts'
import restJson from '../catalog/rest-json/server.ts'
import mcpServer from '../catalog/mcp-server/server.ts'

const root = new URL('..', import.meta.url).pathname
const manifest = (id: string): Manifest => JSON.parse(readFileSync(join(root, 'catalog', id, 'manifest.json'), 'utf8'))
const json = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })

test('every manifest in the catalog is sound', () => {
  for (const id of readdirSync(join(root, 'catalog'))) assert.deepEqual(checkManifest(manifest(id)), [], id)
  assert.ok(checkManifest({ id: 'x', name: 'X', version: 1, icon: 'i', says: 's', category: 'api', hosts: ['{nope}'], fields: [], auth: { kind: 'header', header: 'A', template: '{tok}' }, offers: { data: true, actions: false } }).length >= 2)
})

test('github: credentials added by the gateway (never seen by the connector), pages followed, an issue opened, other hosts refused', async () => {
  const seen: Request[] = []
  const api = (async (url: string, init: RequestInit) => {
    const req = new Request(url, init); seen.push(req)
    const u = new URL(url)
    if (u.pathname === '/user') return json({ login: 'ana' })
    if (u.pathname === '/repos/acme/app/issues' && req.method === 'GET') {
      const page = u.searchParams.get('page') ?? '1'
      const rows = page === '1' ? [{ number: 2, title: 'Two', state: 'open', user: { login: 'b' }, labels: [{ name: 'bug' }], comments: 1, created_at: '2026-10-01T00:00:00Z' }, { number: 3, title: 'A PR', pull_request: {} }] : [{ number: 1, title: 'One', state: 'open', user: { login: 'a' }, labels: [] }]
      return json(rows, { headers: page === '1' ? { link: '<https://api.github.com/repos/acme/app/issues?page=2>; rel="next"' } : {} })
    }
    if (u.pathname === '/repos/acme/app/issues' && req.method === 'POST') { const b = await req.json(); return json({ number: 9, html_url: `https://github.com/acme/app/issues/9`, title: b.title }, { status: 201 }) }
    return json({ message: 'Not Found' }, { status: 404 })
  }) as typeof fetch
  const calls: CallRecord[] = []
  const m = manifest('github')
  const gw = gatewayFetch({ manifest: m, settings: {}, secrets: { token: 'ghp_secret' }, record: (c) => calls.push(c), fetcher: api })
  const t = await runOp(github, 'test', {}, null, gw)
  assert.deepEqual(t.result, { ok: true, message: 'connected as ana' })
  assert.equal(seen[0].headers.get('authorization'), 'Bearer ghp_secret')
  const r = await runOp(github, 'read', {}, { entity: 'issues', filters: { repo: 'acme/app' }, limit: 10 }, gw)
  assert.ok(r.ok, r.error)
  assert.deepEqual((r.result as any).rows.map((x: any) => x.number), [2, 1])   // the pull request is left out; page 2 followed
  assert.equal((r.result as any).rows[0].labels, 'bug')
  const a = await runOp(github, 'act', {}, { action: 'open_issue', input: { repo: 'acme/app', title: 'Hello' } }, gw)
  assert.deepEqual(a.result, { ok: true, result: { number: 9, url: 'https://github.com/acme/app/issues/9' }, message: 'opened #9' })
  const missing = await runOp(github, 'act', {}, { action: 'open_issue', input: { repo: 'acme/app' } }, gw)
  assert.match(missing.error!, /needs title/)
  // the connector's code reaching anywhere else is refused, and recorded
  const evil = await gw('https://evil.example.com/steal').catch((e) => e)
  assert.match(String(evil.message), /not a host this connector may call/)
  assert.equal(calls.at(-1)!.refused, 'host not allowed')
  assert.ok(calls.every((c) => !JSON.stringify(c).includes('ghp_secret')))   // the record never holds a credential
  const bad = await runOp(github, 'read', {}, { entity: 'nothing' }, gw)
  assert.match(bad.error!, /nothing called "nothing"/)
})

test('rest-json: the endpoints a person names become entities with their fields; next links followed; its host is the base URL', async () => {
  const m = manifest('rest-json')
  const settings = { baseUrl: 'https://api.shop.example/v1', endpoints: 'customers /customers\norders /orders', header: 'X-Api-Key' }
  assert.deepEqual(allowedHosts(m, settings), ['api.shop.example'])
  const api = (async (url: string, init: RequestInit) => {
    const h = new Headers(init.headers)
    if (h.get('x-api-key') !== 'Bearer k1') return json({ error: 'no key' }, { status: 401 })
    const u = new URL(url)
    if (u.pathname === '/v1/customers') return u.searchParams.get('after') ? json({ data: [{ id: 3, name: 'C', address: { city: 'Pune' } }] }) : json({ data: [{ id: 1, name: 'A', address: { city: 'Delhi' } }, { id: 2, name: 'B', address: { city: 'Goa' } }], next: 'https://api.shop.example/v1/customers?after=2' })
    if (u.pathname === '/v1/orders') return json([{ id: 10, total: 5.5, at: '2026-10-01T10:00:00Z', paid: true }])
    return json({}, { status: 404 })
  }) as typeof fetch
  const gw = gatewayFetch({ manifest: m, settings, secrets: { token: 'k1' }, record: () => {}, fetcher: api })
  const i = await runOp(restJson, 'introspect', settings, null, gw)
  const ents = (i.result as any).entities
  assert.deepEqual(ents.map((e: any) => e.name), ['customers', 'orders'])
  assert.deepEqual(ents[1].fields, [{ name: 'id', type: 'integer' }, { name: 'total', type: 'number' }, { name: 'at', type: 'timestamp' }, { name: 'paid', type: 'boolean' }])
  assert.ok(ents[0].fields.some((f: any) => f.name === 'address.city'))
  const r = await runOp(restJson, 'read', settings, { entity: 'customers', limit: 10 }, gw)
  assert.deepEqual((r.result as any).rows.map((x: any) => x['address.city']), ['Delhi', 'Goa', 'Pune'])
  const noKey = await runOp(restJson, 'test', settings, null, gatewayFetch({ manifest: m, settings, secrets: {}, record: () => {}, fetcher: api }))
  assert.match(noKey.error!, /credentials were refused/)
})

test('mcp-server: a Streamable HTTP server — tools become actions by their hints, resources readable, a tool run; replies as JSON and as an event stream', async () => {
  const m = manifest('mcp-server')
  const settings = { url: 'https://mcp.example.com/mcp' }
  let initialized = false
  const tools = [
    { name: 'search', description: 'Search documents', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
    { name: 'recent', description: 'Recent documents', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
    { name: 'delete_doc', description: 'Delete a document', annotations: { destructiveHint: true }, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'tag', description: 'Tag a document', inputSchema: { type: 'object', properties: { id: { type: 'string' }, tag: { type: 'string' } } } },
  ]
  const api = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as ArrayBuffer)); const h = new Headers(init.headers)
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'docs' } } }, { headers: { 'mcp-session-id': 'sess-1' } })
    if (h.get('mcp-session-id') !== 'sess-1') return new Response('no session', { status: 400 })
    if (body.method === 'notifications/initialized') { initialized = true; return new Response(null, { status: 202 }) }
    const reply = (result: unknown) => body.method === 'tools/call'
      ? new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : json({ jsonrpc: '2.0', id: body.id, result })
    if (body.method === 'tools/list') return reply({ tools })
    if (body.method === 'resources/list') return reply({ resources: [{ uri: 'docs://readme', name: 'readme', title: 'Read me' }] })
    if (body.method === 'resources/read') return reply({ contents: [{ uri: body.params.uri, mimeType: 'text/plain', text: 'Hello' }] })
    if (body.method === 'tools/call' && body.params.name === 'recent') return reply({ content: [{ type: 'text', text: JSON.stringify([{ id: 'd1', title: 'Plan' }]) }] })
    if (body.method === 'tools/call' && body.params.name === 'tag') return reply({ content: [{ type: 'text', text: 'tagged' }] })
    return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such method' } })
  }) as typeof fetch
  const gw = gatewayFetch({ manifest: m, settings, secrets: { token: 't' }, record: () => {}, fetcher: api })
  const i = await runOp(mcpServer, 'introspect', settings, null, gw)
  assert.ok(i.ok, i.error)
  assert.ok(initialized)
  const actions = (i.result as any).actions
  assert.deepEqual(actions.map((a: any) => [a.name, a.effect, !!a.confirm]), [['search', 'read', false], ['recent', 'read', false], ['delete_doc', 'irreversible', true], ['tag', 'write', true]])
  assert.deepEqual(actions[0].input, [{ name: 'q', type: 'string', description: undefined, required: true }])
  assert.deepEqual((i.result as any).entities.map((e: any) => e.name), ['docs://readme', 'tool:recent'])
  const res = await runOp(mcpServer, 'read', settings, { entity: 'docs://readme' }, gw)
  assert.deepEqual((res.result as any).rows, [{ uri: 'docs://readme', mimeType: 'text/plain', text: 'Hello' }])
  const viaTool = await runOp(mcpServer, 'read', settings, { entity: 'tool:recent' }, gw)
  assert.deepEqual((viaTool.result as any).rows, [{ id: 'd1', title: 'Plan' }])
  const act = await runOp(mcpServer, 'act', settings, { action: 'tag', input: { id: 'd1', tag: 'x' } }, gw)
  assert.deepEqual(act.result, { ok: true, result: 'tagged', message: undefined })
  const none = await runOp(mcpServer, 'act', settings, { action: 'nope', input: {} }, gw)
  assert.match(none.error!, /no action "nope"/)
})
