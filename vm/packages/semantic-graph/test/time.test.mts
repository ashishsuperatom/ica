// Time the way people ask it and the way organisations cut it: weeks, fiscal and listed calendars (in memory and in
// SQL alike), comparison by whole periods, relative spans against the asker's today, moments moved into the asker's
// days across a daylight-saving change, and replaying a recorded answer as of the day it was given.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, createGraph, dayIn, evaluate, keyOf, nests, periodOf, resolveSpan, runSql, schemaProblems, shiftPeriods, Store, type Question, type Schema } from '../src/index.js'
import { instance as I, schema as base } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

const FY = { fiscal: { period: 'quarter' as const, startMonth: 7 } }
const RETAIL = { periods: [
  { label: 'R2026-07', from: '2026-06-28', to: '2026-08-02' }, { label: 'R2026-08', from: '2026-08-02', to: '2026-08-30' },
  { label: 'R2026-09', from: '2026-08-30', to: '2026-10-04' }, { label: 'R2026-10', from: '2026-10-04', to: '2026-11-01' },
] }

test('calendar keys and periods, built in, fiscal and listed', () => {
  assert.equal(keyOf({ level: 'week' }, '2026-09-17'), '2026-09-14')
  assert.equal(keyOf(FY, '2026-07-01'), 'FY2027-Q1')
  assert.equal(keyOf(FY, '2026-06-30'), 'FY2026-Q4')
  assert.deepEqual(periodOf(FY, 'FY2027-Q2'), { from: '2026-10-01', to: '2027-01-01' })
  assert.equal(keyOf({ fiscal: { period: 'year', startMonth: 1 } }, '2026-03-01'), 'FY2026')
  assert.equal(keyOf(RETAIL, '2026-09-02'), 'R2026-09')
  assert.equal(shiftPeriods(RETAIL, 'R2026-10', -2), 'R2026-08')
  assert.ok(nests({ level: 'month' }, FY) && !nests({ level: 'week' }, { level: 'month' }))
})

function schema(): Schema {
  const s: Schema = structuredClone(base)
  s.objects.Day.arrows = { month: 'Month', week: 'Week', fq: 'FiscalQuarter', retail: 'RetailMonth' }
  s.objects.Month.arrows = { quarter: 'Quarter', fq: 'FiscalQuarter' }
  s.objects.Week = { kind: 'calendar', level: 'week' }
  s.objects.FiscalQuarter = { kind: 'calendar', ...FY }
  s.objects.RetailMonth = { kind: 'calendar', ...RETAIL }
  return s
}

test('a week does not roll up into a month', () => {
  const s = schema()
  s.objects.Week.arrows = { month: 'Month' }
  assert.ok(schemaProblems(s).some((p) => /not every Week lies inside one Month/.test(p)))
  assert.deepEqual(schemaProblems(schema()), [])
})

test('weeks, fiscal quarters and retail months: the same in memory and in SQL', async () => {
  const s = schema()
  const { query, sources } = toSqlite(s, I)
  for (const q of [
    { measures: ['Sale.hours'], by: [{ to: 'Week' }] },
    { measures: ['Sale.hours'], by: [{ to: 'FiscalQuarter' }] },
    { measures: ['Sale.hours'], by: [{ to: 'RetailMonth' }] },
    { measures: ['Budget.budget'], by: [{ to: 'FiscalQuarter' }], where: [{ to: 'BudgetVersion', in: ['base'] }], currency: 'AUD' },
    { measures: ['Sale.hours'], by: [{ to: 'RetailMonth' }], span: { from: '2026-10-04', to: '2026-11-01' }, compare: { back: { periods: 1 } } },
  ] as Question[]) {
    const v = check(s, q)
    if (!v.ok) assert.fail(`${v.rule}: ${v.reason}`)
    assert.deepEqual((await runSql(s, sources, v.plan, query)).rows, evaluate(s, I, v.plan).rows, JSON.stringify(q))
  }
  const v = check(s, { measures: ['Sale.hours'], by: [{ to: 'RetailMonth' }] })
  assert.ok(v.ok)
  assert.deepEqual(evaluate(s, I, v.plan).rows, [['R2026-09', 23], ['R2026-10', 6]])
  const wk = check(s, { measures: ['Sale.hours'], by: [{ to: 'Week' }] })
  assert.ok(wk.ok)
  assert.deepEqual(evaluate(s, I, wk.plan).rows, [['2026-09-07', 18], ['2026-09-14', 5], ['2026-10-05', 6]])
})

test('comparison moves back by whole periods of the calendar grouped by', () => {
  const s = schema()
  assert.equal(check(s, { measures: ['Sale.hours'], by: [{ to: 'Week' }], span: { from: '2026-09-14', to: '2026-09-21' }, compare: { back: { days: 7 } } }).ok, true)
  const bad = check(s, { measures: ['Sale.hours'], by: [{ to: 'Week' }], span: { from: '2026-09-14', to: '2026-09-21' }, compare: { back: { days: 3 } } })
  assert.ok(!bad.ok && bad.rule === 'D6')
  const fq = check(s, { measures: ['Sale.hours'], by: [{ to: 'FiscalQuarter' }], span: { from: '2026-10-01', to: '2027-01-01' }, compare: { back: { years: 1 } } })
  assert.ok(fq.ok)
})

