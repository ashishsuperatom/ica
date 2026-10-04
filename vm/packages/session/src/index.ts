// ── Sessions — one user's thread of blocks, its STATE and its answer history ─────────────────────────────────────────
//
// A session belongs to one user and starts with one agent. Its blocks are a tree: each block has the STATE it was made
// from and the answer it shows. The session's STATE is its current block's. An intent is applied to a block's STATE
// through the STATE engine:
//
//   to "current", sent from the current block   the block's STATE and answer are replaced (the answer records which
//                                               answer it replaced)
//   to "new", or sent from an earlier block     a new block under it: earlier blocks are never changed, so changing
//                                               one branches the thread
//
// Every answer is appended to the answer history; the history a person reads is the answers no later answer replaced.
// Only the result for the latest intent is applied: an intent that finishes after a newer one started is dropped
// (it says so), never applied over it.
//
// Everything is recorded in an append-only log, one entry per change, so a session can be rebuilt from its log, and
// read as of any moment. The log is behind a small interface: a file per session in the engine, a Durable Object on
// the platform.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Answer, Intent, Op, Session, State } from '@superatom/platform-types'
import { checkIntent } from '@superatom/platform-types'
import { stateHash, StateRefusal, type Outcome, type Ran, type StateEngine } from '@superatom/state'

export class SessionRefusal extends Error {
  constructor(public problems: string[]) { super(problems.join('; ')) }
}

/** One entry of a session's log. */
export type Entry =
  | { t: 'open'; at: string; session: string; user: string; agent: string }
  | { t: 'block'; at: string; id: string; parent: string | null; state: State; stateHash: string; intent: string | null }
  | { t: 'state'; at: string; block: string; state: State; stateHash: string; intent: string }   // the current block's STATE replaced
  | { t: 'answer'; at: string; answer: Answer }
  | { t: 'intent'; at: string; intent: Intent }
  | { t: 'current'; at: string; block: string }                                                   // a person moved to another block

export interface SessionLog {
  append(session: string, entry: Entry): void
  read(session: string): Entry[]
}

/** The log in memory (tests, and a session not kept). */
export function memoryLog(): SessionLog {
  const all = new Map<string, Entry[]>()
  return {
    append: (s, e) => { const l = all.get(s) ?? []; l.push(structuredClone(e)); all.set(s, l) },
    read: (s) => structuredClone(all.get(s) ?? []),
  }
}

/** The log as a JSON-lines file per session: `<dir>/<session>/session.jsonl`. Appended, never rewritten. */
export function fileLog(dir: string): SessionLog {
  const file = (s: string) => {
    if (!/^[\w-]+$/.test(s)) throw new SessionRefusal([`"${s}" is not a session id`])
    return join(dir, s, 'session.jsonl')
  }
  return {
    append: (s, e) => { const f = file(s); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, JSON.stringify(e) + '\n') },
    read: (s) => {
      const f = file(s)
      if (!existsSync(f)) return []
      // A line cut off by a crash mid-write is the last one; it is left out, everything before it stands.
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Entry] } catch { return [] } })
    },
  }
}

/** A session as its log makes it, as of a moment (the whole log when left out). */
export interface SessionView extends Session {
  /** Each block's own STATE, by block id. */
  states: Record<string, State>
  /** Every answer, in order, the replaced ones too. */
  answers: Answer[]
  intents: Intent[]
}

export function replay(entries: Entry[], asOf?: string): SessionView | null {
  let v: SessionView | null = null
  for (const e of entries) {
    if (asOf && e.at > asOf) break
    if (e.t === 'open') { v = { id: e.session, user: e.user, agent: e.agent, state: { packages: {} }, blocks: [], leaf: '', created: e.at, updated: e.at, states: {}, answers: [], intents: [] }; continue }
    if (!v) continue
    v.updated = e.at
    if (e.t === 'block') { v.blocks.push({ id: e.id, parent: e.parent, answer: null, stateHash: e.stateHash }); v.states[e.id] = e.state; v.leaf = e.id }
    else if (e.t === 'state') { v.states[e.block] = e.state; const b = v.blocks.find((x) => x.id === e.block); if (b) b.stateHash = e.stateHash }
    else if (e.t === 'answer') { v.answers.push(e.answer); const b = v.blocks.find((x) => x.id === e.answer.block); if (b) b.answer = e.answer.id }
    else if (e.t === 'intent') v.intents.push(e.intent)
    else if (e.t === 'current') v.leaf = e.block
  }
  if (v) v.state = v.states[v.leaf] ?? { packages: {} }
  return v
}

/** The answer history a person reads: the answers no later answer replaced, in order. */
export function history(v: SessionView): Answer[] {
  const replaced = new Set(v.answers.map((a) => a.replaced).filter(Boolean))
  return v.answers.filter((a) => !replaced.has(a.id))
}

/** The blocks from the first down to one block: the thread a person sees when that block is current. */
export function pathTo(v: SessionView, block: string): string[] {
  const out: string[] = []
  for (let b: string | null = block; b; b = v.blocks.find((x) => x.id === b)?.parent ?? null) out.unshift(b)
  return out
}

export interface IntentResult {
  /** Dropped: a newer intent started before this one finished; nothing of it was applied. */
  stale?: true
  session: SessionView
  block: string
  /** A new block was opened (else the current block was replaced). */
  opened: boolean
  answer: Answer | null
  changed: string[]
  ran: Ran[]
}

