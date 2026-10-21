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
  assert.deepEqual(run.actions.map((a: any) => a.label), ['Run', 'Every branch', 'Next page'])
  assert.deepEqual(run.actions[1].intent, { action: { package: 'trips', id: 'all-branches' }, to: 'current' })
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
  assert.deepEqual(out.at(-1).agents.find((a: any) => a.id === 'graph-trips'), { id: 'graph-trips', name: 'Trips (graph)', scope: 'group:ops', ui: { start: '' }, isDefault: false,
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

test('words in a session: the agent is told the step and its programs; its :::intent line changes STATE (here) or opens a step (call)', async () => {
  const out: any[] = []
  const told: any[] = []
  const answers = [
    { markdown: 'Looking at Hyderabad instead.\n:::intent {"ops":[{"op":"set","path":"trips.branch","value":"HYDERABAD"}],"to":"current"}', blocks: [] },
    { markdown: 'Every branch, in a new step.\n:::intent {"call":{"package":"trips","fn":"run"},"to":"new"}', blocks: [] },
    { markdown: 'Just words: the trips are settled monthly.', blocks: [] },
  ]
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), ask: async (o) => { told.push(o); return answers.shift()! } })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u7' }); return out.at(-1) }
  const opened = await ask({ t: 'session:open', session: 'w1', agent: 'trips' })
  const here = await ask({ t: 'session:intent', session: 'w1', kind: 'language', text: 'what about hyderabad?' })
  assert.equal(told[0].domain, 'vendors-and-hire')
  assert.match(told[0].context, /The step's STATE:\n\{.*"branch":"PUNE"/)
  assert.match(told[0].context, /:::intent/)
  assert.match(told[0].context, /## trips/)
  assert.equal(here.result.opened, false)
  assert.equal(here.view.state.trips.branch, 'HYDERABAD')
  // the program reads trips.branch, so the change re-runs it: its answer follows the agent's words
  assert.match(here.result.answer.markdown, /^Looking at Hyderabad instead\.\n\n1 trips at HYDERABAD/)
  assert.doesNotMatch(here.result.answer.markdown, /:::intent/)
  const next = await ask({ t: 'session:intent', session: 'w1', kind: 'language', text: 'run it in a new step' })
  assert.equal(next.result.opened, true)
  assert.match(next.result.answer.markdown, /^Every branch, in a new step\.\n\n1 trips at HYDERABAD/)
  const words = await ask({ t: 'session:intent', session: 'w1', kind: 'language', text: 'how often are they settled?' })
  assert.equal(words.result.opened, true)
  assert.equal(words.result.answer.markdown, 'Just words: the trips are settled monthly.')
  assert.equal(words.view.blocks.length, 3)
  assert.equal(opened.view.leaf, words.view.blocks[0].id)
})

test('a change written wrongly goes back to the agent once, with what was wrong; the person reads only the answer that came of it — or, wrong again, a plain line (the reason to the operators)', async () => {
  const out: any[] = [], told: any[] = [], failed: string[] = []
  const activities = { start: () => ({ id: 'a', progress: () => {}, done: () => {}, failed: (d: string) => { failed.push(d) } }), around: async (_o: string, _k: string, _t: string, w: any) => w({ progress: () => {} }) }
  const answers = [
    { markdown: 'Hyderabad.\n:::intent {"ops":[{"op":"by","value":"HYDERABAD"}]}', blocks: [] },
    { markdown: 'Hyderabad.\n:::intent {"ops":[{"op":"set","path":"trips.branch","value":"HYDERABAD"}],"to":"current"}', blocks: [] },
    { markdown: 'Chennai.\n:::intent {"ops":[{"op":"by"}]}', blocks: [] },
    { markdown: 'Chennai.\n:::intent {"ops":[{"op":"by"}]}', blocks: [] },
  ]
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), activities: activities as any, ask: async (o) => { told.push(o); return answers.shift()! } })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u7' }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'wr1', agent: 'trips' })
  const fixed = await ask({ t: 'session:intent', session: 'wr1', kind: 'language', text: 'what about hyderabad?' })
  assert.equal(told.length, 2)
  assert.match(told[1].text, /could not be used: change 1\.op must be set, add or remove, not "by"/)
  assert.equal(fixed.view.state.trips.branch, 'HYDERABAD')
  assert.doesNotMatch(fixed.result.answer.markdown, /op must be|could not be changed/)
  const still = await ask({ t: 'session:intent', session: 'wr1', kind: 'language', text: 'and chennai?' })
  assert.equal(told.length, 4)
  assert.match(still.result.answer.markdown, /^Chennai\.\n\n_The view could not be changed to match this answer/)
  assert.doesNotMatch(still.result.answer.markdown, /op must be/)
  assert.match(failed.at(-1)!, /op must be set, add or remove/)
})

