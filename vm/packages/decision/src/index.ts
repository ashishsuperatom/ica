// ── Decision memory — the decision state ────────────────────────────────────────────────────────────────────────────
//
// Following the stable-attractor pattern (docs/stable-attractor-associative-memory-source.md):
//
//   experience      each passage through a step: its cues (language), the world as it was (the figures the step
//                   showed), the STATE it was at, the path taken next, and later its outcome. Append-only.
//   decision state  a situation recognised from experiences (an attractor): a description, its cues, the paths possible
//                   from it with the reasoning and record of each, the range of the world it was seen in, its evidence.
//                   It may specialise another (parent). Specificity is earned: one general state until evidence splits it.
//   recognition     the hot path, deterministic: cues → an associative index (phrases, BM25-like, scope as a ranking
//                   factor, strength from the record) → decision states → is the world still like the one each was seen
//                   in? → learned · similar | learned · changed | not learned. Memory advises; exploring is always open.
//   operations      the only way a decision state changes (the learning path calls them): create, reinforce, weaken,
//                   merge, generalise, specialise, supersede, split, compete, invalidate. Each makes new versions; nothing
//                   is erased; any decision state can be read as of any moment.
//
// Nothing here knows a domain: cues are words from the agent, the question and the STATE's own values.

import type { Answer, Op, State } from '@superatom/platform-types'

/** global, a group's, or one person's. Inheritance is visibility (user → group → global), not copying. */
export type Scope = string
export const isScope = (s: unknown): s is Scope => typeof s === 'string' && /^(global|group:[^\s]+|user:[^\s]+)$/.test(s)

/** The figures a step showed, by name. */
export type World = Record<string, number>
/** The range each figure was seen in. */
export type Seen = Record<string, { min: number; max: number; n: number }>

/** What a person can do from a decision state: an intent the session takes, and why. */
export interface Path {
  id: string
  label: string
  intent: { ops?: Op[]; action?: { package: string; id: string }; call?: { package: string; fn: string; params?: Record<string, unknown> }; text?: string; to?: 'current' | 'new' }
  reasoning: string
}

/** The path a person took from a step (the intent that followed it), as recorded. */
export interface Taken { kind: 'structured' | 'language'; label: string; ops?: Op[]; action?: Path['intent']['action']; call?: Path['intent']['call']; text?: string; to?: 'current' | 'new' }

export type Outcome = 'succeeded' | 'failed' | 'abandoned' | 'reversed'

export interface Experience {
  id: string
  at: string
  session: string
  block: string
  agent: string
  /** Whose experience it is (the session's owner): user:<id>. */
  scope: Scope
  cues: string[]
  world: World
  stateHash: string
  taken: Taken | null
  /** The decision state it was recognised as, when there was one. */
  recognised?: string | null
}

export interface DecisionBody {
  title: string
  /** The situation in language: what another instance should be reminded of. */
  description: string
  cues: string[]
  paths: Path[]
  seen: Seen
  /** The more general state this one specialises. */
  parent?: string | null
  /** States it competes with: contradictory experience kept until evidence explains it. */
  competes?: string[]
}

export interface DecisionVersion {
  id: string
  version: number
  at: string
  by: string
  why: string
  op: DecisionOp['op']
  scope: Scope
  status: 'active' | 'superseded' | 'invalidated'
  body: DecisionBody
  /** Experience ids this version added as evidence. */
  supports: string[]
  contradicts: string[]
}

/** The record of a path: how often taken from this state, and how it went. */
export interface PathRecord { taken: number; succeeded: number; failed: number }

// ── Words → cues ────────────────────────────────────────────────────────────────────────────────────────────────────

const STOP = new Set('a an the of for to in on at by with and or is are was were be been it its this that these those what which who how much many show me my our your their from as into than then there here do does did not no yes all any each per vs via'.split(' '))
export const words = (text: string): string[] =>
  String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}.\-_ ]+/gu, ' ').split(/\s+/).map((w) => w.replace(/^[.\-_]+|[.\-_]+$/g, '')).filter((w) => w && !STOP.has(w))

