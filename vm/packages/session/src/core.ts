// ── Sessions, the part that runs anywhere ────────────────────────────────────────────────────────────────────────────
// A session's log entries and what they make: the view (blocks, STATE, answers) as of any moment, the answer history,
// the path to a block. No file system and no engine here, so the platform (a Durable Object) reads a session with the
// same code the engine writes it with.

import type { Answer, Intent, Session, State } from '@superatom/platform-types'

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

