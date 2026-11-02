// THE INTENT GRAPH, ON THE ENGINE (docs/intent-graph.md): the platform keeps the graph (intents.ts, intent-do.ts); the
// engine asks it what each message is decided with, and tells it what happened.
//
//   find   the message's canonical form, the node the session is at (with the variant the person answers with), and
//          the candidates — the one node with the same canonical form, else the best five by their words
//   node   one node with the person's variant (the composer chose a candidate whose knowledge it was not yet given)
//   pass   a question answered at a node (made now when new — by the analyst or a node's agent, never the composer)
//   close  what the clone of the session learnt when an intent closed
//   next   the ways out of a node, offered after its answer when their check holds
//
// Nothing here decides: every message goes to the session's composer, which decides by meaning (session-seam.ts).

import type { IntentNodeBody, IntentParam, IntentVariantBody, IntentEdge } from '@superatom/platform-types'

export interface NodeView {
  id: string; title: string; intent: string; canonical: string; agent: string | null; needs: string | null; allowed: boolean; system: boolean; passages: number
  variant?: (IntentVariantBody & { whose: 'mine' | 'project'; verified: boolean; version: number; owner: string }) | null
}
export interface Found { canonical: string; params: IntentParam[]; exact: boolean; here: NodeView | null; candidates: NodeView[]; total: number }
export type NextEdge = IntentEdge & { title: string; allowed: boolean; taken?: number }

export function createIntents(o: { send: (msg: Record<string, unknown>) => boolean; log?: (s: string) => void }) {
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

  return {
    onMessage,
    async find(q: { text: string; at: string | null; owner: string; caps: string[] }): Promise<Found> {
      return ask({ type: 'intent:find', ...q })
    },
    async node(q: { id: string; owner: string; caps: string[] }): Promise<NodeView | null> {
      try { return (await ask({ type: 'intent:node', ...q })).node ?? null } catch (e: any) { log(`[intent] node ${q.id} could not be read: ${e?.message ?? e}`); return null }
    },
    async pass(p: { node: string | null; body?: IntentNodeBody; from: string | null; session: string; block: string | null; question: string; canonical: string; params: IntentParam[]; answer: string; owner: string; by: string; agent: string; how: 'matched' | 'made' | 'same' }): Promise<NodeView | null> {
      try { return (await ask({ type: 'intent:pass', ...p })).node ?? null } catch (e: any) { log(`[intent] the passage was not kept: ${e?.message ?? e}`); return null }
    },
    async close(c: { node: string; owner: string; by: string; session: string; madeHere: boolean; title?: string; intent?: string; variant?: IntentVariantBody | null; names?: IntentParam[]; next?: { asked: string; title?: string; label?: string; kind?: string | null; check?: string | null }[]; retire?: { to: string; why: string }[] }) {
      return ask({ type: 'intent:close', ...c }, 60_000)
    },
    async next(q: { at: string; owner: string; caps: string[] }): Promise<NextEdge[]> {
      try { return (await ask({ type: 'intent:next', ...q })).next ?? [] } catch (e: any) { log(`[intent] the ways out of ${q.at} could not be read: ${e?.message ?? e}`); return [] }
    },
    /** What the checks on a node's ways out did after one answer: kept as their history (nothing waits on it). */
    tried(at: string, results: { to: string; owner: string; tag: string; outcome: 'held' | 'empty' | 'failed' }[]) {
      if (results.length) void ask({ type: 'intent:tried', at, results }).catch((e: any) => log(`[intent] the checks' history was not kept: ${e?.message ?? e}`))
    },
    /** A specialised agent's full spec (its instructions), from the platform. */
    async agent(name: string): Promise<{ name: string; title: string; instructions?: string; needs: string; harness: string; builtin?: boolean } | null> {
      try { return (await ask({ type: 'intent:agent', name })).agent ?? null } catch { return null }
    },
  }
}
