// ── The intent graph, as the project holds it (docs/intent-graph.md) ────────────────────────────────────────────────
//
// Each node lives in an IntentDO of its own (intent-do.ts); the project keeps the INDEX every node is found in
// (intent_index: its canonical form and words; intent_canon: every canonical form it was reached by), the ways between
// nodes (intent_edges, as each node keeps them, so the graph is read at once), the names its questions carry
// (intent_names) and the specialised agents its admins made (session_agents).
//
//   from the engine (every message goes to the session's composer; these give it what to decide with, and keep what
//   happened):
//     intent:find  { text, at?, owner, caps }  → the question's canonical form; the node the session is at; the
//                                                candidates — the one node with the same canonical form, else the
//                                                best five by their words (text search, no semantic search) — each
//                                                with the variant the person answers with
//     intent:pass  { node | body, … }          → the node (made when new), its passage kept, the way from `from` counted
//     intent:close { node, owner, … }          → what the clone of the session learnt at the end of an intent, kept
//     intent:next  { at, owner, caps }         → the ways out of a node, to offer after its answer
//   from people (the admin console, the user UI, sacli), over HTTP — read from what the platform keeps, the engine never
//   asked:  GET /intents · GET|PUT /intents/<id> · POST /intents/<id>/approve · GET|POST /session-agents · DELETE …
//
// A published knowledge version marks every node whose variants use what changed — or what is made of it — stale.

import { Store, sqlStorageGraphDb } from '../../../vm/packages/composition-graph/src/index.js'
import { BUILTIN_SESSION_AGENTS, SESSION_AGENT_NAME, SYSTEM_INTENT_NODES, INTENT_ID, canonicalOf, checkIntentBody, newIntentId, termsOf, textSearch, type IntentEdge, type IntentNodeBody, type IntentParam, type IntentVariantBody, type SessionAgentSpec } from '../../../vm/packages/platform-types/src/intent.js'
import { intentStub } from './intent-do.js'

/** How many nodes text search hands the composer when no node has the question's exact canonical form. */
const CANDIDATES = 5
const NEXT = 8

interface IndexRow { id: string; title: string; intent: string; canonical: string; terms: string[]; concepts: string[]; agent: string | null; needs: string | null; system: string | null; stale: string | null; passages: number; by: string; at: string; updated_at: string }
export interface NodeView { id: string; title: string; intent: string; canonical: string; agent: string | null; needs: string | null; allowed: boolean; system: boolean; passages: number; variant?: (IntentVariantBody & { whose: 'mine' | 'project'; verified: boolean; version: number; owner: string }) | null }

