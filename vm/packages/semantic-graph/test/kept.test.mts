// A MEASURE KEPT TO A CONDITION OF ITS OWN: added up only from the rows where its filters hold — a row that fails is
// absent, not zero — with the same filter forms a question uses, plus a comparison of another measure of the row with a
// number or a setting. Every aggregate compiled to SQL must give the oracle's answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, createGraph, evaluate, runSql, schemaProblems, Store, type Instance, type Question, type Schema } from '../src/index.js'
import { instance as I, schema as base } from './fixtures/shifts.js'
import { toSqlite } from './fixtures/sqlite.js'

function data(): Schema {
  const s: Schema = structuredClone(base)
  Object.assign(s.objects.Shift.measures!, {
    short: { unit: 'shifts', kind: 'flow', aggregate: 'count', where: [{ measure: 'worked', op: '<', value: 8 }] },
    shortHours: { unit: 'h', kind: 'flow', aggregate: 'sum', where: [{ measure: 'worked', op: '<', value: 8 }] },
    northRate: { unit: 'ratio', kind: 'value-per-unit', aggregate: 'weighted average', weight: 'worked', where: [{ attribute: 'site', in: ['north'] }] },
    seniorPeople: { unit: 'people', kind: 'flow', aggregate: 'count distinct', of: 'person', where: [{ condition: 'senior person' }] },
    alphaMax: { unit: 'h', kind: 'flow', aggregate: 'max', where: [{ to: 'Team', via: ['person', 'team'], in: ['t1'] }, { measure: 'worked', op: '!=', value: 12 }] },
    long: { unit: 'shifts', kind: 'flow', aggregate: 'count', where: [{ measure: 'worked', op: '>', setting: 'long shift' }] },
  })
  return s
}
// shortHours reads the worked column: the fixture gives every kept measure the row's value it is over.
const rows = (): Instance => ({ ...I, rows: { Shift: I.rows.Shift.map((r) => ({ ...r, measures: { ...r.measures, short: 1, shortHours: r.measures.worked, northRate: r.measures.rate, seniorPeople: 1, alphaMax: r.measures.worked, long: 1 } })) } })

async function both(s: Schema, q: Question, context: { today?: string; settings?: Record<string, unknown> } = {}) {
  const v = check(s, q, context)
  if (!v.ok) assert.fail(`${v.rule}: ${v.reason}`)
  const mem = evaluate(s, rows(), v.plan)
  const { query, sources } = toSqlite(s, rows())
  assert.deepEqual((await runSql(s, sources, v.plan, query)).rows, mem.rows, 'SQL and the oracle agree')
  return mem.rows
}

test('a count of rows under a threshold, by group, is the oracle\'s — and a failing row is absent, not zero', async () => {
  const s = data()
  assert.deepEqual(schemaProblems(s), [])
  // p1 has one short shift (6h); p2 has one (7h) — the row with nothing recorded meets no comparison.
  assert.deepEqual(await both(s, { measures: ['Shift.short', 'Shift.shortHours', 'Shift.shifts'], by: [{ to: 'Person' }] }), [['p1', 1, 6, 6], ['p2', 1, 7, 6]])
  // A group with no kept row: the sum is absent, the count is 0.
  assert.deepEqual(await both(s, { measures: ['Shift.short', 'Shift.shortHours'], by: [{ to: 'Person' }], where: [{ attribute: 'site', in: ['south'] }] }), [['p1', 0, null], ['p2', 0, null]])
  const v = check(s, { measures: ['Shift.short'] })
  assert.ok(v.ok)
  assert.deepEqual(v.plan.facts[0].kept, { short: [{ measure: 'worked', op: '<', value: 8 }] })
  assert.ok(v.plan.additive!.includes('Shift.short'), 'a conditional count is still a flow that adds up')
})

