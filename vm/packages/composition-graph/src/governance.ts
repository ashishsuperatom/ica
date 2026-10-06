// ── Governance — who may change what ─────────────────────────────────────────────────────────────────────────────────
//
// Every node has one owner. The owner (or an admin) changes it; anyone else suggests a change, which the owner approves
// or rejects. A new node is made, not suggested, and whoever makes it owns it. A node with no owner (knowledge imported
// before owners existed) is changed by an admin. Suggestions and decisions are append-only; a suggestion's status is
// read from its decision. An approval applies the suggested content as a change by the approver, recorded with where
// it came from — and is refused if the node changed after the suggestion was made, so nobody approves something other
// than what they read.

import { canonical, hashOf, type Kind, type Scope, type Store } from './store.js'
import { conceptsOf, isComposed, type ConceptBody, type DomainBody } from './compose.js'

export class GovernanceRefusal extends Error {}

/** Who is acting: a person (user:<id>) or an agent key (agent:<keyId>), and whether they administer the project. */
export interface Actor { id: string; admin?: boolean }

export type Status = 'open' | 'approved' | 'rejected' | 'withdrawn'
export interface Suggestion { id: number; at: number; name: string; kind: Kind; body: unknown; baseHash: string | null; scope: Scope | null; by: string; reason: string; status: Status; decidedBy: string | null; decidedAt: number | null; decision: string | null }

/** What a body of each writable kind must be. */
export function checkBody(kind: Kind, body: unknown): string[] {
  const b = body as any
  if (!b || typeof b !== 'object' || Array.isArray(b)) return [`a ${kind} is an object`]
  if (kind === 'concept') {
    if (typeof b.title !== 'string' || !b.title.trim()) return ['a concept has a title']
    if (b.form === 'text') return typeof b.text === 'string' && b.text.trim() ? [] : ['a text concept has its text']
    if (b.form === 'bullets' || b.form === 'numbered') return Array.isArray(b.items) && b.items.length && b.items.every((x: unknown) => typeof x === 'string' && x.trim()) ? [] : [`a ${b.form} concept has its items, each text`]
    if (b.form === 'worked') return Array.isArray(b.items) && b.items.every((x: any) => typeof x?.question === 'string' && Array.isArray(x.steps)) ? [] : ['a worked concept has examples, each a question and its steps']
    if (b.form === 'composed') return Array.isArray(b.concepts) && b.concepts.every((x: unknown) => typeof x === 'string' && x) && (b.text === undefined || typeof b.text === 'string') ? [] : ['an intermediate concept lists its atomic concepts by name (and may have a line of its own)']
    return ['a concept\'s form is text, bullets, numbered, worked, or composed (an intermediate concept)']
  }
  if (kind === 'domain') {
    const lists = ['capabilities', 'concepts', 'files'] as const
    const bad = lists.filter((k) => !Array.isArray(b[k]) || b[k].some((x: unknown) => typeof x !== 'string'))
    return bad.length ? [`a domain lists its ${bad.join(', ')} (names)`] : []
  }
  if (kind === 'agent') {
    // An agent: a domain of the graph (its concepts), the programs it may run, the tools it is given, where STATE starts,
    // its starting UI, and the ICA that answers in words. Its scope and owner are the node's.
    const out: string[] = []
    if (typeof b.title !== 'string' || !b.title.trim()) out.push('an agent has a title')
    if (typeof b.domain !== 'string' || !b.domain) out.push('an agent names its domain')
    if (!Array.isArray(b.programs) || b.programs.some((x: unknown) => typeof x !== 'string' || !x)) out.push('an agent lists its programs (names or hashes)')
    if (b.tools !== undefined && (!Array.isArray(b.tools) || b.tools.some((x: unknown) => typeof x !== 'string'))) out.push('an agent\'s tools are names')
    if (b.start !== undefined && (typeof b.start !== 'object' || Array.isArray(b.start))) out.push('an agent\'s start is fields by slice')
    if (b.ica !== undefined && typeof b.ica !== 'string') out.push('an agent\'s ica names the agent that answers in words')
    for (const k of ['icon', 'accent', 'says'] as const) if (b[k] !== undefined && typeof b[k] !== 'string') out.push(`an agent's ${k} is text`)
    if (b.main !== undefined && (typeof b.main !== 'object' || typeof b.main?.label !== 'string' || (b.main.says !== undefined && typeof b.main.says !== 'string'))) out.push('an agent\'s main view has a label and perhaps a line')
    if (b.starts !== undefined && (!Array.isArray(b.starts) || b.starts.some((x: any) => !x || typeof x.key !== 'string' || !x.key || typeof x.label !== 'string' || !x.label || typeof x.start !== 'object' || Array.isArray(x.start) || (x.says !== undefined && typeof x.says !== 'string'))))
      out.push('an agent\'s starts are each a key, a label, an optional line, and a start (fields by slice)')
    return out
  }
  return [`a ${kind} is not changed this way`]
}

