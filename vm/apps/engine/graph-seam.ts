// THE COMPOSITION GRAPH, for people and agents. Reads and governed changes over the hub:
//
//   graph:domains | graph:names { kind? } | graph:show { name, asOf? } | graph:history { name } | graph:compose { domain }
//   graph:suggestions { status?, name? }
//   graph:concept { name, body, reason?, scope? }      make a concept, or change one you own
//   graph:domain  { name, body, reason?, scope? }      make a domain, or change one you own
//   graph:agent   { name, body, reason?, scope? }      make an agent (a domain, its programs, tools, start, UI), or change one you own
//   graph:join    { domain, concept, at?, reason? }    put a concept into a domain you own
//   graph:leave   { domain, concept, reason? }
//   graph:suggest { name, kind, body, reason }         suggest a change to someone else's node
//   graph:decide  { id, verdict: approved|rejected|withdrawn, reason? }
//   graph:publish { name, scope, reason }             suggest a node be seen more widely (a group, everyone); an admin decides
//
// → graph:reply { … } or graph:refused { reason }. Who acts is the hub's word (identity.ts); the rules are the
// composition graph's governance (owner changes, others suggest, owner decides). A person sees global nodes and their
// own and their groups'; an admin sees everything; an agent sees global nodes and its groups'.

import { join } from 'node:path'
import { Store, compose, domains, governance as g, GovernanceRefusal, type Kind } from '@superatom/composition-graph'
import { whoIs, IdentityRefusal } from './identity.js'

export const GRAPH_MESSAGES = new Set(['graph:domains', 'graph:names', 'graph:show', 'graph:history', 'graph:compose', 'graph:suggestions', 'graph:concept', 'graph:domain', 'graph:agent', 'graph:join', 'graph:leave', 'graph:suggest', 'graph:decide', 'graph:publish'])

export function createGraphSeam(d: { projectDir: string; send: (to: any, msg: Record<string, unknown>) => void; file?: string }) {
  let store: Store | null = null
  const open = () => (store ??= new Store(d.file ?? join(d.projectDir, 'db', 'composition.sqlite')))
  const str = (v: unknown, what: string) => { if (typeof v !== 'string' || !v.trim()) throw new GovernanceRefusal(`${what} is required`); return v.trim() }
  const kinds: Kind[] = ['domain', 'concept', 'file', 'setting', 'agent']

  async function handle(payload: any, from: any): Promise<void> {
    const t = String(payload?.t ?? '')
    const reply = (msg: Record<string, unknown>) => d.send(from, { ...msg, reqId: payload.reqId })
    try {
      const who = whoIs(from)
      const s = open()
      const viewer = who.admin ? undefined : who.scopes
      const asOf = payload.asOf ? Date.parse(String(payload.asOf)) : undefined
      if (asOf !== undefined && Number.isNaN(asOf)) throw new GovernanceRefusal(`"${payload.asOf}" is not a time`)
      const ok = (data: Record<string, unknown>) => reply({ t: 'graph:reply', ...data })
      const visible = (name: string) => { const n = s.get(name, asOf); return n && (!viewer || n.scope === 'global' || viewer.includes(n.scope)) ? n : null }
      switch (t) {
        case 'graph:domains': return ok({ domains: domains(s, { asOf, viewer }) })
        case 'graph:names': {
          const kind = payload.kind ? String(payload.kind) as Kind : undefined
          if (kind && !kinds.includes(kind)) throw new GovernanceRefusal(`there is no kind "${kind}"`)
          return ok({ names: s.names(kind, { asOf, viewer }) })
        }
        case 'graph:show': { const n = visible(str(payload.name, 'name')); if (!n) throw new GovernanceRefusal(`there is no "${payload.name}"`); return ok({ node: n }) }
        case 'graph:history': { const name = str(payload.name, 'name'); if (!visible(name)) throw new GovernanceRefusal(`there is no "${name}"`); return ok({ history: s.history(name) }) }
        case 'graph:compose': { const c = compose(s, str(payload.domain, 'domain'), asOf, { viewer }); return ok({ composition: c }) }
        case 'graph:suggestions': return ok({ suggestions: g.list(s, { status: payload.status, name: payload.name }).filter((x) => visible(x.name) || x.by === who.id) })
        case 'graph:concept': case 'graph:domain': case 'graph:agent': {
          const kind = t === 'graph:concept' ? 'concept' : t === 'graph:domain' ? 'domain' : 'agent'
          const r = g.write(s, who, str(payload.name, 'name'), kind, payload.body, { reason: payload.reason }, payload.scope ? { scope: String(payload.scope) } : {})
          return ok({ name: payload.name, ...r, node: s.get(payload.name) })
        }
        case 'graph:join': case 'graph:leave': {
          const r = g.compose(s, who, str(payload.domain, 'domain'), str(payload.concept, 'concept'), { leave: t === 'graph:leave', at: payload.at === undefined ? undefined : Number(payload.at) }, payload.reason)
          return ok({ ...r, node: s.get(payload.domain) })
        }
        case 'graph:suggest': return ok({ suggestion: g.suggest(s, who, str(payload.name, 'name'), str(payload.kind, 'kind') as Kind, payload.body, String(payload.reason ?? '')) })
        case 'graph:publish': return ok({ suggestion: g.publish(s, who, str(payload.name, 'name'), str(payload.scope, 'scope') as any, String(payload.reason ?? '')) })
        case 'graph:decide': {
          const verdict = String(payload.verdict ?? '')
          if (!['approved', 'rejected', 'withdrawn'].includes(verdict)) throw new GovernanceRefusal('a verdict is approved, rejected or withdrawn')
          return ok({ suggestion: g.decide(s, who, Number(payload.id), verdict as 'approved' | 'rejected' | 'withdrawn', payload.reason) })
        }
      }
      throw new GovernanceRefusal(`there is no ${t}`)
    } catch (e: any) {
      if (e instanceof GovernanceRefusal || e instanceof IdentityRefusal || /^there is no (domain|concept)/.test(e?.message ?? '')) return reply({ t: 'graph:refused', reason: e.message })
      console.error('[graph]', e?.stack ?? e)
      return reply({ t: 'graph:refused', reason: `the graph could not do that: ${e?.message ?? e}` })
    }
  }
  return { handle, close: () => { store?.close(); store = null } }
}
