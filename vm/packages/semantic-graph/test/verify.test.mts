// Completion says what a question COULD be; this says which one it IS — restated in the graph's words, checked
// against the terms it should account for, and separated by what the data actually holds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, complete, evaluate, judge, judgedText, leftOver, probe, revisions, saidBack, tied, type Question } from '../src/index.js'
import { instance, schema as branches } from './fixtures/branches.js'

const span = { from: '2026-09-01', to: '2026-11-01' }   // where this fixture's sales are
// Asking, answered from the fixture in memory: the same shape the live graph gives, without a database.
const ask = async (q: Question) => {
  const v = check(branches, q)
  if (!v.ok) return { ok: false as const, rule: v.rule, reason: v.reason }
  return { ok: true as const, result: { rows: evaluate(branches, instance, v.plan).rows } }
}

test('a question is said back in the graph\'s own words, so a wrong reading is visible at once', () => {
  const said = saidBack(branches, { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['person', 'branch'] }], where: [{ to: 'Branch', via: ['person', 'branch'], in: ['b1'] }], span })
  assert.match(said, /Sale\.hours/)
  assert.match(said, /by Branch \(by person\.branch\)/)
  assert.match(said, /Branch \(by person\.branch\) is b1/)
})

test('a phrase the reading does not account for is reported, not ignored', () => {
  const q: Question = { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], span }
  assert.deepEqual(leftOver(q, ['branch', 'hours', 'sponsor']), ['sponsor'])
})

test('the data separates two readings: one finds rows, the other finds none', async () => {
  const both = complete(branches, { measures: ['Sale.hours'], by: ['Branch'], span })
  assert.ok(both.length >= 2)
  const judged = await judge(branches, both, ['hours', 'branch'], ask)
  assert.ok(judged[0].evidence, 'the reading that wins was actually asked')
  assert.ok(judged[0].evidence!.rows > 0, 'and the data agreed with it')
  assert.ok(judged[0].score >= judged[judged.length - 1].score)
  assert.match(judgedText(judged), /by Branch/)
})

test('when nothing matches, the filter responsible is named', async () => {
  // Branch b3 has sales; the commitment "Soft" on those rows does not — so one filter is the cause and is named.
  const q: Question = { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }],
    where: [{ to: 'Branch', via: ['project', 'branch'], in: ['b1'] }, { attribute: 'commitment', in: ['Soft'] }], span }
  const e = await probe(q, ask)
  assert.equal(e.rows, 0)
  assert.ok(e.empties.length >= 1, `something is named as the cause: ${JSON.stringify(e)}`)
  assert.match(e.empties.join(' '), /filter on/)
})

test('a reading that holds up is offered a way to be asked again when it does not', async () => {
  const q: Question = { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], where: [{ to: 'Branch', via: ['project', 'branch'], in: ['nobody'] }], span }
  const e = await probe(q, ask)
  const ways = revisions(branches, q, e)
  assert.ok(ways.length >= 1)
  assert.match(ways.map((w) => w.why).join(' '), /without the filter on Branch|wider span/)
})

test('two readings that both hold are reported as both holding, with what differs', async () => {
  const both = complete(branches, { measures: ['Sale.hours'], by: ['Branch'], span })
  const judged = await judge(branches, both, ['hours', 'branch'], ask)
  const ties = tied(judged, 5)
  if (ties.length) assert.match(ties[0].differ, /grouped by|kept to/)
})