/** Phrases of 1–3 words, in order, from a text. */
export function phrases(text: string, max = 3): string[] {
  const w = words(text)
  const out: string[] = []
  for (let n = 1; n <= max; n++) for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '))
  return out
}

/** A step's cues: the agent, the question in words, and the STATE's own values as phrases (a key with its value). */
export function cuesOf(input: { agent?: string; question?: string | null; state?: State | null; extra?: string[] }, limit = 60): string[] {
  const out = new Set<string>()
  const add = (c: string) => { const t = words(c).join(' '); if (t) out.add(t) }
  if (input.agent) add(input.agent)
  for (const p of phrases(input.question ?? '')) out.add(p)
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 3 || v == null) return
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const val = String(v)
      if (val.length > 60) return
      if (key) add(`${key} ${val}`)
      if (typeof v === 'string') add(val)
      return
    }
    if (Array.isArray(v)) { v.slice(0, 12).forEach((x) => walk(x, key, depth + 1)); return }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1)
  }
  for (const [k, v] of Object.entries(input.state ?? {})) {
    if (k === 'packages') { for (const p of Object.keys(v as object)) add(p); continue }
    if (k === 'agent') { const a = v as { question?: string; seeing?: string }; for (const p of phrases(a?.question ?? '')) out.add(p); continue }
    walk(v, '', 0)
  }
  for (const e of input.extra ?? []) add(e)
  return [...out].slice(0, limit)
}

/** The figures an answer showed: those its program named (`world`), and every plain number in its KPI blocks. */
export function worldOf(answer: Pick<Answer, 'blocks'> & { world?: World } | null | undefined): World {
  const w: World = {}
  if (!answer) return w
  for (const [k, v] of Object.entries(answer.world ?? {})) if (typeof v === 'number' && Number.isFinite(v)) w[k] = v
  for (const b of Object.values(answer.blocks ?? {})) {
    const items = (b as any)?.type === 'kpis' ? (b as any).items ?? (b as any).kpis : null
    if (Array.isArray(items)) for (const it of items) {
      const v = typeof it?.value === 'number' ? it.value : Number(it?.value)
      if (it?.label && Number.isFinite(v) && !(String(it.label) in w)) w[String(it.label)] = v
    }
  }
  return w
}

// ── The world: still like the one a state was seen in? ──────────────────────────────────────────────────────────────

export interface WorldCheck { similar: boolean; thin: boolean; drift: { figure: string; now: number; min: number; max: number }[]; compared: number }

/** Each figure known to both is within the range seen, with a margin of a tenth of the range (or of the value). A state
 *  seen fewer than three times is thin: its range says little. Figures only one side has are not compared. */
export function checkWorld(now: World, seen: Seen): WorldCheck {
  const drift: WorldCheck['drift'] = []
  let compared = 0, thin = false
  for (const [figure, s] of Object.entries(seen)) {
    const v = now[figure]
    if (typeof v !== 'number') continue
    compared++
    if (s.n < 3) thin = true
    const margin = Math.max(Math.abs(s.max - s.min), Math.abs((s.max + s.min) / 2)) * 0.1
    if (v < s.min - margin || v > s.max + margin) drift.push({ figure, now: v, min: s.min, max: s.max })
  }
  return { similar: drift.length === 0, thin, drift, compared }
}

/** The range seen, widened by one more observation. */
export function observe(seen: Seen, world: World): Seen {
  const out: Seen = { ...seen }
  for (const [k, v] of Object.entries(world)) {
    const s = out[k]
    out[k] = s ? { min: Math.min(s.min, v), max: Math.max(s.max, v), n: s.n + 1 } : { min: v, max: v, n: 1 }
  }
  return out
}

