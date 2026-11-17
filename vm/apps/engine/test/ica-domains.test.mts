// Each platform ICA starts from its own domain (platform-types ICA_DOMAIN): picked by the ICA, never by the question.
// What ICAs do alike is one text, so a change to it reaches each of them; each has its own part.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '@superatom/composition-graph/node'
import { DEFAULTS, ICA_DOMAIN } from '@superatom/platform-types'
import { icaDomain, compose, domainTools } from '../knowledge.ts'

/** A project's graph given the defaults, as the platform puts them in (by the platform: they are read as they are now). */
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-domains-')); mkdirSync(join(dir, 'db'))
  const s = openStore(join(dir, 'db', 'composition.sqlite'))
  const ctx = { by: 'platform', reason: 'the defaults' }
  for (const c of DEFAULTS.concepts) s.put(c.name, 'concept', c.body as any, ctx, {})
  for (const x of DEFAULTS.domains) s.put(x.name, 'domain', x.body as any, ctx, {})
  return { dir, s }
}
const textOf = async (dir: string, name: string) => (await compose(dir, (await icaDomain(dir, name))!)).text

test("every ICA starts from its own domain: the IntentMatcher decides what a message is, the composer answers from the intent it is given, the analyst decides again and works a new one out", async () => {
  const { dir, s } = home()
  s.close()
  for (const name of Object.values(ICA_DOMAIN)) assert.ok(await icaDomain(dir, name), `${name} is in the graph`)
  const intentMatcher = await textOf(dir, ICA_DOMAIN.intentMatcher), composer = await textOf(dir, ICA_DOMAIN.composer), analyst = await textOf(dir, ICA_DOMAIN.analyst)
  for (const shared of ['The data tools', 'How every answer is given']) { assert.match(composer, new RegExp(shared)); assert.match(analyst, new RegExp(shared)) }
  // what a match is: the IntentMatcher's and the analyst's (it decides again), never the composer's
  for (const rule of ['What a match is', 'Staying in an intent']) { assert.match(intentMatcher, new RegExp(rule)); assert.match(analyst, new RegExp(rule)); assert.doesNotMatch(composer, new RegExp(rule)) }
  assert.match(intentMatcher, /You are the session's IntentMatcher/); assert.doesNotMatch(intentMatcher, /\{\{\s*tools|\.\/[a-z]/)   // no tools: it only decides
  assert.deepEqual(domainTools(dir, ICA_DOMAIN.intentMatcher), ['inspect'])   // what every domain reaches; the IntentMatcher's model runs with no tools at all
  assert.match(composer, /send-to-agent analyst current-question/); assert.doesNotMatch(analyst, /send-to-agent/)   // the hand-off is the composer's
  assert.match(analyst, /A new kind of question/); assert.doesNotMatch(composer, /A new kind of question/)         // working out a new one is the analyst's
  // the tools are composed from their cards, never left as a reference
  for (const t of [composer, analyst]) { assert.doesNotMatch(t, /\{\{\s*tools/); assert.match(t, /- \.\/query "<SOURCE>"/) }
  assert.match(analyst, /- \.\/find-intent "<the question, spelled out in full>"/)
  assert.match(composer, /- \.\/send-to-agent <agent> current-question/)
  // the composer finds no intents: it is given the one the message is, and reads that intent's experience
  const composerTools = domainTools(dir, ICA_DOMAIN.composer)!, analystTools = domainTools(dir, ICA_DOMAIN.analyst)!
  for (const t of ['find-intent', 'get-intent', 'choose-intent']) { assert.ok(!composerTools.includes(t), t); assert.ok(analystTools.includes(t), t) }
  assert.ok(composerTools.includes('experience')); assert.ok(composerTools.includes('send-to-agent'))
  // nothing sends the composer to programs or to ./inspect: a program reaches it only through an intent's method
  assert.doesNotMatch(composer, /\.\/inspect|run-program|programs/)
  // the analyst looks for a program only when it decides one may already compute a new kind of question
  assert.match(analyst, /Before working out a new kind of question from the data, decide whether the project may already compute it/)
  assert.equal((analyst.match(/\.\/inspect/g) ?? []).length, 1)   // that concept's one look, nowhere else
  assert.ok(analystTools.includes('run-program'))
  // the learner and the builder are told by the graph, never the code
  assert.match(await textOf(dir, ICA_DOMAIN.learner), /what the conversation taught[\s\S]*Like a large program[\s\S]*interpolation[\s\S]*export default async function[\s\S]*SIGNAL[\s\S]*Known surprises/)
  assert.match(await textOf(dir, ICA_DOMAIN.builder), /You are the builder of this session/)
})

test('a shared concept changed once reaches every ICA that uses it', async () => {
  const { dir, s } = home()
  s.put('intent/match', 'concept', { form: 'text', title: 'What a match is', text: 'Our own rule for a match.' } as any, { by: 'user:root', reason: 'ours' }, {})
  s.close()
  assert.match(await textOf(dir, ICA_DOMAIN.intentMatcher), /Our own rule for a match/)
  assert.match(await textOf(dir, ICA_DOMAIN.analyst), /Our own rule for a match/)
})
