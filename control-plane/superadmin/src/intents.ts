// ── The intent graph, as the project holds it (docs/intent-graph.md) ────────────────────────────────────────────────
//
// Each node lives in its cluster's IntentDO (intent-do.ts); the project keeps an INDEX of every node (intent_index) so a
// question can be placed against all of them with one read, and the specialised agents its admins made (session_agents).
//
//   from the engine (it places each question, then says what happened):
//     intent:context { at?, text, caps }   → the node the session is at, the nodes people went to from it, the nodes
//                                              that read like the question, the domains, the agents the asker may use
//     intent:record  { node | body, from?, session, block?, question, answer, who, scope, how }
//                                           → the node (made when new), its passage kept, the way from `from` counted
//   from people (the admin console, the user UI, sacli):
//     intent:graph   · intent:node { id }   · intent:write { id, body, why }
//     agents:list    · agents:save { spec } · agents:remove { name }
//
// A published knowledge version marks every node linking to what changed — or to what is made of it — stale.

import { Store, sqlStorageGraphDb } from '../../../vm/packages/composition-graph/src/index.js'
import { BUILTIN_SESSION_AGENTS, SESSION_AGENT_NAME, checkIntentBody, clusterFor, clusterOf, newIntentId, type IntentEdge, type IntentLink, type IntentNode, type IntentNodeBody, type SessionAgentSpec } from '../../../vm/packages/platform-types/src/intent.js'
import { intentStub } from './intent-do.js'

export const INTENT_MESSAGES = new Set(['intent:graph', 'intent:node', 'intent:write', 'agents:list', 'agents:save', 'agents:remove'])
const SIMILAR = 8, NEXT = 6

interface IndexRow { id: string; cluster: string; title: string; intent: string; links: IntentLink[]; agent: string | null; stale: string | null; passages: number; by: string; at: string; updated_at: string }
const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? [])
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, Math.min(a.size, b.size)) }

