// S7 and S8 on local rows: memory of series, expectations, surprises traced to their part, and decisions that
// reopen when the data crosses them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, createEngine, withinLimit, type Contract } from '../src/index.ts'

// Two teams, eighteen months. Team b's people keep booking about 130 hours a month each — until June 2026, when
// their hours fall to about half. Their headcount does not change. In Q3 the hours stay low.
const months: string[] = []
for (let y = 2025, m = 1; months.length < 21; m++) { if (m > 12) { m = 1; y++ } months.push(`${y}-${String(m).padStart(2, '0')}`) }
const wobble = (i: number) => [3, -2, 1, -4, 2, 0, -1, 4, -3, 2][i % 10]
const HOURS = months.flatMap((mo, i) => [
  { worked_on: `${mo}-15`, team: 'a', hours: 4 * 130 + wobble(i) * 4 },
  { worked_on: `${mo}-15`, team: 'b', hours: mo >= '2026-06' ? 3 * 65 + wobble(i) : 3 * 130 + wobble(i) * 3 },
])
const PEOPLE = [
  ...['a1', 'a2', 'a3', 'a4'].map((id) => ({ person_id: id, team: 'a', hired: '2024-01-01', hours: 40 })),
  ...['b1', 'b2', 'b3'].map((id) => ({ person_id: id, team: 'b', hired: '2024-01-01', hours: 40 })),
]

