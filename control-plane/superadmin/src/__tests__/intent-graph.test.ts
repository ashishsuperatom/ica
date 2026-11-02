// The intent graph, in the REAL Durable Objects (Miniflare): the engine asks what a message is decided with (its canonical
// form, the node the session is at, the candidates: the one exact match, else the best five by their words), says what
// happened (a node made, matched, stayed at — each node in an IntentDO of its own), and what a clone learnt when an intent
// closed (a person's variant, the names, the next intents); a person with no variant of their own answers with the
// project's; a curator approves one; people read it all over HTTP with no engine connected; a published change marks the
// nodes whose variants use it stale.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '44444333-3333-4444-5555-666666666666'
const SECRET = 's3cret'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export { IntentDO } from '../intent-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url)
  const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, v: 2, ...claims })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}
const at = async (path: string, init?: RequestInit) => { const r = await mf.dispatchFetch(`http://x${path}`, init); return { status: r.status, body: await r.json() as any } }
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** One engine process: connects, says hello as `engineId`, keeps what it hears and how its socket closed. */
async function engine(engineId: string | undefined, instance = `i-${Math.random().toString(36).slice(2)}`, epoch = Date.now()) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket! as unknown as WebSocket & { accept(): void }
  const got: any[] = []; let closed: number | null = null
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
  ws.addEventListener('close', (e: any) => { closed = e.code })
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'code-engine', key: 'ek', ...(engineId ? { engineId } : {}), host: 'box', instanceId: instance, epoch }))
  const until = async (pred: (m: any) => boolean, what = 'a message') => { for (let i = 0; i < 200; i++) { const m = got.find(pred); if (m) return m; await wait() } throw new Error(`${what} never came: ${JSON.stringify(got.map((x) => x.payload?.t))}`) }
  const part = async () => (await until((m) => m.payload?.t === 'welcome' || m.payload?.t === 'standby', 'a welcome or standby')).payload.t as 'welcome' | 'standby'
  return { ws, got, until, part, closed: () => closed }
}
/** A person watching the project, to see which engine their messages reach. */
async function person(tab?: string) {
  const token = jwt({ userId: 'u1', email: 'u1@x.io', role: 'user' })
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}?token=${token}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket! as unknown as WebSocket & { accept(): void }
  const got: any[] = [], raw: string[] = []
  ws.addEventListener('message', (e: any) => { raw.push(String(e.data)); try { got.push(JSON.parse(String(e.data))) } catch { /* not JSON */ } }); ws.accept()
  ws.send(JSON.stringify({ type: 'hello', role: 'runtime', token, ...(tab ? { tab } : {}) }))
  for (let i = 0; i < 200 && !got.some((m) => m.payload?.t === 'welcome'); i++) await wait()
  return { ws, got, raw }
}
beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true }, INTENT: { className: 'IntentDO', useSQLite: true } },
    r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await at('/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  await at('/do/access', { method: 'POST', body: JSON.stringify({ email: 'u1@x.io', roleId: 'admin' }) })   // seated for real (a token's own role counts for nothing)
}, 60_000)
afterAll(async () => { await mf?.dispose() })



