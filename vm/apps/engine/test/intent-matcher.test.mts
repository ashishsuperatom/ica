// The IntentMatcher's cases (intent-matcher.ts): the first message in an intent's words, no model; a follow-up spelled out
// then decided; an intent that usually comes next chosen; and no decision — the model failing, or choosing what it was not
// offered — said as such, never a guess.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIntentMatcher } from '../intent-matcher.ts'

const node = (id: string, title: string) => ({ id, title, intent: title.toLowerCase(), canonical: title.toLowerCase(), agent: null, needs: null, allowed: true, system: false, passages: 1, method: null })
const here = node('in-openrfq01', 'Open RFQs')
const byPlant = node('in-rfqplant1', 'Open RFQs by plant')
const later = node('in-awarded01', 'Awarded RFQs')

function intentMatcherWith(replies: (string | Error)[], o: { exact?: boolean } = {}) {
  const searched: string[] = [], prompts: string[] = []
  const intents: any = {
    find: async (q: any) => { searched.push(q.text); return { canonical: q.text, params: [], exact: !!o.exact, total: 3, here: null, candidates: [byPlant] } },
    next: async () => [{ from: here.id, to: later.id, owner: 'u', tag: 'suggested', kind: 'extrapolation', count: 0, title: later.title, allowed: true }],
    node: async (q: any) => (q.id === later.id ? later : null),
  }
  const intentMatcher = createIntentMatcher({ intents, domain: async () => 'the IntentMatcher', cwd: '/tmp',
    converse: () => ({ say: async (p: string) => { prompts.push(p); const r = replies.shift(); if (r instanceof Error) throw r; return r ?? '' }, close() {} }) })
  return { intentMatcher, searched, prompts }
}
const who = { owner: 'user:u1', caps: [] }

test('the first message in the words of an intent\'s question is that intent — no model', async () => {
  const { intentMatcher, prompts } = intentMatcherWith([], { exact: true })
  const m = await intentMatcher.match({ message: 'open RFQs by plant', earlier: [], here: null, ...who })
  assert.deepEqual([m.decision, m.node?.id, m.how], ['matched', byPlant.id, 'exact']); assert.equal(prompts.length, 0)
})

test('a follow-up is spelled out from the questions before it, searched by those words, then decided among the intent it is in, those found and those that come next', async () => {
  const { intentMatcher, searched, prompts } = intentMatcherWith(['{ "question": "Show the open RFQs by plant" }', 'Here: { "decision": "matched", "id": "in-rfqplant1" }'])
  const m = await intentMatcher.match({ message: 'by plant', earlier: [{ question: 'show me the open RFQs', intent: 'Open RFQs' }], here, ...who })
  assert.deepEqual([m.decision, m.node?.id, m.question, m.how], ['matched', byPlant.id, 'Show the open RFQs by plant', 'model'])
  assert.deepEqual(searched, ['Show the open RFQs by plant'])
  assert.match(prompts[1], /The intent the conversation is in:\n- in-openrfq01: Open RFQs[\s\S]*found by its words:\n- in-rfqplant1[\s\S]*usually come next:\n- in-awarded01: Awarded RFQs/)
})

test('an intent that usually comes next may be chosen; the one the conversation is in is same', async () => {
  const a = await intentMatcherWith(['{ "question": "which were awarded?" }', '{ "decision": "matched", "id": "in-awarded01" }']).intentMatcher.match({ message: 'which were awarded?', earlier: [{ question: 'open RFQs', intent: null }], here, ...who })
  assert.deepEqual([a.decision, a.node?.id], ['matched', later.id])
  const b = await intentMatcherWith(['{ "question": "open RFQs, as a chart" }', '{ "decision": "same" }']).intentMatcher.match({ message: 'as a chart', earlier: [{ question: 'open RFQs', intent: null }], here, ...who })
  assert.deepEqual([b.decision, b.node?.id], ['same', here.id])
})

test('no decision is said as such and goes to the analyst (new): the model failing, a reply with no decision, an intent it was not offered', async () => {
  const cases: [(string | Error)[], RegExp][] = [
    [[new Error('the account refused')], /the account refused/],
    [['I think it is the open RFQs.'], /no decision in its reply/],
    [['{ "decision": "matched", "id": "in-elsewhere1" }'], /it chose in-elsewhere1, which was not offered/],
  ]
  for (const [replies, why] of cases) {
    const m = await intentMatcherWith(replies).intentMatcher.match({ message: 'what about suppliers?', earlier: [], here: null, ...who })
    assert.equal(m.decision, 'new'); assert.equal(m.node, null); assert.match(m.failed ?? '', why)
  }
})