const hours: Contract = { name: 'hours', kind: 'concept', description: 'Hours booked.', reads: { sources: ['T'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { team: { column: 'team', history: 'stable' } }, measures: { hours: { aggregate: 'sum', column: 'hours', unit: 'h', kind: 'flow' } }, time: 'worked_on' } }
const people: Contract = { name: 'people', kind: 'concept', description: 'People employed.', reads: { sources: ['T'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { team: { column: 'team', history: 'stable' } }, measures: { headcount: { aggregate: 'count', unit: 'people', kind: 'stock' } } } }
// Utilisation by team and month: hours over 130 hours a person.
const utilisation = { body: `export default async (ctx, { during }) => {
    const h = await ctx.call('hours', { by: ['team', 'month'], during })
    const p = await ctx.call('people', { by: ['team', 'month'], during })
    const people = new Map(p.rows.map((r) => [r.team + r.month, r.headcount]))
    return {
      columns: [{ name: 'team', role: 'dimension' }, { name: 'month', role: 'dimension' }, { name: 'utilisation', role: 'measure', unit: 'ratio', kind: 'ratio' }],
      rows: h.rows.map((r) => ({ team: r.team, month: r.month, utilisation: r.hours / (people.get(r.team + r.month) * 130) })),
      caveats: [],
    }
  }`,
  contract: { name: 'utilisation', kind: 'program', description: 'Hours as a share of 130 a person.', reads: { sources: [], programs: ['hours', 'people'] },
              params: { during: 'the span' }, returns: 'value' } as Contract }
// Hire when last quarter's utilisation for the team was above 90%.
const hire = { body: `export default async (ctx, { team }) => {
    const u = await ctx.call('utilisation', { during: { previous: 'quarter' } })
    const rows = u.rows.filter((r) => r.team === team)
    const average = rows.reduce((a, r) => a + r.utilisation, 0) / rows.length
    return { team, average, hire: ctx.decideAt('last quarter above 90% utilised', average, '>', 0.9) }
  }`,
  contract: { name: 'should hire', kind: 'program', description: 'Whether a team should hire.', reads: { sources: [], programs: ['utilisation'] },
              params: { team: 'the team' }, returns: 'value' } as Contract }

async function setup() {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-s7-')), 'memory.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14' })
  await engine.define({ body: `export default async () => ({ source: 'T', rows: ${JSON.stringify(HOURS)} })`, contract: hours }, { by: 'test' })
  await engine.define({ body: `const P = ${JSON.stringify(PEOPLE)}
export default async (ctx, { asAt }) => ({ source: 'T', rows: P.filter((p) => p.hired <= asAt) })`, contract: people }, { by: 'test' })
  await engine.define(utilisation, { by: 'test' })
  await engine.define(hire, { by: 'test' })
  return { engine, store }
}
const SPAN = { from: '2025-01-01', to: '2026-07-01' }

test('S7: a value outside what its series leads memory to expect is found, and only that one', async () => {
  const { engine } = await setup()
  const r = await engine.call<any>('utilisation', { during: SPAN })
  const found = engine.surprises(r.callId)
  assert.deepEqual(found.map((s) => [s.member, s.period, s.measure]), [[{ team: 'b' }, '2026-06', 'utilisation']])
  const e = found[0].expectation
  assert.ok(e.known && e.n === 12 && e.z! < -3, `z ${e.z}`)
})

test('S7: triage walks the surprise down to the part that moved — hours, not headcount', async () => {
  const { engine } = await setup()
  const r = await engine.call<any>('utilisation', { during: SPAN })
  const { root, leads } = engine.explain(r.callId, { member: { team: 'b' }, period: '2026-06', measure: 'utilisation' })
  assert.ok(root!.expectation.surprising)
  const parts = new Map(root!.parts.map((p) => [`${p.name}.${p.measure}`, p.expectation.surprising]))
  assert.deepEqual(Object.fromEntries(parts), { 'hours.hours': true, 'people.headcount': false })
  assert.deepEqual(leads.map((l) => `${l.name}.${l.measure}`), ['hours.hours'])
})

test('S7: memory is in the store\'s SQLite file, keyed by the question, and hypothetical answers are not remembered', async () => {
  const { engine, store } = await setup()
  await engine.call('utilisation', { during: SPAN })
  const count = () => Number((store.db.prepare('SELECT COUNT(*) AS n FROM observation').get() as any).n)
  const before = count()
  assert.ok(before > 0)
  await engine.call('utilisation', { during: SPAN }, { intervene: { people: { add: [{ row: { team: 'b' } }] } } })
  assert.equal(count(), before, 'nothing imagined became memory')
  await engine.call('utilisation', { during: SPAN })
  assert.equal(count(), before, 'the same periods answered again replace, not pile up')
  const other = engine.surprises((await engine.call<any>('hours', { by: ['team', 'month'], where: { team: 'a' }, during: SPAN })).callId)
  assert.deepEqual(other, [], 'a different question has its own series')
})

test('S8: a decision records its boundary, and a later review reopens it when the data crosses', async () => {
  const { engine, store } = await setup()
  const decided = await engine.call<any>('should hire', { team: 'b' }, { today: '2026-04-10' })
  assert.equal(decided.value.hire, true, 'Q1 2026: team b above 90%')
  const d = store.getCall(decided.callId)!.decisions[0]
  assert.equal(d.boundary!.op, '>')
  assert.ok(d.boundary!.margin > 0)
  const steady = await engine.review({ today: '2026-04-20' })
  assert.equal(steady.find((x) => (x.request as any).team === 'b')!.reopened, false, 'the same quarter: nothing to reopen')
  const reviewed = await engine.review({ today: '2026-10-05' })
  const b = reviewed.find((x) => (x.request as any).team === 'b')!
  assert.equal(b.reopened, true, 'Q3 2026: the hours fell, and the decision would now be not to hire')
  assert.equal(b.flipped[0].was.took, true)
  assert.equal(b.flipped[0].now.took, false)
  assert.ok(b.flipped[0].now.margin! < 0)
})

test('memory lets go of old periods into the series\' summary distribution', async () => {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-mem-')), 'memory.sqlite'))
  const rows = Array.from({ length: 130 }, (_, i) => ({ name: 'n', hash: 'h', callId: 'c', series: 's', member: '{}', grain: 'day', measure: 'm',
    period: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, value: i, at: 1 }))
  assert.equal(store.recordObservations(rows), true)
  const kept = store.series({ name: 'n', series: 's', member: '{}', measure: 'm', grain: 'day' })
  assert.equal(kept.length, 120)
  assert.equal(kept[0].value, 10, 'the ten oldest were let go')
  const s = store.summary({ name: 'n', series: 's', member: '{}', measure: 'm', grain: 'day' })!
  assert.deepEqual([s.n, s.mean, s.min, s.max, s.from], [10, 4.5, 0, 9, '2026-01-01'])
  assert.equal(store.recordObservations(Array.from({ length: 10_001 }, () => rows[0])), false, 'the store never takes more than one answer\'s worth')
  const big = [0, 1, 2].flatMap((m) => Array.from({ length: 5000 }, (_, i) => ({ ...rows[0], member: `{"k":${m}}`, period: String(i), value: (m + 1) * 10 })))
  const cut = withinLimit(big, 10_000)
  assert.deepEqual([cut.series, cut.keptSeries, cut.kept.length], [3, 2, 10_000])
  assert.deepEqual([...new Set(cut.kept.map((o) => o.member))], ['{"k":2}', '{"k":1}'], 'whole series, largest first')
})
