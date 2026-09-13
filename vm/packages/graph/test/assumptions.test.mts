// Assumptions — named beliefs, looked up by name — and interventions — changes for one request only. Local rows,
// so the SQL each intervention wraps around a relation actually runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, createEngine, type Contract } from '../src/index.ts'

const PEOPLE = [
  { person_id: 'p1', team: 'a', hired: '2025-01-01', released: null, hours: 40 },
  { person_id: 'p2', team: 'a', hired: '2026-02-10', released: null, hours: 20 },
  { person_id: 'p3', team: 'b', hired: '2025-06-01', released: null, hours: 40 },
]
const HOURS = [
  { person_id: 'p1', team: 'a', worked_on: '2026-03-02', hours: 30 },
  { person_id: 'p3', team: 'b', worked_on: '2026-03-03', hours: 35 },
]
const people: Contract = { name: 'people', kind: 'concept', description: 'People employed.', reads: { sources: ['HR'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { person: { column: 'person_id', history: 'stable' }, team: { column: 'team', history: 'current' } },
           measures: { headcount: { aggregate: 'count', unit: 'people', kind: 'stock' }, weekly_hours: { aggregate: 'sum', column: 'hours', unit: 'h', kind: 'stock' } } } }
const PEOPLE_BODY = `const P = ${JSON.stringify(PEOPLE)}
export default async (ctx, { asAt }) => ({ source: 'HR', rows: P.filter((p) => p.hired <= asAt && (!p.released || p.released > asAt)) })`
const worked: Contract = { name: 'worked', kind: 'concept', description: 'Hours worked.', reads: { sources: ['HR'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { person: { column: 'person_id', history: 'stable' }, team: { column: 'team', history: 'current' } },
           measures: { hours: { aggregate: 'sum', column: 'hours', unit: 'h', kind: 'flow' } }, time: 'worked_on' } }
const WORKED_BODY = `export default async () => ({ source: 'HR', rows: ${JSON.stringify(HOURS)} })`

const program = (name: string, reads: string[], body: string, assumes?: Contract['assumes']) => ({ body,
  contract: { name, kind: 'program', description: name, reads: { sources: [], programs: reads }, params: {}, returns: 'value', ...(assumes ? { assumes } : {}) } as Contract })

async function setup(organisation?: Record<string, unknown>) {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-as-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [],
                                today: () => '2026-03-31', assumptions: organisation })
  await engine.define({ body: PEOPLE_BODY, contract: people }, { by: 'test' })
  await engine.define({ body: WORKED_BODY, contract: worked }, { by: 'test' })
  await engine.define(program('capacity', ['people'],
    `export default async (ctx) => { const r = await ctx.call('people', { measures: ['headcount'], at: ctx.today }); return r.rows[0].headcount * ctx.assume('working week') }`,
    { 'working week': { description: 'hours in a standard working week', unit: 'h', default: 40 } }), { by: 'test' })
  return { engine, store }
}

test('an assumption comes from the caller, else the organisation, else the default — and memory says which', async () => {
  const plain = await setup()
  const d = await plain.engine.call<number>('capacity')
  assert.equal(d.value, 3 * 40)
  assert.deepEqual(plain.store.getCall(d.callId)!.assumptions, [{ name: 'working week', value: 40, from: 'default' }])

  const org = await setup({ 'working week': 37.5 })
  const o = await org.engine.call<number>('capacity')
  assert.equal(o.value, 3 * 37.5)
  assert.equal(org.store.getCall(o.callId)!.assumptions[0].from, 'organisation')

  const c = await org.engine.call<number>('capacity', {}, { assume: { 'working week': 35 } })
  assert.equal(c.value, 3 * 35)
  assert.equal(org.store.getCall(c.callId)!.assumptions[0].from, 'caller')
})

