// Run:  cd vm && pnpm exec tsx --test packages/scaffold/src/fmt.test.ts
//
// The point of this file: a helper that the agent is never told about may as well not exist, and a helper
// described by a stale line is worse than one described by none. The registry lives beside the functions, and
// this is what stops the two drifting.
import { test } from 'node:test'
import assert from 'node:assert'
import * as fmt from './fmt.js'

test('every exported helper documents itself', () => {
  const exported = Object.entries(fmt).filter(([n, v]) => typeof v === 'function' && n !== 'formatHelpText').map(([n]) => n)
  const documented = Object.keys(fmt.FORMAT_HELPERS)
  assert.deepEqual(exported.sort(), documented.sort(),
    'a helper with no entry in FORMAT_HELPERS is invisible to the agent; one with an entry and no function is a lie')
})

test('the instructions name every helper and say when to reach for it', () => {
  const text = fmt.formatHelpText()
  for (const [name, doc] of Object.entries(fmt.FORMAT_HELPERS)) {
    assert.ok(text.includes(name), `${name} missing from the rendered instructions`)
    assert.ok(text.includes(doc.when), `${name} has no "when" in the rendered instructions`)
  }
})

test('the helpers still do what they say', () => {
  assert.equal(fmt.pct(0.1234), '12.3%')
  assert.equal(fmt.num(1234567), '1,234,567')
  assert.ok(fmt.money(1234567, 'AUD').startsWith('AUD'))
  assert.ok(fmt.abbrev(1234567).includes('M'))
})
