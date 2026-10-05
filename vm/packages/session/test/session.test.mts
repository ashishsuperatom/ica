import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateEngine } from '@superatom/state'
import type { Intent } from '@superatom/platform-types'
import { createSessions, memoryLog, fileLog, history, pathTo, replay, SessionRefusal } from '../src/index.ts'

// Two packages: a scope everyone reads, and trips, which re-runs when the scope changes.
const scope = {
  name: 'scope', hash: 'h-scope',
  spec: { owns: 'scope', schema: { branch: { nullable: 'string' } }, initial: { branch: null }, reads: [], functions: [{ name: 'run', produces: 'data' as const }], actions: [], commands: [], doc: 'doc.md' },
  functions: { run: () => {} },
}
const trips = {
  name: 'trips', hash: 'h-trips',
  spec: {
    owns: 'trips', schema: { page: 'number', count: 'number' }, initial: { page: 1, count: 0 }, reads: ['scope.branch'],
    functions: [{ name: 'run', produces: 'view' as const }, { name: 'more', produces: 'data' as const }],
    actions: [{ id: 'next', label: 'Next page', ops: [{ op: 'set' as const, path: 'trips.page', value: 2 }] }], commands: [], doc: 'doc.md',
  },
  functions: {
    run: async (s: any, ctx: any) => {
      const count = ({ PUNE: 3, HYDERABAD: 365 } as any)[s.scope.branch] ?? 6927
      if (s.scope.branch === 'SLOW') await new Promise((r) => setTimeout(r, 60))
      ctx.set({ count })
      return { answer: { markdown: `${count} trips${s.scope.branch ? ` at ${s.scope.branch}` : ''}, page ${s.trips.page}\n:::table trips.json`, files: ['trips.json'], blocks: { 'trips.json': { type: 'table', columns: [{ key: 'n', label: 'Trips' }], rows: [{ n: count }] } } } }
    },
    more: (s: any, ctx: any) => { ctx.set({ page: s.trips.page + Number(ctx.params.by ?? 1) }) },
  },
}

let clock = 0
const setup = (log = memoryLog()) => {
  let k = 0
  const sessions = createSessions({ log, engine: createStateEngine([scope, trips] as any), now: () => new Date(Date.UTC(2026, 9, 4, 10, 0, clock++)).toISOString(), id: (kind) => `${kind}${++k}` })
  return { sessions, log }
}
let ni = 0
const intent = (over: Partial<Intent>): Intent => ({ id: `int${++ni}`, session: 's1', kind: 'structured', to: 'current', by: 'user:u1', at: '2026-10-04T10:00:00Z', ...over } as Intent)
const setBranch = (value: unknown, over: Partial<Intent> = {}) => intent({ ops: [{ op: 'set', path: 'scope.branch', value }], ...over })

test('a session opens with one block holding the agent\'s starting STATE', () => {
  const { sessions } = setup()
  const v = sessions.open({ session: 's1', user: 'user:u1', agent: 'agt_trips' })
  assert.equal(v.blocks.length, 1)
  assert.equal(v.leaf, 'blk1')
  assert.deepEqual(v.state.scope, { branch: null })
  assert.deepEqual(v.state.packages, { scope: 'h-scope', trips: 'h-trips' })
  assert.throws(() => sessions.open({ session: 's1', user: 'user:u1', agent: 'x' }), /already exists/)
})

test('an intent to the current view replaces its STATE and answer; one to a new view opens a block; the history shows what was not replaced', async () => {
  const { sessions } = setup()
  sessions.open({ session: 's1', user: 'user:u1', agent: 'agt_trips' })
  const a = await sessions.intent(setBranch('PUNE'))
  assert.equal(a.opened, false)
  assert.equal(a.block, 'blk1')
  assert.deepEqual(a.changed.sort(), ['scope.branch', 'trips.count'])
  assert.equal(a.answer?.markdown, '3 trips at PUNE, page 1\n:::table trips.json')
  assert.deepEqual(a.answer?.files, ['trips.json'])
  assert.deepEqual(a.answer?.blocks?.['trips.json']?.rows, [{ n: 3 }])
  const b = await sessions.intent(setBranch('HYDERABAD'))
  assert.equal(b.answer?.replaced, a.answer?.id)
  assert.equal(b.session.blocks.length, 1)
  const c = await sessions.intent(intent({ action: { package: 'trips', id: 'next' }, to: 'new' }))
  assert.equal(c.opened, true)
  assert.equal(c.block, c.session.leaf)
  assert.equal((c.session.state.trips as any).page, 2)
  assert.equal((c.session.states.blk1.trips as any).page, 1)          // the earlier block keeps its own STATE
  assert.deepEqual(history(c.session).map((x) => x.markdown.split('\n')[0]), ['365 trips at HYDERABAD, page 1', '365 trips at HYDERABAD, page 2'])
  assert.equal(c.session.answers.length, 3)                             // every answer is kept
})