export interface SessionsOptions {
  log: SessionLog
  /** The STATE engine with the agent's packages loaded. */
  engine: StateEngine
  now?: () => string
  id?: (kind: 'blk' | 'ans') => string
}

/** The sessions of one agent's packages: open one, apply intents to it, move between its blocks, read it. */
export function createSessions(opts: SessionsOptions) {
  const now = opts.now ?? (() => new Date().toISOString())
  let n = 0
  const id = opts.id ?? ((kind) => `${kind}_${Date.now().toString(36)}${(n++).toString(36).padStart(3, '0')}`)
  const generation = new Map<string, number>()

  const read = (session: string, asOf?: string): SessionView => {
    const v = replay(opts.log.read(session), asOf)
    if (!v) throw new SessionRefusal([`there is no session ${session}`])
    return v
  }

  /** The answer a run gave: the runs' markdown in order, their files together. */
  const answerOf = (ran: Ran[], extra?: { markdown?: string; files?: string[] }): { markdown: string; files: string[] } | null => {
    const parts = [extra?.markdown, ...ran.map((r) => r.answer?.markdown)].filter((m): m is string => !!m?.trim())
    if (!parts.length) return null
    const files = [...new Set([...(extra?.files ?? []), ...ran.flatMap((r) => r.answer?.files ?? [])])]
    return { markdown: parts.join('\n\n'), files }
  }

  function open(o: { session: string; user: string; agent: string; start?: Parameters<StateEngine['start']>[0]; agentKeys?: Record<string, unknown> }): SessionView {
    if (opts.log.read(o.session).length) throw new SessionRefusal([`session ${o.session} already exists`])
    const at = now()
    const state = opts.engine.start(o.start, o.agentKeys)
    opts.log.append(o.session, { t: 'open', at, session: o.session, user: o.user, agent: o.agent })
    opts.log.append(o.session, { t: 'block', at, id: id('blk'), parent: null, state, stateHash: stateHash(state), intent: null })
    return read(o.session)
  }

  async function intent(i: Intent): Promise<IntentResult> {
    const bad = checkIntent(i)
    if (bad.length) throw new SessionRefusal(bad)
    const before = read(i.session)
    if (i.by !== before.user) throw new SessionRefusal([`session ${i.session} is ${before.user}'s; ${i.by} cannot change it`])
    const from = i.block ?? before.leaf
    const base = before.states[from]
    if (!base) throw new SessionRefusal([`session ${i.session} has no block ${from}`])
    const isLeaf = !before.blocks.some((b) => b.parent === from)
    const opening = i.to === 'new' || !isLeaf || from !== before.leaf

    const g = (generation.get(i.session) ?? 0) + 1
    generation.set(i.session, g)

    // What the intent does to STATE: ops (the control's, or what the ICA read from the words), then an action or a call.
    let out: Outcome = { state: base, changed: [], ran: [] }
    try {
      const ops: Op[] = i.kind === 'language' ? (i.result?.ops ?? []) : (i.ops ?? [])
      if (ops.length) out = await opts.engine.dispatch(base, ops)
      if (i.action) { const r = await opts.engine.act(out.state, i.action.package, i.action.id); out = { state: r.state, changed: [...out.changed, ...r.changed], ran: [...out.ran, ...r.ran] } }
      if (i.call) { const r = await opts.engine.call(out.state, i.call.package, i.call.fn, i.call.params); out = { state: r.state, changed: [...out.changed, ...r.changed], ran: [...out.ran, ...r.ran] } }
    } catch (e) {
      if (e instanceof StateRefusal) throw new SessionRefusal(e.problems ?? [e.message])
      throw e
    }

    if (generation.get(i.session) !== g) return { stale: true, session: read(i.session), block: from, opened: false, answer: null, changed: [], ran: [] }

    const at = now()
    opts.log.append(i.session, { t: 'intent', at, intent: i })
    const hash = stateHash(out.state)
    let block = from
    if (opening) {
      block = id('blk')
      opts.log.append(i.session, { t: 'block', at, id: block, parent: from, state: out.state, stateHash: hash, intent: i.id })
    } else if (hash !== stateHash(base)) {
      opts.log.append(i.session, { t: 'state', at, block, state: out.state, stateHash: hash, intent: i.id })
    }
    const said = answerOf(out.ran, i.kind === 'language' ? i.result : undefined)
    let answer: Answer | null = null
    if (said) {
      const previous = opening ? null : before.blocks.find((b) => b.id === from)?.answer ?? null
      answer = { id: id('ans'), session: i.session, block, cause: i.id, stateHash: hash, at, markdown: said.markdown, files: said.files, ...(previous ? { replaced: previous } : {}) }
      opts.log.append(i.session, { t: 'answer', at, answer })
    }
    return { session: read(i.session), block, opened: opening, answer, changed: out.changed, ran: out.ran }
  }

  /** Make another block the current one (a person went back to it). Nothing else changes. */
  function goTo(session: string, block: string, by: string): SessionView {
    const v = read(session)
    if (by !== v.user) throw new SessionRefusal([`session ${session} is ${v.user}'s; ${by} cannot change it`])
    if (!v.states[block]) throw new SessionRefusal([`session ${session} has no block ${block}`])
    if (v.leaf !== block) opts.log.append(session, { t: 'current', at: now(), block })
    return read(session)
  }

  return { open, intent, goTo, read }
}