test('a change the programs refuse goes back to the agent once, with their reason, and its second answer is the one kept — refused again, the answer stands without it, said plainly', async () => {
  const out: any[] = [], told: any[] = []
  const activities = { start: () => ({ id: 'a', progress: () => {}, done: () => {}, failed: () => {} }), around: async (_o: string, _k: string, _t: string, w: any) => w({ progress: () => {} }) }
  const answers = [
    { markdown: 'By lane.\n:::intent {"ops":[{"op":"set","path":"trips.lane","value":"all"}],"to":"current"}', blocks: [] },
    { markdown: 'Hyderabad instead.\n:::intent {"ops":[{"op":"set","path":"trips.branch","value":"HYDERABAD"}],"to":"current"}', blocks: [] },
    { markdown: 'By lane.\n:::intent {"ops":[{"op":"set","path":"trips.lane","value":"all"}],"to":"current"}', blocks: [] },
    { markdown: 'Still by lane.\n:::intent {"ops":[{"op":"set","path":"trips.lane","value":"x"}],"to":"current"}', blocks: [] },
  ]
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), activities: activities as any, ask: async (o) => { told.push(o); return answers.shift()! } })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u7' }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'rf1', agent: 'trips' })
  const fixed = await ask({ t: 'session:intent', session: 'rf1', kind: 'language', text: 'books for all lanes' })
  assert.equal(told.length, 2)
  assert.match(told[1].text, /refused by the programs: .*trips\.lane/)
  assert.equal(fixed.view.state.trips.branch, 'HYDERABAD')
  assert.match(fixed.result.answer.markdown, /^Hyderabad instead\./)
  const still = await ask({ t: 'session:intent', session: 'rf1', kind: 'language', text: 'by lane please' })
  assert.equal(told.length, 4)
  assert.match(still.result.answer.markdown, /^Still by lane\.\n\n_The view could not be changed to match this answer/)
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