test('every aggregate keeps to its own condition alike: a weighted average, a distinct count, a max, an entity, an attribute, a condition', async () => {
  const s = data()
  // northRate: p1 north rows (6h@1.0, 9h@1.0, 9h@1.0) → 1.0; p2 north rows (8h@1, 8h@1, 7h@1) → 1.0; the 1.5 and 2.0 rows are south or excluded.
  assert.deepEqual(await both(s, { measures: ['Shift.northRate', 'Shift.rate'], by: [{ to: 'Person' }] }), [['p1', (6 + 13.5 + 9 + 9) / 33, (6 + 13.5 + 9 + 24 + 9 + 9) / 54], ['p2', 1, 1]])
  assert.deepEqual(await both(s, { measures: ['Shift.seniorPeople', 'Shift.people'] }), [[1, 2]])
  assert.deepEqual(await both(s, { measures: ['Shift.alphaMax'], by: [{ to: 'Team', via: ['person', 'team'] }] }), [['t1', 9], ['t2', null]])
})

test('a threshold named as a setting is resolved before the check, and changes the answer with the setting', async () => {
  const s = data()
  assert.deepEqual(await both(s, { measures: ['Shift.long'], by: [{ to: 'Person' }] }, { settings: { 'long shift': 8 } }), [['p1', 5], ['p2', 0]])
  assert.deepEqual(await both(s, { measures: ['Shift.long'], by: [{ to: 'Person' }] }, { settings: { 'long shift': 9 } }), [['p1', 1], ['p2', 0]])
  const v = check(s, { measures: ['Shift.long'] })
  assert.ok(!v.ok && v.rule === 'Q' && /the setting "long shift", which has no value here/.test(v.reason), JSON.stringify(v))
  const plan = check(s, { measures: ['Shift.long'] }, { settings: { 'long shift': 9 } })
  assert.ok(plan.ok)
  assert.doesNotMatch(JSON.stringify(plan.plan), /long shift/, 'the plan holds the value, never the setting\'s name')

  // End to end: the organisation's setting is read for whoever asks, and the answer says where the number came from.
  const { query, sources } = toSqlite(s, rows())
  const g = createGraph({ store: new Store(':memory:'), query, today: () => '2026-03-01' })
  g.defineSchema('roster', s, 'test'); await g.defineSources('roster', sources, 'test')
  g.defineSettings('roster', { 'long shift': 9 }, 'test')
  const a = await g.ask({ measures: ['Shift.long'], by: [{ to: 'Person' }] }, { model: 'roster' })
  assert.ok(a.ok, JSON.stringify(a))
  assert.deepEqual(a.result.rows, [['p1', 1], ['p2', 0]])
  assert.ok(a.result.notes.some((n) => /Kept to Shift.long: rows where worked > 9, from the setting "long shift"/.test(n)), a.result.notes.join('\n'))
  const b = await g.ask({ measures: ['Shift.long'] }, { model: 'roster', assume: { 'long shift': 8 } })
  assert.ok(b.ok && b.result.rows[0][0] === 5)
})

test('a measure\'s own condition is checked when the schema is: an unknown measure, a comparison with nothing, a filter on nothing', () => {
  const s = data()
  Object.assign(s.objects.Shift.measures!, {
    a: { unit: 'h', kind: 'flow', aggregate: 'sum', where: [{ measure: 'nothing', op: '<', value: 1 }] },
    b: { unit: 'h', kind: 'flow', aggregate: 'sum', where: [{ measure: 'worked', op: '<' }] },
    c: { unit: 'h', kind: 'flow', aggregate: 'sum', where: [{ attribute: 'colour', in: ['x'] }] },
    d: { unit: 'h', kind: 'flow', aggregate: 'sum', where: [{ condition: 'nobody' }] },
  })
  const p = schemaProblems(s)
  assert.ok(p.some((x) => x === 'Shift.a keeps to rows by nothing, which is not a measure of Shift'), p.join('\n'))
  assert.ok(p.some((x) => x === 'Shift.b: the comparison with worked names a number (value) or a setting'), p.join('\n'))
  assert.ok(p.some((x) => x === "Shift.c's own condition keeps to Shift.colour, which is not an attribute"), p.join('\n'))
  assert.ok(p.some((x) => x === `Shift.d's own condition uses "nobody", which is not a condition of the schema`), p.join('\n'))
  const v = check(s, { measures: ['Shift.a'] })
  assert.ok(!v.ok && v.rule === 'Q' && /nothing, which is not a measure of Shift/.test(v.reason))
})