const ownerOf = (store: Store, name: string) => store.get(name)

/** May this actor change this node directly? Says why not. */
function mayWrite(store: Store, actor: Actor, name: string): { ok: true } | { ok: false; why: string } {
  const cur = ownerOf(store, name)
  if (!cur) return { ok: true }
  if (actor.admin) return { ok: true }
  if (cur.owner === actor.id) return { ok: true }
  return { ok: false, why: cur.owner ? `"${name}" is ${cur.owner}'s — suggest the change instead` : `"${name}" has no owner — an admin changes it; suggest the change instead` }
}

/** Make or change a node as this actor: a new node becomes theirs; an existing one only if they own it (or admin). */
export function write(store: Store, actor: Actor, name: string, kind: Kind, body: unknown, ctx: { reason?: string; from?: string } = {}, place: { scope?: Scope } = {}) {
  // A name: letters, digits, spaces, dots, dashes, underscores and "/" — a domain's parts are named under it ("<domain>/<part>").
  if (!/^[\w](?:[\w .\/-]{0,118}[\w.-])?$/.test(name) || name.includes('//')) throw new GovernanceRefusal(`"${name}" is not a name: letters, digits, spaces, dots, dashes, underscores and "/"`)
  const bad = checkBody(kind, body)
  if (bad.length) throw new GovernanceRefusal(bad.join('; '))
  const may = mayWrite(store, actor, name)
  if (!may.ok) throw new GovernanceRefusal(may.why)
  const cur = ownerOf(store, name)
  // PUBLISHING IS DECIDED: making a node seen more widely (a person's → a group's → everyone's) is suggested, and an admin
  // decides (publish below); only an admin widens one directly.
  if (cur && place.scope && !actor.admin && reach(place.scope) > reach(cur.scope)) throw new GovernanceRefusal(`making "${name}" seen by ${place.scope === 'global' ? 'everyone' : place.scope} is decided by an admin — suggest it (publish)`)
  // A NEW node starts where its maker may put it: someone who may publish, anywhere (everyone's by default); anyone else,
  // in their own scope — then they suggest it more widely (publish).
  const own = `user:${actor.id.replace(/^(user|agent):/, '')}`
  if (!cur && place.scope && !actor.admin && place.scope !== own) throw new GovernanceRefusal(`a new "${name}" starts as yours (${own}) — then suggest it for ${place.scope === 'global' ? 'everyone' : place.scope} (publish)`)
  if (!cur && !place.scope && !actor.admin) place = { ...place, scope: own }
  if (kind === 'domain') for (const c of conceptsOf(body as DomainBody)) if (!store.get(c)) throw new GovernanceRefusal(`the domain names a concept that does not exist: "${c}"`)
  if (kind === 'concept') checkLevels(store, name, body as ConceptBody)
  if (kind === 'agent') { const d = store.get((body as any).domain); if (!d || d.kind !== 'domain') throw new GovernanceRefusal(`the agent names a domain that does not exist: "${(body as any).domain}"`) }
  try {
    return store.put(name, kind, body, { by: actor.id, reason: ctx.reason, from: ctx.from }, { ...(place.scope ? { scope: place.scope } : {}), ...(cur ? {} : { owner: actor.id }) })
  } catch (e: any) { throw new GovernanceRefusal(e?.message ?? String(e)) }
}

/** How widely a scope is seen: a person's, a group's, everyone's. */
const reach = (s: string | null | undefined) => (s === 'global' ? 2 : String(s ?? '').startsWith('group:') ? 1 : 0)

/** Suggest that a node be seen more widely (published to a group, or to everyone). An admin decides; approving it changes
 *  the node's scope, nothing else. */
