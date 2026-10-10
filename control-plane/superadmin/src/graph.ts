// ── The composition graph, held by the platform — in the project's own Durable Object ───────────────────────────────
//
// The project's graph lives here: every read people make of it, and every governed change (make, change, join, leave,
// suggest, decide, publish, the draft and its versions), is answered here from the Durable Object's SQLite — the same
// @superatom/composition-graph package the engines use, over this storage (sqlStorageGraphDb). Engines keep a replica:
// they pull what changed after their cursor (graph:pull) when told something did (graph:changed), and never write it.
// The questions the engines route are recorded here too (graph:asked). Every record a change adds also goes to the
// platform's own record stream (records.ts), as before.
//
//   graph:domains | graph:names { kind? } | graph:show { name, asOf? } | graph:history { name } | graph:compose { domain }
//   graph:suggestions { status?, name? }
//   graph:concept | graph:domain | graph:agent { name, body, reason?, scope? }    make or change a node one owns
//   graph:map { body, reason? }                                                  the project's map (someone who may publish)
//   graph:join | graph:leave { into|domain, concept, at?, reason? }              compose a concept into a domain or concept
//   graph:suggest { name, kind, body, reason } · graph:decide { id, verdict, reason? } · graph:publish { name, scope, reason }
//   graph:versions · graph:version { message } (publish the draft) · graph:restore { name } (the draft set to a version)
//   graph:import { domains, settings?, files: { "<domain>|<file>": text }, reason? }   a project's written knowledge, imported
//                (sacli graph import knowledge/index.mts) — by someone who may publish; one unit, all or none
//   inspect views: composition, compositionNode, compositionCompose, compositionColumns
// → graph:reply { … } | graph:refused { reason }.