export function projectIntents(storage: DurableObjectStorage, env: unknown, project: () => string, can: (caps: string[], cap: string) => boolean) {
  const sql = storage.sql
  let store: Store | null = null
  const graph = () => (store ??= new Store(sqlStorageGraphDb(storage as any)))
  const index = (): IndexRow[] => [...sql.exec('SELECT * FROM intent_index ORDER BY updated_at DESC')].map(rowOf)
  const one = (id: string): IndexRow | null => { const r = [...sql.exec('SELECT * FROM intent_index WHERE id = ?', id)][0]; return r ? rowOf(r) : null }
  const stub = (cluster: string) => intentStub(env, project(), cluster)
  const indexed = (n: IntentNode) => sql.exec(`INSERT INTO intent_index (id, cluster, title, intent, links, agent, stale, passages, by, at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, intent = excluded.intent, links = excluded.links, agent = excluded.agent, stale = excluded.stale, passages = excluded.passages, updated_at = excluded.updated_at`,
    n.id, n.cluster, n.title, n.intent, JSON.stringify(n.links), n.agent ?? null, n.stale ?? null, n.passages ?? 0, n.by, n.at, new Date().toISOString())

  function agents(caps: string[] | null): (Omit<SessionAgentSpec, 'instructions'> & { instructions?: string; allowed: boolean })[] {
    const own = [...sql.exec('SELECT * FROM session_agents ORDER BY name')].map((r: any) => ({ name: r.name, title: r.title, description: r.description, instructions: r.instructions, needs: r.needs, harness: r.harness }) as SessionAgentSpec)
    return [...BUILTIN_SESSION_AGENTS, ...own].map((a) => ({ ...a, allowed: caps ? can(caps, a.needs) : false }))
  }

  /** Domains, with what each is about — what a new node may link to. */
  function domains() {
    const s = graph()
    return s.names('domain').map((d) => { const b = s.get<any>(d.name)?.body ?? {}; return { name: d.name, title: String(b.title ?? d.name), description: String(b.description ?? '') } })
  }

  return {
    /** What the engine needs to place a question: where the session is, where people went from there, what reads like it. */
    async context(m: { at?: string | null; text: string; caps?: string[]; scopes?: string[] }) {
      const all = index()
      const here = m.at ? all.find((n) => n.id === m.at) ?? null : null
      let next: (IndexRow & { count: number; scope: string })[] = []
      if (here) {
        const out = await stub(here.cluster).edges([here.id])
        const mine = new Set(m.scopes ?? [])
        // The narrowest scope first: the person's own ways, their groups', everyone's — then the most taken.
        out.sort((a, b) => (Number(mine.has(b.scope)) - Number(mine.has(a.scope))) || b.count - a.count)
        const seen = new Set<string>()
        for (const e of out) { if (seen.has(e.to)) continue; const n = all.find((x) => x.id === e.to); if (n) { seen.add(e.to); next.push({ ...n, count: e.count, scope: e.scope }) } if (next.length >= NEXT) break }
      }
      const q = words(m.text)
      const similar = all.filter((n) => n.id !== here?.id && !next.some((x) => x.id === n.id))
        .map((n) => ({ n, s: overlap(q, words(`${n.title} ${n.intent}`)) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, SIMILAR).map((x) => x.n)
      return { here, next, similar, domains: domains(), agents: agents(m.caps ?? []).map(({ name, title, description, allowed }) => ({ name, title, description, allowed })), total: all.length }
    },

    /** A question answered: at a node already known, or at one made now; the way from the node before, counted. */
    async record(m: { node?: string | null; body?: IntentNodeBody; from?: string | null; session: string; block?: string | null; question: string; answer: string; who: string; scope: string; how: 'followed' | 'made' | 'stayed' }) {
      let id = m.node ?? null
      if (!id) {
        if (!m.body) throw new Error('a new node comes with its body')
        const bad = checkIntentBody(m.body); if (bad) throw new Error(bad)
        id = newIntentId(clusterFor(m.body))
        const made = await stub(clusterOf(id)!).write(id, m.body, m.who, `made for "${m.question.slice(0, 120)}"`)
        indexed(made)
      }
      const cluster = clusterOf(id)
      if (!cluster || !one(id)) throw new Error(`there is no intent node ${id}`)
      const { passages } = await stub(cluster).pass({ node: id, session: m.session, block: m.block ?? null, question: m.question, answer: m.answer, who: m.who, at: new Date().toISOString(), how: m.how, from: m.from ?? null })
      sql.exec('UPDATE intent_index SET passages = ?, updated_at = ? WHERE id = ?', passages, new Date().toISOString(), id)
      if (m.from && m.from !== id) { const fc = clusterOf(m.from); if (fc && one(m.from)) await stub(fc).edge(m.from, id, m.scope) }
      return { node: one(id)! }
    },

    /** Every node and every way between them. */
    async graph() {
      const nodes = index()
      const clusters = [...new Set(nodes.map((n) => n.cluster))]
      const edges: IntentEdge[] = (await Promise.all(clusters.map((c) => stub(c).edges()))).flat()
      return { nodes, edges, clusters }
    },

    async node(id: string) {
      const c = clusterOf(id); if (!c || !one(id)) throw new Error(`there is no intent node ${id}`)
      return stub(c).node(id, { passages: 50 })
    },

    /** A node changed by a person (a new version; its stale mark cleared). */
    async write(id: string, body: IntentNodeBody, by: string, why: string) {
      const c = clusterOf(id); if (!c || !one(id)) throw new Error(`there is no intent node ${id}`)
      const n = await stub(c).write(id, body, by, why || 'changed by a person')
      indexed({ ...n, passages: one(id)!.passages })
      return { node: one(id)! }
    },

    agents,
    saveAgent(spec: SessionAgentSpec, by: string) {
      if (!SESSION_AGENT_NAME.test(String(spec?.name ?? ''))) throw new Error('an agent is named in lower case: letters, digits and -, 2 to 40')
      if (BUILTIN_SESSION_AGENTS.some((b) => b.name === spec.name)) throw new Error(`${spec.name} is one of Superatom's own agents`)
      for (const k of ['title', 'description', 'instructions', 'needs'] as const) if (typeof spec[k] !== 'string' || !spec[k].trim()) throw new Error(`an agent has ${k === 'needs' ? 'the capability it needs' : `a ${k}`}`)
      if (spec.harness !== 'claude-code' && spec.harness !== 'codex') throw new Error('an agent runs on claude-code or codex')
      sql.exec(`INSERT INTO session_agents (name, title, description, instructions, needs, harness, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET title = excluded.title, description = excluded.description, instructions = excluded.instructions, needs = excluded.needs, harness = excluded.harness, by = excluded.by, at = excluded.at`,
        spec.name, spec.title.trim(), spec.description.trim(), spec.instructions.trim(), spec.needs.trim(), spec.harness, by, new Date().toISOString())
      return { saved: spec.name }
    },
    removeAgent(name: string) { sql.exec('DELETE FROM session_agents WHERE name = ?', name); return { removed: name } },
    /** An agent's full spec, for the engine that runs it (instructions included). */
    agentSpec(name: string) { return agents(null).find((a) => a.name === name) ?? null },

    /** Knowledge published: every node linking to a changed name — or to a domain or composite made of one — is stale. */
    async staleAfter(changed: string[], version: string) {
      if (!changed.length) return 0
      const s = graph()
      const affected = new Set(changed)
      // Upward: what is made of what changed (a composite of a concept, a domain of either), until nothing new.
      for (let grew = true; grew;) {
        grew = false
        for (const n of s.names()) {
          if (affected.has(n.name) || (n.kind !== 'domain' && n.kind !== 'concept')) continue
          const b = s.get<any>(n.name)?.body ?? {}
          const parts: string[] = [...(Array.isArray(b.concepts) ? b.concepts : []), ...(Array.isArray(b.parts) ? b.parts : [])]
          if (parts.some((p) => affected.has(p))) { affected.add(n.name); grew = true }
        }
      }
      const hit = index().filter((n) => n.links.some((l) => affected.has(l.name)))
      const why = `knowledge ${version} changed ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? '…' : ''}`
      const byCluster = new Map<string, string[]>()
      for (const n of hit) byCluster.set(n.cluster, [...(byCluster.get(n.cluster) ?? []), n.id])
      for (const [c, ids] of byCluster) await stub(c).markStale(ids, why)
      for (const n of hit) sql.exec('UPDATE intent_index SET stale = ?, updated_at = ? WHERE id = ?', why, new Date().toISOString(), n.id)
      return hit.length
    },
  }
}

const rowOf = (r: any): IndexRow => ({ id: r.id, cluster: r.cluster, title: r.title, intent: r.intent, links: JSON.parse(String(r.links)), agent: r.agent ?? null, stale: r.stale ?? null, passages: Number(r.passages), by: r.by, at: r.at, updated_at: r.updated_at })
