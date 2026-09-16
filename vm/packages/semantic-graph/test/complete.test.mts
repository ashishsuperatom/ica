// Words become things first (eagerly), and only then does the graph finish the question — every way it could be
// finished, ranked, with what was uncertain said out loud. These are deterministic properties of the algebra;
// whether an agent asks better questions is decided by running real ones, not here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { complete, completions, find, fragmentOf, type Fragment } from '../src/index.js'
import { schema as branches } from './fixtures/branches.js'

const span = { from: '2026-01-01', to: '2026-04-01' }

test('a fragment with no paths is finished by the graph', () => {
  const got = complete(branches, { measures: ['Sale.hours'], by: ['Month'], span })
  assert.ok(got.length >= 1)
  assert.deepEqual(got[0].question.by, [{ to: 'Month', via: ['day', 'month'] }])
  assert.match(got[0].why.join('\n'), /Month by day\.month/)
})

test('several routes are several completions, ranked, and the choice is named as uncertain', () => {
  // Sale reaches Branch by its person and by its project: two honest readings of "by branch".
  const got = complete(branches, { measures: ['Sale.hours'], by: ['Branch'], span })
  assert.ok(got.length >= 2, `expected more than one route, got ${got.length}`)
  const vias = got.map((g) => (g.question.by![0] as any).via.join('.'))
  assert.ok(vias.includes('person.branch') && vias.includes('project.branch'), vias.join(' | '))
  assert.match(got[0].uncertain.join('\n'), /Branch is reached \d+ ways/)
})

test('a record whose meaning is not certain forks the question, once per meaning', () => {
  const f: Fragment = { measures: ['Sale.hours'], values: [{ text: 'Sydney', meanings: [{ object: 'Branch', key: 'b1', label: 'Sydney' }, { object: 'State', key: 'NSW', label: 'New South Wales' }] }], span }
  const got = complete(branches, f)
  const kept = got.map((g) => (g.question.where![0] as any).to)
  assert.ok(kept.includes('Branch') && kept.includes('State'), kept.join(' | '))
  assert.match(got[0].uncertain.join('\n'), /"Sydney" could be a/)
})

test('a fragment the graph cannot finish comes back empty, rather than nearly right', () => {
  assert.deepEqual(complete(branches, { measures: ['Sale.hours'], by: ['BudgetVersion'], span }), [])
})

test('a measure named without its fact is found among the facts that have it', () => {
  const got = complete(branches, { measures: ['value'], by: ['Project'], span, currency: 'AUD' })
  assert.ok(got.length >= 1)
  assert.equal(got[0].question.measures[0], 'Contract.value')
})

test('when nothing completes, the reason is kept — usually one thing the asker can give', () => {
  const { done, refused } = completions(branches, { measures: ['value'], by: ['Project'], span })
  assert.equal(done.length, 0)
  assert.ok(refused.length >= 1)
  assert.match(refused[0].reason, /currency/)
})

test('what resolve-terms found becomes a fragment, with nothing chosen yet', () => {
  const terms = [
    { phrase: 'hours', means: find(branches, 'hours') },
    { phrase: 'branch', means: find(branches, 'branch') },
    { phrase: 'sydney', means: find(branches, 'Sydney') },
  ]
  const f = fragmentOf(terms, span)
  assert.ok(f.measures.includes('Sale.hours'))
  assert.ok(f.by?.includes('Branch'))
  assert.equal(f.values?.[0].text, 'sydney')
  const got = complete(branches, f)
  assert.ok(got.length >= 1)
  assert.match(got[0].why.join('\n'), /"sydney" is Sydney, a Branch/)
})
