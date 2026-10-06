import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexOf, rank, terms } from '../src/node.ts'

const index = indexOf([
  { name: 'utilisation', text: 'utilised hours per person week, red week below the threshold, target hours, project allocation', intents: ['utilisation', 'under the threshold', 'billable hours', 'timesheet'] },
  { name: 'health', text: 'project RAG red amber green, budget consumed, remaining budget, go live, senior supplier, project', intents: ['project health', 'budget used', 'over budget', 'red projects'] },
])

test('a term both domains hold weighs less than one only a domain holds', () => {
  const r = rank(index, 'which project is red')
  assert.equal(r.domain, 'health')
  assert.ok(r.ranked[0].terms.includes('red project') || r.ranked[0].terms.includes('red'))
})

test('intents decide: budget questions go to health, threshold questions to utilisation', () => {
  assert.equal(rank(index, 'Show me all the projects for which we have used more than half of the budget').domain, 'health')
  assert.equal(rank(index, 'Who was under the threshold in both of the last two weeks?').domain, 'utilisation')
  assert.equal(rank(index, 'Which people have not submitted a timesheet?').domain, 'utilisation')
})

test('a question with no known term routes nowhere, and says so', () => {
  const r = rank(index, 'what is the weather')
  assert.equal(r.domain, null)
})

test('the same question always routes the same way, and says which terms decided', () => {
  const a = rank(index, 'projects over budget by pillar'), b = rank(index, 'projects over budget by pillar')
  assert.deepEqual(a, b)
  assert.ok(a.ranked[0].terms.length > 0)
  assert.ok(terms('red weeks').includes('red week'))
})