// ── Recognition ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Candidate {
  id: string
  scope: Scope
  body: DecisionBody
  /** Experiences supporting and contradicting it, all versions. */
  supports: number
  contradicts: number
  paths: Record<string, PathRecord>
}

/** How each scope ranks a match: one's own first, then one's groups', then everyone's — a factor, never an override. */
/** A phrase counts more than a word. */
const weight = (cue: string) => 1 + 0.5 * (cue.split(' ').length - 1)
const SCOPE_FACTOR = (s: Scope) => (s.startsWith('user:') ? 1 : s.startsWith('group:') ? 0.9 : 0.8)

export interface Match {
  id: string
  title: string
  description: string
  scope: Scope
  score: number
  /** Share of the state's cues the step has, a phrase weighing more than a word (what "learned" is judged on; the score
   *  only ranks, since rarity means little while the memory holds few states). */
  coverage: number
  matched: string[]
  world: WorldCheck
  evidence: { supports: number; contradicts: number }
  paths: (Path & { record: PathRecord })[]
  competes: string[]
}

export type Mode = 'learned-similar' | 'learned-changed' | 'not-learned'
export interface Recognition { mode: Mode; matches: Match[]; why: string }

/** Thresholds of "learned": settings, defaulting to these until usage teaches better. */
export interface RecognitionSettings { minScore: number; minCoverage: number; minSupports: number; top: number }
export const DEFAULT_RECOGNITION: RecognitionSettings = { minScore: 0, minCoverage: 0.5, minSupports: 2, top: 3 }

/**
 * Rank candidate decision states for a step's cues. `df` is how many active states carry each cue and `n` how many
 * there are (the rarity of a cue); a longer phrase counts more than a word; a state's record strengthens it (how often
 * its paths succeeded against failed); scope is a factor.
 */
export function recognise(cues: string[], world: World, candidates: Candidate[], df: Record<string, number>, n: number, settings: RecognitionSettings = DEFAULT_RECOGNITION): Recognition {
  const have = new Set(cues)
  const scored: Match[] = []
  for (const c of candidates) {
    const matched = c.body.cues.filter((q) => have.has(q))
    if (!matched.length) continue
    let score = 0
    for (const q of matched) {
      const idf = Math.log(1 + (n - (df[q] ?? 0) + 0.5) / ((df[q] ?? 0) + 0.5))
      score += idf * weight(q)
    }
    const succeeded = Object.values(c.paths).reduce((a, p) => a + p.succeeded, 0)
    const failed = Object.values(c.paths).reduce((a, p) => a + p.failed, 0)
    score *= SCOPE_FACTOR(c.scope) * (1 + 0.25 * Math.log1p(succeeded) - 0.15 * Math.log1p(failed))
    const record = (id: string) => c.paths[id] ?? { taken: 0, succeeded: 0, failed: 0 }
    scored.push({
      id: c.id, title: c.body.title, description: c.body.description, scope: c.scope, score: Math.round(score * 1000) / 1000,
      coverage: Math.round((matched.reduce((a, q) => a + weight(q), 0) / Math.max(1, c.body.cues.reduce((a, q) => a + weight(q), 0))) * 1000) / 1000, matched,
      world: checkWorld(world, c.body.seen), evidence: { supports: c.supports, contradicts: c.contradicts },
      // paths with the best record first; untried ones keep their written order after them
      paths: c.body.paths.map((p, i) => ({ ...p, record: record(p.id), i })).sort((a, b) => (b.record.succeeded - b.record.failed) - (a.record.succeeded - a.record.failed) || a.i - b.i).map(({ i, ...p }) => p),
      competes: c.body.competes ?? [],
    })
  }
  scored.sort((a, b) => b.score - a.score)
  const matches = scored.slice(0, settings.top)
  const best = matches[0]
  if (!best) return { mode: 'not-learned', matches, why: 'no decision state matches this step' }
  const learned = best.score >= settings.minScore && best.coverage >= settings.minCoverage && best.evidence.supports >= settings.minSupports
  if (!learned) {
    const short = best.score < settings.minScore ? 'the match is weak' : best.coverage < settings.minCoverage ? 'the step has few of its cues' : 'its evidence is thin'
    return { mode: 'not-learned', matches, why: `"${best.title}" is the nearest, but ${short}` }
  }
  // Contradiction unexplained: a competing state scoring close is a reason to check, not to pick.
  const rival = matches.find((m) => m !== best && (best.competes.includes(m.id) || m.competes.includes(best.id)) && m.score >= best.score * 0.8)
  if (rival) return { mode: 'learned-changed', matches, why: `"${best.title}" and "${rival.title}" compete here; evidence has not explained the difference` }
  if (!best.world.similar) return { mode: 'learned-changed', matches, why: `the world has moved since "${best.title}" was learned: ${best.world.drift.map((d) => `${d.figure} seen ${d.min}–${d.max}, now ${d.now}`).join('; ')}` }
  return { mode: 'learned-similar', matches, why: `recognised as "${best.title}"${best.world.thin ? ' (seen only a few times)' : ''}` }
}

