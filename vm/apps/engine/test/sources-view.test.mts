// The sources a conversation may read (docs/connectors-plan.md 9g): the project's, narrowed by its domain's rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourcesFor } from '../sources-view.ts'

test("the project's sources, narrowed by the domain: only these, or all but these; no rule, every one", () => {
  const all = ['SALES', 'MAIL', 'CRM']
  assert.equal(sourcesFor(all, {}), null)
  assert.equal(sourcesFor(all, { domain: {} }), null)
  assert.deepEqual(sourcesFor(all, { domain: { only: ['MAIL', 'GONE'] } }), ['MAIL'])        // one no longer there is not given
  assert.deepEqual(sourcesFor(all, { domain: { remove: ['CRM'] } }), ['SALES', 'MAIL'])
  assert.deepEqual(sourcesFor(all, { domain: { only: ['SALES', 'CRM'], remove: ['CRM'] } }), ['SALES'])
})
