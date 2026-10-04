// The session seam end to end, without an agent: an agent file and a built program in a project home, a datasource
// manager answering over HTTP, and thread:* payloads in, replies out.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProgram, ProgramStore } from '@superatom/programs'
import { createSessionSeam } from '../session-seam.ts'

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
  mkdirSync(join(home, 'agents'))
  writeFileSync(join(home, 'agents', 'trips.json'), JSON.stringify({ id: 'trips', name: 'Trips', scope: 'global', owner: 'user:builder', domain: 'vendors-and-hire', programs: ['unsettled-trips'], tools: [], start: { trips: { branch: 'PUNE' } }, ui: { start: 'web/Start.tsx' }, ica: 'composer' }))
  writeFileSync(join(home, 'agents', 'broken.json'), JSON.stringify({ id: 'broken' }))
  writeFileSync(join(home, 'agents', 'finance.json'), JSON.stringify({ id: 'finance', name: 'Finance', scope: 'group:finance', owner: 'user:builder', domain: 'd', programs: ['unsettled-trips'], tools: [], ui: { start: 's' }, ica: 'composer' }))
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
  const run = await ask({ t: 'session:intent', session: 's1', call: { package: 'trips', fn: 'run' }, to: 'current' })
  assert.equal(run.result.opened, false)
  assert.equal(run.result.answer.markdown.split('\n')[0], '2 trips at PUNE are completed but not settled; 3 to settle.')
  assert.equal(queries.at(-1).id, 'TRIPS')
  // the answer as the card every surface draws: the prose, and the table its marker names
  const card = run.cards[run.result.answer.id]
  assert.equal(card.answer, '2 trips at PUNE are completed but not settled; 3 to settle.')
  assert.deepEqual(card.sections, [{ kind: 'table', title: 'Unsettled trips', columns: [{ label: 'Trip' }, { label: 'Balance' }], rows: [['T1', 1], ['T2', 2]] }])
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
  assert.match((await ask({ t: 'session:open', session: 's3', agent: 'broken' })).reason, /^agents\/broken.json: agent.name is required/)
  assert.match((await ask({ t: 'session:intent', session: 's2', ops: [{ op: 'set', path: 'trips.branch', value: 7 }], to: 'current' })).reason, /trips.branch/)
  assert.match((await ask({ t: 'session:intent', session: 's2', kind: 'language', text: 'hi', to: 'new' })).reason, /answers no words in sessions/)
  assert.equal((await ask({ t: 'session:nope', session: 's2' })).reason, 'there is no session:nope')
})

test('an agent kept in the composition graph is listed (by its scope) and opens a working session', async () => {
  const { Store, governance } = await import('@superatom/composition-graph')
  const graphFile = join(home, 'db', 'composition.sqlite')
  mkdirSync(join(home, 'db'), { recursive: true })
  const g = new Store(graphFile)
  const ana = { id: 'user:ana' }
  governance.write(g, ana, 'c1', 'concept', { title: 'Settled', form: 'text', text: 'A trip is settled when its settlement document exists.' })
  governance.write(g, ana, 'trips-domain', 'domain', { capabilities: [], concepts: ['c1'], files: [] })
  governance.write(g, ana, 'graph-trips', 'agent', { title: 'Trips (graph)', domain: 'trips-domain', programs: ['unsettled-trips'], start: { trips: { branch: 'HYDERABAD' } } }, {}, { scope: 'group:ops' })
  g.close()
  const out: any[] = []
  const s = createSessionSeam({ projectDir: home, datasource: url, graphFile, send: (_to, msg) => out.push(msg) })
  await s.handle({ t: 'session:agents' }, { type: 'runtime', userId: 'u1', scopes: ['user:u1'] })
  assert.ok(!out.at(-1).agents.some((a: any) => a.id === 'graph-trips'))                  // not in group ops
  await s.handle({ t: 'session:agents' }, { type: 'runtime', userId: 'u2', scopes: ['user:u2', 'group:ops'] })
  assert.deepEqual(out.at(-1).agents.find((a: any) => a.id === 'graph-trips'), { id: 'graph-trips', name: 'Trips (graph)', scope: 'group:ops', ui: { start: '' }, isDefault: false })
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
