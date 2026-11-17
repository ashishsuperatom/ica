import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_CARDS, checkCards, inspectTools, reachOf, parsePath } from '../src/tools.ts'

test('the tree is whole: every card in its place, with its sections', () => assert.deepEqual(checkCards(), []))

test('a broken card is said', () => {
  const bad = [...TOOL_CARDS, { name: 'tools.nowhere.thing', command: 'other', summary: 'x', when: 'y' }]
  const said = checkCards(bad).join('\n')
  assert.match(said, /there is no area tools\.nowhere/)
  assert.match(said, /ends in its command/)
  assert.match(said, /a tool has Run, Gives/)
})

test('paths: a node, its children, its subtree', () => {
  assert.deepEqual(parsePath('tools.data'), { name: 'tools.data', depth: 'node' })
  assert.deepEqual(parsePath('tools.data.*'), { name: 'tools.data', depth: 'children' })
  assert.deepEqual(parsePath('tools.data.**'), { name: 'tools.data', depth: 'all' })
  assert.equal(parsePath('sources'), null)
  assert.equal(parsePath('tools.Data'), null)
})

test('inspect: the top, a node with its children listed, a node with its children whole', () => {
  const top = inspectTools('')!
  assert.match(top, /tools\.data/); assert.doesNotMatch(top, /find-schema/)
  const node = inspectTools('tools.data')!
  assert.match(node, /^### The data sources/); assert.match(node, /- \.\/query "<SOURCE>"/); assert.doesNotMatch(node, /Traps/)
  const kids = inspectTools('tools.data.*')!
  assert.match(kids, /### \.\/query — /); assert.match(kids, /Traps/)
  assert.equal(inspectTools('tools.data.**'), kids)   // no deeper level under data
  assert.match(inspectTools('tools.data.query')!, /^### \.\/query/)
  assert.equal(inspectTools('tools.nothing'), null)
})

test('reach: a path grants its whole subtree, and inspect always', () => {
  assert.deepEqual(reachOf([]), ['inspect'])
  assert.deepEqual(reachOf(['tools.data']).sort(), ['find-schema', 'get-schema', 'inspect', 'query', 'sources'])
  assert.deepEqual(reachOf(['tools.agent.send-to-agent']).sort(), ['inspect', 'send-to-agent'])
  assert.deepEqual(reachOf(['sources']), ['inspect'])   // a variable, not a path
})

import { DEFAULT_CONCEPTS, DEFAULT_DOMAINS } from '../src/default-concepts.ts'
test('every {{tools…}} a default concept writes is a place in the tree', () => {
  const paths = DEFAULT_CONCEPTS.flatMap((c) => (c.body.form === 'text' ? [...c.body.text.matchAll(/\{\{\s*(tools[\w.*-]*)\s*\}\}/g)].map((m) => m[1]!) : []))
  assert.ok(paths.length > 0)
  for (const p of paths) assert.notEqual(inspectTools(p), null, `${p} is not in the tree`)
})

test("each ICA's reach, from what its domain's concepts reference", () => {
  const body = (n: string) => DEFAULT_CONCEPTS.find((c) => c.name === n)!.body
  const textOf = (n: string): string => { const b = body(n); return b.form === 'text' ? b.text : b.concepts.map(textOf).join('\n') }
  const reach = (domain: string) => reachOf(DEFAULT_DOMAINS.find((d) => d.name === domain)!.body.concepts.flatMap((n) => [...textOf(n).matchAll(/\{\{\s*(tools[\w.*-]*)\s*\}\}/g)].map((m) => m[1]!))).sort()
  assert.deepEqual(reach('intent-matcher-domain'), ['inspect'])   // it decides only what a message is
  assert.deepEqual(reach('composer-domain'), ['experience', 'find-concept', 'find-schema', 'get-schema', 'inspect', 'query', 'send-to-agent', 'sources'])   // no intent search: it is given the intent   // no programs: they reach it through an intent's way
  assert.deepEqual(reach('analyst-domain'), ['choose-intent', 'experience', 'find-concept', 'find-intent', 'find-schema', 'get-intent', 'get-schema', 'inspect', 'query', 'run-program', 'sources'])
  assert.deepEqual(reach('connector-domain'), ['connections', 'inspect', 'sources'])
  assert.deepEqual(reach('learner-domain'), ['inspect'])
})