test('changing an earlier block branches the thread; going back moves nothing else', async () => {
  const { sessions } = setup()
  sessions.open({ session: 's1', user: 'user:u1', agent: 'agt_trips' })
  await sessions.intent(setBranch('PUNE'))
  const second = await sessions.intent(intent({ call: { package: 'trips', fn: 'more', params: { by: 4 } }, to: 'new' }))
  assert.equal((second.session.state.trips as any).page, 5)
  // from the first block, even "to current": it is not the last block, so a new branch is made under it
  const branch = await sessions.intent(setBranch('HYDERABAD', { block: 'blk1' }))
  assert.equal(branch.opened, true)
  const v = branch.session
  assert.deepEqual(v.blocks.map((b) => [b.id, b.parent]), [['blk1', null], [second.block, 'blk1'], [branch.block, 'blk1']])
  assert.deepEqual(pathTo(v, branch.block), ['blk1', branch.block])
  assert.equal((v.states[second.block].scope as any).branch, 'PUNE')
  const back = sessions.goTo('s1', second.block, 'user:u1')
  assert.equal(back.leaf, second.block)
  assert.equal((back.state.trips as any).page, 5)
  assert.equal(back.answers.length, branch.session.answers.length)
})

test('refused, never guessed: a broken op, another user, an unknown block, a malformed intent', async () => {
  const { sessions } = setup()
  sessions.open({ session: 's1', user: 'user:u1', agent: 'agt_trips' })
  await assert.rejects(sessions.intent(intent({ ops: [{ op: 'set', path: 'trips.page', value: 'two' }] })), (e: any) => e instanceof SessionRefusal && /trips.page/.test(e.message))
  await assert.rejects(sessions.intent(setBranch('PUNE', { by: 'user:u2' })), /is user:u1's; user:u2 cannot change it/)
  await assert.rejects(sessions.intent(setBranch('PUNE', { block: 'nope' })), /has no block nope/)
  await assert.rejects(sessions.intent(intent({})), /carries ops, an action or a call/)
  assert.equal(sessions.read('s1').answers.length, 0)                  // nothing refused was recorded
})

test('only the latest intent is applied: one that finishes after a newer one started is dropped', async () => {
  const { sessions } = setup()
  sessions.open({ session: 's1', user: 'user:u1', agent: 'agt_trips' })
  const slow = sessions.intent(setBranch('SLOW'))
  const fast = sessions.intent(setBranch('PUNE'))
  const [s, f] = await Promise.all([slow, fast])
  assert.equal(s.stale, true)
  assert.equal(f.answer?.markdown.split('\n')[0], '3 trips at PUNE, page 1')
  const v = sessions.read('s1')
  assert.equal((v.state.scope as any).branch, 'PUNE')
  assert.equal(v.intents.length, 1)
})

test('a language intent applies what the ICA read from the words, and its answer comes first', async () => {
  const { sessions } = setup()
  sessions.open({ session: 's1', user: 'user:u1', agent: 'agt_trips' })
  const r = await sessions.intent(intent({ kind: 'language', text: 'only Pune', to: 'current', result: { ops: [{ op: 'set', path: 'scope.branch', value: 'PUNE' }], markdown: 'Pune only.' } }))
  assert.equal(r.answer?.markdown, 'Pune only.\n\n3 trips at PUNE, page 1\n:::table trips.json')
  const words = await sessions.intent(intent({ kind: 'language', text: 'what is a trip?', to: 'new', result: { markdown: 'A vehicle trip document.' } }))
  assert.equal(words.opened, true)
  assert.equal(words.answer?.markdown, 'A vehicle trip document.')
})

test('the log rebuilds the session, can be read as of any moment, and survives a line cut off by a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ses-'))
  const { sessions } = setup(fileLog(dir))
  sessions.open({ session: 's1', user: 'user:u1', agent: 'agt_trips' })
  const a = await sessions.intent(setBranch('PUNE'))
  await sessions.intent(setBranch('HYDERABAD', { to: 'new' }))
  const later = setup(fileLog(dir)).sessions.read('s1')
  assert.equal(later.blocks.length, 2)
  assert.equal((later.state.scope as any).branch, 'HYDERABAD')
  const then = replay(fileLog(dir).read('s1'), a.answer!.at)!
  assert.equal(then.blocks.length, 1)
  assert.equal((then.state.scope as any).branch, 'PUNE')
  appendFileSync(join(dir, 's1', 'session.jsonl'), '{"t":"answer","at":"2026-1')
  assert.equal(setup(fileLog(dir)).sessions.read('s1').answers.length, later.answers.length)
})

test('a session opens on a whole STATE a view was at: the same STATE, nothing reset', async () => {
  const { sessions } = setup()
  const first = sessions.open({ session: 'v1', user: 'user:u1', agent: 'agt_trips' })
  const moved = await sessions.intent(setBranch('PUNE', { session: 'v1' }))
  const again = sessions.open({ session: 'v2', user: 'user:u1', agent: 'agt_trips', state: moved.session.state })
  assert.deepEqual(again.state, moved.session.state)
  assert.notDeepEqual(first.state, again.state)
})