export function publish(store: Store, actor: Actor, name: string, scope: Scope, reason: string): Suggestion {
  if (!reason?.trim()) throw new GovernanceRefusal('publishing says why')
  const cur = store.get(name)
  if (!cur) throw new GovernanceRefusal(`there is no "${name}"`)
  if (!/^(global|group:[\w.-]+|user:[\w.:@-]+)$/.test(String(scope))) throw new GovernanceRefusal(`"${scope}" is not a scope`)
  if (reach(scope) <= reach(cur.scope)) throw new GovernanceRefusal(`"${name}" is already seen at least that widely (${cur.scope})`)
  if (cur.owner !== actor.id && !actor.admin) throw new GovernanceRefusal(`only ${cur.owner ?? 'its owner'} or an admin publishes "${name}"`)
  const r = store.db.prepare('INSERT INTO suggestion (at, name, kind, body_hash, base_hash, scope, by, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(Date.now(), name, cur.kind, cur.hash, cur.hash, scope, actor.id, reason.trim())
  return get(store, Number(r.lastInsertRowid))!
}

/** The levels hold: an intermediate concept composes atomic concepts that exist (never itself, never another
 *  intermediate); a concept that is a part of an intermediate stays atomic. */
function checkLevels(store: Store, name: string, body: ConceptBody) {
  if (isComposed(body)) {
    for (const c of body.concepts) {
      const n = store.get<ConceptBody>(c)
      if (!n || n.kind !== 'concept') throw new GovernanceRefusal(`"${name}" names a concept that does not exist: "${c}"`)
      if (c === name || isComposed(n.body)) throw new GovernanceRefusal(`"${c}" is an intermediate concept — an intermediate concept is made of atomic ones`)
    }
    const within = partOf(store, name)
    if (within.length) throw new GovernanceRefusal(`"${name}" is a part of ${within.map((x) => `"${x}"`).join(', ')} — a part stays atomic`)
  }
}
/** The intermediate concepts a concept is a part of. */
export const partOf = (store: Store, concept: string): string[] =>
  store.names('concept').filter((n) => { const b = store.content<ConceptBody>(n.hash); return isComposed(b) && b.concepts.includes(concept) }).map((n) => n.name)

/** Attach a concept to a domain or to an intermediate concept (at a position), or detach it — a change to the one it is
 *  attached to. A domain takes any concept; an intermediate concept takes atomic ones. */
export function compose(store: Store, actor: Actor, into: string, concept: string, how: { leave?: boolean; at?: number }, reason?: string) {
  const d = store.get<DomainBody | ConceptBody>(into)
  if (!d || !(d.kind === 'domain' || (d.kind === 'concept' && isComposed(d.body)))) throw new GovernanceRefusal(`there is no domain or intermediate concept "${into}"`)
  const had = d.kind === 'domain' ? conceptsOf(d.body as DomainBody) : (d.body as Extract<ConceptBody, { form: 'composed' }>).concepts
  const list = had.filter((c) => c !== concept)
  if (!how.leave) {
    const c = store.get(concept)
    if (!c || c.kind !== 'concept') throw new GovernanceRefusal(`there is no concept "${concept}"`)
    list.splice(Math.max(0, Math.min(how.at ?? list.length, list.length)), 0, concept)
  } else if (list.length === had.length) throw new GovernanceRefusal(`"${concept}" is not in "${into}"`)
  const why = { reason: reason ?? `${how.leave ? 'detach' : 'attach'} ${concept}` }
  if (d.kind === 'concept') return write(store, actor, into, 'concept', { ...(d.body as object), concepts: list }, why)
  const { parts: _legacy, ...rest } = d.body as DomainBody
  return write(store, actor, into, 'domain', { ...rest, concepts: list }, why)
}

/** Suggest a change to a node someone else owns (or a node with no owner). */
export function suggest(store: Store, actor: Actor, name: string, kind: Kind, body: unknown, reason: string): Suggestion {
  if (!reason?.trim()) throw new GovernanceRefusal('a suggestion says why')
  const bad = checkBody(kind, body)
  if (bad.length) throw new GovernanceRefusal(bad.join('; '))
  const cur = store.get(name)
  if (!cur) throw new GovernanceRefusal(`there is no "${name}" — a new ${kind} is made, not suggested`)
  if (cur.kind !== kind) throw new GovernanceRefusal(`"${name}" is a ${cur.kind}, not a ${kind}`)
  if (cur.hash === hashOf(body)) throw new GovernanceRefusal(`that is what "${name}" already says`)
  const hash = hashOf(body)
  const now = Date.now()
  store.db.prepare('INSERT OR IGNORE INTO content (hash, body, at) VALUES (?, ?, ?)').run(hash, canonical(body), now)
  const r = store.db.prepare('INSERT INTO suggestion (at, name, kind, body_hash, base_hash, scope, by, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(now, name, kind, hash, cur.hash, null, actor.id, reason.trim())
  return get(store, Number(r.lastInsertRowid))!
}

/** A suggestion, with its status. */
export function get(store: Store, id: number): Suggestion | null {
  const r = store.db.prepare('SELECT s.*, d.verdict, d.by AS d_by, d.at AS d_at, d.reason AS d_reason FROM suggestion s LEFT JOIN decision d ON d.suggestion = s.id WHERE s.id = ?').get(id) as any
  return r ? row(store, r) : null
}
function row(store: Store, r: any): Suggestion {
  return { id: r.id, at: r.at, name: r.name, kind: r.kind, body: store.content(r.body_hash), baseHash: r.base_hash, scope: r.scope, by: r.by, reason: r.reason,
    status: (r.verdict ?? 'open') as Status, decidedBy: r.d_by ?? null, decidedAt: r.d_at ?? null, decision: r.d_reason ?? null }
}

/** Suggestions, newest first: by status, for a node, or by whom. */
export function list(store: Store, q: { status?: Status; name?: string; by?: string; limit?: number } = {}): Suggestion[] {
  const rows = store.db.prepare('SELECT s.*, d.verdict, d.by AS d_by, d.at AS d_at, d.reason AS d_reason FROM suggestion s LEFT JOIN decision d ON d.suggestion = s.id ORDER BY s.id DESC LIMIT ?').all(Math.min(q.limit ?? 100, 500)) as any[]
  return rows.map((r) => row(store, r)).filter((s) => (!q.status || s.status === q.status) && (!q.name || s.name === q.name) && (!q.by || s.by === q.by))
}

/** The owner (or an admin) approves or rejects; the one who suggested may withdraw. */
export function decide(store: Store, actor: Actor, id: number, verdict: 'approved' | 'rejected' | 'withdrawn', reason?: string): Suggestion {
  const s = get(store, id)
  if (!s) throw new GovernanceRefusal(`there is no suggestion ${id}`)
  if (s.status !== 'open') throw new GovernanceRefusal(`suggestion ${id} was already ${s.status}`)
  if (verdict === 'withdrawn') { if (s.by !== actor.id) throw new GovernanceRefusal('only the one who suggested it withdraws it') }
  else {
    const cur = store.get(s.name)
    const may = mayWrite(store, actor, s.name)
    if (!may.ok) throw new GovernanceRefusal(cur?.owner ? `only ${cur.owner} (the owner) or an admin decides on suggestion ${id}` : `"${s.name}" has no owner — an admin decides on suggestion ${id}`)
    if (s.scope && !actor.admin) throw new GovernanceRefusal(`publishing "${s.name}" is decided by an admin`)
    if (verdict === 'approved') {
      if (!cur || cur.hash !== s.baseHash) throw new GovernanceRefusal(`"${s.name}" changed after suggestion ${id} was made — it cannot be approved as it is; ask for a new suggestion`)
      if (s.kind === 'domain') for (const c of conceptsOf(s.body as DomainBody)) if (!store.get(c)) throw new GovernanceRefusal(`the suggested domain names a concept that does not exist: "${c}"`)
    }
  }
  // One unit: the decision and, for an approval, the change it makes (units nest: put's own is part of it).
  store.db.atomic(() => {
    store.db.prepare('INSERT INTO decision (suggestion, at, by, verdict, reason) VALUES (?, ?, ?, ?, ?)').run(id, Date.now(), actor.id, verdict, reason ?? null)
    if (verdict === 'approved') store.put(s.name, s.kind, s.body, { by: actor.id, reason: `approved suggestion ${id} by ${s.by}: ${s.reason}${reason ? ` — ${reason}` : ''}`, from: `suggestion:${id}` }, s.scope ? { scope: s.scope } : {})
  })
  return get(store, id)!
}

export type { ConceptBody }
