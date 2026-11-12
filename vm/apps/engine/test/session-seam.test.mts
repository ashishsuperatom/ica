// The session seam end to end, without an agent: an agent file and a built program in a project home, a datasource
// manager answering over HTTP, and thread:* payloads in, replies out.
import { readdirSync, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProgram, ProgramStore } from '@superatom/programs'
import { createSessionSeam } from '../session-seam.ts'
import { agentsInGraph } from './graph-agents.ts'

const home = mkdtempSync(join(tmpdir(), 'session-'))
let server: Server, url = ''
const queries: any[] = []
before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c)).on('end', () => {
      const q = JSON.parse(body); queries.push(q)
      const rows = q.params?.branch === 'HYDERABAD' ? [{ trip_no: 'T1', balance: 2160 }] : [{ trip_no: 'T1', balance: 1 }, { trip_no: 'T2', balance: 2 }]
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ rows }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(server.address() as any).port}`
  const src = fileURLToPath(new URL('../../../packages/programs/test/fixtures/unsettled-trips', import.meta.url))
  buildProgram(src, new ProgramStore(join(home, 'programs', 'store')))
  agentsInGraph(home, [{ id: 'trips', name: 'Trips', scope: 'global', owner: 'user:builder', domain: 'vendors-and-hire', programs: ['unsettled-trips'], tools: [], start: { trips: { branch: 'PUNE' } }, ui: { start: 'web/Start.tsx' }, ica: 'composer' }])
  agentsInGraph(home, [{ id: 'broken' }])
  agentsInGraph(home, [{ id: 'finance', name: 'Finance', scope: 'group:finance', owner: 'user:builder', domain: 'd', programs: ['unsettled-trips'], tools: [], ui: { start: 's' }, ica: 'composer' }])
})
after(() => server.close())

const seam = () => {
  const out: any[] = []
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg) })
  return { out, ask: async (payload: any, userId: string | null = 'u1') => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId }); return out.at(-1) } }
}

test('the agents a project has, as far as the asker sees them; a broken agent file is left out', async () => {
  const out: any[] = []
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg) })
  const list = async (from: any) => { await s.handle({ t: 'session:agents', reqId: 'r1' }, from); return out.at(-1).agents.map((a: any) => a.id).sort() }
  assert.deepEqual(await list({ type: 'runtime', userId: 'u1', scopes: ['user:u1'] }), ['trips'])
  assert.deepEqual(await list({ type: 'runtime', userId: 'u2', scopes: ['user:u2', 'group:finance'] }), ['finance', 'trips'])
  assert.deepEqual(await list({ type: 'runtime', userId: 'root', admin: true }), ['finance', 'trips'])
  await s.handle({ t: 'session:open', session: 'fin1', agent: 'finance' }, { type: 'runtime', userId: 'u1', scopes: ['user:u1'] })
  assert.equal(out.at(-1).reason, 'there is no agent "finance"')
})

test('open, intents to the current view and to a new block, go back, read as of a moment — data through the manager', async () => {
  const { ask } = seam()
  const opened = await ask({ t: 'session:open', session: 's1', agent: 'trips' })
  assert.equal(opened.t, 'session:view')
  assert.equal(opened.view.user, 'user:u1')
  assert.equal(opened.view.state.trips.branch, 'PUNE')
  const run = await ask({ t: 'session:intent', session: 's1', call: { package: 'trips', fn: 'run' }, to: 'current', label: 'Run it' })
  assert.equal(run.result.opened, false)
  assert.equal(run.view.intents.at(-1).label, 'Run it')   // the control's words, kept as what was done
  assert.equal(run.result.answer.markdown.split('\n')[0], '2 trips at PUNE are completed but not settled; 3 to settle.')
  assert.equal(queries.at(-1).id, 'TRIPS')
  // the answer as every surface takes it: the markdown as written, and the table its marker names as rows and words
  const card = run.cards[run.result.answer.id]
  assert.equal(card.markdown.split('\n')[0], '2 trips at PUNE are completed but not settled; 3 to settle.')
  const [name] = Object.keys(card.cards)
  assert.deepEqual([card.cards[name].title, card.cards[name].columns.map((c: any) => c.label), card.cards[name].text], ['Unsettled trips', ['Trip', 'Balance'], [['T1', '1'], ['T2', '2']]])
  // the options at the step: what the program's option functions computed there (2 trips: no more pages to offer)
  assert.deepEqual(run.options, [{ package: 'trips', label: 'Every branch, not only PUNE', intent: { ops: [{ op: 'set', path: 'trips.branch', value: null }], to: 'current' } }])
  // the program's React side, named in the view and served file by file
  assert.deepEqual(run.uis.map((u: any) => [u.package, u.entry, u.blocks]), [['trips', 'web/index.js', ['unsettled-trips']]])
  const file = await ask({ t: 'session:file', hash: run.uis[0].hash, path: 'web/index.js' })
  assert.match(file.text, /export function UnsettledTrips/)
  assert.match((await ask({ t: 'session:file', hash: run.uis[0].hash, path: '../manifest.json' })).reason, /is not a file of a program's React side/)
  assert.match((await ask({ t: 'session:file', hash: run.uis[0].hash, path: 'node/index.js' })).reason, /is not a file of a program's React side/)
  const hyd = await ask({ t: 'session:intent', session: 's1', ops: [{ op: 'set', path: 'trips.branch', value: 'HYDERABAD' }], to: 'new' })
  assert.equal(hyd.result.opened, true)
  assert.equal(hyd.view.blocks.length, 2)
  assert.equal(hyd.result.answer.markdown.split('\n')[0], '1 trips at HYDERABAD are completed but not settled; 2160 to settle.')
  const back = await ask({ t: 'session:goto', session: 's1', block: opened.view.leaf })
  assert.equal(back.view.state.trips.branch, 'PUNE')
  const then = await ask({ t: 'session:get', session: 's1', asOf: run.result.answer.at })
  assert.equal(then.view.blocks.length, 1)
  // a new seam (an engine restart) reads the same session from its log
  const again = await seam().ask({ t: 'session:get', session: 's1' })
  assert.equal(again.view.blocks.length, 2)
})

test('refused with a sentence: another user, no user, no agent, a broken op, words, an unknown message', async () => {
  const { ask } = seam()
  await ask({ t: 'session:open', session: 's2', agent: 'trips' })
  assert.deepEqual(await ask({ t: 'session:get', session: 's2' }, 'u2'), { t: 'session:refused', reason: 'session s2 is not yours', reqId: undefined })
  assert.equal((await ask({ t: 'session:get', session: 's2' }, null)).reason, 'the hub did not say who is asking')
  // an agent key is its own identity: it neither sees a person's session nor passes for one
  const agentOut: any[] = []
  const agentSeam = createSessionSeam({ projectDir: home, datasource: url, send: (_t, m) => agentOut.push(m) })
  await agentSeam.handle({ t: 'session:get', session: 's2' }, { type: 'agent', userId: 'agent:key_1' })
  assert.equal(agentOut.at(-1).reason, 'session s2 is not yours')
  await agentSeam.handle({ t: 'session:open', session: 'a1', agent: 'trips' }, { type: 'agent', userId: 'agent:key_1' })
  assert.equal(agentOut.at(-1).view.user, 'agent:key_1')
  assert.equal((await ask({ t: 'session:open', session: 's3', agent: 'nobody' })).reason, 'there is no agent "nobody"')
  assert.match((await ask({ t: 'session:open', session: 's3', agent: 'broken' })).reason, /^agent "broken": agent.domain is required/)
  assert.match((await ask({ t: 'session:intent', session: 's2', ops: [{ op: 'set', path: 'trips.branch', value: 7 }], to: 'current' })).reason, /trips.branch/)
  assert.match((await ask({ t: 'session:intent', session: 's2', kind: 'language', text: 'hi', to: 'new' })).reason, /answers no words in sessions/)
  assert.equal((await ask({ t: 'session:nope', session: 's2' })).reason, 'there is no session:nope')
})

test('an agent kept in the composition graph is listed (by its scope) and opens a working session', async () => {
  const { openStore, governance } = await import('@superatom/composition-graph/node')
  const graphFile = join(home, 'db', 'composition.sqlite')
  mkdirSync(join(home, 'db'), { recursive: true })
  const g = openStore(graphFile)
  const ana = { id: 'user:ana', admin: true }   // may publish: places the agent in group ops
  governance.write(g, ana, 'c1', 'concept', { title: 'Settled', form: 'text', text: 'A trip is settled when its settlement document exists.' })
  governance.write(g, ana, 'trips-domain', 'domain', { capabilities: [], concepts: ['c1'], files: [] })
  governance.write(g, ana, 'graph-trips', 'agent', { title: 'Trips (graph)', domain: 'trips-domain', programs: ['unsettled-trips'], start: { trips: { branch: 'HYDERABAD' } },
    icon: 'lucide:truck', accent: 'series-1', says: 'Trips not yet settled.', starts: [{ key: 'pune', label: 'Pune', says: 'The Pune branch', start: { trips: { branch: 'PUNE' } } }] }, {}, { scope: 'group:ops' })
  g.close()
  const out: any[] = []
  const s = createSessionSeam({ projectDir: home, datasource: url, graphFile, send: (_to, msg) => out.push(msg) })
  await s.handle({ t: 'session:agents' }, { type: 'runtime', userId: 'u1', scopes: ['user:u1'] })
  assert.ok(!out.at(-1).agents.some((a: any) => a.id === 'graph-trips'))                  // not in group ops
  await s.handle({ t: 'session:agents' }, { type: 'runtime', userId: 'u2', scopes: ['user:u2', 'group:ops'] })
  assert.deepEqual(out.at(-1).agents.find((a: any) => a.id === 'graph-trips'), { id: 'graph-trips', name: 'Trips (graph)', scope: 'group:ops', ui: { start: '' }, isDefault: false, ica: 'composer',
    look: { icon: 'lucide:truck', accent: 'series-1', says: 'Trips not yet settled.' }, starts: [{ key: 'pune', label: 'Pune', says: 'The Pune branch' }] })
  // the project's map: each person sees only the places whose agent they may use, and no section left empty
  const g2 = openStore(graphFile)
  governance.write(g2, ana, 'map', 'map', { sections: [{ label: 'Operations', items: [{ agent: 'graph-trips', slug: 'trips-board', label: 'Trips board' }] }] })
  g2.close()
  await s.handle({ t: 'session:agents' }, { type: 'runtime', userId: 'u2', scopes: ['user:u2', 'group:ops'] })
  assert.deepEqual(out.at(-1).map, { sections: [{ label: 'Operations', items: [{ agent: 'graph-trips', slug: 'trips-board', label: 'Trips board' }] }] })
  await s.handle({ t: 'session:agents' }, { type: 'runtime', userId: 'u1', scopes: ['user:u1'] })
  assert.deepEqual(out.at(-1).map, { sections: [] })
  // a starting point opens on its own STATE; one the agent does not declare is refused
  await s.handle({ t: 'session:open', session: 'ga0', agent: 'graph-trips', startAt: 'pune', run: false }, { type: 'runtime', userId: 'u2', scopes: ['user:u2', 'group:ops'] })
  assert.equal(out.at(-1).view.state.trips.branch, 'PUNE')
  await s.handle({ t: 'session:open', session: 'ga9', agent: 'graph-trips', startAt: 'mars', run: false }, { type: 'runtime', userId: 'u2', scopes: ['user:u2', 'group:ops'] })
  assert.match(out.at(-1).reason, /no starting point "mars"/)
  await s.handle({ t: 'session:open', session: 'ga1', agent: 'graph-trips' }, { type: 'runtime', userId: 'u2', scopes: ['user:u2', 'group:ops'] })
  assert.equal(out.at(-1).view.state.trips.branch, 'HYDERABAD')
  await s.handle({ t: 'session:intent', session: 'ga1', call: { package: 'trips', fn: 'run' }, to: 'current' }, { type: 'runtime', userId: 'u2', scopes: ['user:u2', 'group:ops'] })
  assert.equal(out.at(-1).result.answer.markdown.split('\n')[0], '1 trips at HYDERABAD are completed but not settled; 2160 to settle.')
})

test('words in a session: the agent is told the step and its programs; its answer is words — each a step of its own, changing nothing in STATE', async () => {
  const out: any[] = []
  const told: any[] = []
  const answers = [{ markdown: 'Just words: the trips are settled monthly.', blocks: [] }]
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), ask: async (o) => { told.push(o); return answers.shift()! } })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u7' }); return out.at(-1) }
  const opened = await ask({ t: 'session:open', session: 'w1', agent: 'trips' })
  const words = await ask({ t: 'session:intent', session: 'w1', kind: 'language', text: 'how often are they settled?' })
  assert.equal(told[0].role, 'composer')   // every message goes to the session's composer first
  assert.match(told[0].context, /The step's STATE:\n\{.*"branch":"PUNE"/)
  assert.match(told[0].context, /## trips/)
  assert.doesNotMatch(told[0].context, /:::intent/)   // no change is passed through an answer's words
  assert.equal(words.result.opened, true)
  assert.equal(words.result.answer.markdown, 'Just words: the trips are settled monthly.')
  assert.equal(words.view.state.trips.branch, 'PUNE')
  assert.equal(opened.view.leaf, words.view.blocks[0].id)
})

test('a model account refusing: the person reads a plain sentence — never the provider\'s words — and the project\'s Attention gets a failed activity with them', async () => {
  const out: any[] = [], failed: string[] = []
  const activities = { start: () => ({ id: 'a', progress: () => {}, done: () => {}, failed: (d: string) => { failed.push(d) } }), around: async (_o: string, _k: string, _t: string, w: any) => w({ progress: () => {} }) }
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), activities: activities as any,
    ask: async () => ({ markdown: null, blocks: [], failure: 'opencode-go · gpt-6-luna refused: 403 An active OpenCode Go subscription is required' }) })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u7' }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'w-refused', agent: 'trips' })
  const r = await ask({ t: 'session:intent', session: 'w-refused', kind: 'language', text: 'how many trips?' })
  assert.match(r.result.answer.markdown, /could not be answered just now/)
  assert.doesNotMatch(r.result.answer.markdown, /opencode|subscription|403|refused/i)
  assert.deepEqual(failed, ['opencode-go · gpt-6-luna refused: 403 An active OpenCode Go subscription is required'])
})

test('a question from home, no agent picked: the default agent opens a session (words never choose it) and its composer answers', async () => {
  const out: any[] = []
  const told: any[] = []
  const s0 = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), ask: async (o) => { told.push(o); return { markdown: 'Nothing fits better; here is what I know.', blocks: [] } } })
  const ask = async (payload: any) => { await s0.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u5', scopes: ['user:u5'] }); return out.at(-1) }
  assert.match((await ask({ t: 'session:start', session: 'h0', text: 'anything at all?' })).reason, /no default agent/)
  agentsInGraph(home, [{ id: 'helper', name: 'Ask anything', scope: 'global', owner: 'user:builder', domain: 'd', programs: [], tools: [], ui: { start: '' }, ica: 'composer', isDefault: true }])
  const r = await ask({ t: 'session:start', session: 'h1', text: 'anything at all?' })
  assert.deepEqual(r.routed, { agent: 'helper', name: 'Ask anything', how: 'default' })
  assert.equal(told[0].role, 'composer')
  assert.equal(r.result.answer.markdown, 'Nothing fits better; here is what I know.')
  assert.equal(r.view.agent, 'helper')
  // the first question is a turn like any other: a page reloaded while it is being answered is told it is
  let release: () => void = () => {}
  const s1 = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), ask: async () => { await new Promise<void>((r) => { release = r }); return { markdown: 'Done.', blocks: [] } } })
  const asking = s1.handle({ t: 'session:start', session: 'h2', text: 'a long question', reqId: 'st' }, { id: 'ws1', type: 'runtime', userId: 'u5', scopes: ['user:u5'] })
  await new Promise((res) => setTimeout(res, 100))
  await s1.handle({ t: 'session:get', session: 'h2', reqId: 'reload' }, { id: 'ws2', type: 'runtime', userId: 'u5', scopes: ['user:u5'] })
  assert.equal(out.find((m) => m.reqId === 'reload').turns.running.text, 'a long question')
  release(); await asking
  assert.equal(out.find((m) => m.reqId === 'st').result.answer.markdown, 'Done.')
})

test('views: an agent browsed without a session — nothing written; a step computed from the STATE given; kept at need by replaying the path', async () => {
  const out: any[] = []
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg) })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws9', type: 'runtime', userId: 'u9' }); return out.at(-1) }
  const before = existsSync(join(home, 'sessions')) ? readdirSync(join(home, 'sessions')).length : 0
  const opened = await ask({ t: 'view:open', agent: 'trips' })
  assert.equal(opened.t, 'view:view')
  assert.ok(opened.view.answers.length >= 1)
  const root = opened.view.states[opened.view.leaf]
  const moved = await ask({ t: 'view:intent', agent: 'trips', state: root, ops: [{ op: 'set', path: 'trips.branch', value: 'HYDERABAD' }] })
  assert.equal(moved.t, 'view:view')
  assert.equal(moved.view.state.trips.branch, 'HYDERABAD')
  const after = existsSync(join(home, 'sessions')) ? readdirSync(join(home, 'sessions')).length : 0
  assert.equal(after, before)                                       // browsing wrote nothing
  // the question: the path is written as the session's first steps, replayed here
  const kept = await ask({ t: 'session:keep', session: 'k1', agent: 'trips', path: [{ open: {}, edits: [] }, { intent: { ops: [{ op: 'set', path: 'trips.branch', value: 'HYDERABAD' }] }, edits: [] }] })
  assert.equal(kept.t, 'session:view')
  assert.equal(kept.view.blocks.length, 2)
  assert.equal(kept.view.state.trips.branch, 'HYDERABAD')
  assert.ok(existsSync(join(home, 'sessions', 'k1', 'session.jsonl')))
  assert.match((await ask({ t: 'session:keep', session: 'k2', agent: 'trips', path: [] })).reason, /names the path/)
  // the browser's STATE is never trusted as it comes: its pinned builds are ignored, foreign slices dropped, a slice that
  // does not fit its schema refused
  const forged = await ask({ t: 'view:intent', agent: 'trips', state: { ...root, packages: { trips: 'f'.repeat(64) }, evil: { x: 1 } }, ops: [{ op: 'set', path: 'trips.branch', value: 'PUNE' }] })
  assert.equal(forged.t, 'view:view')
  assert.notEqual(forged.view.state.packages.trips, 'f'.repeat(64))
  assert.equal(forged.view.state.evil, undefined)
  const bad = await ask({ t: 'view:intent', agent: 'trips', state: { ...root, trips: { ...root.trips, branch: 42 } }, ops: [{ op: 'set', path: 'trips.branch', value: 'PUNE' }] })
  assert.match(bad.reason, /does not fit trips/)
})

test('a question from an application screen is a composer turn in a session: on the agent of the screen\'s domain, with what the person is looking at', async () => {
  const { openStore, governance } = await import('@superatom/composition-graph/node')
  const graphFile = join(home, 'db-screen.sqlite')
  const g = openStore(graphFile)
  const admin = { id: 'user:admin', admin: true }
  governance.write(g, admin, 'c1', 'concept', { title: 'Settled', form: 'text', text: 'A trip is settled when its settlement document exists.' })
  governance.write(g, admin, 'trips-domain', 'domain', { capabilities: [], concepts: ['c1'], files: [] })
  governance.write(g, admin, 'screen-trips', 'agent', { title: 'Trips', domain: 'trips-domain', programs: ['unsettled-trips'], start: { trips: { branch: 'PUNE' } } })
  g.close()
  const told: any[] = []
  const s = createSessionSeam({ projectDir: home, datasource: url, graphFile, send: () => {}, ask: async (o) => { told.push(o); return { markdown: 'Two are open.', blocks: [] } } })
  const r = await s.ask({ session: 'scr1', text: 'how many are open?', from: { id: 'ws1', type: 'runtime', userId: 'u9' }, qid: 'q1', screen: 'Unsettled trips, PUNE: 2 rows', domain: 'trips-domain', reqId: 'r1' })
  assert.equal(r.agent.agent, 'screen-trips')
  assert.equal(r.answer.markdown, 'Two are open.')
  assert.match(told[0].context, /^This question's out\/ folder: .*\n\nWhat the person is looking at:\nUnsettled trips, PUNE: 2 rows/)
  assert.equal(told[0].reqId, 'r1')                       // the turn's narration finds the asking page
})

test('a domain program that crashes is reported by its error, never by the runtime\'s closing line', async () => {
  const { errorOf } = await import('../session-seam.ts')
  const crash = 'file:///x/organisation-data.mjs:19\n  throw new Error(x)\n  ^\n\nError: the setting "reporting-currency-code" is not in settings.json\n    at setting (file:///x/organisation-data.mjs:19:34)\n\nNode.js v22.23.3'
  assert.equal(errorOf(crash), 'Error: the setting "reporting-currency-code" is not in settings.json')
  assert.equal(errorOf('SuiteQL refused: unknown field\n'), 'SuiteQL refused: unknown field')
})

test('an answer that breaks the answer rules goes back to the agent once, with the problem said; still broken, the linter fixes it — the person never reads a markdown table', async () => {
  const out: any[] = []
  const told: any[] = []
  const table = 'Two bids.\n\n| Supplier | Price |\n|---|---|\n| A | 10 |\n| B | 12 |'
  const answers = [
    { markdown: table, blocks: [] },
    { markdown: 'Two bids.\n:::table bids.json', blocks: [{ marker: 'bids.json', block: { type: 'table', title: 'Bids', columns: [{ key: 'v', label: 'Supplier' }], rows: [{ v: 'A' }] } }] },
    { markdown: table, blocks: [] },
    { markdown: table, blocks: [] },
  ]
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), ask: async (o) => { told.push(o); return answers.shift()! } })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u7' }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'ln1', agent: 'trips' })
  const put = await ask({ t: 'session:intent', session: 'ln1', kind: 'language', text: 'the bids?', to: 'new' })
  assert.match(told[1].text, /broke the answer rules:\n- It writes data as a markdown table/)
  assert.equal(put.result.answer.markdown, 'Two bids.\n:::table bids.json')
  const forced = await ask({ t: 'session:intent', session: 'ln1', kind: 'language', text: 'again?', to: 'new' })
  assert.equal(told.length, 4)
  assert.equal(forced.result.answer.markdown, 'Two bids.\n\n:::table table-1')
  assert.deepEqual(forced.result.answer.blocks['table-1'].rows, [{ c1: 'A', c2: '10' }, { c1: 'B', c2: '12' }])
})

test('every message goes to the composer, which decides its intent: one it sends to the analyst is new and the analyst answers it, the node made; same → the composer answers with the node\'s knowledge; a node\'s agent answers only who may use it; every answer is learnt from (all the session\'s intents); the next intents pass their checks', async () => {
  const out: any[] = [], told: any[] = [], finds: any[] = [], passes: any[] = [], ran: any[] = [], closes: any[] = [], gotten: string[] = []
  // the composer's tools, as the engine serves them for a turn: it finds the intents, and gets the one it answers from
  const opened = new Map<string, (a: any) => Promise<string>>()
  const tools: any = { path: '-', on: (turn: string, tool: string, h: any) => { opened.set(`${turn}|${tool}`, h); return () => opened.delete(`${turn}|${tool}`) }, close() {} }
  const variant = { concepts: [], process: 'Count trips by their completion date.', show: 'one figure', paths: [], whose: 'mine', verified: false, version: 1, owner: 'user:u8' }
  const nodeA = { id: 'in-aaaaaa1', title: 'Trips at a branch', intent: 'trips at a branch', canonical: 'trips in pune', agent: null, needs: null, allowed: true, system: false, passages: 1, variant }
  const builder = (allowed: boolean) => ({ id: 'in-systembuilder', title: 'Build a program', intent: 'a program built', canonical: 'build a program', agent: 'builder', needs: 'project.develop', allowed, system: true, passages: 0 })
  const plan: any[] = [
    { here: null, candidates: [] },
    { here: nodeA, candidates: [] },
    { here: nodeA, candidates: [builder(false)] },
    { here: nodeA, candidates: [builder(true)] },
    { here: nodeA, candidates: [] },
  ]
  const intents: any = {
    find: async (q: any) => { finds.push(q); return { canonical: q.text.toLowerCase(), params: [], exact: false, total: 3, ...plan[cur] } },   // the same for every search of a question
    node: async (q: any) => (q.id === nodeA.id ? nodeA : null),   // the intent the session is in, as it is now
    experience: async (q: any) => (q.node === 'in-aaaaaa1' ? { owner: q.owner, cases: 4, signals: [{ name: 'per-day', purpose: 'how busy a day is', how: 'trips ÷ days', kind: 'number' }], scenarios: [{ id: 'usual', parent: null, says: 'a usual month', expectation: { 'per-day': [20, 30] }, cases: 4 }], recent: [] } : null),
    pass: async (p: any) => { passes.push(p); return p.node ? { ...nodeA, id: p.node, title: p.node === nodeA.id ? nodeA.title : 'Build a program' } : { ...nodeA, title: p.body.title } },
    tried: () => {},
    next: async () => [
      { from: nodeA.id, to: 'in-bbbbbb1', owner: 'user:u8', tag: 'suggested', kind: 'interpolation', count: 0, label: 'Bids per supplier', title: 'Bids per supplier', allowed: true, check: 'export default async (state, ctx) => ({ label: `Bids after ${ctx.history.length} answers` })', last: '' },
      { from: nodeA.id, to: 'in-cccccc1', owner: 'user:u8', tag: 'suggested', kind: 'extrapolation', count: 0, label: 'Never here', title: 'Never here', allowed: true, check: 'export default async () => null', last: '' },
    ],
    agent: async (name: string) => ({ name, title: 'Builder', needs: 'project.develop', harness: 'claude-code', builtin: true }),
  }
  // each composer reply: the intent it gets (by ./get-intent), if any — the intent it is in, or a candidate
  let turn = 0, cur = 0
  const replies: any[] = [
    { markdown: null, blocks: [], sent: { agent: 'analyst', message: 'current-question' } },   // q1 · composer: new, sent
    { markdown: 'Analysed: 12 trips.', blocks: [] },                                      // q1 · analyst
    { get: 'in-aaaaaa1', markdown: 'Words.', blocks: [] },                               // q2 · composer: the intent it is in
    { get: 'in-systembuilder', markdown: null, blocks: [] },                              // q3
    { get: 'in-systembuilder', markdown: null, blocks: [] },                              // q4
    { get: 'in-aaaaaa1', markdown: null, blocks: [], sent: { agent: 'analyst', message: 'current-question' } },   // q5 · a situation its knowledge does not cover
    { get: 'in-aaaaaa1', markdown: 'Worked out again.', blocks: [] },                    // q5 · analyst: decides it is the intent the session is in
  ]
  const agents: any = { run: async (o: any) => { ran.push(o); return { markdown: 'Built it.', built: [], refused: [], ms: 1 } } }
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), intents, agents, tools,
    intentLearn: { answered: async (a: any) => { closes.push(a) } } as any,
    ask: async (o) => {
      told.push(o)
      const { get, ...r } = replies.shift()
      if (o.role === 'composer') cur = turn++
      if (o.role === 'composer' || o.role === 'analyst') {   // each decides with its own tools
        await opened.get(`${o.qid}|find-intent`)!({ question: o.text })
        if (get) gotten.push(await opened.get(`${o.qid}|get-intent`)!({ id: get }))
      }
      return r
    } })
  const ask = async (payload: any, caps: string[] = ['project.ask']) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u8', email: 'u8@x.io', caps }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'n1', agent: 'trips' })
  const a1 = await ask({ t: 'session:intent', session: 'n1', kind: 'language', text: 'trips in pune?' })
  assert.deepEqual(told.map((t) => t.role), ['composer', 'analyst'])
  assert.match(told[0].context, /THE INTENT YOU ARE IN: \(none/); assert.doesNotMatch(told[0].context, /get-intent/)   // how it decides is its role's (the graph), never the turn's
  assert.equal(told[1].text, 'trips in pune?'); assert.equal(told[1].context, 'Understood from the conversation as: trips in pune?\n\nTHE INTENT YOU ARE IN: (none — the conversation starts here)')   // the person's question, filled in by the engine; nothing missed yet; it decides the intent itself
  assert.equal(passes[0].how, 'made'); assert.equal(passes[0].agent, 'analyst'); assert.equal(passes[0].body.asked, 'trips in pune?'); assert.equal(passes[0].owner, 'user:u8')
  assert.deepEqual(a1.result.answer.node, { id: nodeA.id, title: 'trips in pune?', how: 'made', agent: 'analyst' })
  assert.equal(a1.result.answer.markdown, 'Analysed: 12 trips.')
  assert.equal(a1.result.answer.next, undefined)   // the answer never waits for its next intents: they follow it
  const after = async () => { for (let i = 0; i < 100 && !out.some((m) => m.t === 'answer:next' && m.answer === a1.result.answer.id); i++) await new Promise((r) => setTimeout(r, 20)); return out.find((m) => m.t === 'answer:next' && m.answer === a1.result.answer.id) }
  assert.deepEqual((await after())?.next, [{ id: 'in-bbbbbb1', title: 'Bids per supplier', label: 'Bids after 1 answers', tag: 'suggested', kind: 'interpolation', count: 0 }])   // the check said its label; the other offered nothing
  const a2 = await ask({ t: 'session:intent', session: 'n1', kind: 'language', text: 'and hyderabad?' })
  assert.equal(finds[2].at, nodeA.id)   // the next message starts from the node the last one was answered at (each turn searches twice: the words, then the question spelled out)
  assert.match(told[2].context, /THE INTENT YOU ARE IN: in-aaaaaa1: Trips at a branch/)
  assert.doesNotMatch(told[2].context, /Count trips by their completion date/)   // its knowledge only when it gets it
  assert.match(gotten[0], /^in-aaaaaa1: Trips at a branch[\s\S]*Count trips by their completion date/)
  assert.match(gotten[0], /What it has met \(4 cases; each one with \.\/experience in-aaaaaa1\):[\s\S]*"per-day"[\s\S]*"usual"/)   // its experience: the signals and scenarios, the cases one tool away
  assert.equal(a2.result.answer.markdown, 'Words.'); assert.equal(passes[1].how, 'same'); assert.equal(passes[1].from, nodeA.id)
  assert.equal(closes.length, 2)   // learnt from after every answer — the first one too
  assert.deepEqual(closes[1].intents.map((i: any) => [i.node, i.madeHere, i.turns.map((t: any) => t.agent)]), [[nodeA.id, true, ['analyst', 'composer']]])
  const a3 = await ask({ t: 'session:intent', session: 'n1', kind: 'language', text: 'build me a report program' })
  assert.match(a3.result.answer.markdown, /not given — it needs the "project.develop" permission/); assert.equal(ran.length, 0)
  assert.equal(closes.length, 3); assert.deepEqual(closes[2].intents.map((i: any) => i.node), [nodeA.id, 'in-systembuilder'])   // every intent of the session, this answer's included
  const a4 = await ask({ t: 'session:intent', session: 'n1', kind: 'language', text: 'build me a report program' }, ['project.ask', 'project.develop'])
  assert.equal(a4.result.answer.markdown, 'Built it.'); assert.equal(ran.length, 1); assert.equal(ran[0].spec.name, 'builder')
  const a5 = await ask({ t: 'session:intent', session: 'n1', kind: 'language', text: 'that is not right, check again' })
  assert.equal(told.at(-1).role, 'analyst'); assert.equal(told.at(-1).text, 'that is not right, check again')
  assert.match(told.at(-1).context, /Since you last saw this conversation the person asked[\s\S]*- and hyderabad\?\n- build me a report program\n- build me a report program/)   // word for word, the answers in the files
  assert.equal(passes.at(-1).how, 'matched'); assert.equal(passes.at(-1).node, nodeA.id)   // the analyst decided it is the trips intent — back from the builder's, where the session was
  assert.equal(a5.result.answer.markdown, 'Worked out again.')
})

test('a question the learner suggested before anyone asked it is answered at that node — never at a second one made beside it', async () => {
  const out: any[] = [], passes: any[] = []
  const suggested = { id: 'in-sugg001', title: 'Carry cost', intent: 'carry cost', canonical: 'what would it cost', agent: null, needs: null, allowed: true, system: false, passages: 0, variant: null }
  const intents: any = {
    find: async (q: any) => ({ canonical: q.text.toLowerCase(), params: [], exact: true, total: 1, here: null, candidates: [suggested] }),
    node: async () => null, next: async () => [], tried: () => {}, agent: async () => null,
    pass: async (p: any) => { passes.push(p); return { ...suggested, passages: 1 } },
  }
  const opened = new Map<string, (a: any) => Promise<string>>()
  const tools: any = { path: '-', on: (turn: string, tool: string, h: any) => { opened.set(`${turn}|${tool}`, h); return () => opened.delete(`${turn}|${tool}`) }, close() {} }
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), intents, tools,
    ask: async (o) => {
      await opened.get(`${o.qid}|find-intent`)!({ question: o.text })   // each agent searches; neither gets the suggested one: new to it
      return (o.role === 'composer' ? { markdown: null, blocks: [], sent: { agent: 'analyst', message: 'current-question' } } : { markdown: 'Worked out.', blocks: [] }) as any
    } })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u9', caps: ['project.ask'] }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'sg1', agent: 'trips' })
  await ask({ t: 'session:intent', session: 'sg1', kind: 'language', text: 'What would it cost?' })
  assert.equal(passes[0].node, 'in-sugg001'); assert.equal(passes[0].how, 'made'); assert.equal(passes[0].body, undefined)
  // the hand-off is recorded in the session: who, to whom, which question
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = readdirSync(join(home, 'sessions')).find((x) => x.startsWith('sg1'))!
  const handed = readFileSync(join(home, 'sessions', dir, 'session.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.t === 'handoff')
  assert.deepEqual(handed.map((e) => [e.from, e.to, e.question]), [['composer', 'analyst', 'What would it cost?']])
})

test('a question needing a source the person has not connected goes to their connector: the person\'s own agent answers it, and no intent is made or learnt for it', async () => {
  const out: any[] = [], passes: any[] = [], asked: any[] = []
  const intents: any = {
    find: async (q: any) => ({ canonical: q.text.toLowerCase(), params: [], exact: false, total: 0, here: null, candidates: [] }),
    node: async () => null, next: async () => [], tried: () => {}, agent: async () => null,
    pass: async (p: any) => { passes.push(p); return null },
  }
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), intents,
    ask: async (o) => { asked.push(o.role); return (o.role === 'composer' ? { markdown: null, blocks: [], sent: { agent: 'connector', message: 'current-question' } } : { markdown: 'Sign in to Microsoft 365 first.\n:::connect MICROSOFT_365', blocks: [] }) as any } })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u9', caps: ['project.ask'] }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'cn1', agent: 'trips' })
  const r = await ask({ t: 'session:intent', session: 'cn1', kind: 'language', text: "what's new in my Teams?" })
  assert.deepEqual(asked, ['composer', 'connector'])
  assert.equal(passes.length, 0)                                                   // nothing learnt: connecting is not a kind of question
  assert.match(r.view.answers.at(-1).markdown, /:::connect MICROSOFT_365/)
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = readdirSync(join(home, 'sessions')).find((x) => x.startsWith('cn1'))!
  const handed = readFileSync(join(home, 'sessions', dir, 'session.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.t === 'handoff')
  assert.deepEqual(handed.map((e) => [e.from, e.to]), [['composer', 'connector']])
})

test('the composer spells the question out (find-intent): candidates found by those words; the passage keeps the person\'s words and what was understood apart', async () => {
  const out: any[] = [], passes: any[] = [], searched: string[] = []
  const opened = new Map<string, (a: any) => Promise<string>>()
  const tools: any = { path: '-', on: (turn: string, tool: string, h: any) => { opened.set(`${turn}|${tool}`, h); return () => opened.delete(`${turn}|${tool}`) }, close() {} }
  const byPlant = { id: 'in-poplant01', title: 'Open PO value by plant', intent: 'open PO value by plant', canonical: 'open po value by plant', agent: null, needs: null, allowed: true, system: false, passages: 2, variant: null }
  const intents: any = {
    find: async (q: any) => { searched.push(q.text); return /open purchase order/.test(q.text) ? { canonical: 'open po value by plant', params: [], exact: false, total: 1, here: null, candidates: [byPlant] } : { canonical: q.text.toLowerCase(), params: [], exact: false, total: 0, here: null, candidates: [] } },
    node: async () => null, next: async () => [], tried: () => {}, agent: async () => null,
    pass: async (p: any) => { passes.push(p); return byPlant },
  }
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), intents, tools,
    ask: async (o) => {
      const found = await opened.get(`${o.qid}|find-intent`)!({ question: 'open purchase order value awaiting delivery, broken down by plant' })
      assert.match(found, /in-poplant01/)
      assert.match(await opened.get(`${o.qid}|get-intent`)!({ id: 'in-poplant01' }), /^in-poplant01: Open PO value by plant/)
      await assert.rejects(() => opened.get(`${o.qid}|get-intent`)!({ id: 'in-nowhere' }), /not one you may answer from: the intent you are in or one \.\/find-intent gave \(in-poplant01\)/)
      return { markdown: 'By plant: …', blocks: [] } as any
    } })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u9', caps: ['project.ask'] }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'fi1', agent: 'trips' })
  await ask({ t: 'session:intent', session: 'fi1', kind: 'language', text: 'break it down by plant' })
  assert.deepEqual(searched, ['open purchase order value awaiting delivery, broken down by plant'])   // only the agent searches: nothing before it
  assert.equal(passes[0].node, 'in-poplant01'); assert.equal(passes[0].how, 'matched')
  assert.equal(passes[0].question, 'break it down by plant')
  assert.equal(passes[0].understood, 'open purchase order value awaiting delivery, broken down by plant')
  assert.equal(passes[0].canonical, 'open po value by plant')
  assert.equal(opened.size, 0)   // closed when the turn ended
})

test('a session\'s turns: one answered at a time; questions asked meanwhile wait, go together when it ends, and each gets that answer; a waiting one can be withdrawn; too long is refused', async () => {
  const out: any[] = [], asked: string[] = []
  let release: () => void = () => {}
  const first = new Promise<void>((r) => { release = r })
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg),
    ask: async (o) => { asked.push(o.text); if (asked.length === 1) await first; return { markdown: `Answer to: ${o.text}`, blocks: [] } as any } })
  const from = { id: 'ws1', type: 'runtime', userId: 'u9', caps: ['project.ask'] }
  const send = (payload: any) => s.handle(payload, from)
  await send({ t: 'session:open', session: 'tq1', agent: 'trips', reqId: 'o' })
  const a = send({ t: 'session:intent', session: 'tq1', kind: 'language', text: 'first question', reqId: 'r1' })
  await new Promise((r) => setTimeout(r, 50))
  const b = send({ t: 'session:intent', session: 'tq1', kind: 'language', text: 'second question', reqId: 'r2' })
  const c = send({ t: 'session:intent', session: 'tq1', kind: 'language', text: 'third question', reqId: 'r3' })
  const w = send({ t: 'session:intent', session: 'tq1', kind: 'language', text: 'withdrawn one', reqId: 'r4' })
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(out.filter((m) => m.t === 'session:waiting').map((m) => m.reqId), ['r2', 'r3', 'r4'])
  const waiting = out.filter((m) => m.t === 'session:turns').at(-1)
  assert.deepEqual(waiting.queue.map((q: any) => q.text), ['second question', 'third question', 'withdrawn one'])
  await send({ t: 'session:withdraw', session: 'tq1', qid: waiting.queue[2].qid, reqId: 'x' })
  await send({ t: 'session:intent', session: 'tq1', kind: 'language', text: 'x'.repeat(2001), reqId: 'r5' })
  assert.match(out.find((m) => m.reqId === 'r5').reason, /at most 2000 characters/)
  release()
  await Promise.all([a, b, c, w])
  assert.deepEqual(asked, ['first question', 'second question\n\nthird question'])   // the waiting ones, together
  const replies = (id: string) => out.find((m) => m.reqId === id && (m.t === 'session:view' || m.t === 'session:refused'))
  assert.equal(replies('r1').t, 'session:view')
  assert.equal(replies('r2').t, 'session:view'); assert.deepEqual(replies('r2').view, replies('r3').view)   // one answer for both
  assert.match(replies('r4').reason, /withdrawn/)
  assert.deepEqual(out.filter((m) => m.t === 'session:turns').at(-1), { t: 'session:turns', session: 'tq1', running: null, queue: [] })
})

test('a message while it works goes into the turn running, a coding agent\'s way: to the agent working it, answered by that turn\'s one answer, recorded with it; one it cannot take waits its turn as before', async () => {
  const out: any[] = [], asked: string[] = [], steered: string[] = []
  let release: () => void = () => {}
  const first = new Promise<void>((r) => { release = r })
  let takes = true
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg),
    steer: async (_session, text) => { if (!takes) return false; steered.push(text); return true },
    ask: async (o) => { asked.push(o.text); if (asked.length === 1) await first; return { markdown: `Answer to: ${o.text}`, blocks: [] } as any } })
  const from = { id: 'ws1', type: 'runtime', userId: 'u9', caps: ['project.ask'] }
  const send = (payload: any) => s.handle(payload, from)
  await send({ t: 'session:open', session: 'st1', agent: 'trips', reqId: 'o' })
  const a = send({ t: 'session:intent', session: 'st1', kind: 'language', text: 'how many trips', reqId: 'r1' })
  await new Promise((r) => setTimeout(r, 50))
  const b = send({ t: 'session:intent', session: 'st1', kind: 'language', text: 'only in Pune', reqId: 'r2' })
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(steered, ['only in Pune'])                                        // to the agent, now
  assert.equal(out.filter((m) => m.t === 'session:waiting').length, 0)               // not queued
  assert.deepEqual(out.filter((m) => m.t === 'session:turns').at(-1).running.added.map((x: any) => x.text), ['only in Pune'])
  // one the agent cannot take (no turn able to): waits its turn
  takes = false
  const c = send({ t: 'session:intent', session: 'st1', kind: 'language', text: 'and Mumbai', reqId: 'r3' })
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(out.filter((m) => m.t === 'session:waiting').map((m) => m.reqId), ['r3'])
  release()
  await Promise.all([a, b, c])
  assert.deepEqual(asked, ['how many trips', 'and Mumbai'])                          // the added one was not asked again
  const reply = (id: string) => out.find((m) => m.reqId === id && (m.t === 'session:view' || m.t === 'session:refused'))
  assert.equal(reply('r2').t, 'session:view')                                        // answered by the turn it went into
  const intents = reply('r3').view.intents.filter((i: any) => i.kind === 'language').map((i: any) => i.text)
  assert.deepEqual(intents, ['how many trips\n\nonly in Pune', 'and Mumbai'])       // recorded with its turn
})

test('a message put in after the agent began its answer is answered after it: the question\'s answer, then a step answering the message — its own words, in order', async () => {
  const out: any[] = []
  let release: () => void = () => {}
  const held = new Promise<void>((r) => { release = r })
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), steer: async () => true,
    ask: async () => { await held; return { markdown: 'There were 40 trips.', blocks: [], more: [{ markdown: 'In Pune, 12.', blocks: [] }] } as any } })
  const from = { id: 'ws1', type: 'runtime', userId: 'u9', caps: ['project.ask'] }
  const send = (payload: any) => s.handle(payload, from)
  await send({ t: 'session:open', session: 'st2', agent: 'trips', reqId: 'o' })
  const a = send({ t: 'session:intent', session: 'st2', kind: 'language', text: 'how many trips', reqId: 'r1' })
  await new Promise((r) => setTimeout(r, 50))
  const b = send({ t: 'session:intent', session: 'st2', kind: 'language', text: 'only in Pune', reqId: 'r2' })
  await new Promise((r) => setTimeout(r, 50))
  release()
  await Promise.all([a, b])
  const view = out.find((m) => m.reqId === 'r2' && m.t === 'session:view').view
  const said = view.intents.filter((i: any) => i.kind === 'language').map((i: any) => [i.text, i.result?.markdown])
  assert.deepEqual(said, [['how many trips', 'There were 40 trips.'], ['only in Pune', 'In Pune, 12.']])
})

test('a workbench agent takes its own messages: no intent looked for, made or learnt — and only for those given it (project.workbench), not for developing the project', async () => {
  const out: any[] = [], told: any[] = [], finds: any[] = [], passes: any[] = []
  agentsInGraph(home, [{ id: 'bench', name: 'Workbench', scope: 'global', owner: 'user:builder', domain: 'workbench', programs: [], tools: [], ui: { start: '' }, ica: 'workbench' }])
  const intents: any = { find: async (q: any) => { finds.push(q); return { canonical: '', params: [], exact: false, total: 0, here: null, candidates: [] } }, node: async () => null, next: async () => [], tried: () => {}, agent: async () => null, experience: async () => null, pass: async (p: any) => { passes.push(p); return null } }
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), intents, ask: async (o) => { told.push(o); return { markdown: 'Built it.', blocks: [] } as any } })
  const dev = { id: 'ws1', type: 'runtime', userId: 'u9', caps: ['project.ask', 'project.workbench'] }
  const send = async (payload: any, from: any = dev) => { await s.handle(payload, from); return out.at(-1) }
  await send({ t: 'session:open', session: 'wb1', agent: 'bench' })
  const r = await send({ t: 'session:intent', session: 'wb1', kind: 'language', text: 'make me a report generator' })
  assert.equal(r.result.answer.markdown, 'Built it.')
  assert.deepEqual(told.map((t) => t.role), ['workbench'])   // on its own domain: the engine starts each agent from its agent's (app-seam ROLE_DOMAIN)
  assert.equal(finds.length, 0); assert.equal(passes.length, 0)
  const listed = await send({ t: 'session:agents' }, { ...dev, caps: ['project.ask'] })
  assert.ok(!listed.agents.some((a: any) => a.id === 'bench'))   // not even listed for someone not given the workbench
  assert.match((await send({ t: 'session:intent', session: 'wb1', kind: 'language', text: 'again' }, { ...dev, caps: ['project.ask'] })).reason, /for those given it/)
  assert.match((await send({ t: 'session:intent', session: 'wb1', kind: 'language', text: 'again' }, { ...dev, caps: ['project.ask', 'project.develop'] })).reason, /for those given it/)   // developing the project is not it
})


test('a file given with a question: received before it (even before its session exists), moved into the question\'s in/ folder, named to the agent, kept with the question', async () => {
  const { createHash } = await import('node:crypto')
  const { existsSync, readFileSync, readdirSync } = await import('node:fs')
  const png = Buffer.from('fake image bytes'), hash = createHash('sha256').update(png).digest('hex')
  const out: any[] = [], told: any[] = []
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), fetchAttachment: async () => png, ask: async (o) => { told.push(o); return { markdown: 'It is a chart.', blocks: [] } as any } })
  const from = { id: 'ws1', type: 'runtime', userId: 'u9', caps: ['project.ask'], scopes: ['user:u9'] }
  agentsInGraph(home, [{ id: 'helper', name: 'Ask anything', scope: 'global', owner: 'user:builder', domain: 'd', programs: [], tools: [], ui: { start: '' }, ica: 'composer', isDefault: true }])
  await s.handle({ t: 'session:attach', session: 'fq1', name: 'pasted-1.png', type: 'image/png', hash, size: png.length, question: true, reqId: 'up' }, from)
  assert.equal(out.at(-1).t, 'session:attached')
  await s.handle({ t: 'session:start', session: 'fq1', text: 'what is in this picture?', files: [{ name: 'pasted-1.png', hash }], reqId: 'q' }, from)
  const qdir = readdirSync(join(home, 'sessions', 'fq1')).find((x) => x.startsWith('q_'))!
  assert.ok(existsSync(join(home, 'sessions', 'fq1', qdir, 'in', 'pasted-1.png')))
  assert.ok(!existsSync(join(home, 'sessions', 'fq1', 'incoming', hash)))   // moved, not copied
  assert.match(told[0].context, /Files given with this question — look at them:\n- .*\/in\/pasted-1\.png \(image\/png\)/)
  const view = out.find((m) => m.reqId === 'q').view
  assert.deepEqual(view.intents.find((i: any) => i.kind === 'language').files, [{ name: 'pasted-1.png', type: 'image/png', hash }])
})


test('files wait under their hashes: two of one name both reach the question, numbered; a session begun is its owner\'s alone', async () => {
  const { createHash } = await import('node:crypto')
  const { existsSync, readFileSync, readdirSync } = await import('node:fs')
  const a = Buffer.from('first'), b = Buffer.from('second')
  const ha = createHash('sha256').update(a).digest('hex'), hb = createHash('sha256').update(b).digest('hex')
  const out: any[] = []
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), fetchAttachment: async (_s, h) => (h === ha ? a : b), ask: async () => ({ markdown: 'Seen.', blocks: [] }) } as any)
  const from = { id: 'ws1', type: 'runtime', userId: 'u7', caps: ['project.ask'], scopes: ['user:u7'] }
  agentsInGraph(home, [{ id: 'helper', name: 'Ask anything', scope: 'global', owner: 'user:builder', domain: 'd', programs: [], tools: [], ui: { start: '' }, ica: 'composer', isDefault: true }])
  await s.handle({ t: 'session:attach', session: 'fq2', name: 'image.png', type: 'image/png', hash: ha, size: a.length, question: true, reqId: 'u1' }, from)
  await s.handle({ t: 'session:attach', session: 'fq2', name: 'image.png', type: 'image/png', hash: hb, size: b.length, question: true, reqId: 'u2' }, from)
  await s.handle({ t: 'session:start', session: 'fq2', text: 'compare these', files: [{ name: 'image.png', hash: ha }, { name: 'image.png', hash: hb }], reqId: 'q' }, from)
  const qdir = readdirSync(join(home, 'sessions', 'fq2')).find((x) => x.startsWith('q_'))!
  assert.equal(readFileSync(join(home, 'sessions', 'fq2', qdir, 'in', 'image.png'), 'utf8'), 'first')
  assert.equal(readFileSync(join(home, 'sessions', 'fq2', qdir, 'in', 'image (2).png'), 'utf8'), 'second')
  // someone else may not put a file into a session begun by another
  const other = { id: 'ws2', type: 'runtime', userId: 'u8', caps: ['project.ask'], scopes: ['user:u8'] }
  await s.handle({ t: 'session:attach', session: 'fq2', name: 'x.png', type: 'image/png', hash: ha, size: a.length, question: true, reqId: 'u3' }, other)
  assert.notEqual(out.at(-1).t, 'session:attached')
  assert.ok(!existsSync(join(home, 'sessions', 'fq2', 'incoming', ha)))
})

test('a data question the composer answers with no intent goes to the analyst — read from what it did (a data tool), never its words; a greeting stays its own', async () => {
  const out: any[] = [], told: any[] = [], passes: any[] = []
  const opened = new Map<string, (a: any) => Promise<string>>(), used = new Map<string, string[]>()
  const tools: any = { path: '-', on: (turn: string, tool: string, h: any) => { opened.set(`${turn}|${tool}`, h); return () => opened.delete(`${turn}|${tool}`) },
    usedIn: (turn: string) => used.get(turn) ?? [], forget: (turn: string) => used.delete(turn), close() {} }
  const made = { id: 'in-dsources1', title: 'Data sources', intent: 'data sources', canonical: 'how many data sources', agent: null, needs: null, allowed: true, system: false, passages: 0, variant: null }
  const intents: any = {
    find: async (q: any) => ({ canonical: q.text.toLowerCase(), params: [], exact: false, total: 0, here: null, candidates: [] }),
    node: async () => null, next: async () => [], tried: () => {}, agent: async () => null,
    pass: async (p: any) => { passes.push(p); return made },
  }
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), intents, tools,
    ask: async (o) => {
      told.push(o)
      if (o.role === 'composer') await opened.get(`${o.qid}|find-intent`)!({ question: o.text })
      if (o.role === 'composer' && /data sources/.test(o.text)) { used.set(o.qid!, ['find-intent', 'sources']); return { markdown: 'There are 2.', blocks: [] } as any }   // answered it itself, from the data
      if (o.role === 'composer') return { markdown: 'Hello!', blocks: [] } as any                                                                                          // a greeting: no data read
      return { markdown: 'The project has 2 data sources.', blocks: [] } as any
    } })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u9', caps: ['project.ask'] }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'dq1', agent: 'trips' })
  const a = await ask({ t: 'session:intent', session: 'dq1', kind: 'language', text: 'how many data sources does this project have' })
  assert.deepEqual(told.map((t) => t.role), ['composer', 'analyst'])
  assert.equal(a.result.answer.markdown, 'The project has 2 data sources.')   // the analyst's, not the composer's
  assert.equal(passes[0].how, 'made'); assert.equal(passes[0].agent, 'analyst')
  const hi = await ask({ t: 'session:intent', session: 'dq1', kind: 'language', text: 'hello' })
  assert.equal(told.at(-1).role, 'composer'); assert.equal(hi.result.answer.markdown, 'Hello!'); assert.equal(passes.length, 1)
})
