// Usage per person, at the engine: what each harness reports, stamped with the turn's session and person.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proxyBaseFor, parsePath } from '../../../packages/agent-contract/contract.mjs'

test('codex: a turn is what its session log adds across it', async () => {
  const { codexTotals } = await import('../ica/codex.ts')
  assert.deepEqual(codexTotals(null), { input: 0, cached: 0, output: 0 })
  assert.deepEqual(codexTotals('no-such-thread'), { input: 0, cached: 0, output: 0 })
})


test("the tag travels in the proxy address and is read back out", () => {
  const base = proxyBaseFor('superatom.site', 'p-1', 'opencode-go', 'pi-abc123')
  assert.equal(base, 'https://proxy.superatom.site/p/p-1/t/pi-abc123/opencode-go')
  const u = new URL(base + '/chat/completions')
  assert.deepEqual({ ...parsePath(u.pathname) }, { projectId: 'p-1', tag: 'pi-abc123', service: null, provider: 'opencode-go', rest: 'chat/completions', arg: 'chat' })
  assert.equal(proxyBaseFor('superatom.site', 'p-1', 'opencode-go', 'bad/tag'), 'https://proxy.superatom.site/p/p-1/opencode-go')
})
