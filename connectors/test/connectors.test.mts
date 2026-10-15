import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkEngineManifest, type EngineManifest } from '../src/contract.ts'
import { createBridge as github } from '../bridges/github/connector.ts'
import { createBridge as restJson } from '../bridges/rest-json/connector.ts'
import { createBridge as mcpServer } from '../bridges/mcp-server/connector.ts'

const root = new URL('..', import.meta.url).pathname
const manifest = (id: string): EngineManifest => JSON.parse(readFileSync(join(root, 'bridges', id, 'manifest.json'), 'utf8'))
const json = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
const failed = (p: Promise<unknown>) => p.then(() => { throw new Error('it did not fail') }, (e) => String(e?.message ?? e))

test('every connector is one kind — an engine connector — and every manifest is sound', () => {
  for (const id of readdirSync(join(root, 'bridges'))) assert.deepEqual(checkEngineManifest(manifest(id)), [], id)
})

test('github: signed in with its token, pages followed, read with a JSON query, an issue opened', async () => {
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
  const g = github({ secrets: { token: 'ghp_secret' }, fetch: api })
  assert.equal(g.kind, 'api'); assert.ok(g.ready())
  assert.equal(await g.test(), 'connected as ana')
  assert.equal(seen[0].headers.get('authorization'), 'Bearer ghp_secret')
  const rows = await g.query(JSON.stringify({ entity: 'issues', filters: { repo: 'acme/app' }, limit: 10 }))
  assert.deepEqual(rows.map((x: any) => x.number), [2, 1])   // the pull request is left out; page 2 followed
  assert.equal((rows[0] as any).labels, 'bug')
  assert.deepEqual(await g.act('open_issue', { repo: 'acme/app', title: 'Hello' }), { ok: true, result: { number: 9, url: 'https://github.com/acme/app/issues/9' }, message: 'opened #9' })
  assert.match(await failed(g.act('open_issue', { repo: 'acme/app' })), /needs title/)
  assert.match(await failed(g.query(JSON.stringify({ entity: 'nothing' }))), /nothing called "nothing" to read \(its entities: repositories, issues, pull_requests\)/)
  assert.match(await failed(g.query('SELECT 1')), /a query is JSON/)
  const described = await g.introspect()
  assert.deepEqual(described.tables.map((t: any) => t.name), ['repositories', 'issues', 'pull_requests'])
  assert.ok(described.tables[1].columns.some((c: any) => c.name === 'title'))
  assert.deepEqual(described.actions.map((x: any) => x.name), ['open_issue'])
  assert.equal(github({}).ready(), false)                     // no token: not tried
})

test('rest-json: the endpoints a person names become entities with their fields; next links followed; its token in the header named', async () => {
  const settings = { baseUrl: 'https://api.shop.example/v1', endpoints: 'customers /customers\norders /orders', header: 'X-Api-Key' }
  const api = (async (url: string, init: RequestInit) => {
    const h = new Headers(init.headers)
    if (h.get('x-api-key') !== 'Bearer k1') return json({ error: 'no key' }, { status: 401 })
    const u = new URL(url)
    if (u.pathname === '/v1/customers') return u.searchParams.get('after') ? json({ data: [{ id: 3, name: 'C', address: { city: 'Pune' } }] }) : json({ data: [{ id: 1, name: 'A', address: { city: 'Delhi' } }, { id: 2, name: 'B', address: { city: 'Goa' } }], next: 'https://api.shop.example/v1/customers?after=2' })
    if (u.pathname === '/v1/orders') return json([{ id: 10, total: 5.5, at: '2026-10-01T10:00:00Z', paid: true }])
    return json({}, { status: 404 })
  }) as typeof fetch
  const r = restJson({ settings, secrets: { token: 'k1' }, fetch: api })
  const ents = (await r.introspect()).tables
  assert.deepEqual(ents.map((e: any) => e.name), ['customers', 'orders'])
  assert.deepEqual(ents[1].columns, [{ name: 'id', type: 'integer' }, { name: 'total', type: 'number' }, { name: 'at', type: 'timestamp' }, { name: 'paid', type: 'boolean' }])
  assert.ok(ents[0].columns.some((f: any) => f.name === 'address.city'))
  assert.deepEqual((await r.query(JSON.stringify({ entity: 'customers', limit: 10 }))).map((x: any) => x['address.city']), ['Delhi', 'Goa', 'Pune'])
  assert.match(await failed(restJson({ settings, secrets: {}, fetch: api }).test()), /credentials were refused/)
})

test('mcp-server: a Streamable HTTP server — tools become actions by their hints, resources readable, a tool run; replies as JSON and as an event stream', async () => {
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
  const m = mcpServer({ settings, secrets: { token: 't' }, fetch: api })
  const i = await m.introspect()
  assert.ok(initialized)
  assert.deepEqual(i.actions.map((a: any) => [a.name, a.effect, !!a.confirm]), [['search', 'read', false], ['recent', 'read', false], ['delete_doc', 'irreversible', true], ['tag', 'write', true]])
  assert.deepEqual(i.actions[0].input, [{ name: 'q', type: 'string', description: undefined, required: true }])
  assert.deepEqual(i.tables.map((e: any) => e.name), ['docs://readme', 'tool:recent'])
  assert.deepEqual(await m.query(JSON.stringify({ entity: 'docs://readme' })), [{ uri: 'docs://readme', mimeType: 'text/plain', text: 'Hello' }])
  assert.deepEqual(await m.query(JSON.stringify({ entity: 'tool:recent' })), [{ id: 'd1', title: 'Plan' }])
  assert.deepEqual(await m.act('tag', { id: 'd1', tag: 'x' }), { ok: true, result: 'tagged', message: undefined })
  assert.match(await failed(m.act('nope', {})), /no action "nope"/)
})
