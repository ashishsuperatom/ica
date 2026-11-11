// Each platform agent starts from its own domain (platform-types AGENT_DOMAIN): picked by the agent, never by the question.
// The composer and the analyst share what they do alike — one text, so a change to it reaches both; each has its own part.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '@superatom/composition-graph/node'
import { DEFAULTS, AGENT_DOMAIN } from '@superatom/platform-types'
import { agentDomain, compose, domainTools } from '../knowledge.ts'

/** A project's graph given the defaults, as the platform puts them in (by the platform: they are read as they are now). */
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-domains-')); mkdirSync(join(dir, 'db'))
  const s = openStore(join(dir, 'db', 'composition.sqlite'))
  const ctx = { by: 'platform', reason: 'the defaults' }
  for (const c of DEFAULTS.concepts) s.put(c.name, 'concept', c.body as any, ctx, {})
  for (const x of DEFAULTS.domains) s.put(x.name, 'domain', x.body as any, ctx, {})
  return { dir, s }
}
const textOf = async (dir: string, name: string) => (await compose(dir, (await agentDomain(dir, name))!)).text

test("every agent starts from its own domain; the composer and the analyst share their way of working, each with its own part", async () => {
  const { dir, s } = home()
  s.close()
  for (const name of Object.values(AGENT_DOMAIN)) assert.ok(await agentDomain(dir, name), `${name} is in the graph`)
  const composer = await textOf(dir, AGENT_DOMAIN.composer), analyst = await textOf(dir, AGENT_DOMAIN.analyst)
  for (const shared of ['Which intent a message is', 'What a match is', 'The data tools', 'How every answer is given']) {
    assert.match(composer, new RegExp(shared)); assert.match(analyst, new RegExp(shared))
  }
  assert.match(composer, /send-to-agent analyst current-question/); assert.doesNotMatch(analyst, /send-to-agent/)   // the hand-off is the composer's
  assert.match(analyst, /A new kind of question/); assert.doesNotMatch(composer, /A new kind of question/)         // working out a new one is the analyst's
  // the same tools, but the hand-off
  assert.deepEqual(domainTools(dir, AGENT_DOMAIN.analyst)!.sort(), domainTools(dir, AGENT_DOMAIN.composer)!.filter((t) => t !== 'send-to-agent').sort())
  // the learner and the builder are told by the graph, never the code
  assert.match(await textOf(dir, AGENT_DOMAIN.learner), /what the conversation taught[\s\S]*Like a large program[\s\S]*interpolation[\s\S]*export default async function[\s\S]*SIGNAL[\s\S]*Known surprises/)
  assert.match(await textOf(dir, AGENT_DOMAIN.builder), /You are the builder of this session/)
})

test('a shared concept changed once reaches every agent that uses it', async () => {
  const { dir, s } = home()
  s.put('intent/match', 'concept', { form: 'text', title: 'What a match is', text: 'Our own rule for a match.' } as any, { by: 'user:root', reason: 'ours' }, {})
  s.close()
  assert.match(await textOf(dir, AGENT_DOMAIN.composer), /Our own rule for a match/)
  assert.match(await textOf(dir, AGENT_DOMAIN.analyst), /Our own rule for a match/)
})
