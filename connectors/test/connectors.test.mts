import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkEngineManifest, type EngineManifest } from '../src/contract.ts'
import { createBridge as github } from '../bridges/github/connector.ts'
import { createBridge as restJson } from '../bridges/rest-json/connector.ts'
import { createBridge as mcpServer } from '../bridges/mcp-server/connector.ts'
import { createBridge as sheets } from '../bridges/google-sheets/connector.ts'

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
  assert.match(await failed(g.query('SELECT 1')), /a query is JSON/i)
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

test('google-sheets: a tree — a person\'s own spreadsheets (paged, searched), a spreadsheet\'s sheets, a sheet\'s rows named by its first row; read by path', async () => {
  const seen: Request[] = []
  const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  const api = (async (url: string, init: RequestInit) => {
    const req = new Request(url, init); seen.push(req)
    const u = new URL(url)
    if (u.pathname === '/drive/v3/about') return json({ user: { emailAddress: 'ana@x.test' } })
    if (u.pathname === '/drive/v3/files') {
      assert.match(u.searchParams.get('q') ?? '', /mimeType='application\/vnd.google-apps.spreadsheet'/)
      if (/name contains 'Bud'/.test(u.searchParams.get('q') ?? '')) return json({ files: [{ id: ID, name: 'Budget' }] })
      return u.searchParams.get('pageToken') ? json({ files: [{ id: 'older', name: 'Old', modifiedTime: '2026-01-01T00:00:00Z' }] }) : json({ files: [{ id: ID, name: 'Budget', modifiedTime: '2026-10-01T00:00:00Z', owners: [{ emailAddress: 'ana@x.test' }], webViewLink: 'https://docs.google.com/x' }], nextPageToken: 'p2' })
    }
    if (u.pathname === `/v4/spreadsheets/${ID}`) return json({ properties: { title: 'Budget' }, sheets: [{ properties: { title: 'Q4 plan', gridProperties: { rowCount: 100, columnCount: 5 } } }] })
    if (u.pathname.startsWith(`/v4/spreadsheets/${ID}/values/`)) {
      assert.equal(decodeURIComponent(u.pathname.split('/values/')[1]), "'Q4 plan'!1:3")
      return json({ values: [['Region', 'Amount', '', 'Amount'], ['North', 120, 'x', 5], ['', '', '', ''], ['South', 80]] })
    }
    return json({ error: { message: 'not found' } }, { status: 404 })
  }) as typeof fetch
  const g = sheets({ secrets: { accessToken: 'ya29.token' }, fetch: api })
  assert.ok(g.ready()); assert.equal(sheets({}).ready(), false)   // no account connected: not tried
  assert.equal(await g.test(), 'signed in as ana@x.test')
  assert.equal(seen[0].headers.get('authorization'), 'Bearer ya29.token')
  // its tree: two levels, the last holding rows
  assert.deepEqual(g.tree, [{ name: 'Spreadsheet' }, { name: 'Sheet' }])
  assert.deepEqual((await g.introspect()).tree, g.tree)
  const top = await g.children({ path: [], limit: 1 })
  assert.deepEqual(top, { nodes: [{ id: ID, label: 'Budget', table: false, detail: { modified: '2026-10-01T00:00:00Z', owner: 'ana@x.test' } }], next: 'p2' })   // a page, and where the next starts
  assert.deepEqual((await g.children({ path: [], cursor: top.next })).nodes.map((n: any) => n.label), ['Old'])
  assert.deepEqual((await g.children({ path: [], limit: 10 })).nodes.map((n: any) => n.label), ['Budget', 'Old'])   // its pages followed
  assert.deepEqual((await g.children({ path: [], search: 'Bud' })).nodes.map((n: any) => n.label), ['Budget'])   // searched at the source
  assert.deepEqual((await g.children({ path: [ID] })).nodes, [{ id: 'Q4 plan', label: 'Q4 plan', table: true, detail: { rows: 100, columns: 5 } }])
  assert.match(await failed(g.children({ path: [ID, 'Q4 plan'] })), /holds rows/)
  // the first row names the fields; an empty or repeated name is the column's letter; an empty row is left out
  assert.deepEqual(await g.query(JSON.stringify({ path: [ID, 'Q4 plan'], limit: 2 })), [{ Region: 'North', Amount: 120, C: 'x', D: 5 }, { Region: 'South', Amount: 80, C: null, D: null }])
  // an agent lists with the same query: a path short of a table, what is inside it
  assert.deepEqual(await g.query(JSON.stringify({ path: [ID] })), [{ sheet: 'Q4 plan', id: 'Q4 plan', rows: 100, columns: 5 }])
  assert.deepEqual((await g.query(JSON.stringify({ path: [], limit: 1 })))[0], { spreadsheet: 'Budget', id: ID, modified: '2026-10-01T00:00:00Z', owner: 'ana@x.test' })
  assert.match(g.description, /\{"path": \["<spreadsheet>", "<sheet>"\]/)
  assert.match(await failed(g.query(JSON.stringify({ path: [ID, 'Q4 plan', 'x'] }))), /at most 2 parts/)
  assert.match(await failed(g.query(JSON.stringify({ path: ['nope', 'x'] }))), /not a spreadsheet/)
})

test('tree: a connector with no levels is one level of tables — its entities — listed and read by path the same way; a tree of one level is refused', async () => {
  const { apiConnector } = await import('../src/api.ts')
  const flat = apiConnector('flat', { description: 'Flat.', test: async () => 'ok', entities: [{ name: 'users', label: 'Users', fields: [] }, { name: 'posts', fields: [] }], read: { '*': async (_c, r) => ({ rows: [{ from: r.entity }] }) } })()
  assert.equal((flat as any).tree, undefined)
  assert.deepEqual(await flat.children({ path: [] }), { nodes: [{ id: 'users', label: 'Users', table: true }, { id: 'posts', label: 'posts', table: true }], next: null })
  assert.deepEqual((await flat.children({ path: [], search: 'post' })).nodes.map((n: any) => n.id), ['posts'])
  assert.deepEqual(await flat.query(JSON.stringify({ path: ['posts'] })), [{ from: 'posts' }])
  assert.match(await failed(flat.children({ path: ['posts'] })), /holds rows/)
  const one = apiConnector('one', { description: 'One.', test: async () => 'ok', tree: { levels: [{ name: 'Table' }], children: async () => ({ nodes: [] }), read: async () => ({ rows: [] }) } })
  assert.throws(() => one(), /two levels or more/)
})

test("setup: each connector's steps ask every field once, each proven by a check; one without is made from its fields; a failure says how to fix it", async () => {
  const { setupOf, fixFor, checkSetup } = await import('../src/setup.ts')
  for (const id of readdirSync(join(root, 'bridges'))) {
    const m = manifest(id)
    if (m.builtin) continue
    const steps = setupOf(m as any)
    assert.ok(steps.length, id)
    assert.ok(steps.some((s) => s.check), `${id}: something is checked`)
  }
  // made from the fields: where it is (reached) → sign in (tested)
  const made = setupOf({ title: 'Acme DB', kind: 'sql', identity: ['shared'], fields: [{ name: 'host', label: 'Host', type: 'text' }, { name: 'port', label: 'Port', type: 'number' }, { name: 'user', label: 'User', type: 'text' }, { name: 'password', label: 'Password', type: 'secret' }] } as any)
  assert.deepEqual(made.map((s) => [s.id, s.fields, s.check?.kind]), [['where', ['host', 'port'], 'reach'], ['signin', ['user', 'password'], 'signin']])
  // one people sign in to: the organisation's app, then each person's account
  assert.deepEqual(setupOf({ title: 'Docs', kind: 'api', identity: ['person-oauth'], oauth: { provider: 'google' }, fields: [] } as any).map((s) => s.check?.kind), ['oauth-app', 'oauth-account'])
  // a field asked nowhere, an unknown check: refused
  assert.deepEqual(checkSetup({ fields: [{ name: 'a', label: 'A', type: 'text' }, { name: 'b', label: 'B', type: 'text' }], setup: [{ id: 's', title: 'S', say: '', fields: ['a'], check: { kind: 'magic' } }, { id: 't', title: 'T', say: '', check: { kind: 'custom' } }] } as any),
    ['setup step s: check is reach, signin, oauth-app, oauth-account, custom', 'setup step t: a custom check names one of its connector\'s checks', 'setup: field b is asked in no step'])
  // an API connector's own checks (Parts.checks), run by name
  const withCheck = (await import('../src/api.ts')).apiConnector('x', { description: 'x', test: async () => 'ok', checks: { scopes: async (ctx) => `token for ${ctx.secrets.token}` } })({ secrets: { token: 't1' } })
  assert.equal(await withCheck.check('scopes'), 'token for t1')
  assert.match(await failed(withCheck.check('other')), /no check other/)
  // what to tell the person: the step's own words first, then the common ones, with what they gave
  const pg = setupOf(manifest('postgres') as any).find((s) => s.id === 'signin')!
  assert.match(fixFor(pg, 'no pg_hba.conf entry for host "1.2.3.4"', { user: 'reader' }), /host all reader/)
  assert.match(fixFor(pg, 'password authentication failed for user "x"'), /sign-in was refused/)
  assert.match(fixFor(undefined, 'getaddrinfo ENOTFOUND db.nope'), /No computer answers to that name/)
})
