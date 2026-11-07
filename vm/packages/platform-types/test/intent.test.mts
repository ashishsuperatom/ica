import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalOf, termsOf, textSearch, currentGlobal, shortOf, categoryOf, type IntentVariant } from '../src/index.ts'

test('a question\'s values become placeholders; the same question with other values has the same canonical form', () => {
  const a = canonicalOf('How many trips were completed in September 2026?')
  const b = canonicalOf('how many trips were completed in March 2025')
  assert.equal(a.canonical, 'how many trips were completed in {period}')
  assert.equal(a.canonical, b.canonical)
  assert.deepEqual(a.params, [{ kind: 'period', value: 'september 2026' }])
  assert.equal(canonicalOf('Show bids for RFQ-01405 above 2,500 MT').canonical, 'show bids for {code} above {number} mt')
  assert.equal(canonicalOf('spend last month vs 2025-10-01').canonical, 'spend {period} vs {date}')
  assert.equal(canonicalOf('Q3 FY26 revenue').canonical, '{period} revenue')
})

test('the project\'s names are found first, the longest first', () => {
  const known = [{ kind: 'supplier', value: 'Acme' }, { kind: 'supplier', value: 'Acme Steel Works' }]
  const c = canonicalOf('Open orders for Acme Steel Works in 2026', known)
  assert.equal(c.canonical, 'open orders for {supplier} in {year}')
  assert.deepEqual(c.params[0], { kind: 'supplier', value: 'acme steel works' })
})

test('text search ranks the nodes sharing the rarest words first, and leaves out the ones sharing none', () => {
  const nodes = [
    { id: 'a', terms: termsOf('how many trips were completed in {period}') },
    { id: 'b', terms: termsOf('open orders by supplier') },
    { id: 'c', terms: termsOf('trips by branch in {period}') },
  ]
  const r = textSearch(termsOf('completed trips {period}'), nodes)
  assert.deepEqual(r.map((x) => x.node.id), ['a', 'c'])
  assert.equal(textSearch(termsOf('the weather'), nodes).length, 0)
})

test('the project\'s view: the approved variant; else the most represented, verified only when everyone agrees', () => {
  const v = (owner: string, process: string, version = 1): IntentVariant => ({ owner, version, by: owner, at: `2026-11-0${version}T00:00:00Z`, why: '', concepts: ['x'], process, show: '', paths: [] })
  const all = [v('user:a', 'sum net'), v('user:b', 'sum net'), v('user:c', 'sum gross')]
  assert.equal(currentGlobal(all, null).variant?.process, 'sum net')
  assert.equal(currentGlobal(all, null).verified, false)
  assert.equal(currentGlobal(all, { owner: 'user:c', version: 1 }).variant?.process, 'sum gross')
  assert.equal(currentGlobal(all, { owner: 'user:c', version: 1 }).verified, true)
  assert.equal(currentGlobal([v('user:a', 'x'), v('user:b', 'x')], null).verified, true)
})

test('an intent\'s short form is five words or fewer; its category lowercase words joined by hyphens, a namespace before /', () => {
  assert.equal(shortOf('  stock value   by plant '), 'stock value by plant')
  assert.equal(shortOf('which materials hold the most stock value'), null)
  assert.equal(categoryOf('Stock Value'), 'stock-value')
  assert.equal(categoryOf('inventory / stock value'), 'inventory/stock-value')
  assert.equal(categoryOf('a/b/c/d'), null)
  assert.equal(categoryOf('much too many words here'), null)
})

test('what a learner writes as experience is checked for its shape, never its content', async () => {
  const { checkExperienceWrite } = await import('../src/index.ts')
  assert.equal(checkExperienceWrite({ case: { session: 's', range: {}, computation: '', signals: { a: 1 }, outcome: {}, scenario: null } }), null)
  assert.match(checkExperienceWrite({ case: { session: 's' } })!, /signals/)
  assert.match(checkExperienceWrite({ signals: [{ name: 'Bad Name', purpose: 'x', how: 'x', kind: 'number' }] })!, /lowercase/)
  assert.match(checkExperienceWrite({ case: { session: 's', signals: {}, outcome: 'x'.repeat(20_000) } })!, /not its data/)
})
