import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateEngine, createStateSession, stateHash, StateRefusal, type LoadedPackage } from '../src/index.ts'

// A global filter package, and a program that reads it — the "change a global filter, then run" case.
const scope: LoadedPackage = {
  name: 'scope', hash: 'h-scope',
  spec: { owns: 'scope', schema: { branch: { nullable: 'string' }, year: 'number' }, initial: { branch: null, year: 2026 }, reads: [],
    functions: [{ name: 'run', produces: 'data' }], actions: [], commands: [], doc: 'doc.md' },
  functions: { run: () => {} },
}
let tripRuns = 0
const trips: LoadedPackage = {
  name: 'trips', hash: 'h-trips',
  spec: { owns: 'trips', schema: { settled: { nullable: 'boolean' }, page: 'number', count: 'number', tags: { list: 'string' }, window: { object: { from: 'date', to: 'date' } } },
    initial: { settled: null, page: 1, count: 0, tags: [], window: { from: '2026-04-01', to: '2027-04-01' } }, reads: ['scope.branch'],
    functions: [{ name: 'run', produces: 'view' }, { name: 'rate', produces: 'data' }, { name: 'sneaky', produces: 'data' }, { name: 'mutate', produces: 'data' }],
    actions: [{ id: 'unsettled', label: 'Completed, not settled', ops: [{ op: 'set', path: 'trips.settled', value: false }] }, { id: 'rerate', label: 'Re-rate', call: 'rate' }],
    commands: [], doc: 'doc.md' },
  functions: {
    run: (s, ctx) => { tripRuns++; const n = (s.scope as any).branch === 'HYDERABAD' ? 365 : 1000; ctx.set({ count: n }); return { answer: { markdown: `${n} trips · page ${(s.trips as any).page}` } } },
    rate: (_s, ctx) => { ctx.set({ page: Number(ctx.params.page ?? 1) }) },
    sneaky: (_s, ctx) => { ctx.set({ branch: 'X' } as any) },
    mutate: (s) => { (s.scope as any).branch = 'X' },
  },
}
// A third package that reads trips' result: re-runs follow a changed slice down the chain.
const summary: LoadedPackage = {
  name: 'summary', hash: 'h-summary',
  spec: { owns: 'summary', schema: { text: 'string' }, initial: { text: '' }, reads: ['trips.count'], functions: [{ name: 'run', produces: 'view' }], actions: [], commands: [], doc: 'doc.md' },
  functions: { run: (s, ctx) => { ctx.set({ text: `${(s.trips as any).count} trips` }) } },
}
const engine = () => createStateEngine([summary, trips, scope])

test('loading: dependency order, one owner per slice, every function provided, no cycles', () => {
  assert.deepEqual(engine().order, ['scope', 'trips', 'summary'])
  assert.throws(() => createStateEngine([trips, { ...trips }, scope]), /two packages own the slice "trips"/)
  assert.throws(() => createStateEngine([{ ...trips, functions: { run: trips.functions.run } }, scope]), /declares rate\(\) but does not provide it/)
  const a: LoadedPackage = { ...summary, name: 'a', spec: { ...summary.spec, owns: 'a', reads: ['b.text'] } }
  const b: LoadedPackage = { ...summary, name: 'b', spec: { ...summary.spec, owns: 'b', reads: ['a.text'] } }
  assert.throws(() => createStateEngine([a, b]), /cycle: a → b → a/)
})

test('a first STATE: packages by hash, initial slices, the agent\'s keys', () => {
  const s = engine().start({ trips: { page: 3 } }, { question: 'unsettled trips' })
  assert.deepEqual(s.packages, { summary: 'h-summary', trips: 'h-trips', scope: 'h-scope' })
  assert.equal((s.trips as any).page, 3)
  assert.deepEqual(s.agent, { question: 'unsettled trips' })
  assert.throws(() => engine().start({ trips: { page: 'x' } as any }), /trips.page must be a number/)
})

