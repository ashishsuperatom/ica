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
import type { Answer, Intent, Op, State } from '@superatom/platform-types'
import { checkIntent } from '@superatom/platform-types'
import { stateHash, StateRefusal, type Outcome, type Ran, type StateEngine } from '@superatom/state'

import { SessionRefusal, replay, type Entry, type SessionLog, type SessionView } from './core.ts'
export * from './core.ts'

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
  const answerOf = (ran: Ran[], extra?: { markdown?: string; files?: string[]; blocks?: Record<string, Record<string, unknown>> }): { markdown: string; files: string[]; blocks?: Record<string, Record<string, unknown>>; world?: Record<string, number> } | null => {
    const parts = [extra?.markdown, ...ran.map((r) => r.answer?.markdown)].filter((m): m is string => !!m?.trim())
    if (!parts.length) return null
    const files = [...new Set([...(extra?.files ?? []), ...ran.flatMap((r) => r.answer?.files ?? [])])]
    const blocks = Object.assign({}, extra?.blocks ?? {}, ...ran.map((r) => r.answer?.blocks ?? {}))
    const world = Object.assign({}, ...ran.map((r) => r.answer?.world ?? {}))
    return { markdown: parts.join('\n\n'), files, ...(Object.keys(blocks).length ? { blocks } : {}), ...(Object.keys(world).length ? { world } : {}) }
  }

  /** Open a session: on the agent's start (its fields over every package's initial slice), or on a whole STATE a view
   *  was already at (a browsed view becoming a session, or a view computed in a throwaway session). */
  function open(o: { session: string; user: string; agent: string; start?: Parameters<StateEngine['start']>[0]; agentKeys?: Record<string, unknown>; state?: State }): SessionView {
    if (opts.log.read(o.session).length) throw new SessionRefusal([`session ${o.session} already exists`])
    const at = now()
    const state = o.state ?? opts.engine.start(o.start, o.agentKeys)
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
    const said = answerOf(out.ran, i.kind === 'language' ? i.result as { markdown?: string; files?: string[]; blocks?: Record<string, Record<string, unknown>> } : undefined)
    let answer: Answer | null = null
    if (said) {
      const previous = opening ? null : before.blocks.find((b) => b.id === from)?.answer ?? null
      answer = { id: id('ans'), session: i.session, block, cause: i.id, stateHash: hash, at, markdown: said.markdown, files: said.files, ...(said.blocks ? { blocks: said.blocks } : {}), ...(said.world ? { world: said.world } : {}), ...(previous ? { replaced: previous } : {}) }
      opts.log.append(i.session, { t: 'answer', at, answer })
    }
    return { session: read(i.session), block, opened: opening, answer, changed: out.changed, ran: out.ran }
  }

  /** Open a session and run its programs at once, so its first step shows what the agent's programs show — a dashboard
   *  opens with its data. Each package's run sees the STATE the one before it left; their answers are one answer. */
  async function openAndRun(o: Parameters<typeof open>[0] & { run: string[] }): Promise<SessionView> {
    const v = open(o)
    if (!o.run.length) return v
    let out: Outcome = { state: v.state, changed: [], ran: [] }
    try {
      for (const pkg of o.run) { const r = await opts.engine.call(out.state, pkg, 'run'); out = { state: r.state, changed: [...out.changed, ...r.changed], ran: [...out.ran, ...r.ran] } }
    } catch (e) {
      if (e instanceof StateRefusal) throw new SessionRefusal(e.problems ?? [e.message])
      throw e
    }
    const at = now(), block = v.leaf, hash = stateHash(out.state)
    if (hash !== stateHash(v.state)) opts.log.append(o.session, { t: 'state', at, block, state: out.state, stateHash: hash, intent: 'open' })
    const said = answerOf(out.ran)
    if (said) opts.log.append(o.session, { t: 'answer', at, answer: { id: id('ans'), session: o.session, block, cause: 'open', stateHash: hash, at, markdown: said.markdown, files: said.files, ...(said.blocks ? { blocks: said.blocks } : {}), ...(said.world ? { world: said.world } : {}) } })
    return read(o.session)
  }

  /** Make another block the current one (a person went back to it). Nothing else changes. */
  function goTo(session: string, block: string, by: string): SessionView {
    const v = read(session)
    if (by !== v.user) throw new SessionRefusal([`session ${session} is ${v.user}'s; ${by} cannot change it`])
    if (!v.states[block]) throw new SessionRefusal([`session ${session} has no block ${block}`])
    if (v.leaf !== block) opts.log.append(session, { t: 'current', at: now(), block })
    return read(session)
  }

  return { open, openAndRun, intent, goTo, read }
}