// ── Operations: the only way a decision state changes ───────────────────────────────────────────────────────────────

export type DecisionOp =
  | { op: 'create'; id: string; scope: Scope; body: DecisionBody; supports?: string[] }
  | { op: 'reinforce'; id: string; supports: string[]; world?: World[] }
  | { op: 'weaken'; id: string; contradicts: string[] }
  | { op: 'merge'; ids: string[]; into: string; body: DecisionBody }
  | { op: 'generalise'; id: string; body: DecisionBody }
  | { op: 'specialise'; parent: string; id: string; scope?: Scope; body: DecisionBody; supports?: string[] }
  | { op: 'supersede'; id: string; by: string }
  | { op: 'split'; id: string; into: { id: string; body: DecisionBody; supports?: string[] }[] }
  | { op: 'compete'; ids: [string, string] }
  | { op: 'invalidate'; id: string }

export class DecisionRefusal extends Error { constructor(public problems: string[]) { super(problems.join('; ')) } }

/** A new version to append. */
export interface Write { id: string; scope: Scope; status: DecisionVersion['status']; body: DecisionBody; supports: string[]; contradicts: string[] }

const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/

export function checkBody(b: unknown, where = 'body'): string[] {
  const out: string[] = []
  const x = b as DecisionBody
  if (!x || typeof x !== 'object') return [`${where} is a decision state's body`]
  if (typeof x.title !== 'string' || !x.title.trim()) out.push(`${where}.title is required`)
  if (typeof x.description !== 'string' || !x.description.trim()) out.push(`${where}.description says the situation in words`)
  if (!Array.isArray(x.cues) || !x.cues.length || x.cues.some((c) => typeof c !== 'string' || !c.trim())) out.push(`${where}.cues are the phrases that recognise it`)
  if (!Array.isArray(x.paths)) out.push(`${where}.paths is a list (it may be empty)`)
  else x.paths.forEach((p, i) => {
    if (!p || typeof p.id !== 'string' || !p.id || typeof p.label !== 'string' || !p.label) out.push(`${where}.paths[${i}] has an id and a label`)
    if (!p?.reasoning) out.push(`${where}.paths[${i}] says why (reasoning)`)
    if (!p?.intent || !(p.intent.ops || p.intent.action || p.intent.call || p.intent.text)) out.push(`${where}.paths[${i}].intent is ops, an action, a call or words`)
  })
  if (x.seen && typeof x.seen !== 'object') out.push(`${where}.seen is the range each figure was seen in`)
  return out
}

/**
 * What an operation writes, given each state's current version (a lookup). Refused with sentences when it cannot apply —
 * a state that does not exist, an id already taken, a body that does not say what a decision state must.
 */
