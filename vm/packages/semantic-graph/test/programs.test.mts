// An answer program on the graph: its data only from ctx.ask, its steps recorded, its answer checked — views against
// their datasets, every number in the narration a cited cell.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraph, deliver, runProgram, Store } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

const PROGRAM = `
export const meta = { name: 'hours by branch', description: 'Hours by the project branch, the largest first, with its share.', params: { from: 'first day', through: 'last day' }, logic: 'hours by branch → share of the total → the largest' }
export default async (ctx, p) => {
  const byBranch = await ctx.ask({ measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], span: { from: p.from, through: p.through } }, 'hours by branch')
  const total = ctx.transform('total hours', () => byBranch.rows.reduce((n, r) => n + r.hours, 0))
  const ranked = ctx.transform('rank and share', () => ({ columns: [...byBranch.columns, { name: 'share', role: 'measure', unit: 'ratio' }],
    rows: [...byBranch.rows].sort((a, b) => b.hours - a.hours).map((r) => ({ ...r, share: r.hours / total })) }))
  await ctx.verify('shares add to the whole', () => Math.abs(ranked.rows.reduce((n, r) => n + r.share, 0) - 1) < 1e-9)
  ctx.decideAt('the largest branch dominates', ranked.rows[0].share, '>', 0.5, 'more than half the hours')
  return {
    data: { ranked },
    views: [{ id: 'table', component: 'table', data: 'ranked', title: 'Hours by branch', encode: { columns: ['Branch', 'hours', 'share'] } }],
    narration: [{ text: '{top} worked {hours}, {share} of all hours.', cites: { top: { data: 'ranked', row: 0, column: 'Branch' }, hours: { data: 'ranked', row: 0, column: 'hours' }, share: { data: 'ranked', row: 0, column: 'share' } } }],
    nextSteps: [{ label: 'By state instead', why: 'one level up' }],
  }
}`

async function setup() {
  const { query, sources } = toSqlite(s, I)
  const g = createGraph({ store: new Store(':memory:'), query, today: () => '2026-10-10' })
  g.defineSchema('b', s, 't'); await g.defineSources('b', sources, 't')
  return g
}

test('a program asks the graph, transforms, checks, and says what it found in cited numbers', async () => {
  const g = await setup()
  const r = await runProgram(g, PROGRAM, { from: '2026-09-01', through: '2026-10-31' }, { model: 'b', today: '2026-10-10' })
  assert.equal(r.error, undefined)
  assert.equal(r.answer!.narration[0].text, 'Sydney worked 21 h, 72.4% of all hours.')
  assert.equal(r.answer!.period, '1 Sep 2026 – 31 Oct 2026', 'the time an answer holds for comes from the questions it asked')
  assert.deepEqual(r.steps.map((x) => x.kind), ['ask', 'transform', 'transform', 'verify', 'decide'])
  const run = g.store.getCall(r.callId)!
  assert.deepEqual(run.question, { program: 'hours by branch', params: { from: '2026-09-01', through: '2026-10-31' } })
  assert.equal(g.store.children(r.callId).length, 1, 'the question it asked is recorded under the run')
})

test('an answer is refused when a number is typed, a cell is not there, or the graph refuses the question', async () => {
  const g = await setup()
  const bad = async (edit: (p: string) => string, why: RegExp) => { const r = await runProgram(g, edit(PROGRAM), { from: '2026-09-01', through: '2026-10-31' }, { model: 'b' }); assert.match(r.error ?? '', why); assert.equal(g.store.getCall(r.callId)!.refusal!.rule, 'program') }
  await bad((p) => p.replace("'{top} worked {hours}", "'{top} worked 21 hours and {hours}"), /types the number 21/)
  await bad((p) => p.replace("column: 'share' } } }]", "column: 'revenue' } } }]"), /cites the column "revenue"/)
  await bad((p) => p.replace("via: ['project', 'branch']", "via: ['branch']"), /was refused: Sale has no link "branch"/)
  await bad((p) => p.replace("encode: { columns: ['Branch', 'hours', 'share'] }", "encode: { columns: ['Region'] }"), /puts "Region"/)
})

test('a year followed by a comma is a year, not a typed number', () => {
  const t = { columns: [{ name: 'hours', role: 'measure' as const, unit: 'h' }], rows: [{ hours: 5 }] }
  const d = deliver({ data: { t }, views: [], narration: [{ text: 'In October 2026, {h} were worked.', cites: { h: { data: 't', row: 0, column: 'hours' } } }], nextSteps: [] }, [])
  assert.equal(d.narration[0].text, 'In October 2026, 5 h were worked.')
})

test('an answer the data cannot give says what is missing, and narration is up to five points', () => {
  const t = { columns: [{ name: 'hours', role: 'measure' as const, unit: 'h' }], rows: [{ hours: 5 }] }
  assert.throws(() => deliver({ status: 'unknowable', data: {}, views: [], narration: [], nextSteps: [] }, []), /says what is missing/)
  assert.equal(deliver({ status: 'unknowable', missing: 'no dated comments are recorded', data: {}, views: [], narration: [], nextSteps: [] }, []).missing, 'no dated comments are recorded')
  const point = { text: '{h} were worked.', cites: { h: { data: 't', row: 0, column: 'hours' } } }
  assert.throws(() => deliver({ data: { t }, views: [], narration: Array(6).fill(point), nextSteps: [] }, []), /up to five/)
})
