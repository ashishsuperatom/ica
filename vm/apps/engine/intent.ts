// THE INTENT GRAPH, ON THE ENGINE (docs/intent-graph.md): each question in a session is placed at an intent node before
// it is answered — and what happened is told back to the platform, which keeps the graph (intents.ts, intent-do.ts).
//
//   place   the session stands at a node (or nowhere, at its start). The platform gives that node, the nodes people went
//           to from it, the nodes that read like the question, the domains and the agents the asker may use. A small,
//           fast model decides: one of those nodes answers the question COMPLETELY (followed); or none does, and a new
//           node is described (made) — what it is for, the knowledge it links to, the agent that answers there; or the
//           message is about the answer just given (stayed). A question it cannot place is still answered: a new node,
//           linked to the domain its words reach.
//   record  the question and its answer kept at the node (its passage); the way from the node before, counted.
//
// The node's links (a domain, a concept — never copies) are the knowledge its answers are given; the search for the right
// knowledge happens once, when a node is made — after that, reaching the node brings it.

import { createSession, type Session } from './ica/index.js'
import { agentConfig } from './config/index.js'
import type { IntentLink, IntentNodeBody } from '@superatom/platform-types'

export interface IndexedNode { id: string; cluster: string; title: string; intent: string; links: IntentLink[]; agent: string | null; stale: string | null; passages: number }
export interface Context { here: IndexedNode | null; next: (IndexedNode & { count: number; scope: string })[]; similar: IndexedNode[]; domains: { name: string; title: string; description: string }[]; agents: { name: string; title: string; description: string }[]; total: number }
export interface Placed {
  how: 'followed' | 'made' | 'stayed'
  /** The node answered at: known, or (made) its body, to be kept when the answer is. */
  node: IndexedNode | null
  body: IntentNodeBody | null
  standalone: string
  why: string
}

const PLACE = `You place a person's message in an intent graph: a map of the kinds of things people in this organisation ask
for. Each node is one kind of request, described by its intent. You decide where this message belongs, and you answer
with JSON only — no other words.

- "asks": "about-answer" when the message only reacts to the answer just given (how it is shown, a thank-you, a
  correction of how it was presented); otherwise "request".
- "standalone": the message as a request that stands on its own: every "it", "that", "this one" replaced by what it
  means in the conversation.
- "node": the id of a node that answers the request COMPLETELY: the same request, possibly about another item, person or
  period — nothing more and nothing less. A node that answers only part of it, or more than it, is not it. When unsure,
  null.
- "new": when "node" is null and the message is a request: the node it needs —
  { "title": a few words, "intent": what is asked for, in general terms (not only this item or period), "links": the
  knowledge it needs — [{ "kind": "domain", "name": <one of the domains listed> }], "agent": the name of an agent listed
  under AGENTS only when the person asks for that agent's kind of work to be done (something to be built, a source to be
  connected), else null }.
- "why": one sentence.`

const parse = (s: string): any => { const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) throw new Error('no JSON'); return JSON.parse(s.slice(a, b + 1)) }
const line = (n: IndexedNode) => `- ${n.id}: ${n.title} — ${n.intent.replace(/\s+/g, ' ').slice(0, 300)}${n.agent ? ` [answered by the ${n.agent} agent]` : ''}`

