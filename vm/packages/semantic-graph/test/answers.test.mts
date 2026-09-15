// An answer a person reads: datasets that are recorded answers, views checked against their columns, narration whose
// every number is read from a cited cell, next steps that are moves the algebra allows — and the trace of how it was
// reached, read from memory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraph, Store, type AnswerDoc } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

const B = { to: 'Branch', via: ['project', 'branch'] }

async function setup() {
  const { query, sources } = toSqlite(s, I)
  const g = createGraph({ store: new Store(':memory:'), query, today: () => '2026-10-10' })
  g.defineSchema('b', s, 't'); await g.defineSources('b', sources, 't')
  const hours = await g.ask({ measures: ['Sale.hours', 'Sale.amount'], by: [B, { to: 'Month' }], span: { from: '2026-09-01', to: '2026-11-01' }, currency: 'AUD', share: { outputs: ['Sale.hours'], within: ['Month'] } }, { model: 'b' })
  assert.ok(hours.ok)
  return { g, hours }
}

test('narration is written from cited cells, views are checked, next steps are moves', async () => {
  const { g, hours } = await setup()
  const doc: AnswerDoc = {
    data: { hours: { callId: hours.callId } },
    views: [{ id: 'bars', component: 'bar', data: 'hours', encode: { x: 'Month', y: 'Sale.hours', series: 'Branch by project.branch' } }],
    narration: [{ text: 'In September Sydney worked {sep}, {share} of all hours, and billed {billed}.', cites: {
      sep: { data: 'hours', group: ['b1', '2026-09'], column: 'Sale.hours' },
      share: { data: 'hours', group: ['b1', '2026-09'], column: 'Sale.hours share within Month' },
      billed: { data: 'hours', group: ['b1', '2026-09'], column: 'Sale.amount' } } }],
    nextSteps: [{ label: 'By state', data: 'hours', move: { move: 'drill up', target: 0, along: 'state' } }],
  }
  const out = g.render('b', doc)
  assert.equal(out.narration[0].text, 'In September Sydney worked 15 h, 65.2% of all hours, and billed 1,500.')
  assert.equal(out.nextSteps[0].question.by![0] && (out.nextSteps[0].question.by![0] as any).to, 'State')

  const bad = (change: (d: AnswerDoc) => void, why: RegExp) => { const d = structuredClone(doc); change(d); assert.throws(() => g.render('b', d), why) }
  bad((d) => { d.narration[0].text = 'Sydney worked 15 hours.'; d.narration[0].cites = {} }, /types the number 15/)
  bad((d) => { d.narration[0].cites!.sep.group = ['b2', '2026-09'] }, /not in "hours"/)
  bad((d) => { d.narration[0].cites!.sep.column = 'Sale.rate' }, /does not have/)
  bad((d) => { d.views[0].encode.y = 'revenue' }, /no such column/)
  bad((d) => { d.nextSteps[0].move = { move: 'add measure', measure: 'Budget.budget' } }, /would be refused/)
  bad((d) => { d.narration[0].text = 'Worked {nothing}.' }, /cites nothing/)
  const refused = await g.ask({ measures: ['Sale.hours'], by: [{ to: 'Branch' }] }, { model: 'b' })
  bad((d) => { d.data.hours = { callId: refused.callId } }, /was refused/)
})

test('the trace of an answer is read from memory, with the calls made for it', async () => {
  const { g } = await setup()
  const c = await g.counterfactual({ measures: ['Sale.hours'], by: [B], currency: 'AUD' }, [{ on: 'Sale', match: { project: 'j1' }, scale: { hours: 2 } }], { model: 'b', who: { id: 'ana' }, assume: { 'surprise threshold': 4 } })
  assert.ok(c.ok)
  const text = g.trace(c.actual.callId, { sql: true })
  assert.match(text, /answered in \d+ ms/)
  assert.match(text, /asked by \{"id":"ana"\}/)
  assert.match(text, /setting surprise threshold = 4 \(from caller\)/)
  assert.match(text, /read Sale from DB: 2 rows/)
  assert.match(text, /GROUP BY/)
  assert.match(text, /\n  answered in \d+ ms[^]*hypothetical:/, 'the intervened side is traced under the actual one')
})