test('relative spans resolve against today and the schema\'s own calendars', () => {
  const s = schema()
  assert.deepEqual(resolveSpan(s, { this: 'FiscalQuarter' }, '2026-09-15').span, { from: '2026-07-01', to: '2026-10-01' })
  assert.deepEqual(resolveSpan(s, { this: 'Month', toDate: true }, '2026-09-15').span, { from: '2026-09-01', to: '2026-09-16' })
  assert.deepEqual(resolveSpan(s, { previous: 'Month', count: 3 }, '2026-09-15').span, { from: '2026-06-01', to: '2026-09-01' })
  assert.deepEqual(resolveSpan(s, { last: 30, unit: 'Day' }, '2026-09-15').span, { from: '2026-08-17', to: '2026-09-16' })
  assert.match(resolveSpan(s, { previous: 'Quarter' }, '2026-09-15').said!, /2026-04-01 to 2026-06-30/)
  assert.throws(() => resolveSpan(s, { this: 'Branch' }, '2026-09-15'), /not a calendar/)
})

test('today is the day where the asker is, and the resolved dates are said with the answer', async () => {
  const s = schema()
  const { query, sources } = toSqlite(s, I)
  // 13:00 UTC on 14 September is already 15 September in Auckland.
  const g = createGraph({ store: new Store(':memory:'), query, now: () => new Date('2026-09-14T13:00:00Z') })
  g.defineSchema('b', s, 't'); await g.defineSources('b', sources, 't')
  assert.equal(dayIn('Pacific/Auckland', new Date('2026-09-14T13:00:00Z')), '2026-09-15')
  const q = { measures: ['Sale.hours'], span: { this: 'Week', toDate: true } }
  const nz = await g.ask(q, { model: 'b', who: { timezone: 'Pacific/Auckland' } })
  const utc = await g.ask(q, { model: 'b' })
  assert.ok(nz.ok && utc.ok)
  assert.equal(g.store.getCall(nz.callId)!.today, '2026-09-15')
  assert.ok(nz.caveats.some((c) => /this Week to date is 2026-09-14 to 2026-09-15/.test(c)))
  assert.ok(utc.caveats.some((c) => /today is taken as 2026-09-14 in UTC/.test(c)))
  assert.deepEqual(g.store.getCall(nz.callId)!.question, q, 'the question is kept as it was asked')
  const bad = await g.ask(q, { model: 'b', who: { timezone: 'Mars/Olympus' } })
  assert.ok(!bad.ok && /not a time zone/.test(bad.reason))
})

test('moments are placed in the asker\'s days by the offset in force at each moment, across a daylight-saving change', async () => {
  const s: Schema = { name: 'logins', objects: { Day: { kind: 'calendar', level: 'day' }, Login: { kind: 'fact', arrows: { day: 'Day' }, measures: { n: { unit: 'logins', kind: 'flow', aggregate: 'count' } } } } }
  // Written in UTC. Sydney moves from +10 to +11 at 02:00 local on 4 October 2026 (16:00 UTC on 3 October).
  const moments = ['2026-10-03 13:30:00', '2026-10-03 14:30:00', '2026-10-03 15:30:00', '2026-10-03 16:30:00', '2026-10-04 12:30:00', '2026-10-04 13:30:00']
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE login (at TEXT, n INTEGER)')
  for (const m of moments) db.prepare('INSERT INTO login VALUES (?, 1)').run(m)
  const query = async (_s: string, sql: string, p: any) => db.prepare(sql).all(p) as any[]
  const sources = { facts: { Login: { source: 'DB', sql: 'SELECT * FROM login', arrows: {}, time: 'at', timeZone: 'UTC', measures: { n: 'n' } } }, entities: {} }
  const v = check(s, { measures: ['Login.n'], by: [{ to: 'Day' }], span: { from: '2026-10-04', to: '2026-10-06' } })
  assert.ok(v.ok)
  // In Sydney: 13:30 UTC is 23:30 on the 3rd (+10); 14:30 is 00:30 on the 4th; after the change 12:30 UTC on the 4th is 23:30 (+11), 13:30 is 00:30 on the 5th.
  assert.deepEqual((await runSql(s, sources, v.plan, query, undefined, { zone: 'Australia/Sydney' })).rows, [['2026-10-04', 4], ['2026-10-05', 1]])
  assert.deepEqual((await runSql(s, sources, v.plan, query, undefined, { zone: 'UTC' })).rows, [['2026-10-04', 2]])
})

test('a recorded answer is replayed on the definitions and the day it was given, even after the model changed', async () => {
  const s = schema()
  const { query, sources } = toSqlite(s, I)
  const g = createGraph({ store: new Store(':memory:'), query, now: () => new Date('2026-10-10T00:00:00Z') })
  g.defineSchema('b', s, 't'); await g.defineSources('b', sources, 't')
  const first = await g.ask({ measures: ['Sale.hours'], by: [{ to: 'Month' }], span: { previous: 'Month', count: 2 } }, { model: 'b', assume: { 'surprise threshold': 4 } })
  assert.ok(first.ok)
  const changed = structuredClone(s); changed.objects.Branch.names = { Sydney: 'b1', Melbourne: 'b2' }
  g.defineSchema('b', changed, 't')
  const later = createGraph({ store: g.store, query, now: () => new Date('2026-12-01T00:00:00Z') })
  const r = await later.replay(first.callId, { model: 'b' })
  assert.ok(r.same && r.answer.ok)
  const rc = g.store.getCall(r.answer.callId)!
  assert.equal(rc.today, g.store.getCall(first.callId)!.today)
  assert.equal(rc.schema, g.store.getCall(first.callId)!.schema)
  assert.deepEqual(rc.assumptions!.find((x) => x.name === 'surprise threshold'), { name: 'surprise threshold', value: 4, from: 'caller' })
})