export function createIntents(o: { send: (msg: Record<string, unknown>) => boolean; cwd: string; log?: (s: string) => void; /** The placing model (tests script it); the narrator's small model otherwise. */ judge?: (prompt: string) => Promise<any> }) {
  const log = o.log ?? (() => {})
  let n = 0
  const waiting = new Map<string, { resolve: (p: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  function ask(msg: Record<string, unknown>, ms = 20_000): Promise<any> {
    const reqId = `int-${Date.now().toString(36)}-${++n}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`the platform did not answer ${msg.type} in ${ms / 1000}s`)) }, ms)
      waiting.set(reqId, { resolve, reject, timer })
      if (!o.send({ ...msg, reqId })) { clearTimeout(timer); waiting.delete(reqId); reject(new Error('the platform is not connected')) }
    })
  }
  /** A reply from the platform to one of ours; whether it was. */
  function onMessage(p: any): boolean {
    const w = typeof p?.reqId === 'string' ? waiting.get(p.reqId) : undefined
    if (!w) return false
    waiting.delete(p.reqId); clearTimeout(w.timer)
    if (p.t === 'intent:refused') w.reject(new Error(p.reason ?? 'refused')); else w.resolve(p)
    return true
  }

  async function judge(prompt: string): Promise<any> {
    if (o.judge) return o.judge(prompt)
    const cfg = agentConfig('narrator')   // the small, fast model the narrator runs on
    let s: Session | null = null
    try {
      s = createSession(cfg.harness, { cwd: o.cwd, model: cfg.model, provider: cfg.provider, thinking: cfg.thinking, noTools: true, system: PLACE })
      const r = await Promise.race([s.run(prompt), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('the placing model took longer than 45 s')), 45_000))])
      return parse(r.lastLines)
    } finally { try { s?.stop() } catch { /* gone */ } }
  }

  return {
    onMessage,
    /** Where a message belongs: a node it follows to, a node to make, or the node it is already at. */
    async place(q: { text: string; recent: { q: string; a: string }[]; at: string | null; caps: string[]; scopes: string[]; fallbackDomain: () => Promise<string | null> }): Promise<Placed> {
      let ctx: Context | null = null
      try { ctx = await ask({ type: 'intent:context', at: q.at, text: q.text, caps: q.caps, scopes: q.scopes }) } catch (e: any) { log(`[intent] the platform gave no context: ${e?.message ?? e}`) }
      const fallback = async (why: string): Promise<Placed> => {
        const d = await q.fallbackDomain()
        return { how: 'made', node: null, body: { title: q.text.replace(/\s+/g, ' ').slice(0, 80), intent: q.text, links: d ? [{ kind: 'domain', name: d }] : [], agent: null }, standalone: q.text, why }
      }
      if (!ctx) return fallback('the intent graph could not be read')
      const known = new Map<string, IndexedNode>([...(ctx.here ? [ctx.here] : []), ...ctx.next, ...ctx.similar].map((x) => [x.id, x]))
      const prompt = [
        `CONVERSATION SO FAR:\n${q.recent.slice(-3).map((t) => `- asked: ${t.q.slice(0, 300)}\n  answered: ${t.a.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n') || '(it starts here)'}`,
        `THE MESSAGE: ${JSON.stringify(q.text)}`,
        `THE NODE THE CONVERSATION IS AT:\n${ctx.here ? line(ctx.here) : '(none — the start)'}`,
        `WHERE PEOPLE WENT FROM IT:\n${ctx.next.map(line).join('\n') || '(nowhere yet)'}`,
        `OTHER NODES THAT READ LIKE THE MESSAGE:\n${ctx.similar.map(line).join('\n') || '(none)'}`,
        `DOMAINS (knowledge a new node can link to):\n${ctx.domains.map((d) => `- ${d.name}: ${d.title}${d.description ? ` — ${d.description.slice(0, 200)}` : ''}`).join('\n') || '(none)'}`,
        `AGENTS this person may use:\n${ctx.agents.map((a) => `- ${a.name}: ${a.description}`).join('\n') || '(none)'}`,
        'JSON: {"asks": "...", "standalone": "...", "node": "<id>" or null, "new": {…} or null, "why": "..."}',
      ].join('\n\n')
      let v: any
      try { v = await judge(prompt) } catch (e: any) { log(`[intent] the message could not be placed: ${e?.message ?? e}`); return fallback(`not placed: ${e?.message ?? e}`) }
      const standalone = typeof v.standalone === 'string' && v.standalone.trim() ? v.standalone.trim() : q.text
      if (v.asks === 'about-answer' && ctx.here) return { how: 'stayed', node: ctx.here, body: null, standalone, why: String(v.why ?? '') }
      if (typeof v.node === 'string' && known.has(v.node)) return { how: 'followed', node: known.get(v.node)!, body: null, standalone, why: String(v.why ?? '') }
      const nw = v.new ?? {}
      const domains = new Set(ctx.domains.map((d) => d.name)), agents = new Set(ctx.agents.map((a) => a.name))
      const links: IntentLink[] = (Array.isArray(nw.links) ? nw.links : []).filter((l: any) => l && (l.kind === 'domain' ? domains.has(l.name) : l.kind === 'concept' && typeof l.name === 'string'))
      if (!links.length) { const d = await q.fallbackDomain(); if (d) links.push({ kind: 'domain', name: d }) }
      const body: IntentNodeBody = {
        title: String(nw.title ?? standalone).replace(/\s+/g, ' ').slice(0, 120) || standalone.slice(0, 120),
        intent: String(nw.intent ?? standalone).slice(0, 2000) || standalone,
        links,
        agent: typeof nw.agent === 'string' && agents.has(nw.agent) ? nw.agent : null,
        about: { placed: String(v.why ?? '').slice(0, 300), firstAsked: q.text.slice(0, 300) },
      }
      return { how: 'made', node: null, body, standalone, why: String(v.why ?? '') }
    },

    /** What was answered at a node (made now, when new): kept, and the way from the node before counted. */
    async record(r: { placed: Placed; from: string | null; session: string; block: string | null; question: string; answer: string; who: string; scope: string }): Promise<IndexedNode | null> {
      try {
        const out = await ask({ type: 'intent:record', node: r.placed.node?.id ?? null, ...(r.placed.node ? {} : { body: r.placed.body }), from: r.from, session: r.session, block: r.block, question: r.question, answer: r.answer, who: r.who, scope: r.scope, how: r.placed.how })
        return out.node as IndexedNode
      } catch (e: any) { log(`[intent] the passage was not kept: ${e?.message ?? e}`); return null }
    },

    /** A specialised agent's full spec (its instructions), from the platform. */
    async agent(name: string): Promise<{ name: string; title: string; instructions?: string; needs: string; harness: string; builtin?: boolean } | null> {
      try { return (await ask({ type: 'intent:agent', name })).agent ?? null } catch { return null }
    },
  }
}