test('an agent made from a session: forked with its lineage, on a domain of its own with what the session learned as worked examples, the person\'s own', async () => {
  const { openStore, governance } = await import('@superatom/composition-graph/node')
  const file = join(home, 'db-fork.sqlite')
  const store = openStore(file)
  governance.write(store, { id: 'user:builder', admin: true, scopes: [] } as any, 'vendors-and-hire', 'domain', { capabilities: [], concepts: [], files: [] }, { reason: 'seed' })
  store.put('trips', 'agent', { title: 'Trips', domain: 'vendors-and-hire', programs: ['unsettled-trips'], tools: [], start: { trips: { branch: 'PUNE' } }, ui: { start: 'web/Start.tsx' }, ica: 'composer' }, { by: 'test' }, { owner: 'user:builder' })
  store.close?.()
  const out: any[] = []
  const answers = [{ markdown: 'Hyderabad it is.\n:::intent {"ops":[{"op":"set","path":"trips.branch","value":"HYDERABAD"}],"to":"current"}', blocks: [] }]
  // The platform, as this engine reaches it: it writes the nodes through governance, as the person (the replica here
  // stands in for its copy).
  const platform = async (who: any, writes: any[]) => { const st = openStore(file); try { return writes.map((w) => ({ name: w.name, ...governance.write(st, who, w.name, w.kind, w.body, { reason: w.reason }, w.scope ? { scope: w.scope } : {}), node: st.get(w.name) })) } finally { st.close() } }
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), graphFile: file, graphWrite: platform, ask: async () => answers.shift()! })
  const from = { id: 'ws1', type: 'runtime', userId: 'u9', scopes: ['user:u9'] }
  const ask = async (payload: any) => { await s.handle(payload, from); return out.at(-1) }
  await ask({ t: 'session:open', session: 'f1', agent: 'trips' })
  await ask({ t: 'session:intent', session: 'f1', kind: 'language', text: 'what about hyderabad?' })
  await ask({ t: 'session:intent', session: 'f1', call: { package: 'trips', fn: 'run' }, to: 'new' })
  assert.match((await ask({ t: 'session:fork', session: 'f1', name: '', title: '' })).reason, /a name and a title/)
  const forked = await ask({ t: 'session:fork', session: 'f1', name: 'Hyderabad trips', title: 'Hyderabad trips' })
  assert.equal(forked.t, 'session:forked')
  assert.deepEqual([forked.agent, forked.domain, forked.concept, forked.scope], ['hyderabad-trips', 'hyderabad-trips-domain', 'hyderabad-trips-learned', 'user:u9'])
  const g = openStore(file)
  const agent = g.get('hyderabad-trips')!
  assert.equal(agent.kind, 'agent'); assert.equal(agent.scope, 'user:u9')
  assert.deepEqual([agent.body.forkedFrom, agent.body.fromSession, agent.body.domain, agent.body.programs], ['trips', 'f1', 'hyderabad-trips-domain', ['unsettled-trips']])
  assert.deepEqual(g.get('hyderabad-trips-domain')!.body.concepts, ['hyderabad-trips-learned'])
  assert.deepEqual(g.get('hyderabad-trips-learned')!.body.items, [{ question: 'what about hyderabad?', steps: ['ran trips.run'] }])
})

