// A measure worked out from a fact's others is defined once, in the graph, and asked for by name — so an idea like
// a shortfall is not computed afresh, and differently, in every program that needs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, schemaProblems, type Schema } from '../src/index.js'

const s: Schema = { name: 'shop', objects: {
  Day: { kind: 'calendar', level: 'day' },
  Order: { kind: 'fact', arrows: { day: 'Day' }, measures: {
    sold: { unit: 'units', kind: 'flow', aggregate: 'sum' },
    returned: { unit: 'units', kind: 'flow', aggregate: 'sum' },
    net: { unit: 'units', kind: 'flow', aggregate: 'sum', expr: '[Order.sold] - [Order.returned]' },
  } },
} }

test('a derived measure is asked for by name and answered by what it is made of, under the name asked', () => {
  assert.deepEqual(schemaProblems(s), [])
  const v = check(s, { measures: ['Order.net'] })
  assert.ok(v.ok)
  assert.equal(v.plan.outputs[0]!.name, 'Order.net')            // the graph's name for the idea survives
  assert.equal(v.plan.outputs[0]!.unit, 'units')                // units come from its parts
  assert.deepEqual([...v.plan.facts[0]!.measures].sort(), ['returned', 'sold'])   // only real measures are read
  const w = check(s, { measures: ['[Order.net] / [Order.sold]'] })   // and it composes inside an expression
  assert.ok(w.ok)
  assert.equal(w.plan.outputs[0]!.unit, 'ratio')
})

test("an expression is over this fact's own added-up measures, and never over another expression", () => {
  const bad = structuredClone(s)
  bad.objects.Order!.measures!.worse = { unit: 'units', kind: 'flow', aggregate: 'sum', expr: '[Order.net] - [Order.nothing]' }
  const p = schemaProblems(bad)
  assert.ok(p.some((x) => x.includes('itself an expression')), p.join('\n'))
  assert.ok(p.some((x) => x.includes('no measure "nothing"')), p.join('\n'))
})