export function projectIntents(storage: DurableObjectStorage, env: unknown, project: () => string, can: (caps: string[], cap: string) => boolean) {
  const sql = storage.sql
  let store: Store | null = null
  const graph = () => (store ??= new Store(sqlStorageGraphDb(storage as any)))
  const now = () => new Date().toISOString()
  const index = (): IndexRow[] => [...sql.exec('SELECT * FROM intent_index ORDER BY updated_at DESC')].map(rowOf)
  const one = (id: string): IndexRow | null => { const r = [...sql.exec('SELECT * FROM intent_index WHERE id = ?', id)][0]; return r ? rowOf(r) : null }
  const stub = (id: string) => intentStub(env, project(), id)
  const known = (): IntentParam[] => [...sql.exec('SELECT value, kind FROM intent_names')].map((r: any) => ({ value: String(r.value), kind: String(r.kind) }))
  const allowed = (n: Pick<IndexRow, 'needs'>, caps: string[]) => !n.needs || can(caps, n.needs)
  const view = (n: IndexRow, caps: string[]): NodeView => ({ id: n.id, title: n.title, intent: n.intent, canonical: n.canonical, agent: n.agent, needs: n.needs, allowed: allowed(n, caps), system: !!n.system, passages: n.passages })

  function indexed(n: { id: string; title: string; intent: string; canonical: string; agent?: string | null; needs?: string | null; system?: boolean; by: string; at: string }, extra: { concepts?: string[]; passages?: number } = {}) {
    const was = one(n.id)
    const forms = [...sql.exec('SELECT canonical FROM intent_canon WHERE id = ?', n.id)].map((r: any) => String(r.canonical))
    const terms = [...new Set([...termsOf(n.canonical), ...forms.flatMap(termsOf), ...termsOf(canonicalOf(n.title).canonical)])]
    sql.exec(`INSERT INTO intent_index (id, title, intent, canonical, terms, concepts, agent, needs, system, stale, passages, by, at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, intent = excluded.intent, canonical = excluded.canonical, terms = excluded.terms, concepts = excluded.concepts, agent = excluded.agent, needs = excluded.needs, passages = excluded.passages, updated_at = excluded.updated_at`,
      n.id, n.title, n.intent, n.canonical, JSON.stringify(terms), JSON.stringify(extra.concepts ?? was?.concepts ?? []), n.agent ?? null, n.needs ?? null, n.system ? 'platform' : null, extra.passages ?? was?.passages ?? 0, n.by, n.at, now())
    sql.exec('INSERT OR IGNORE INTO intent_canon (canonical, id, at) VALUES (?, ?, ?)', n.canonical, n.id, now())
  }

  /** A node made: its own Durable Object, then the index. */
  async function make(body: IntentNodeBody, by: string, why: string, id = newIntentId()) {
    const bad = checkIntentBody(body); if (bad) throw new Error(bad)
    const n = await stub(id).write(id, body, by, why)
    indexed(n)
    return one(id)!
  }

  /** The platform's own nodes (one for each of its agents), made once in every project. */
  let ensured = false
  async function ensureSystemNodes() {
    if (ensured) return
    for (const s of SYSTEM_INTENT_NODES) {
      const id = `in-system${s.key}`
      if (one(id)) continue
      const { key: _k, ...body } = s
      await make({ ...body, canonical: canonicalOf(s.asked).canonical, params: [] }, 'platform', `the platform's node for its ${s.key} agent`, id)
    }
    ensured = true
  }

  function agents(caps: string[] | null): (Omit<SessionAgentSpec, 'instructions'> & { instructions?: string; allowed: boolean })[] {
    const own = [...sql.exec('SELECT * FROM session_agents ORDER BY name')].map((r: any) => ({ name: r.name, title: r.title, description: r.description, instructions: r.instructions, needs: r.needs, harness: r.harness }) as SessionAgentSpec)
    return [...BUILTIN_SESSION_AGENTS, ...own].map((a) => ({ ...a, allowed: caps ? can(caps, a.needs) : false }))
  }

  /** A node as a person meets it: with the variant they answer with (their own, else the project's). */
  async function withVariant(n: IndexRow, owner: string, caps: string[]): Promise<NodeView> {
    const v = await stub(n.id).variantFor(owner)
    return { ...view(n, caps), variant: v.variant ? { concepts: v.variant.concepts, process: v.variant.process, show: v.variant.show, paths: v.variant.paths, ...(v.variant.about ? { about: v.variant.about } : {}), whose: v.whose!, verified: v.verified, version: v.variant.version, owner: v.variant.owner } : null }
  }

  async function edgeKept(from: string, e: IntentEdge) {
    sql.exec(`INSERT INTO intent_edges (from_id, to_id, owner, tag, count, label, last) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_id, to_id, owner, tag) DO UPDATE SET count = excluded.count, label = excluded.label, last = excluded.last`, from, e.to, e.owner, e.tag, e.count, e.label, e.last)
  }

  return {
    ensureSystemNodes,

    /** What the composer decides a message with: its canonical form, the node the session is at, and the candidates. */
    async find(m: { text: string; at?: string | null; owner: string; caps?: string[] }) {
      await ensureSystemNodes()
      const caps = m.caps ?? []
      const { canonical, params } = canonicalOf(m.text, known())
      const all = index()
      const hereRow = m.at ? all.find((n) => n.id === m.at) ?? null : null
      const here = hereRow ? await withVariant(hereRow, m.owner, caps) : null
      // The one node with the same canonical form (the most answered, when the same form reached two), else the best five
      // by their words. The node the session is at is never its own candidate.
      const exactIds = new Set([...sql.exec('SELECT id FROM intent_canon WHERE canonical = ?', canonical)].map((r: any) => String(r.id)))
      const exactRow = all.filter((n) => exactIds.has(n.id) && n.id !== m.at).sort((a, b) => b.passages - a.passages)[0]
      // Each with the variant the person answers with: the composer decides and answers in one turn.
      const candidates: NodeView[] = await Promise.all((exactRow ? [exactRow] : textSearch(termsOf(canonical), all.filter((n) => n.id !== m.at), CANDIDATES).map((x) => x.node)).map((n) => withVariant(n, m.owner, caps)))
      return { canonical, params, exact: !!exactRow, here, candidates, total: all.length }
    },

    /** A node read for answering at it (the composer chose a candidate): with the variant the person answers with. */
    async nodeFor(m: { id: string; owner: string; caps?: string[] }) {
      const n = one(m.id); if (!n) throw new Error(`there is no intent node ${m.id}`)
      return withVariant(n, m.owner, m.caps ?? [])
    },

    /** A question answered: at a node already known, or at one made now (by the analyst, never the composer); the way from
     *  the node before, counted. A question matched to a node teaches it one more canonical form. */
    async pass(m: { node?: string | null; body?: IntentNodeBody; from?: string | null; session: string; block?: string | null; question: string; canonical?: string; params?: IntentParam[]; answer: string; owner: string; by: string; agent: string; how: 'matched' | 'made' | 'same' }) {
      let id = m.node ?? null
      if (!id) {
        if (!m.body) throw new Error('a new node comes with its body')
        id = (await make(m.body, m.by, `made for "${m.question.slice(0, 120)}"`)).id
      }
      const n = one(id); if (!n) throw new Error(`there is no intent node ${id}`)
      if (m.how === 'matched' && m.canonical && m.canonical !== n.canonical) { sql.exec('INSERT OR IGNORE INTO intent_canon (canonical, id, at) VALUES (?, ?, ?)', m.canonical, id, now()); indexed({ ...n, system: !!n.system }) }
      const { passages } = await stub(id).pass({ node: id, session: m.session, block: m.block ?? null, question: m.question, params: m.params ?? [], answer: m.answer, who: m.by, agent: m.agent, at: now(), how: m.how, from: m.from ?? null })
      sql.exec('UPDATE intent_index SET passages = ?, updated_at = ? WHERE id = ?', passages, now(), id)
      if (m.from && m.from !== id && one(m.from)) await edgeKept(m.from, await stub(m.from).edge({ to: id, owner: m.owner, tag: 'asked', label: n.title, taken: true }))
      return { node: view(one(id)!, []) }
    },

    /** What the clone of a session learnt when an intent closed: the person's variant (written only when it differs from
     *  what they answered with), what the node is (a node the analyst made in this session), the names in its questions,
     *  and the next intents it suggests — each a node (found by its canonical form, else made) with a way out to it. */
    async close(m: { node: string; owner: string; by: string; session: string; madeHere?: boolean; title?: string; intent?: string; variant?: IntentVariantBody | null; names?: IntentParam[]; next?: { asked: string; title?: string; label?: string; check?: string | null }[] }) {
      const n = one(m.node); if (!n) throw new Error(`there is no intent node ${m.node}`)
      const out: { variant?: { version: number; changed: boolean }; renamed?: boolean; names: number; next: string[] } = { names: 0, next: [] }
      if (m.madeHere && !n.system && (m.title?.trim() || m.intent?.trim())) {
        const cur = (await stub(n.id).read({ passages: 0 }))!.node
        const body: IntentNodeBody = { title: (m.title?.trim() || cur.title).slice(0, 160), intent: (m.intent?.trim() || cur.intent).slice(0, 4000), asked: cur.asked, canonical: cur.canonical, params: cur.params, agent: cur.agent ?? null, needs: cur.needs ?? null }
        if (body.title !== cur.title || body.intent !== cur.intent) { indexed(await stub(n.id).write(n.id, body, m.by, `what it is, from the session that made it (${m.session})`)); out.renamed = true }
      }
      if (m.variant) {
        const r = await stub(n.id).putVariant(m.owner, m.variant, m.by, `learnt in session ${m.session}`)
        out.variant = { version: r.variant.version, changed: r.changed }
        if (r.changed) {
          const concepts = [...new Set([...one(n.id)!.concepts, ...m.variant.concepts])]
          sql.exec('UPDATE intent_index SET concepts = ?, updated_at = ? WHERE id = ?', JSON.stringify(concepts), now(), n.id)
        }
      }
      for (const p of m.names ?? []) {
        const value = String(p?.value ?? '').trim().toLowerCase(), kind = String(p?.kind ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
        if (value.length < 2 || value.length > 80 || !kind || ['date', 'period', 'year', 'number', 'code'].includes(kind)) continue
        sql.exec('INSERT INTO intent_names (value, kind, by, at) VALUES (?, ?, ?, ?) ON CONFLICT(value) DO NOTHING', value, kind, m.by, now())
        out.names++
      }
      for (const s of (m.next ?? []).slice(0, 8)) {
        const asked = String(s?.asked ?? '').trim(); if (!asked) continue
        const { canonical, params } = canonicalOf(asked, known())
        const hit = [...sql.exec('SELECT id FROM intent_canon WHERE canonical = ?', canonical)].map((r: any) => String(r.id)).find((id) => id !== n.id && one(id))
        const to = hit ?? (await make({ title: (s.title?.trim() || asked).slice(0, 160), intent: asked, asked, canonical, params }, m.by, `suggested after "${n.title}" (session ${m.session})`)).id
        await edgeKept(n.id, await stub(n.id).edge({ to, owner: m.owner, tag: 'suggested', label: (s.label?.trim() || s.title?.trim() || asked).slice(0, 200), check: typeof s.check === 'string' && s.check.trim() ? s.check : null }))
        out.next.push(to)
      }
      return out
    },

    /** The ways out of a node to offer after its answer: the person's own first, then everyone's; asked before suggested. */
    async next(m: { at: string; owner: string; caps?: string[] }) {
      const n = one(m.at); if (!n) return { next: [] }
      const edges = await stub(m.at).edges()
      edges.sort((a, b) => (Number(b.owner === m.owner) - Number(a.owner === m.owner)) || (Number(b.tag === 'asked') - Number(a.tag === 'asked')) || b.count - a.count)
      const seen = new Set<string>(), out: (IntentEdge & { title: string; allowed: boolean })[] = []
      for (const e of edges) {
        const to = one(e.to); if (!to || seen.has(e.to)) continue
        seen.add(e.to); out.push({ ...e, title: to.title, allowed: allowed(to, m.caps ?? []) })
        if (out.length >= NEXT) break
      }
      return { next: out }
    },

    /** Every node and every way between them. */
    async graph() {
      await ensureSystemNodes()
      const nodes = index().map(({ terms: _t, ...n }) => n)
      const edges = [...sql.exec('SELECT * FROM intent_edges ORDER BY count DESC')].map((r: any) => ({ from: r.from_id, to: r.to_id, owner: r.owner, tag: r.tag, count: Number(r.count), label: r.label, last: r.last }))
      return { nodes, edges }
    },

    /** One node: its versions, everyone's variants, the project's view, its ways out and its latest passages. */
    async node(id: string) {
      if (!INTENT_ID.test(id) || !one(id)) throw new Error(`there is no intent node ${id}`)
      return stub(id).read({ passages: 50 })
    },

    /** A node changed by who runs the project (a new version): what it is, its agent, who may be answered there. */
    async write(id: string, patch: Partial<Pick<IntentNodeBody, 'title' | 'intent' | 'agent' | 'needs'>>, by: string, why: string) {
      if (!one(id)) throw new Error(`there is no intent node ${id}`)
      const cur = (await stub(id).read({ passages: 0 }))!.node
      const body: IntentNodeBody = { title: patch.title ?? cur.title, intent: patch.intent ?? cur.intent, asked: cur.asked, canonical: cur.canonical, params: cur.params, agent: patch.agent !== undefined ? patch.agent : cur.agent ?? null, needs: patch.needs !== undefined ? patch.needs : cur.needs ?? null, ...(cur.system ? { system: true } : {}) }
      if (body.agent && !agents(null).some((a) => a.name === body.agent)) throw new Error(`there is no agent "${body.agent}"`)
      indexed(await stub(id).write(id, body, by, why || 'changed by a person'))
      return { node: one(id)! }
    },

    /** One person's variant approved as the project's way of answering the node. */
    async approve(id: string, owner: string, version: number, by: string, why: string) {
      if (!one(id)) throw new Error(`there is no intent node ${id}`)
      await stub(id).approve(owner, version, by, why || 'approved')
      return stub(id).read({ passages: 0 })
    },

    agents,
    saveAgent(spec: SessionAgentSpec, by: string) {
      if (!SESSION_AGENT_NAME.test(String(spec?.name ?? ''))) throw new Error('an agent is named in lower case: letters, digits and -, 2 to 40')
      if (BUILTIN_SESSION_AGENTS.some((b) => b.name === spec.name)) throw new Error(`${spec.name} is one of Superatom's own agents`)
      for (const k of ['title', 'description', 'instructions', 'needs'] as const) if (typeof spec[k] !== 'string' || !spec[k].trim()) throw new Error(`an agent has ${k === 'needs' ? 'the capability it needs' : `a ${k}`}`)
      if (spec.harness !== 'claude-code' && spec.harness !== 'codex') throw new Error('an agent runs on claude-code or codex')
      sql.exec(`INSERT INTO session_agents (name, title, description, instructions, needs, harness, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET title = excluded.title, description = excluded.description, instructions = excluded.instructions, needs = excluded.needs, harness = excluded.harness, by = excluded.by, at = excluded.at`,
        spec.name, spec.title.trim(), spec.description.trim(), spec.instructions.trim(), spec.needs.trim(), spec.harness, by, now())
      return { saved: spec.name }
    },
    removeAgent(name: string) { sql.exec('DELETE FROM session_agents WHERE name = ?', name); return { removed: name } },
    /** An agent's full spec, for the engine that runs it (instructions included). */
    agentSpec(name: string) { return agents(null).find((a) => a.name === name) ?? null },

    /** Knowledge published: every node whose variants use a changed name — or a composite or domain made of one — is stale. */
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
      const hit = index().filter((n) => n.concepts.some((c) => affected.has(c)))
      const why = `knowledge ${version} changed ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? '…' : ''}`
      for (const n of hit) { await stub(n.id).markStale(why); sql.exec('UPDATE intent_index SET stale = ?, updated_at = ? WHERE id = ?', why, now(), n.id) }
      return hit.length
    },
  }
}

const rowOf = (r: any): IndexRow => ({ id: r.id, title: r.title, intent: r.intent, canonical: r.canonical, terms: JSON.parse(String(r.terms)), concepts: JSON.parse(String(r.concepts ?? '[]')), agent: r.agent ?? null, needs: r.needs ?? null, system: r.system ?? null, stale: r.stale ?? null, passages: Number(r.passages), by: r.by, at: r.at, updated_at: r.updated_at })