import {
  Store, sqlStorageGraphDb, MIGRATIONS, compose, drift, domains as domainsOf, conceptsOf, governance as g, GovernanceRefusal,
  publishDraft, restoreVersion, draft, published, versionLine, sincePublished, replicaSince, START, importDomains, exportKnowledge, knowledgeSource, graphAt,
  type Kind, type Cursor, type DomainBody, type ConceptBody, type FileBody,
} from '../../../vm/packages/composition-graph/src/index.js'
import { migrate, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { createRecorder } from './records.js'
import { PLATFORM_VIEWS } from '../../shared/hub-messages.js'
import { DEFAULT_AGENT, DEFAULT_DOMAIN } from './default-agent.js'

type Storage = DurableObjectStorage
/** Who acts, as the hub knows them: user:<id> or agent:<key>, whether they may publish, their email, the scopes they see. */
export interface Who { id: string; admin: boolean; email?: string; scopes: string[] }

export const GRAPH_MESSAGES = new Set(['graph:domains', 'graph:names', 'graph:show', 'graph:history', 'graph:compose', 'graph:suggestions', 'graph:concept', 'graph:domain', 'graph:agent', 'graph:map', 'graph:join', 'graph:leave', 'graph:suggest', 'graph:decide', 'graph:publish', 'graph:versions', 'graph:version', 'graph:restore', 'graph:import', 'graph:remove', 'graph:export'])
export const GRAPH_VIEWS = new Set<string>(PLATFORM_VIEWS)
/** What changes the graph (an engine is told to pull after one). */
const WRITES = new Set(['graph:import', 'graph:remove', 'graph:concept', 'graph:domain', 'graph:agent', 'graph:map', 'graph:join', 'graph:leave', 'graph:suggest', 'graph:decide', 'graph:publish', 'graph:version', 'graph:restore'])
const KINDS: Kind[] = ['domain', 'concept', 'file', 'setting', 'agent', 'map']

/** The graph's own tables, by its own migrations (kept apart from the Durable Object's: _graph_migrations). */
export function migrateGraph(storage: Storage) {
  migrate(durableObjectDb(storage), MIGRATIONS, { name: 'the composition graph', table: '_graph_migrations' })
}

export function projectGraph(storage: Storage, env: unknown, project: () => string) {
  const store = new Store(sqlStorageGraphDb(storage))
  const sql = storage.sql
  const one = (q: string) => Number([...sql.exec(q)][0]?.v ?? 0)
  const cursor = (): Cursor => ({ change: store.lastChange(), suggestion: one('SELECT MAX(id) AS v FROM suggestion'), decisionAt: one('SELECT MAX(at) AS v FROM decision'), version: one('SELECT MAX(id) AS v FROM version') })
  const people = () => Object.fromEntries([...sql.exec('SELECT id, email FROM graph_people')].map((r) => [String(r.id), String(r.email)]))
  const notePerson = (who: Who) => { if (who.email) sql.exec('INSERT INTO graph_people (id, email) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email', who.id, who.email) }

  /** What a change added, to the platform's record stream (each record once: its id names it). */
  function recordSince(from: Cursor) {
    const record = createRecorder((env as any).RECORDS, project)
    const b = replicaSince(store, from, 1000)
    const content = (h: unknown) => (typeof h === 'string' && b.contents[h] ? { content: JSON.parse(b.contents[h]) } : {})
    const at = (r: Record<string, unknown>) => new Date(Number(r.at ?? 0) || Date.now()).toISOString()
    for (const r of b.changes) record('graph.change', String(r.id), { ...r, ...content(r.to_hash) }, at(r))
    for (const r of b.suggestions) record('graph.suggestion', String(r.id), { ...r, ...content(r.body_hash) }, at(r))
    for (const r of b.decisions) if (Number(r.at) > from.decisionAt) record('graph.decision', String(r.suggestion), r, at(r))
    for (const r of b.versions ?? []) record('graph.version', String(r.id), r, at(r))
  }

  /** One graph message from a person or an agent: the reply, and whether the graph changed. */
  function handle(payload: any, who: Who): { reply: Record<string, unknown>; changed: boolean } {
    const t = String(payload?.t ?? '')
    const str = (v: unknown, what: string) => { if (typeof v !== 'string' || !v.trim()) throw new GovernanceRefusal(`${what} is required`); return v.trim() }
    try {
      notePerson(who)
      const s = store
      const viewer = who.admin ? undefined : who.scopes
      const asOf = payload.asOf ? Date.parse(String(payload.asOf)) : undefined
      if (asOf !== undefined && Number.isNaN(asOf)) throw new GovernanceRefusal(`"${payload.asOf}" is not a time`)
      const visible = (name: string) => { const n = s.get(name, asOf); return n && (!viewer || n.scope === 'global' || viewer.includes(n.scope)) ? n : null }
      const before = WRITES.has(t) ? cursor() : null
      const compute = (): Record<string, unknown> => {
        switch (t) {
          case 'graph:domains': return { domains: domainsOf(s, { asOf, viewer }) }
          case 'graph:names': {
            const kind = payload.kind ? String(payload.kind) as Kind : undefined
            if (kind && !KINDS.includes(kind)) throw new GovernanceRefusal(`there is no kind "${kind}"`)
            return { names: s.names(kind, { asOf, viewer }) }
          }
          case 'graph:show': { const n = visible(str(payload.name, 'name')); if (!n) throw new GovernanceRefusal(`there is no "${payload.name}"`); return { node: n } }
          case 'graph:history': { const name = str(payload.name, 'name'); if (!visible(name)) throw new GovernanceRefusal(`there is no "${name}"`); return { history: s.history(name) } }
          case 'graph:compose': return { composition: compose(s, str(payload.domain, 'domain'), asOf, { viewer }) }
          case 'graph:suggestions': return { suggestions: g.list(s, { status: payload.status, name: payload.name }).filter((x) => visible(x.name) || x.by === who.id) }
          case 'graph:concept': case 'graph:domain': case 'graph:agent': {
            const kind = t === 'graph:concept' ? 'concept' : t === 'graph:domain' ? 'domain' : 'agent'
            const r = g.write(s, who, str(payload.name, 'name'), kind, payload.body, { reason: payload.reason }, payload.scope ? { scope: String(payload.scope) } : {})
            return { name: payload.name, ...r, node: s.get(payload.name) }
          }
          case 'graph:map': {
            if (!who.admin) throw new GovernanceRefusal('the project\'s map is written by someone who may publish')
            const r = g.write(s, who, 'map', 'map', payload.body, { reason: payload.reason }, { scope: 'global' })
            return { name: 'map', ...r, node: s.get('map') }
          }
          case 'graph:join': case 'graph:leave': {
            const into = str(payload.into ?? payload.domain, 'into')
            const r = g.compose(s, who, into, str(payload.concept, 'concept'), { leave: t === 'graph:leave', at: payload.at === undefined ? undefined : Number(payload.at) }, payload.reason)
            return { ...r, node: s.get(into) }
          }
          case 'graph:suggest': return { suggestion: g.suggest(s, who, str(payload.name, 'name'), str(payload.kind, 'kind') as Kind, payload.body, String(payload.reason ?? '')) }
          case 'graph:publish': return { suggestion: g.publish(s, who, str(payload.name, 'name'), str(payload.scope, 'scope') as any, String(payload.reason ?? '')) }
          case 'graph:versions': return { people: people(), versions: versionLine(s), published: published(s)?.name ?? null, draft: draft(s), since: sincePublished(s).map((c) => ({ id: c.id, at: c.at, name: c.name, kind: c.kind, by: c.by, reason: c.reason, removed: !c.toHash })) }
          case 'graph:version': return { version: publishDraft(s, who, String(payload.message ?? '')) }
          case 'graph:import': {
            if (!who.admin) throw new GovernanceRefusal('importing knowledge is for someone who may publish')
            if (!Array.isArray(payload.domains)) throw new GovernanceRefusal('an import names its domains')
            const files = (payload.files ?? {}) as Record<string, string>
            const read = (domain: string, file: string) => { const t = files[`${domain}|${file}`]; if (typeof t !== 'string') throw new GovernanceRefusal(`the import lacks the text of ${file} (domain ${domain})`); return t }
            const imported = s.db.atomic(() => importDomains(s, payload.domains, read, { by: who.id, reason: String(payload.reason ?? 'imported from the project\'s knowledge') }, Array.isArray(payload.settings) ? payload.settings : [], Array.isArray(payload.concepts) ? payload.concepts : []))
            return { imported }
          }
          case 'graph:export': {
            // The graph written back as knowledge, to edit and import again: the draft (where edits go) unless a version is named.
            if (!who.admin) throw new GovernanceRefusal('exporting the knowledge is for someone who may publish')
            const at = graphAt(s, String(payload.graph ?? 'draft'))
            const exported = exportKnowledge(s, at.upto, at.name)
            return { graph: at.name, source: knowledgeSource(exported, new Date().toISOString()), files: exported.files, counts: { domains: exported.domains.length, concepts: exported.concepts.length, settings: exported.settings.length, files: Object.keys(exported.files).length } }
          }
          case 'graph:remove': return { removed: g.remove(s, who, str(payload.name, 'name'), String(payload.reason ?? '')) }
          case 'graph:restore': return { restored: restoreVersion(s, who, str(payload.name, 'name')), version: s.version(String(payload.name)) }
          case 'graph:decide': {
            const verdict = String(payload.verdict ?? '')
            if (!['approved', 'rejected', 'withdrawn'].includes(verdict)) throw new GovernanceRefusal('a verdict is approved, rejected or withdrawn')
            return { suggestion: g.decide(s, who, Number(payload.id), verdict as 'approved' | 'rejected' | 'withdrawn', payload.reason) }
          }
        }
        throw new GovernanceRefusal(`there is no ${t}`)
      }
      // A PROJECT ALWAYS HAS A DEFAULT AGENT: a change that would leave it with none (its default removed, unmarked, or a
      // version restored that had none) is refused, whole.
      const data = WRITES.has(t) ? s.db.atomic(() => {
        const had = hasDefault()
        const out = compute()
        if (had && !hasDefault()) throw new GovernanceRefusal('this would leave the project with no default agent — make another agent the default first')
        return out
      }) : compute()
      const changed = !!before && JSON.stringify(cursor()) !== JSON.stringify(before)
      if (changed) recordSince(before!)
      return { reply: { t: 'graph:reply', ...data }, changed }
    } catch (e: any) {
      const known = e instanceof GovernanceRefusal || /^there is no (domain|concept)|^"[^"]+" is a /.test(e?.message ?? '')
      if (!known) console.error('[graph]', e?.stack ?? e)
      return { reply: { t: 'graph:refused', reason: known ? e.message : `the graph could not do that: ${e?.message ?? e}` }, changed: false }
    }
  }

  // ── The console's views of the graph ──
  /** Every domain with its concepts, files and the questions that reached it; the latest changes; who made them. */
  function composition() {
    const domains = domainsOf(store).map((d) => {
      const node = store.get<DomainBody>(d.name)!
      const concepts = conceptsOf(node.body).map((name) => { const n = store.get<ConceptBody>(name); return { name, hash: n?.hash ?? null, title: n?.body.title ?? null, form: n?.body.form ?? null,
        lines: n ? (n.body.form === 'text' ? 1 : n.body.form === 'composed' ? n.body.concepts.length : n.body.form === 'sections' ? n.body.sections.length : n.body.items.length) : 0 } })
      const files = node.body.files.map((name) => { const n = store.get<FileBody>(name); return { name, hash: n?.hash ?? null, file: n?.body.name ?? null, bytes: n ? n.body.text.length : 0 } })
      const asked = store.questions(40, d.name).map((q) => ({ at: q.at, session: q.session, question: q.question, how: q.how, domainHash: q.domainHash,
        decided: Array.isArray(q.ranked) ? ((q.ranked as any[])[0]?.terms ?? []).slice(0, 6) : [] }))
      return { name: d.name, hash: node.hash, description: node.body.description ?? null, intents: node.body.intents ?? [], capabilities: node.body.capabilities, tools: node.body.tools ?? null, concepts, files, asked }
    })
    return { exists: true, domains, people: people(), changes: store.changes(60), counts: { domain: store.names('domain').length, concept: store.names('concept').length, file: store.names('file').length } }
  }
  /** The whole graph for the graph page — as it is now, as a named version reads it, or after one change. */
  function compositionColumns(a: { version?: string; upto?: number } = {}) {
    const v = a.version ? store.version(String(a.version)) : null
    if (a.version && !v) return { exists: true, error: `there is no version "${a.version}"` }
    const upto = v?.upto ?? (a.upto !== undefined && Number.isInteger(Number(a.upto)) ? Number(a.upto) : undefined)
    const line = (b: any) => String(b?.text ?? (Array.isArray(b?.sections) ? b.sections.map((x: any) => x?.name ?? '').join(' · ') : Array.isArray(b?.items) ? b.items.map((x: any) => (typeof x === 'string' ? x : x?.question ?? '')).join(' · ') : '')).replace(/\s+/g, ' ').slice(0, 200)
    const agents = store.names('agent', { upto }).map((n) => { const b = store.content<any>(n.hash); return { name: n.name, title: String(b.title ?? n.name), domain: String(b.domain ?? '') } })
    const domains = store.names('domain', { upto }).map((n) => { const b = store.content<DomainBody>(n.hash); return { name: n.name, title: String((b as any).title ?? n.name), line: String(b.description ?? '').slice(0, 200), scope: n.scope, owner: n.owner, hash: n.hash, concepts: conceptsOf(b), body: b, agents: agents.filter((x) => x.domain === n.name) } })
    const concepts = store.names('concept', { upto }).map((n) => { const b = store.content<any>(n.hash); return { name: n.name, title: String(b.title ?? n.name), form: String(b.form), composed: b.form === 'composed', line: line(b), scope: n.scope, owner: n.owner, hash: n.hash, concepts: b.form === 'composed' ? (b.concepts as string[]) : [], body: b } })
    return { exists: true, ...(v ? { version: v } : {}), domains, intermediate: concepts.filter((c) => c.composed), atomic: concepts.filter((c) => !c.composed) }
  }
  /** One node: its content now or at a moment, every change to it, and the domains that name it. */
  function compositionNode(a: { name?: string; asOf?: string }) {
    const name = String(a.name ?? '')
    const asOf = a.asOf ? Date.parse(a.asOf) : undefined
    const usedBy = store.names('domain').filter((d) => { const b = store.content<DomainBody>(d.hash); return conceptsOf(b).includes(name) || b.files.includes(name) }).map((d) => d.name)
    return { exists: true, node: store.get(name, asOf), history: store.history(name), usedBy }
  }
  /** A domain composed — the whole system prompt its agent gets — now or at a moment, with the hashes it read. */
  function compositionCompose(a: { domain?: string; asOf?: string }) {
    const asOf = a.asOf ? Date.parse(a.asOf) : undefined
    const c = compose(store, String(a.domain ?? ''), asOf)
    return { exists: true, domain: c.domain, text: c.text, used: c.used, bytes: c.text.length, tools: c.tools ?? null }
  }
  /** Every session that asked the graph's agents, from the questions recorded here: its agent, when it began, how many
   *  questions — and which pieces of its agent have changed since (its composition as the graph read when it began,
   *  against the graph now). */
  function graphSessions() {
    const bySession = new Map<string, { id: string; domain: string; first: number; asked: number }>()
    for (const q of store.questions(2000)) {   // newest first: the last seen is the session's first question
      const s = bySession.get(q.session) ?? { id: q.session, domain: q.domain ?? '', first: q.at, asked: 0 }
      s.asked++; if (q.at <= s.first) { s.first = q.at; if (q.domain) s.domain = q.domain }
      bySession.set(q.session, s)
    }
    const sessions = [...bySession.values()].filter((s) => s.domain).sort((a, b) => b.first - a.first).slice(0, 200).map((s) => {
      let used = 0, moved: string[] = []
      try { const c = compose(store, s.domain, s.first); used = Object.keys(c.used).length; moved = drift(store, c.used).map((x) => x.name) } catch { /* its agent is gone from the graph */ }
      return { id: s.id, domain: s.domain, at: new Date(s.first).toISOString(), asked: s.asked, used, moved }
    })
    return { exists: true, sessions }
  }
  const VIEWS: Record<string, (a: any) => unknown> = { composition, compositionColumns, compositionNode, compositionCompose, graphSessions }
  function view(name: string, args: Record<string, unknown>): Record<string, unknown> {
    try { return VIEWS[name]!(args) as Record<string, unknown> } catch (e: any) { return { error: e?.message ?? String(e) } }
  }

  /** Nodes written for a person by an engine (an agent made from their session): each through governance, as them;
   *  all of them or none. */
  function writeFor(who: Who, writes: { name: string; kind: string; body: unknown; reason: string; scope?: string }[]): { results?: unknown[]; error?: string; changed: boolean } {
    const before = cursor()
    try {
      if (!Array.isArray(writes) || !writes.length || writes.length > 20) throw new GovernanceRefusal('a write is 1–20 nodes')
      notePerson(who)
      const results = store.db.atomic(() => writes.map((w) => {
        if (!['concept', 'domain', 'agent'].includes(w.kind)) throw new GovernanceRefusal(`an engine writes concepts, domains and agents, not ${w.kind}`)
        const r = g.write(store, who, String(w.name), w.kind as Kind, w.body, { reason: String(w.reason ?? '') }, w.scope ? { scope: String(w.scope) } : {})
        return { name: w.name, ...r, node: store.get(String(w.name)) }
      }))
      const changed = JSON.stringify(cursor()) !== JSON.stringify(before)
      if (changed) recordSince(before)
      return { results, changed }
    } catch (e: any) { return { error: e?.message ?? String(e), changed: false } }
  }

  /** The default domain (where a question no other domain reaches goes), if the graph has one. */
  const defaultDomain = () => store.names('domain').find((d) => (store.get(d.name)?.body as DomainBody | undefined)?.fallback === true)?.name ?? null
  /** Whether the graph has a default agent: the agent a question no other agent fits goes to, its domain in the graph. */
  const hasDefault = () => store.names('agent').some((a) => { const b = store.get(a.name)?.body as any; return b?.isDefault === true && !!store.get(String(b.domain ?? '')) })
  /** Every project has a default agent: when its graph has no default domain, the platform's (default-agent.ts) is put in,
   *  recorded as the platform's change. Whether it changed the graph (the engine is told). */
  function ensureDefaultAgent(): boolean {
    // Once a graph has a default agent it keeps one (handle refuses a change that would leave none), so this adds it only
    // to a project that never had one: a new project at its setup, or one made before projects had a default agent.
    if (hasDefault() || store.get(DEFAULT_AGENT.name)) return false
    const before = cursor()
    const ctx = { by: 'platform', reason: 'every project has a default agent, for questions no other agent covers' }
    store.db.atomic(() => {
      // Its domain: the project's own default domain, else the platform's general one.
      let domain = defaultDomain()
      if (!domain) {
        if (store.get(DEFAULT_DOMAIN.name)) return
        importDomains(store, [DEFAULT_DOMAIN], () => { throw new Error('the default domain brings no files') }, ctx)
        domain = DEFAULT_DOMAIN.name
      }
      store.put(DEFAULT_AGENT.name, 'agent', { ...DEFAULT_AGENT.body, domain }, ctx, {})
    })
    recordSince(before)
    return hasDefault()
  }


  return {
    handle, view, cursor, writeFor, ensureDefaultAgent,
    /** What an engine lacks after its cursor (its replica pulls this, in order, until nothing is left). */
    pull: (after: Partial<Cursor>) => replicaSince(store, { ...START, ...after } as Cursor, 500),
    /** A question an engine routed, and the domain it went to. */
    asked: (q: { session: string; qid?: string; question: string; domain: string | null; how: 'routed' | 'chosen' | 'session'; ranked?: unknown }) => store.recordQuestion(q),
    /** Suggestions no decision has answered yet (what needs an owner's or an admin's word). */
    open: () => g.list(store, { status: 'open' as any, limit: 200 }).map((s) => ({ id: s.id, at: s.at, name: s.name, kind: s.kind, by: s.by, reason: s.reason, scope: s.scope ?? null })),
  }
}