const ask = async (e: Awaited<ReturnType<typeof engine>>, msg: Record<string, unknown>) => {
  const reqId = `r${Math.random().toString(36).slice(2, 8)}`
  e.ws.send(JSON.stringify({ ...msg, reqId }))
  return (await e.until((m) => m.payload?.reqId === reqId, String(msg.type))).payload
}
/** The project's HTTP API, as a seated person calls it through the worker (who is asking; the DO decides what they hold). */
const http = async (method: string, path: string, body?: unknown, email = 'u1@x.io') => (await mf.dispatchFetch(`http://x/do${path}`, { method, headers: { 'x-sa-caller': JSON.stringify({ kind: 'person', email }), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json() as Promise<any>
const say = async (p: Awaited<ReturnType<typeof person>>, payload: Record<string, unknown>) => {
  const reqId = `p${Math.random().toString(36).slice(2, 8)}`
  p.ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { ...payload, reqId } }))
  for (let i = 0; i < 200; i++) { const m = p.got.find((x) => x.payload?.reqId === reqId); if (m) return m.payload; await wait() }
  throw new Error(`no reply to ${payload.t}`)
}

describe('the intent graph', () => {
  let e: Awaited<ReturnType<typeof engine>>
  let rfqs = '', bids = ''
  const pass = (m: Record<string, unknown>) => ask(e, { type: 'intent:pass', from: null, block: null, params: [], owner: 'user:u1', by: 'u1@x.io', agent: 'analyst', ...m })
  it('a new project has the platform\'s nodes for its agents; a question no node has the words of finds none of them; the analyst\'s answer makes a node', async () => {
    e = await engine('eng-11111111'); expect(await e.part()).toBe('welcome')
    const f = await ask(e, { type: 'intent:find', text: 'How many RFQs are open in September 2026?', at: null, owner: 'user:u1', caps: ['project.ask'] })
    expect(f.t).toBe('intent:found'); expect(f.here).toBe(null); expect(f.total).toBe(2)
    expect(f.canonical).toBe('how many rfqs are open in {period}'); expect(f.params).toEqual([{ kind: 'period', value: 'september 2026' }])
    expect(f.exact).toBe(false); expect(f.candidates).toEqual([])
    const build = await ask(e, { type: 'intent:find', text: 'build me a program for open RFQs', at: null, owner: 'user:u1', caps: ['project.ask'] })
    expect(build.candidates.map((c: any) => [c.id, c.agent, c.allowed])).toEqual([['in-systembuilder', 'builder', false]])   // a member without project.develop may not be answered there
    const r = await pass({ node: null, body: { title: 'Open RFQs', intent: 'How many RFQs are open in a period', asked: 'How many RFQs are open in September 2026?', canonical: f.canonical, params: f.params }, session: 's1', question: 'How many RFQs are open in September 2026?', canonical: f.canonical, answer: '28 are open', how: 'made' })
    expect(r.t).toBe('intent:passed'); rfqs = r.node.id
    expect(rfqs).toMatch(/^in-[a-z0-9]+$/); expect(r.node.passages).toBe(1)
  })
  it('the same question with other values is an exact match: the one candidate, with the variant the person answers with', async () => {
    const f = await ask(e, { type: 'intent:find', text: 'how many RFQs are open in March 2025', at: null, owner: 'user:u1', caps: [] })
    expect(f.exact).toBe(true); expect(f.candidates.map((c: any) => c.id)).toEqual([rfqs]); expect(f.candidates[0].variant).toBe(null)   // nothing learnt yet (a candidate comes with the variant the person answers with)
    // A partial match by its words is a candidate for the composer to decide, never an exact one.
    const near = await ask(e, { type: 'intent:find', text: 'which RFQs are open', at: null, owner: 'user:u1', caps: [] })
    expect(near.exact).toBe(false); expect(near.candidates.map((c: any) => c.id)).toEqual([rfqs])
    // A question matched to the node by meaning teaches it one more canonical form: next time it is an exact match.
    await pass({ node: rfqs, session: 's2', question: 'which RFQs are open', canonical: near.canonical, answer: '28', how: 'matched', agent: 'composer' })
    expect((await ask(e, { type: 'intent:find', text: 'Which RFQs are open?', at: null, owner: 'user:u1', caps: [] })).exact).toBe(true)
  })
  it('a closed intent keeps what its clone learnt: the person\'s variant, the names in its questions, the next intents as nodes with ways out', async () => {
    const c = await ask(e, { type: 'intent:close', node: rfqs, owner: 'user:u1', by: 'u1@x.io', session: 's1', madeHere: true, title: 'Open RFQs in a period', intent: 'How many RFQs are open in a period',
      variant: { concepts: ['rfq/open'], process: 'Count RFQs whose status is open on the last day of the period.', show: 'one figure', paths: [{ when: 'a buyer is named', how: 'only their RFQs' }] },
      names: [{ value: 'Acme Steel', kind: 'supplier' }, { value: 'March 2026', kind: 'period' }],
      next: [{ asked: 'Show the bids for RFQ-00031', label: 'Bids for one', check: 'export default async () => ({ label: "Bids for one" })' }] })
    expect(c.t).toBe('intent:closed'); expect(c.variant).toEqual({ version: 1, changed: true }); expect(c.renamed).toBe(true); expect(c.names).toBe(1)   // a period is not a name
    bids = c.next[0]
    // the names are placeholders now
    expect((await ask(e, { type: 'intent:find', text: 'open orders for Acme Steel', at: null, owner: 'user:u1', caps: [] })).canonical).toBe('open orders for {supplier}')
    // the same variant again is not a new version
    const again = await ask(e, { type: 'intent:close', node: rfqs, owner: 'user:u1', by: 'u1@x.io', session: 's3', variant: { concepts: ['rfq/open'], process: 'Count RFQs whose status is open on the last day of the period.', show: 'one figure', paths: [{ when: 'a buyer is named', how: 'only their RFQs' }] } })
    expect(again.variant).toEqual({ version: 1, changed: false })
    // asked later after the node: the way taken counted
    await pass({ node: bids, from: rfqs, session: 's1', question: 'Show the bids for RFQ-00044', canonical: 'show the bids for {code}', answer: '3 bids', how: 'matched', agent: 'composer' })
    const nx = await ask(e, { type: 'intent:next', at: rfqs, owner: 'user:u1', caps: [] })
    expect(nx.next.map((x: any) => [x.to, x.tag, x.count, !!x.check])).toEqual([[bids, 'asked', 1, false], [bids, 'suggested', 0, true]].slice(0, 1))   // one way per node: the asked one first
  })
  it('a person with no variant of their own answers with the project\'s: the most represented, unverified, until a curator approves one', async () => {
    const mine = await ask(e, { type: 'intent:node', id: rfqs, owner: 'user:u1', caps: [] })
    expect(mine.node.variant).toEqual(expect.objectContaining({ whose: 'mine', version: 1 }))
    const theirs = await ask(e, { type: 'intent:node', id: rfqs, owner: 'user:u2', caps: [] })
    expect(theirs.node.variant).toEqual(expect.objectContaining({ whose: 'project', verified: false, process: expect.stringMatching(/last day/) }))
    await ask(e, { type: 'intent:close', node: rfqs, owner: 'user:u3', by: 'u3@x.io', session: 's9', variant: { concepts: ['rfq/open'], process: 'Count RFQs not yet awarded.', show: '', paths: [] } })
    const p = await person()
    const approved = await http('POST', `/intents/${rfqs}/approve`, { owner: 'user:u3', version: 1, why: 'awarded is the rule' })
    expect(approved.global).toEqual(expect.objectContaining({ verified: true, variant: expect.objectContaining({ owner: 'user:u3' }) }))
    expect((await ask(e, { type: 'intent:node', id: rfqs, owner: 'user:u2', caps: [] })).node.variant).toEqual(expect.objectContaining({ whose: 'project', verified: true, process: 'Count RFQs not yet awarded.' }))
    p.ws.close()
  })
  it('people read the graph and a node: every person\'s variants, the project\'s view, its ways out, its passages and versions', async () => {
    const g = await http('GET', '/intents')
    expect(g.nodes.map((n: any) => n.id).sort()).toEqual([rfqs, bids, 'in-systembuilder', 'in-systemconnector'].sort())
    expect(g.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: rfqs, to: bids, tag: 'asked', count: 1 }), expect.objectContaining({ from: rfqs, to: bids, tag: 'suggested' })]))
    const n = await http('GET', `/intents/${rfqs}`)
    expect(n.node.title).toBe('Open RFQs in a period'); expect(n.node.passages).toBe(2)
    expect(n.variants.map((v: any) => v.owner).sort()).toEqual(['user:u1', 'user:u3'])
    expect(n.approved).toEqual(expect.objectContaining({ owner: 'user:u3', version: 1 }))
    expect(n.versions).toHaveLength(2); expect(n.passages.map((x: any) => x.question)).toEqual(['which RFQs are open', 'How many RFQs are open in September 2026?'])
  })
  it('specialised agents: listed with whether one may use each; made by who runs the project, never over Superatom\'s own', async () => {
    const l = await http('GET', '/session-agents')
    expect(l.agents.map((a: any) => [a.name, a.builtin, a.allowed])).toEqual([['builder', true, true], ['connector', true, true]])   // u1 is the project's admin
    const bad = await http('POST', '/session-agents', { name: 'builder', title: 'x', description: 'x', instructions: 'x', needs: 'project.ask', harness: 'claude-code' })
    expect(bad.error).toMatch(/Superatom's own/)
    const ok = await http('POST', '/session-agents', { name: 'report-writer', title: 'Report writer', description: 'Writes reports', instructions: 'Write the report.', needs: 'project.ask', harness: 'claude-code' })
    expect(ok.saved).toBe('report-writer')
    const spec = await ask(e, { type: 'intent:agent', name: 'report-writer' })
    expect(spec.agent).toEqual(expect.objectContaining({ name: 'report-writer', instructions: 'Write the report.', needs: 'project.ask' }))
    // a node given the agent, by who runs the project
    const w = await http('PUT', `/intents/${bids}`, { body: { agent: 'report-writer', needs: 'project.ask' }, why: 'reports' })
    expect(w.node.agent).toBe('report-writer')
  })
  it('a node removed is a new version of it: never matched, offered or answered at, still readable, restorable; the platform\'s own nodes stay', async () => {
    expect((await http('DELETE', `/intents/${rfqs}`, {})).error).toMatch(/says why/)
    expect((await http('DELETE', '/intents/in-systembuilder', { why: 'x' })).error).toMatch(/platform's own/)
    expect((await http('DELETE', `/intents/${rfqs}`, { why: 'two questions in one' })).removed).toBe(rfqs)
    const f = await ask(e, { type: 'intent:find', text: 'how many RFQs are open in March 2025', at: null, owner: 'user:u1', caps: [] })
    expect(f.exact).toBe(false); expect(f.candidates.map((c: any) => c.id)).not.toContain(rfqs)
    expect((await pass({ node: rfqs, session: 's', question: 'q', answer: 'a', how: 'matched' })).reason).toMatch(/removed/)
    const g = await http('GET', '/intents')
    expect(g.nodes.map((n: any) => n.id)).not.toContain(rfqs); expect(g.removed).toEqual([expect.objectContaining({ id: rfqs, removed: expect.objectContaining({ why: 'two questions in one' }) })])
    expect(g.edges.some((x: any) => x.from === rfqs || x.to === rfqs)).toBe(false)
    const n = await http('GET', `/intents/${rfqs}`)
    expect(n.node.removed.why).toBe('two questions in one'); expect(n.versions[0].why).toMatch(/^removed: two questions in one/)
    expect((await http('POST', `/intents/${rfqs}/restore`, { why: 'it was right' })).restored).toBe(rfqs)
    expect((await ask(e, { type: 'intent:find', text: 'how many RFQs are open in March 2025', at: null, owner: 'user:u1', caps: [] })).exact).toBe(true)
    expect((await http('GET', `/intents/${rfqs}`)).node.removed).toBeUndefined()
  })
  it('a node that does not exist is refused, saying so', async () => {
    const r = await pass({ node: 'in-zzzzzz9', session: 's', question: 'q', answer: 'a', how: 'matched' })
    expect(r.t).toBe('intent:refused'); expect(r.reason).toMatch(/no intent node/)
  })
  it('a published change to a concept marks every node whose variants use it — or what is made of it — stale', async () => {
    const p = await person()
    const c = await say(p, { t: 'graph:concept', name: 'rfq/open', body: { title: 'Open RFQ', form: 'text', text: 'An RFQ is open when it is in negotiation.' }, reason: 'test' })
    expect(c.reason).toBeUndefined()
    expect((await say(p, { t: 'graph:version', message: 'first' })).version).toBeTruthy()
    await say(p, { t: 'graph:concept', name: 'rfq/open', body: { title: 'Open RFQ', form: 'text', text: 'An RFQ is open when it is in negotiation or sent.' }, reason: 'sent counts too' })
    expect((await say(p, { t: 'graph:version', message: 'second' })).version).toBeTruthy()
    let g: any
    for (let i = 0; i < 100; i++) { g = await http('GET', '/intents'); if (g.nodes.find((n: any) => n.id === rfqs)?.stale) break; await wait(50) }
    expect(g.nodes.filter((n: any) => n.stale).map((n: any) => n.id)).toEqual([rfqs])
    expect((await http('GET', `/intents/${rfqs}`)).node.stale).toMatch(/rfq\/open/)
    p.ws.close()
  })
  it('read from the platform\'s storage: with no engine connected at all the graph still reads; a member reads it but approves nothing and makes no agent', async () => {
    e.ws.close(); await wait(100)
    const g = await http('GET', '/intents')
    expect(g.nodes.length).toBe(4)
    await at('/do/access', { method: 'POST', body: JSON.stringify({ email: 'mia@x.io', roleId: 'member' }) })
    expect((await http('GET', '/intents', undefined, 'mia@x.io')).nodes.length).toBe(4)
    expect((await http('POST', `/intents/${rfqs}/approve`, { owner: 'user:u1', version: 1 }, 'mia@x.io')).error).toMatch(/project\.curate/)
    const refused = await http('POST', '/session-agents', { name: 'mine', title: 'M', description: 'm', instructions: 'm', needs: 'project.ask', harness: 'claude-code' }, 'mia@x.io')
    expect(refused.error).toMatch(/project\.manage/)
    expect((await http('GET', '/session-agents', undefined, 'mia@x.io')).agents.map((a: any) => [a.name, a.allowed])).toEqual([['builder', false], ['connector', false], ['report-writer', true]])
  })
})
