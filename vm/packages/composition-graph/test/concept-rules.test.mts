// The rules for writing concepts (src/guide.ts): a concept in sections composes by its sections, and what can be checked
// without reading for meaning is — instances outside examples, full queries, a thing said twice, a domain with no
// entity map, a concept composed without what it builds on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore, importDomains, verifyGraph, compose, governance } from '../src/node.ts'

const by = { by: 'test' }
const read = () => ''
const freeStock = { name: 'free-stock-is-stock-not-reserved', title: 'Free stock', form: 'sections' as const, sections: [
  { name: 'definitions', items: ['free stock = current stock − reserved stock, per material and plant'] },
] }
const contractStock = { name: 'contract-materials-and-their-stock', title: "A contract's materials and their stock", form: 'sections' as const,
  uses: ['free-stock-is-stock-not-reserved'], sections: [
    { name: 'entity map', text: 'contract ──1:n── contract_item ──n:1── material ──1:n── inventory' },
    { name: 'calculation', text: 'contract_item(contract) → material → inventory\ngroup by material, plant: free stock, reorder point' },
    { name: 'method', items: ['resolve the supplier to its ids', 'take its contracts in force, then their materials'] },
    { name: 'examples', items: ['CON-0036 covers 15 materials, ₹40.9 lakh bought'] },
  ] }
const domain = (concepts: any[]) => [{ name: 'contracts', description: 'contracts', intents: ['contract'], capabilities: [], concepts, files: [] }]
const warns = (s: any, check: string) => verifyGraph(s).filter((f) => f.check === check)

test('a concept in sections composes each section; an entity map and a calculation as code; a method numbered', () => {
  const s = openStore(':memory:')
  importDomains(s, domain([freeStock, contractStock]), read, by)
  const t = compose(s, 'contracts').text
  assert.match(t, /Builds on: free-stock-is-stock-not-reserved\./)
  assert.match(t, /## Entity map\n```\ncontract ──1:n──/)
  assert.match(t, /## Method\n1\. resolve the supplier/)
  assert.deepEqual(governance.checkBody('concept', contractStock), [])
  assert.ok(governance.checkBody('concept', { title: 'x', form: 'sections', sections: [{ name: 'rules' }] }).length)
})

test('a well-written domain passes the concept rules; an instance in its examples is allowed', () => {
  const s = openStore(':memory:')
  importDomains(s, domain([freeStock, contractStock]), read, by)
  for (const c of ['generic', 'logic', 'atomic', 'mapped', 'uses']) assert.deepEqual(warns(s, c), [], c)
})

test('an instance outside examples, a full query, a line said twice, no entity map: each warned', () => {
  const s = openStore(':memory:')
  const twice = 'a supplier name is not unique; the supplier id is the supplier'
  importDomains(s, domain([
    { title: 'Danfoss', form: 'bullets', items: ['Vendor VEN-0046 has two contracts', twice] },
    { title: 'Spend', form: 'text', text: `SELECT sum(total_value) FROM purchase_orders\n${twice}` },
  ]), read, by)
  assert.equal(warns(s, 'generic').length, 1)
  assert.equal(warns(s, 'logic').length, 1)
  assert.equal(warns(s, 'atomic').length, 1)
  assert.equal(warns(s, 'mapped').length, 1)
})

test('building on a concept the graph lacks fails; composing without it is warned', () => {
  const s = openStore(':memory:')
  importDomains(s, domain([contractStock]), read, by)
  assert.ok(verifyGraph(s).some((f) => f.level === 'fail' && f.check === 'uses'))
  const t = openStore(':memory:')
  importDomains(t, [...domain([contractStock]), { name: 'other', description: 'o', intents: ['o'], capabilities: [], concepts: [freeStock], files: [] }], read, by)
  assert.equal(warns(t, 'uses').length, 1)
})