test('the store records, validates, renames, exports and imports a measure\'s own condition and a row expression; the tool takes them', async () => {
  const { ModelStore } = await import('../src/modelstore.js')
  const { run } = await import('../src/cli.js')
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const ctx = { by: 'test' }
  const g = new ModelStore(':memory:')
  assert.ok(g.createModel('roster', ctx).ok)
  assert.deepEqual(g.import('roster', { schema: base }, ctx).refused, [])
  const ok = g.apply('roster', { op: 'add-measure', id: 'Shift.short', unit: 'shifts', kind: 'flow', aggregate: 'count', where: [{ measure: 'worked', op: '<', value: 8 }] }, ctx)
  assert.ok(ok.ok, JSON.stringify(ok))
  const bad = g.apply('roster', { op: 'add-measure', id: 'Shift.odd', unit: 'h', kind: 'flow', aggregate: 'sum', where: [{ measure: 'nothing', op: '<', value: 8 }] }, ctx)
  assert.ok(!bad.ok && /Shift.odd keeps to rows by nothing, which is not a measure of Shift/.test(bad.reason), JSON.stringify(bad))
  const row = g.apply('roster', { op: 'add-measure', id: 'Shift.shortfall', unit: 'h', kind: 'flow', aggregate: 'sum', expr: 'max(0, [Shift.target] - [Shift.worked])', at: 'row' }, ctx)
  assert.ok(row.ok, JSON.stringify(row))
  assert.ok(g.apply('roster', { op: 'set', id: 'Shift.short', property: 'where', value: [{ measure: 'worked', op: '<', setting: 'short shift' }] }, ctx).ok)
  const still = g.apply('roster', { op: 'remove', id: 'Shift.worked' }, ctx)
  assert.ok(!still.ok && /Shift.short keeps to rows by it/.test(still.reason) && /Shift.shortfall is worked out from it/.test(still.reason), JSON.stringify(still))
  assert.ok(g.apply('roster', { op: 'rename', id: 'Shift.worked', to: 'done' }, ctx).ok)
  const m = g.state('roster').schema.objects.Shift.measures!
  assert.deepEqual(m.short.where, [{ measure: 'done', op: '<', setting: 'short shift' }])
  assert.equal(m.shortfall.expr, 'max(0, [Shift.target] - [Shift.done])')
  const out = g.export('roster')
  assert.equal(out.schema.objects.Shift.measures!.shortfall.at, 'row')
  const h = new ModelStore(':memory:')
  assert.deepEqual(h.import('roster', out, ctx).refused, [])
  assert.deepEqual(h.state('roster').schema.objects.Shift.measures!.short, m.short)

  const dir = mkdtempSync(join(tmpdir(), 'sg-kept-'))
  const said: string[] = []
  const sg = (...args: string[]) => run([...args, '--db', join(dir, 'g.sqlite'), '--model', 'roster', '--by', 'tester'], (x) => said.push(x))
  assert.equal(await sg('create-model', 'roster'), 0)
  for (const cmd of [['add-calendar', 'Week', '--level', 'week'], ['add-fact', 'Shift'], ['add-arrow', 'Shift.week', 'Week'],
    ['add-measure', 'Shift.target', '--unit', 'h', '--kind', 'flow', '--aggregate', 'sum'], ['add-measure', 'Shift.worked', '--unit', 'h', '--kind', 'flow', '--aggregate', 'sum'],
    ['add-measure', 'Shift.short', '--unit', 'shifts', '--kind', 'flow', '--aggregate', 'count', '--where', '[{"measure":"worked","op":"<","value":8}]'],
    ['add-measure', 'Shift.shortfall', '--unit', 'h', '--kind', 'flow', '--aggregate', 'sum', '--expr', 'max(0, [Shift.target] - [Shift.worked])', '--at', 'row'],
    ['set', 'Shift.short', 'where', '[{"measure":"worked","op":"<","setting":"short shift"}]'],
  ]) assert.equal(await sg(...cmd), 0, `${cmd.join(' ')}: ${said.at(-1)}`)
  said.length = 0
  assert.equal(await sg('set', 'Shift.target', 'at', 'row'), 2)
  assert.match(said.at(-1)!, /Shift.target is worked out per row, so it needs an expression/)
  said.length = 0
  await sg('show', 'Shift.short', '--json')
  assert.deepEqual(JSON.parse(said.at(-1)!).where, [{ measure: 'worked', op: '<', setting: 'short shift' }])
})