test('ops: checked against the schema, all or none, never touching the platform\'s keys', () => {
  const e = engine(), s = e.start()
  const r = e.apply(s, [{ op: 'set', path: 'scope.branch', value: 'PUNE' }, { op: 'add', path: 'trips.tags', value: 'urgent' }, { op: 'set', path: 'trips.window.from', value: '2026-05-01' }])
  assert.deepEqual(r.changed, ['scope.branch', 'trips.tags', 'trips.window.from'])
  assert.equal((r.state.trips as any).window.from, '2026-05-01')
  assert.equal((s.scope as any).branch, null)                          // the old STATE is untouched
  const refused = (ops: any[], re: RegExp) => assert.throws(() => e.apply(s, ops), (x: any) => x instanceof StateRefusal && re.test(x.message))
  refused([{ op: 'set', path: 'trips.page', value: 'two' }], /trips.page must be a number/)
  refused([{ op: 'set', path: 'trips.nope', value: 1 }], /"trips" has no field nope/)
  refused([{ op: 'set', path: 'orders.x', value: 1 }], /no package owns the slice "orders"/)
  refused([{ op: 'add', path: 'trips.page', value: 2 }], /not a list/)
  refused([{ op: 'remove', path: 'trips.page' }], /not a list and not nullable/)
  refused([{ op: 'set', path: 'packages.trips', value: 'h-evil' }], /the platform's/)
  refused([{ op: 'set', path: 'scope.branch', value: 'A' }, { op: 'set', path: 'trips.page', value: 'x' }], /trips.page/)   // nothing applied
  const removed = e.apply(r.state, [{ op: 'remove', path: 'trips.tags', value: 'urgent' }, { op: 'remove', path: 'scope.branch' }]).state
  assert.deepEqual([(removed.trips as any).tags, (removed.scope as any).branch], [[], null])
  const agent = e.apply(s, [{ op: 'set', path: 'agent.seeing', value: 'unsettled trips at Hyderabad' }]).state
  assert.equal((agent.agent as any).seeing, 'unsettled trips at Hyderabad')
})

test('a global filter changes: the package reading it re-runs, and the one reading that re-runs after it', async () => {
  const e = engine(); tripRuns = 0
  const out = await e.dispatch(e.start(), [{ op: 'set', path: 'scope.branch', value: 'HYDERABAD' }])
  assert.deepEqual(out.ran.map((r) => r.package), ['scope', 'trips', 'summary'])
  assert.equal((out.state.trips as any).count, 365)
  assert.equal((out.state.summary as any).text, '365 trips')
  assert.equal(out.ran[1].answer?.markdown, '365 trips · page 1')
  // a change only to trips' own field: scope does not run; trips does; summary only if trips' count changed
  const again = await e.dispatch(out.state, [{ op: 'set', path: 'trips.page', value: 2 }])
  assert.deepEqual(again.ran.map((r) => r.package), ['trips'])
  assert.equal(tripRuns, 2)
})

test('a package can set only its own slice, and cannot change the STATE it was handed', async () => {
  const e = engine(), s = e.start()
  await assert.rejects(e.call(s, 'trips', 'sneaky'), /trips.branch: trips can set only the fields its schema declares — and never another package's slice/)
  await assert.rejects(e.call(s, 'trips', 'mutate'), TypeError)          // frozen: an attempt to write throws
  await assert.rejects(e.call(s, 'trips', 'nope'), /has no function nope\(\)/)
})

test('actions: plain ops then the runs, or a function call with parameters', async () => {
  const e = engine(), s = e.start()
  const a = await e.act(s, 'trips', 'unsettled')
  assert.equal((a.state.trips as any).settled, false)
  assert.deepEqual(a.ran.map((r) => r.package), ['trips', 'summary'])     // trips recounted (0 → 1000), and summary reads trips.count
  const b = await e.act(s, 'trips', 'rerate', { page: 4 })
  assert.equal((b.state.trips as any).page, 4)
  assert.deepEqual(b.ran.map((r) => `${r.package}.${r.fn}`), ['trips.rate'])
  await assert.rejects(e.act(s, 'trips', 'nope'), /suggests no action "nope"/)
})

test('a run for an older STATE that finishes after a newer intent is dropped', async () => {
  const releases: (() => void)[] = []
  const slow: LoadedPackage = { ...summary, name: 'slow', spec: { ...summary.spec, owns: 'slow', reads: [] }, functions: { run: async (s, ctx) => { await new Promise<void>((r) => releases.push(r)); ctx.set({ text: `ran for ${(s.slow as any).text}` }) } } }
  const e = createStateEngine([slow])
  const session = createStateSession(e, e.start())
  const first = session.dispatch([{ op: 'set', path: 'slow.text', value: 'first' }])
  const second = session.dispatch([{ op: 'set', path: 'slow.text', value: 'second' }])
  await new Promise((r) => setTimeout(r, 0))
  releases[0](); const one = await first        // the first run finishes after the second intent arrived
  releases[1](); const two = await second
  assert.equal(one.stale, true)
  assert.equal(two.stale, false)
  assert.equal((session.state.slow as any).text, 'ran for second')        // the newer intent's result is the one kept
})

test('the same STATE always hashes the same, whatever the key order', () => {
  assert.equal(stateHash({ packages: { a: '1', b: '2' }, a: { x: 1, y: 2 } }), stateHash({ a: { y: 2, x: 1 }, packages: { b: '2', a: '1' } }))
  assert.notEqual(stateHash({ packages: {}, a: { x: 1 } }), stateHash({ packages: {}, a: { x: 2 } }))
})

test('a reader re-runs only when the field it reads changed, not any field of that slice', async () => {
  const e = engine()
  const first = await e.dispatch(e.start(), [{ op: 'set', path: 'scope.branch', value: 'HYDERABAD' }])   // count 365
  const pageOnly = await e.dispatch(first.state, [{ op: 'set', path: 'trips.page', value: 3 }])           // count stays 365
  assert.deepEqual(pageOnly.ran.map((r) => r.package), ['trips'])
  assert.deepEqual(pageOnly.changed, ['trips.page'])
})