test('a question from home, no agent picked: no domain\'s words reach it, so the default agent opens a session and answers, from whichever domain the words reach', async () => {
  const out: any[] = []
  const told: any[] = []
  const s0 = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), ask: async (o) => { told.push(o); return { markdown: 'Nothing fits better; here is what I know.', blocks: [] } } })
  const ask = async (payload: any) => { await s0.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u5', scopes: ['user:u5'] }); return out.at(-1) }
  assert.match((await ask({ t: 'session:start', session: 'h0', text: 'anything at all?' })).reason, /no default agent/)
  agentsInGraph(home, [{ id: 'helper', name: 'Ask anything', scope: 'global', owner: 'user:builder', domain: 'd', programs: [], tools: [], ui: { start: '' }, ica: 'composer', isDefault: true }])
  const r = await ask({ t: 'session:start', session: 'h1', text: 'anything at all?' })
  assert.deepEqual(r.routed, { agent: 'helper', name: 'Ask anything', how: 'default' })
  assert.equal(told[0].domain, null)
  assert.equal(r.result.answer.markdown, 'Nothing fits better; here is what I know.')
  assert.equal(r.view.agent, 'helper')
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

test('a change the agent asks for that is not a valid op is left out — the answer still stands, and says so', async () => {
  const { intentOf } = await import('../session-seam.ts')
  const r = intentOf('Lanes by bookings.\n:::intent {"ops":[{"op":"by","value":"lane"}]}')
  assert.equal(r.markdown, 'Lanes by bookings.')
  assert.equal(r.intent, null)
  assert.match(r.problem ?? '', /op must be set, add or remove, not "by"/)
  const ok = intentOf('Filtered.\n:::intent {"ops":[{"op":"set","path":"pmo.pillar","value":"Retail"}]}')
  assert.deepEqual(ok.intent?.ops, [{ op: 'set', path: 'pmo.pillar', value: 'Retail' }])
  assert.equal(ok.problem, undefined)
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
  assert.match(told[0].context, /^What the person is looking at:\nUnsettled trips, PUNE: 2 rows/)
  assert.equal(told[0].reqId, 'r1')                       // the turn's narration finds the asking page
})

test('a domain program that crashes is reported by its error, never by the runtime\'s closing line', async () => {
  const { errorOf } = await import('../session-seam.ts')
  const crash = 'file:///x/organisation-data.mjs:19\n  throw new Error(x)\n  ^\n\nError: the setting "reporting-currency-code" is not in settings.json\n    at setting (file:///x/organisation-data.mjs:19:34)\n\nNode.js v22.23.3'
  assert.equal(errorOf(crash), 'Error: the setting "reporting-currency-code" is not in settings.json')
  assert.equal(errorOf('SuiteQL refused: unknown field\n'), 'SuiteQL refused: unknown field')
})

test('a step names what it established in a :::state line: kept on its answer, never shown; the next question is told what the thread holds — a branch, only its own thread', async () => {
  const out: any[] = []
  const told: any[] = []
  const answers = [
    { markdown: 'Two events are open; RFQ-1 first.\n:::state {"event":"RFQ-1","worklist":true}', blocks: [] },
    { markdown: 'Its best bid is 90.\n:::state {"bids":"best 90","bad key!":1,"nested":{"x":1}}\n:::intent {"call":{"package":"trips","fn":"run"},"to":"new"}', blocks: [] },
    { markdown: 'RFQ-2 instead.\n:::state {"event":"RFQ-2"}', blocks: [] },
    { markdown: 'A line that cannot be read.\n:::state {"event":', blocks: [] },
  ]
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), ask: async (o) => { told.push(o); return answers.shift()! } })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u7' }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'st1', agent: 'trips' })
  const first = await ask({ t: 'session:intent', session: 'st1', kind: 'language', text: 'what is open?', to: 'new' })
  assert.deepEqual(first.result.answer.facts, { event: 'RFQ-1', worklist: true })
  assert.doesNotMatch(first.result.answer.markdown, /:::state/)
  assert.match(told[0].context, /:::state/)
  assert.doesNotMatch(told[0].context, /established so far/)
  const second = await ask({ t: 'session:intent', session: 'st1', kind: 'language', text: 'the bids?' })
  assert.match(told[1].context, /established so far:\n\{"event":"RFQ-1","worklist":true\}/)
  // only plain values under names: the rest of the line is left out
  assert.deepEqual(second.result.answer.facts, { bids: 'best 90' })
  assert.doesNotMatch(second.result.answer.markdown, /:::state|:::intent/)
  // from the first step again: a branch — it holds the first step's facts, not the second's
  await ask({ t: 'session:intent', session: 'st1', kind: 'language', text: 'and RFQ-2?', block: first.result.block, to: 'new' })
  assert.match(told[2].context, /established so far:\n\{"event":"RFQ-1","worklist":true\}/)
  const fourth = await ask({ t: 'session:intent', session: 'st1', kind: 'language', text: 'again?' })
  assert.equal(fourth.result.answer.facts, undefined)
  assert.equal(fourth.result.answer.markdown, 'A line that cannot be read.')
  assert.match(told[3].context, /established so far:\n\{"event":"RFQ-2","worklist":true\}/)
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

test('a step offers next questions in an :::options line: at most three, kept on its answer, never shown in it; one that cannot be read offers none', async () => {
  const out: any[] = []
  const answers = [
    { markdown: 'Two events are open.\n:::state {"open events":2}\n:::options ["Which first?", "Do we have stock?", "Show the bids", "A fourth"]', blocks: [] },
    { markdown: 'Words.\n:::options ["unclosed"', blocks: [] },
  ]
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg), ask: async () => answers.shift()! })
  const ask = async (payload: any) => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId: 'u7' }); return out.at(-1) }
  await ask({ t: 'session:open', session: 'op1', agent: 'trips' })
  const a = await ask({ t: 'session:intent', session: 'op1', kind: 'language', text: 'what is open?', to: 'new' })
  assert.deepEqual(a.result.answer.options, ['Which first?', 'Do we have stock?', 'Show the bids'])
  assert.deepEqual(a.result.answer.facts, { 'open events': 2 })
  assert.equal(a.result.answer.markdown, 'Two events are open.')
  const b = await ask({ t: 'session:intent', session: 'op1', kind: 'language', text: 'and?', to: 'new' })
  assert.equal(b.result.answer.options, undefined)
  assert.equal(b.result.answer.markdown, 'Words.')
})
