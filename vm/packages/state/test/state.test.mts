import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateEngine, createStateSession, stateHash, StateRefusal, type LoadedPackage } from '../src/index.ts'

// A global filter package, and a program that reads it — the "change a global filter, then run" case.
const scope: LoadedPackage = {
  name: 'scope', hash: 'h-scope',
  spec: { owns: 'scope', schema: { branch: { nullable: 'string' }, year: 'number' }, initial: { branch: null, year: 2026 }, reads: [],
    functions: [{ name: 'run', produces: 'data' }], options: [], commands: [], doc: 'doc.md' },
  functions: { run: () => {} },
}
let tripRuns = 0
const trips: LoadedPackage = {
  name: 'trips', hash: 'h-trips',
  spec: { owns: 'trips', schema: { settled: { nullable: 'boolean' }, page: 'number', count: 'number', tags: { list: 'string' }, window: { object: { from: 'date', to: 'date' } } },
    initial: { settled: null, page: 1, count: 0, tags: [], window: { from: '2026-04-01', to: '2027-04-01' } }, reads: ['scope.branch'],
    functions: [{ name: 'run', produces: 'view' }, { name: 'rate', produces: 'data' }, { name: 'sneaky', produces: 'data' }, { name: 'mutate', produces: 'data' }],
    options: ['unsettled', 'nextPage', 'asked', 'slow', 'writes', 'elsewhere', 'fails'], commands: [], doc: 'doc.md' },
  functions: {
    run: (s, ctx) => { tripRuns++; const n = (s.scope as any).branch === 'HYDERABAD' ? 365 : 1000; ctx.set({ count: n }); return { answer: { markdown: `${n} trips · page ${(s.trips as any).page}` } } },
    rate: (_s, ctx) => { ctx.set({ page: Number(ctx.params.page ?? 1) }) },
    sneaky: (_s, ctx) => { ctx.set({ branch: 'X' } as any) },
    mutate: (s) => { (s.scope as any).branch = 'X' },
    // option functions: each computes one move for the step, from the data — or none
    unsettled: async (s, ctx: any) => {
      const [{ n }] = await ctx.services.query('trips', 'SELECT count(*) AS n FROM trips WHERE NOT settled')
      return n ? { label: `${n} trips completed, not settled`, ops: [{ op: 'set', path: 'trips.settled', value: false }] } : null
    },
    nextPage: (s) => ((s.trips as any).count > (s.trips as any).page * 100 ? { label: `Page ${(s.trips as any).page + 1} of ${Math.ceil((s.trips as any).count / 100)}`, call: { fn: 'rate', params: { page: (s.trips as any).page + 1 } }, to: 'current' } : null),
    asked: (_s, ctx: any) => (ctx.history.at(-1)?.question ? { label: `Again, for "${ctx.history.at(-1).question}" — ${ctx.context}`, call: { fn: 'run' } } : null),
    slow: () => new Promise((r) => setTimeout(() => r({ label: 'too late', call: { fn: 'run' } }), 200)),
    writes: (_s, ctx: any) => { ctx.services.append('trips', 'trips', []); return { label: 'wrote', call: { fn: 'run' } } },
    elsewhere: () => ({ label: 'Change the branch', ops: [{ op: 'set', path: 'scope.branch', value: 'X' }] }),
    fails: () => { throw new Error('no data for it') },
  } as any,
}
// A third package that reads trips' result: re-runs follow a changed slice down the chain.
const summary: LoadedPackage = {
  name: 'summary', hash: 'h-summary',
  spec: { owns: 'summary', schema: { text: 'string' }, initial: { text: '' }, reads: ['trips.count'], functions: [{ name: 'run', produces: 'view' }], options: [], commands: [], doc: 'doc.md' },
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

test('options: each option function computes one move for the step from its STATE, context, history and the data — read-only, in time, checked; the rest are left out, saying why', async () => {
  const unsettled = { n: 12 }
  const e = createStateEngine([summary, trips, scope], { services: { query: async () => [unsettled], append: async () => ({ rows: 0 }) } })
  const s = { ...e.start(), trips: { ...e.start().trips as any, count: 1000 } }
  const step = { context: 'opened from the map', history: [{ markdown: '1000 trips' }, { question: 'what about Pune?', markdown: '3 trips' }] }
  const { offered, left } = await e.options(s, step, { timeoutMs: 50 })
  assert.deepEqual(offered.map((o) => [o.fn, o.option.label]), [
    ['unsettled', '12 trips completed, not settled'],
    ['nextPage', 'Page 2 of 10'],
    ['asked', 'Again, for "what about Pune?" — opened from the map'],
  ])
  const why = Object.fromEntries(left.map((l) => [l.fn, l.why]))
  assert.match(why.slow, /took longer than 50 ms/)
  assert.match(why.writes, /failed: .*append/)                              // only the services that read are given
  assert.match(why.elsewhere, /changes another package's slice/)
  assert.equal(why.fails, 'failed: no data for it')
  // a move that does not hold here is not offered
  unsettled.n = 0
  const again = await e.options({ ...s, trips: { ...(s.trips as any), count: 50 } }, { context: '', history: [] }, { timeoutMs: 50 })
  assert.deepEqual(again.offered.map((o) => o.fn), [])
  assert.equal(Object.fromEntries(again.left.map((l) => [l.fn, l.why])).unsettled, 'offers nothing here')
  // taking one is an ordinary intent: its ops, or its call
  const took = await e.call(s, 'trips', 'rate', offered[1].option.call!.params)
  assert.equal((took.state.trips as any).page, 2)
  // an option function that is not provided is refused at load
  assert.throws(() => createStateEngine([{ ...trips, functions: { ...trips.functions, slow: undefined } } as any, scope, summary]), /offers slow\(\) as an option but does not provide it/)
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

test('a change from outside is put to the slice\'s own check: refused with its words, all or none — its own writes are not checked again', async () => {
  const views: LoadedPackage = {
    name: 'views', hash: 'h-views',
    spec: { owns: 'views', schema: { by: { nullable: 'string' }, said: 'string' }, initial: { by: null, said: '' }, reads: [], functions: [{ name: 'run', produces: 'view' }], options: [], commands: [], doc: 'doc.md' },
    functions: {
      run: (s, ctx) => { ctx.set({ said: `by ${(s.views as any).by}` }) },
      // what only the package knows: the breakdowns its model has
      check: ((_s: unknown, ctx: { slice: { by: string | null } }) => ctx.slice.by && !['branch', 'month'].includes(ctx.slice.by) ? `there is no breakdown by ${ctx.slice.by}: branch or month` : null) as any,
    },
  }
  const e = createStateEngine([views])
  const s = e.start()
  await assert.rejects(() => e.dispatch(s, [{ op: 'set', path: 'views.by', value: 'lane' }]), (err: any) => err instanceof StateRefusal && /no breakdown by lane: branch or month/.test(err.message))
  const ok = await e.dispatch(s, [{ op: 'set', path: 'views.by', value: 'month' }])
  assert.equal((ok.state.views as any).said, 'by month')   // accepted, and its own write (said) was not put to check
})

test('a program that fails while running after a change: recorded as failed, its slice as it was, the others run on', async () => {
  const broken: LoadedPackage = { ...summary, name: 'broken', hash: 'h-broken', spec: { ...summary.spec, owns: 'broken', reads: ['scope.branch'] },
    functions: { run: () => { throw new TypeError("Cannot read properties of undefined (reading 'label')") } } }
  const e = createStateEngine([broken, trips, scope, summary])
  const out = await e.dispatch(e.start(), [{ op: 'set', path: 'scope.branch', value: 'HYDERABAD' }])
  const failed = out.ran.find((r) => r.package === 'broken')!
  assert.match(failed.failed!, /reading 'label'/)
  assert.equal((out.state.broken as any).text, '')                       // left as it was
  assert.equal((out.state.trips as any).count, 365)                      // the others ran on
  assert.equal((out.state.summary as any).text, '365 trips')
})

test('settings: a package reads only those it declared (its own and its libraries\'); reading another fails at once, naming the fix', async () => {
  const domain = { floor: 5, threshold: 0.8, 'reporting-currency-code': 'AUD' }
  const reads = (key: string) => async (_s: any, ctx: any) => { const all = await ctx.services.settings('d'); ctx.set({ said: String(all[key]) }) }
  const pkg = (fns: Record<string, any>, settings?: string[]): LoadedPackage => ({ name: 'p', hash: 'h-p', ...(settings ? { settings } : {}),
    spec: { owns: 'p', schema: { said: 'string' }, initial: { said: '' }, reads: [], functions: Object.keys(fns).map((name) => ({ name, produces: 'data' as const })), options: [], commands: [], doc: 'doc.md' }, functions: fns })
  const services = { settings: async () => domain }
  const e = createStateEngine([pkg({ run: () => {}, declared: reads('floor'), undeclared: reads('threshold'), inside: async (_s: any, ctx: any) => { ctx.set({ said: String('threshold' in await ctx.services.settings('d')) }) }, listed: async (_s: any, ctx: any) => { ctx.set({ said: Object.keys(await ctx.services.settings('d')).join(',') }) } }, ['floor', 'missing'])], { services })
  const s = e.start()
  assert.equal(((await e.call(s, 'p', 'declared')).state.p as any).said, '5')
  await assert.rejects(e.call(s, 'p', 'undeclared'), /p reads the setting "threshold" without declaring it — add it to its manifest's "settings"/)
  await assert.rejects(e.call(s, 'p', 'inside'), /without declaring it/)                     // asking whether it is there counts
  assert.equal(((await e.call(s, 'p', 'listed')).state.p as any).said, 'floor')               // a declared one absent from the knowledge is simply absent
  // declaring nothing: reads nothing
  const none = createStateEngine([pkg({ run: () => {}, declared: reads('floor') })], { services })
  await assert.rejects(none.call(none.start(), 'p', 'declared'), /p reads the setting "floor" without declaring it/)
})
