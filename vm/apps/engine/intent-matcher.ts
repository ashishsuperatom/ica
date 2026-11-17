// THE INTENTMATCHER (docs/intent-graph.md "The IntentMatcher"): every message is matched before any agent works on it —
// to the intent the conversation is in (same), another intent (matched), none known (new), or not a request (none). It
// decides only what the message is, never how it is answered; the engine routes on its decision (session-seam.ts).
//
// Its cases, in order:
//   exact  the conversation's first message, with the canonical form (intent.ts canonicalOf) of a question an intent was
//          asked as: that intent, no model.
//   model  everything else — its own ICA (the IntentMatcher's domain, the profile's `intent-matcher`), with no tools: spells the
//          message out as a question that stands alone from the questions asked before it (only when there were some),
//          the intents it may be are found by those words, then it decides among them. A spelled-out question with an
//          intent's exact canonical form is that intent.
// Every match is one record (kept with the session's log), so matching is measured on its own.

import { agentConfig } from './config/index.js'
import { createSession } from './ica/index.js'
import type { Found, NodeView, NextEdge } from './intent.js'

export type Decision = 'same' | 'matched' | 'new' | 'none'

export interface Match {
  decision: Decision
  /** The intent it is (same, matched). */
  node: NodeView | null
  /** The message as a question that stands alone. */
  question: string
  /** What the intents were searched with, and what came back. */
  found: Found | null
  how: 'exact' | 'model'
  ms: number
  /** Why no model decision came back (the model failed, or wrote no decision): the message goes to the analyst. */
  failed?: string
}

/** A question asked earlier in the conversation, with the intent it was answered at. */
export interface Earlier { question: string; intent: string | null }

export interface MatcherDeps {
  intents: {
    find(q: { text: string; at: string | null; owner: string; caps: string[] }): Promise<Found>
    next(q: { at: string; owner: string; caps: string[] }): Promise<NextEdge[]>
    node(q: { id: string; owner: string; caps: string[] }): Promise<NodeView | null>
  }
  /** The IntentMatcher's domain composed (platform-types ICA_DOMAIN.intentMatcher): its system prompt. */
  domain: () => Promise<string>
  /** One conversation with the model: each prompt answered in turn, with what came before. Tests script it. */
  converse?: (system: string) => { say(prompt: string): Promise<string>; close(): void }
  cwd: string
}

/** The IntentMatcher's model, from the project's profile: a conversation of plain text, no tools. */
function modelConversation(cwd: string) {
  return (system: string) => {
    const cfg = agentConfig('intent-matcher')
    const session = createSession(cfg.harness, { cwd, model: cfg.model, provider: cfg.provider, thinking: cfg.thinking, noTools: true, system })
    return {
      async say(prompt: string) {
        const r = await session.run(prompt)
        if (!r.lastLines?.trim() && r.failure) throw new Error(r.failure)
        return r.lastLines ?? ''
      },
      close() { try { session.stop() } catch { /* best-effort */ } },
    }
  }
}

/** The first JSON object in a reply. */
function jsonOf(reply: string): Record<string, unknown> | null {
  const s = reply.indexOf('{'), e = reply.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try { const v = JSON.parse(reply.slice(s, e + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { return null }
}

const line = (id: string, title: string, intent?: string) => `- ${id}: ${title}${intent ? ` — ${intent.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`

export function createIntentMatcher(d: MatcherDeps) {
  const converse = d.converse ?? modelConversation(d.cwd)

  async function match(m: { message: string; earlier: Earlier[]; here: NodeView | null; owner: string; caps: string[] }): Promise<Match> {
    const t0 = Date.now()
    const message = m.message.replace(/\s+/g, ' ').trim()
    const ask = { owner: m.owner, caps: m.caps }
    // exact: the first message, asked in the words of an intent's question (values aside)
    if (!m.earlier.length) {
      const found = await d.intents.find({ text: message, at: null, ...ask })
      if (found.exact && found.candidates[0]) return { decision: 'matched', node: found.candidates[0], question: message, found, how: 'exact', ms: Date.now() - t0 }
    }
    const system = await d.domain()
    const talk = converse(system)
    let question = message, found: Found | null = null
    try {
      const before = m.earlier.length ? `The questions asked so far in this conversation, in order:\n${m.earlier.map((e, i) => `${i + 1}. ${e.question.replace(/\s+/g, ' ').slice(0, 600)}${e.intent ? `  (answered at the intent: ${e.intent})` : ''}`).join('\n')}\n\n` : ''
      if (m.earlier.length) {
        const r = jsonOf(await talk.say(`${before}The message: ${message}\n\nSpell it out as a question that stands alone. Reply with JSON: { "question": "<the question>" }`))
        const q = typeof r?.question === 'string' ? r.question.replace(/\s+/g, ' ').trim() : ''
        if (q) question = q
      }
      found = await d.intents.find({ text: question, at: m.here?.id ?? null, ...ask })
      // a spelled-out question in the words of an intent's question: that intent
      if (found.exact && found.candidates[0]) return { decision: 'matched', node: found.candidates[0], question, found, how: 'exact', ms: Date.now() - t0 }
      const next = m.here ? (await d.intents.next({ at: m.here.id, ...ask }).catch(() => [])).filter((e) => !found!.candidates.some((c) => c.id === e.to)) : []
      const offered = [
        m.here ? `The intent the conversation is in:\n${line(m.here.id, m.here.title, m.here.intent)}` : 'The conversation is in no intent yet.',
        `The intents found by its words:\n${found.candidates.map((c) => line(c.id, c.title, c.intent)).join('\n') || '(none)'}`,
        next.length ? `The intents that usually come next:\n${next.map((e) => line(e.to, e.title)).join('\n')}` : '',
      ].filter(Boolean).join('\n\n')
      const r = jsonOf(await talk.say(`${m.earlier.length ? '' : before}The message: ${message}${question !== message ? `\nSpelled out: ${question}` : ''}\n\n${offered}\n\nDecide. Reply with JSON: { "decision": "same" | "matched" | "new" | "none", "id": "<the intent's id, for same or matched>" }`))
      const decision = String(r?.decision ?? '') as Decision
      if (!['same', 'matched', 'new', 'none'].includes(decision)) return { decision: 'new', node: null, question, found, how: 'model', ms: Date.now() - t0, failed: `no decision in its reply` }
      if (decision === 'new' || decision === 'none') return { decision, node: null, question, found, how: 'model', ms: Date.now() - t0 }
      const id = decision === 'same' ? (m.here?.id ?? String(r?.id ?? '')) : String(r?.id ?? '').trim()
      const node = id === m.here?.id ? m.here : found.candidates.find((c) => c.id === id) ?? (next.some((e) => e.to === id) ? await d.intents.node({ id, ...ask }) : null)
      if (!node) return { decision: 'new', node: null, question, found, how: 'model', ms: Date.now() - t0, failed: `it chose ${id || 'no id'}, which was not offered` }
      return { decision: node.id === m.here?.id ? 'same' : 'matched', node, question, found, how: 'model', ms: Date.now() - t0 }
    } catch (e: any) {
      return { decision: 'new', node: null, question, found, how: 'model', ms: Date.now() - t0, failed: String(e?.message ?? e) }
    } finally { talk.close() }
  }

  return { match }
}