test('an assumption flows down through programs that do not read it, and the nearest caller wins', async () => {
  const { engine } = await setup()
  await engine.define(program('report', ['capacity'], `export default async (ctx) => ({ normal: await ctx.call('capacity'), short: await ctx.call('capacity', {}, { assume: { 'working week': 30 } }) })`), { by: 'test' })
  const r = await engine.call<any>('report', {}, { assume: { 'working week': 45 } })
  assert.deepEqual(r.value, { normal: 3 * 45, short: 3 * 30 })
})

test('refused: reading an assumption not declared, or one nobody gave', async () => {
  const { engine } = await setup()
  await engine.define(program('sneaky', [], `export default async (ctx) => ctx.assume('target')`), { by: 'test' })
  await assert.rejects(engine.call('sneaky'), /does not declare/)
  await engine.define(program('needy', [], `export default async (ctx) => ctx.assume('target')`, { target: { description: 'the utilisation target' } }), { by: 'test' })
  await assert.rejects(engine.call('needy'), /needs the assumption "target"/)
  assert.equal((await engine.call('needy', {}, { assume: { target: 0.8 } })).value, 0.8)
})

test('intervention: a program\'s value replaced for one request, however deep, and the answer says it is hypothetical', async () => {
  const { engine, store } = await setup()
  await engine.define(program('report', ['capacity'], `export default async (ctx) => ({ capacity: await ctx.call('capacity') })`), { by: 'test' })
  const r = await engine.call<any>('report', {}, { intervene: { capacity: { value: 999 } } })
  assert.equal(r.value.capacity, 999)
  assert.ok(store.getCall(r.callId)!.caveats.some((c) => c.startsWith('hypothetical')))
  assert.equal((await engine.call<any>('report')).value.capacity, 120, 'nothing was saved: the next request is real')
})

test('intervention: three hires from a date — a stock gains members from then, and not before', async () => {
  const { engine } = await setup()
  const hire = (i: number) => ({ row: { person_id: `new${i}`, team: 'b', hours: 40 }, from: '2026-03-15' })
  const add = { people: { add: [hire(1), hire(2), hire(3)] } }
  const at = async (date: string, intervene?: any) =>
    (await engine.call<any>('people', { measures: ['headcount'], by: ['team'], at: date }, { intervene })).value.rows.find((x: any) => x.team === 'b').headcount
  assert.equal(await at('2026-03-31'), 1)
  assert.equal(await at('2026-03-31', add), 4)
  assert.equal(await at('2026-03-01', add), 1, 'before they start')
})

test('intervention: rows left out for one request reach every relation built on the one changed', async () => {
  const { engine } = await setup()
  await engine.define({ body: `export default () => ({ sql: "SELECT w.* FROM {{worked}} w WHERE w.hours > 0" })`,
    contract: { ...worked, name: 'real hours', kind: 'program', reads: { sources: [], programs: ['worked'] } } }, { by: 'test' })
  const q = { measures: ['hours'], during: { from: '2026-03-01', to: '2026-04-01' } }
  assert.equal((await engine.call<any>('real hours', q)).value.rows[0].hours, 65)
  assert.equal((await engine.call<any>('real hours', q, { intervene: { worked: { where: { team: 'b' } } } })).value.rows[0].hours, 30)
})

test('replay asks again with the same day, assumptions and interventions', async () => {
  const { engine } = await setup()
  const first = await engine.call<number>('capacity', {}, { assume: { 'working week': 32 }, intervene: { people: { add: [{ row: { person_id: 'x', team: 'a', hours: 40 } }] } } })
  const again = await engine.replay<number>(first.callId)
  assert.equal(first.value, 4 * 32)
  assert.equal(again.value, first.value)
})