export function plan(op: DecisionOp, current: (id: string) => DecisionVersion | null, experienceWorld: (id: string) => World | null = () => null): Write[] {
  const must = (id: string) => { const v = current(id); if (!v) throw new DecisionRefusal([`there is no decision state ${id}`]); if (v.status !== 'active') throw new DecisionRefusal([`decision state ${id} is ${v.status}`]); return v }
  const fresh = (id: string) => { if (!ID.test(id)) throw new DecisionRefusal([`"${id}" is not a decision state id (lowercase letters, digits, . _ -)`]); if (current(id)) throw new DecisionRefusal([`decision state ${id} already exists`]) }
  const body = (b: DecisionBody, where?: string) => { const p = checkBody(b, where); if (p.length) throw new DecisionRefusal(p); return { ...b, seen: b.seen ?? {} } }
  const widen = (b: DecisionBody, ids: string[]) => ids.reduce((acc, e) => { const w = experienceWorld(e); return w ? { ...acc, seen: observe(acc.seen, w) } : acc }, b)
  switch (op.op) {
    case 'create': fresh(op.id); if (!isScope(op.scope)) throw new DecisionRefusal([`"${op.scope}" is not a scope`]); return [{ id: op.id, scope: op.scope, status: 'active', body: widen(body(op.body), op.supports ?? []), supports: op.supports ?? [], contradicts: [] }]
    case 'reinforce': { const v = must(op.id); if (!op.supports?.length) throw new DecisionRefusal(['reinforcing names the experiences that support it']); return [{ id: v.id, scope: v.scope, status: 'active', body: widen(v.body, op.supports), supports: op.supports, contradicts: [] }] }
    case 'weaken': { const v = must(op.id); if (!op.contradicts?.length) throw new DecisionRefusal(['weakening names the experiences that contradict it']); return [{ id: v.id, scope: v.scope, status: 'active', body: v.body, supports: [], contradicts: op.contradicts }] }
    case 'merge': {
      if (!op.ids?.length || op.ids.length < 2) throw new DecisionRefusal(['merging takes two or more states'])
      const vs = op.ids.map(must)
      const into = current(op.into)
      if (into && !op.ids.includes(op.into)) throw new DecisionRefusal([`decision state ${op.into} already exists and is not one of those merged`])
      if (!into) fresh(op.into)
      const b = body(op.body); b.seen = vs.reduce((s, v) => mergeSeen(s, v.body.seen), b.seen)
      const scope = vs.every((v) => v.scope === vs[0].scope) ? vs[0].scope : 'global'
      return [{ id: op.into, scope, status: 'active', body: b, supports: [], contradicts: [] },
        ...vs.filter((v) => v.id !== op.into).map((v) => ({ id: v.id, scope: v.scope, status: 'superseded' as const, body: { ...v.body, competes: v.body.competes }, supports: [], contradicts: [] }))]
    }
    case 'generalise': { const v = must(op.id); const b = body(op.body); return [{ id: v.id, scope: v.scope, status: 'active', body: { ...b, seen: mergeSeen(b.seen, v.body.seen) }, supports: [], contradicts: [] }] }
    case 'specialise': { const p = must(op.parent); fresh(op.id); const scope = op.scope ?? p.scope; if (!isScope(scope)) throw new DecisionRefusal([`"${scope}" is not a scope`]); return [{ id: op.id, scope, status: 'active', body: widen({ ...body(op.body), parent: p.id }, op.supports ?? []), supports: op.supports ?? [], contradicts: [] }] }
    case 'supersede': { const v = must(op.id); must(op.by); return [{ id: v.id, scope: v.scope, status: 'superseded', body: v.body, supports: [], contradicts: [] }] }
    case 'split': {
      const v = must(op.id)
      if (!op.into?.length || op.into.length < 2) throw new DecisionRefusal(['splitting makes two or more states'])
      op.into.forEach((x) => fresh(x.id))
      return [...op.into.map((x, i) => ({ id: x.id, scope: v.scope, status: 'active' as const, body: widen({ ...body(x.body, `into[${i}].body`), parent: v.id }, x.supports ?? []), supports: x.supports ?? [], contradicts: [] })),
        { id: v.id, scope: v.scope, status: 'active', body: v.body, supports: [], contradicts: [] }]   // the general one stays: specialisations sit under it
    }
    case 'compete': {
      const [a, b] = op.ids.map(must)
      if (a.id === b.id) throw new DecisionRefusal(['a state does not compete with itself'])
      const add = (v: DecisionVersion, other: string) => ({ id: v.id, scope: v.scope, status: 'active' as const, body: { ...v.body, competes: [...new Set([...(v.body.competes ?? []), other])] }, supports: [], contradicts: [] })
      return [add(a, b.id), add(b, a.id)]
    }
    case 'invalidate': { const v = must(op.id); return [{ id: v.id, scope: v.scope, status: 'invalidated', body: v.body, supports: [], contradicts: [] }] }
    default: throw new DecisionRefusal([`there is no operation ${(op as any)?.op}`])
  }
}

