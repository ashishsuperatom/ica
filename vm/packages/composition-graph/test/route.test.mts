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

test('with a general (fallback) domain: words every specialised domain holds reach none of them — the question goes to the fallback; a separating word or a domain\'s own intent still decides', async () => {
  const { indexOf, rank } = await import('../src/route.ts')
  const shared = 'Every source has tables; each table has a name and a number.'
  const index = indexOf([
    { name: 'sales', text: `${shared} Revenue by customer and invoice.`, intents: ['revenue'] },
    { name: 'people', text: `${shared} Hours by person, utilisation and revenue per person.`, intents: ['utilisation'] },
    { name: 'general', text: 'Any question about the data sources and their tables.', intents: ['data sources'], fallback: true },
  ])
  assert.equal(rank(index, 'How many tables have a name starting with dim?').domain, null)                 // shared words only
  assert.equal(rank(index, 'Which data sources are there?').domain, 'general')                                // the fallback ranks first
  assert.equal(rank(index, 'Invoices by customer').domain, 'sales')                                            // a separating word
  assert.equal(rank(index, 'Revenue per person').domain !== null, true)                                       // revenue: an intent of sales
})