test('rules: the most specific rule for who is asking and what is read gives the value', async () => {
  const { engine, store } = await setup({
    target: { rules: [
      { value: 0.75 },
      { when: { 'who.department': 'finance' }, value: 0.7 },
      { when: { 'who.department': 'finance', team: 'b' }, value: 0.6 },
      { when: { team: 'b' }, value: 0.8 },
    ] },
  })
  await engine.define(program('targets', [], `export default async (ctx) => ({ a: ctx.assume('target', { team: 'a' }), b: ctx.assume('target', { team: 'b' }) })`,
    { target: { description: 'utilisation target' } }), { by: 'test' })
  assert.deepEqual((await engine.call<any>('targets')).value, { a: 0.75, b: 0.8 }, 'nobody in particular')
  const finance = await engine.call<any>('targets', {}, { who: { id: 'u1', department: 'finance' } })
  assert.deepEqual(finance.value, { a: 0.7, b: 0.6 }, 'finance, and finance on team b')
  const b = store.getCall(finance.callId)!.assumptions.find((x) => (x.about as any)?.team === 'b')!
  assert.deepEqual(b.rule, { 'who.department': 'finance', team: 'b' })
})

test('rules: two equally specific rules that disagree are refused, not picked between', async () => {
  const { engine } = await setup({
    target: { rules: [{ when: { 'who.department': 'finance' }, value: 0.7 }, { when: { team: 'b' }, value: 0.8 }] },
  })
  await engine.define(program('target b', [], `export default async (ctx) => ctx.assume('target', { team: 'b' })`,
    { target: { description: 'utilisation target', default: 0.75 } }), { by: 'test' })
  await assert.rejects(engine.call('target b', {}, { who: { department: 'finance' } }), /apply equally/)
})

test('rules: a layer whose rules do not apply passes to the next', async () => {
  const { engine } = await setup({ target: { rules: [{ when: { 'who.department': 'sales' }, value: 0.9 }] } })
  await engine.define(program('target', [], `export default async (ctx) => ctx.assume('target')`,
    { target: { description: 'utilisation target', default: 0.75 } }), { by: 'test' })
  assert.equal((await engine.call('target', {}, { who: { department: 'sales' } })).value, 0.9)
  assert.equal((await engine.call('target', {}, { who: { department: 'finance', groups: ['a'] } })).value, 0.75)
})

// ── counterfactuals ───────────────────────────────────────────────────────────────────────────────────────

test('counterfactual: a past answer with one more person, as of its own day, row by row', async () => {
  const { engine } = await setup()
  const past = await engine.call<any>('people', { measures: ['headcount', 'weekly_hours'], by: ['team'], at: '2026-03-31' })
  const cf = await engine.counterfactual(past.callId, { intervene: { people: { add: [{ row: { person_id: 'x', team: 'b', hours: 40 } }] } } })
  const b = (cf.difference as any).rows.find((r: any) => r.team === 'b')
  assert.deepEqual([b.headcount, b.headcount_counterfactual, b.headcount_change], [1, 2, 1])
  assert.equal(b.weekly_hours_change, 40)
  assert.equal((cf.difference as any).rows.find((r: any) => r.team === 'a').headcount_change, 0)
})

test('counterfactual: an assumption changed, on a program returning a number', async () => {
  const { engine } = await setup()
  const past = await engine.call<number>('capacity')
  const cf = await engine.counterfactual(past.callId, { assume: { 'working week': 30 } })
  assert.deepEqual(cf.difference, { factual: 120, counterfactual: 90, change: -30 })
})

test('counterfactual: a correction since the answer is not counted as the effect of the change', async () => {
  const { engine } = await setup()
  const past = await engine.call<number>('capacity')
  // people is corrected afterwards: p2 is not counted.
  await engine.define({ body: PEOPLE_BODY.replace('rows: P.filter((p) =>', "rows: P.filter((p) => p.person_id !== 'p2' &&"), contract: people }, { by: 'test', replace: true })
  const cf = await engine.counterfactual(past.callId, { assume: { 'working week': 30 } })
  assert.deepEqual(cf.difference, { factual: 80, counterfactual: 60, change: -20 })
  assert.ok(cf.caveats.some((c) => /differs from the one recorded/.test(c)))
})
