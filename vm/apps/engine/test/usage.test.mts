// Usage per person, at the engine: every agent turn tells the platform which session (and person) it serves, around
// the turn, with the session's tag; tokens are reported by the engine only for routes the proxy does not count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, setUsageSink } from '../ica/index.ts'
import { countedByProxy, proxyBaseFor, parsePath } from '../../../packages/agent-contract/contract.mjs'

test('a turn for a session is bracketed with its tag; a turn for no one is not', async () => {
  const seen: any[] = []
  setUsageSink({ turn: (tag, session, phase, person) => seen.push({ tag, session, phase, person }), report: () => {} })
  const s = createSession('mock', { cwd: mkdtempSync(join(tmpdir(), 'usage-')) })
  await s.run('q', { forSession: 's-1', forPerson: 'email:ann@x.io' })
  await s.run('q')
  setUsageSink(null)
  assert.equal(seen.length, 2)
  assert.deepEqual(seen.map((x) => x.phase), ['start', 'end'])
  assert.equal(seen[0].session, 's-1'); assert.equal(seen[0].person, 'email:ann@x.io')
  assert.equal(seen[0].tag, seen[1].tag); assert.match(seen[0].tag, /^mock-[0-9a-f]{12}$/)
})

test('exactly one place counts each route', () => {
  for (const p of ['opencode-go', 'openrouter']) assert.equal(countedByProxy(p), true, p)
  for (const p of ['claude-code', 'openai-codex']) assert.equal(countedByProxy(p), false, p)
})

test("the tag travels in the proxy address and is read back out", () => {
  const base = proxyBaseFor('superatom.site', 'p-1', 'opencode-go', 'pi-abc123')
  assert.equal(base, 'https://proxy.superatom.site/p/p-1/t/pi-abc123/opencode-go')
  const u = new URL(base + '/chat/completions')
  assert.deepEqual({ ...parsePath(u.pathname) }, { projectId: 'p-1', tag: 'pi-abc123', service: null, provider: 'opencode-go', rest: 'chat/completions', arg: 'chat' })
  assert.equal(proxyBaseFor('superatom.site', 'p-1', 'opencode-go', 'bad/tag'), 'https://proxy.superatom.site/p/p-1/opencode-go')
})