function mergeSeen(a: Seen, b: Seen): Seen {
  const out: Seen = { ...a }
  for (const [k, s] of Object.entries(b)) { const t = out[k]; out[k] = t ? { min: Math.min(t.min, s.min), max: Math.max(t.max, s.max), n: t.n + s.n } : s }
  return out
}

/** Describe what a person did next from a step, from the session's intent. */
export function takenOf(intent: { kind: 'structured' | 'language'; ops?: Op[]; action?: Taken['action']; call?: Taken['call']; text?: string; to?: 'current' | 'new' }): Taken {
  const label = intent.kind === 'language' ? `asked: ${String(intent.text ?? '').slice(0, 120)}`
    : intent.call ? `ran ${intent.call.package}.${intent.call.fn}` : intent.action ? `took ${intent.action.package} · ${intent.action.id}`
    : (intent.ops ?? []).map((o: any) => `${o.op} ${o.path}${'value' in o ? ` = ${JSON.stringify(o.value)}` : ''}`).join(', ') || 'a change'
  return { kind: intent.kind, label, ...(intent.ops ? { ops: intent.ops } : {}), ...(intent.action ? { action: intent.action } : {}), ...(intent.call ? { call: intent.call } : {}), ...(intent.text ? { text: intent.text } : {}), ...(intent.to ? { to: intent.to } : {}) }
}

/** Two taken paths are the same path (what a decision state's path record counts). */
export function samePath(t: Taken, p: Path): boolean {
  const norm = (x: unknown) => JSON.stringify(x ?? null)
  if (p.intent.call) return !!t.call && t.call.package === p.intent.call.package && t.call.fn === p.intent.call.fn
  if (p.intent.action) return !!t.action && t.action.package === p.intent.action.package && t.action.id === p.intent.action.id
  if (p.intent.ops) return norm(t.ops) === norm(p.intent.ops)
  if (p.intent.text) return t.kind === 'language' && words(t.text ?? '').join(' ') === words(p.intent.text).join(' ')
  return false
}

/** A step of a session as the decision memory sees it: its cues, the world its answer showed, its STATE's hash. */
export function stepOf(v: { agent: string; states: Record<string, State>; blocks: { id: string; answer: string | null; stateHash: string }[]; answers: (Answer & { world?: World })[] }, block: string): { cues: string[]; world: World; stateHash: string } | null {
  const state = v.states[block]
  const b = v.blocks.find((x) => x.id === block)
  if (!state || !b) return null
  const answer = b.answer ? v.answers.find((a) => a.id === b.answer) ?? null : null
  return { cues: cuesOf({ agent: v.agent, question: (state.agent as any)?.question ?? null, state }), world: worldOf(answer), stateHash: b.stateHash }
}

/** Whose memory an experience is: the session owner's user scope. */
export const scopeOfUser = (user: string): Scope => `user:${String(user).replace(/^user:/, '')}`
