// The thread seam end to end, without an agent: an agent file and a built program in a project home, a datasource
// manager answering over HTTP, and thread:* payloads in, replies out.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProgram, ProgramStore } from '@superatom/programs'
import { createThreadSeam } from '../thread-seam.ts'

const home = mkdtempSync(join(tmpdir(), 'thread-'))
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
  const s = createThreadSeam({ projectDir: home, datasource: url, send: (_to, msg) => out.push(msg) })
  return { out, ask: async (payload: any, userId: string | null = 'u1') => { await s.handle(payload, { id: 'ws1', type: 'runtime', userId }); return out.at(-1) } }
}

test('the agents a project has; a broken agent file is left out', async () => {
  const { ask } = seam()
  const r = await ask({ t: 'thread:agents', reqId: 'r1' })
  assert.deepEqual(r, { t: 'thread:agents', reqId: 'r1', agents: [{ id: 'trips', name: 'Trips', scope: 'global', ui: { start: 'web/Start.tsx' }, isDefault: false }] })
})

test('open, intents to the current view and to a new block, go back, read as of a moment — data through the manager', async () => {
  const { ask } = seam()
  const opened = await ask({ t: 'thread:open', session: 's1', agent: 'trips' })
  assert.equal(opened.t, 'thread:view')
  assert.equal(opened.view.user, 'user:u1')
  assert.equal(opened.view.state.trips.branch, 'PUNE')
  const run = await ask({ t: 'thread:intent', session: 's1', call: { package: 'trips', fn: 'run' }, to: 'current' })
  assert.equal(run.result.opened, false)
  assert.equal(run.result.answer.markdown.split('\n')[0], '2 trips at PUNE are completed but not settled; 3 to settle.')
  assert.equal(queries.at(-1).id, 'TRIPS')
  const hyd = await ask({ t: 'thread:intent', session: 's1', ops: [{ op: 'set', path: 'trips.branch', value: 'HYDERABAD' }], to: 'new' })
  assert.equal(hyd.result.opened, true)
  assert.equal(hyd.view.blocks.length, 2)
  assert.equal(hyd.result.answer.markdown.split('\n')[0], '1 trips at HYDERABAD are completed but not settled; 2160 to settle.')
  const back = await ask({ t: 'thread:goto', session: 's1', block: opened.view.leaf })
  assert.equal(back.view.state.trips.branch, 'PUNE')
  const then = await ask({ t: 'thread:get', session: 's1', asOf: run.result.answer.at })
  assert.equal(then.view.blocks.length, 1)
  // a new seam (an engine restart) reads the same session from its log
  const again = await seam().ask({ t: 'thread:get', session: 's1' })
  assert.equal(again.view.blocks.length, 2)
})

test('refused with a sentence: another user, no user, no agent, a broken op, words, an unknown message', async () => {
  const { ask } = seam()
  await ask({ t: 'thread:open', session: 's2', agent: 'trips' })
  assert.deepEqual(await ask({ t: 'thread:get', session: 's2' }, 'u2'), { t: 'thread:refused', reason: 'session s2 is not yours', reqId: undefined })
  assert.equal((await ask({ t: 'thread:get', session: 's2' }, null)).reason, 'the hub did not say who is asking')
  assert.equal((await ask({ t: 'thread:open', session: 's3', agent: 'nobody' })).reason, 'there is no agent "nobody"')
  assert.match((await ask({ t: 'thread:open', session: 's3', agent: 'broken' })).reason, /^agents\/broken.json: agent.name is required/)
  assert.match((await ask({ t: 'thread:intent', session: 's2', ops: [{ op: 'set', path: 'trips.branch', value: 7 }], to: 'current' })).reason, /trips.branch/)
  assert.match((await ask({ t: 'thread:intent', session: 's2', kind: 'language', text: 'hi', to: 'new' })).reason, /words are answered in the chat/)
  assert.equal((await ask({ t: 'thread:nope', session: 's2' })).reason, 'there is no thread:nope')
})
