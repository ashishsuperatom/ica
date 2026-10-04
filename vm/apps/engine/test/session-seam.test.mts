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
})
after(() => server.close())

const seam = () => {
  const out: any[] = []
  const s = createSessionSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg) })
  return { out, ask: async (payload: any, userId: string | null = 'u1') => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId }); return out.at(-1) } }
}

test('the agents a project has; a broken agent file is left out', async () => {
  const { ask } = seam()
  const r = await ask({ t: 'session:agents', reqId: 'r1' })
  assert.deepEqual(r, { t: 'session:agents', reqId: 'r1', agents: [{ id: 'trips', name: 'Trips', scope: 'global', ui: { start: 'web/Start.tsx' }, isDefault: false }] })
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
  assert.equal((await ask({ t: 'session:open', session: 's3', agent: 'nobody' })).reason, 'there is no agent "nobody"')
  assert.match((await ask({ t: 'session:open', session: 's3', agent: 'broken' })).reason, /^agents\/broken.json: agent.name is required/)
  assert.match((await ask({ t: 'session:intent', session: 's2', ops: [{ op: 'set', path: 'trips.branch', value: 7 }], to: 'current' })).reason, /trips.branch/)
  assert.match((await ask({ t: 'session:intent', session: 's2', kind: 'language', text: 'hi', to: 'new' })).reason, /words are answered in the chat/)
  assert.equal((await ask({ t: 'session:nope', session: 's2' })).reason, 'there is no session:nope')
})
