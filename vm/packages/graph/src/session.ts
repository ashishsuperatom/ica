// ── THE DATA SESSION: A PERSON'S QUESTIONS AS STATES ──────────────────────────────────────────────────────────
//
// Two sessions run side by side, and both are needed.
//
//   the agent's session   the conversation with the model, kept by whichever harness runs it; only its id reaches here
//   the data session      what the person has asked of the data: states, each the answer's question, and the answers
//
// A person's first question becomes a STATE — a program, the request asked of it, assumptions, interventions, and the
// day it is answered as of when that is fixed. Every follow-up is a MESSAGE applied to the current state, producing
// the next one: S1 → S2 → S3. Each state is answered by calling its program, and the answer is kept with the step, so
// "the third customer" refers to a row the person was actually shown.
//
// Programs are global; a state belongs to its session, and a session to the person. A state is plain data — it can be put in a link, pinned to a
// dashboard, or re-answered on another day — and it names no access: that always comes from whoever asks.
//
// Messages are typed and checked against the program's contract before anything runs, so a follow-up that cannot
// apply is refused as a message, not discovered as a failed query. Going back to an earlier step and applying a
// message there branches the session: a session is a tree.

import { createHash } from 'node:crypto'
import type { Grains } from './calendar.js'
import type { Contract } from './contract.js'
import type { Condition } from './coordinates.js'
import type { Registry } from './registry.js'
import type { Intervention } from './runtime.js'

export interface State {
  program: string
  request: Record<string, unknown>
  assume: Record<string, unknown>
  intervene: Record<string, Intervention>
  /** The day the state is answered as of, when fixed; absent means today, whenever it is asked. */
  asOf?: string
}

export type Message =
  /** A new question: a program and what is asked of it. `keep` carries over what the new program accepts. */
  | { ask: string; request?: Record<string, unknown>; assume?: Record<string, unknown>; keep?: boolean }
  /** Request fields set, or removed with null: during, at, compare, order, limit, totals, currency, detail… */
  | { set: Record<string, unknown> }
  | { measures: { add?: string[]; remove?: string[] } }
  | { split: { add?: string[]; remove?: string[] } }
  | { filter: Record<string, Condition> }
  | { unfilter: string[] }
  | { assume: Record<string, unknown> }
  | { unassume: string[] }
  | { intervene: Record<string, Intervention> }
  | { unintervene: string[] }
  /** Fix the day the state is answered as of, or null to follow today. */
  | { asOf: string | null }

export class MessageError extends Error {}
const refuse = (msg: string): never => { throw new MessageError(msg) }

const COORDINATES = new Set(['measures', 'by', 'where', 'having', 'order', 'limit', 'limitPer', 'currency', 'detail', 'totals', 'share',
  'during', 'at', 'rollup', 'fill', 'compare', 'cumulative', 'rolling'])
/** What a relation keeps when a new question moves to another one: the when and the which, not the what. */
const CARRIED = ['during', 'at', 'compare', 'currency']

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}
export const stateHash = (s: State) => 'state:' + createHash('sha256').update(canonical(s)).digest('hex').slice(0, 16)

const without = <T extends Record<string, unknown>>(o: T, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) as T

/** The state a message makes of the current one. No state yet: only a new question applies. */
export function applyMessage(current: State | null, m: Message, programs: Registry): State {
  if ('ask' in m) {
    const found = programs.resolve(m.ask) ?? refuse(`there is no program "${m.ask}"`)
    let request = m.request ?? {}
    let assume = m.assume ?? {}
    if (m.keep && current) {
      const target = programs.program(found.hash)!.contract
      const accepted = target.returns === 'relation' ? CARRIED : Object.keys(target.params)
      const carried = Object.fromEntries(Object.entries(current.request).filter(([k]) => accepted.includes(k)))
      if (target.returns === 'relation' && current.request.where) {
        const dims = Object.keys(target.shape!.dimensions)
        const where = Object.fromEntries(Object.entries(current.request.where as Record<string, unknown>).filter(([d]) => dims.includes(d.split('.')[0].replace(/_label$/, ''))))
        if (Object.keys(where).length) (carried as any).where = where
      }
      request = { ...carried, ...request }
      assume = { ...current.assume, ...assume }
    }
    return { program: found.name, request, assume, intervene: {}, ...(m.keep && current?.asOf ? { asOf: current.asOf } : {}) }
  }
  if (!current) return refuse('there is no question yet to follow up — start with { ask }')
  const s: State = structuredClone(current)
  if ('set' in m) {
    for (const [k, v] of Object.entries(m.set)) {
      if (v === null) delete s.request[k]
      else s.request[k] = v
    }
  } else if ('measures' in m) {
    const now = new Set((s.request.measures as string[] | undefined) ?? [])
    for (const x of m.measures.add ?? []) now.add(x)
    for (const x of m.measures.remove ?? []) now.delete(x)
    s.request = now.size ? { ...s.request, measures: [...now] } : without(s.request, ['measures'])
  } else if ('split' in m) {
    const now = ((s.request.by as string[] | undefined) ?? []).filter((d) => !(m.split.remove ?? []).includes(d))
    for (const d of m.split.add ?? []) if (!now.includes(d)) now.push(d)
    s.request = now.length ? { ...s.request, by: now } : without(s.request, ['by'])
  } else if ('filter' in m) {
    s.request = { ...s.request, where: { ...((s.request.where as object) ?? {}), ...m.filter } }
  } else if ('unfilter' in m) {
    const where = without((s.request.where as Record<string, unknown>) ?? {}, m.unfilter)
    s.request = Object.keys(where).length ? { ...s.request, where } : without(s.request, ['where'])
  } else if ('assume' in m) {
    s.assume = { ...s.assume, ...m.assume }
  } else if ('unassume' in m) {
    s.assume = without(s.assume, m.unassume)
  } else if ('intervene' in m) {
    s.intervene = { ...s.intervene, ...m.intervene }
  } else if ('unintervene' in m) {
    s.intervene = without(s.intervene as Record<string, unknown>, m.unintervene) as Record<string, Intervention>
  } else if ('asOf' in m) {
    if (m.asOf === null) delete s.asOf
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(m.asOf)) refuse('asOf is a date, YYYY-MM-DD, or null to follow today')
    else s.asOf = m.asOf
  } else {
    refuse(`unknown message: ${Object.keys(m).join(', ')}`)
  }
  return s
}

/** Why a state cannot be asked, found from the contract alone — before any query. */
export function stateProblem(s: State, programs: Registry, grains: Grains): string | null {
  const found = programs.resolve(s.program)
  if (!found) return `there is no program "${s.program}"`
  const c: Contract = programs.program(found.hash)!.contract
  if (c.returns !== 'relation') {
    const unknown = Object.keys(s.request).filter((k) => !(k in c.params))
    if (unknown.length) return `"${s.program}" takes ${Object.keys(c.params).join(', ') || 'nothing'}; it has no ${unknown.map((k) => `"${k}"`).join(', ')}`
    return null
  }
  const shape = c.shape!
  for (const k of Object.keys(s.request)) if (!COORDINATES.has(k)) return `"${k}" is not something a relation can be asked`
  for (const m of (s.request.measures as string[] | undefined) ?? []) if (!shape.measures[m]) return `"${s.program}" has no measure "${m}" — it has ${Object.keys(shape.measures).join(', ')}`
  const knownName = (d: string) => {
    const base = d.replace(/_label$/, '')
    if (shape.dimensions[base] || grains.has(base)) return true
    const [via] = base.split('.')
    return base.includes('.') && !!shape.dimensions[via]?.entity
  }
  for (const d of (s.request.by as string[] | undefined) ?? []) if (!knownName(d)) return `"${s.program}" cannot be split by "${d}" — it has ${[...Object.keys(shape.dimensions), 'a time grain'].join(', ')}`
  for (const d of Object.keys((s.request.where as object | undefined) ?? {})) if (!knownName(d) || grains.has(d)) return `"${s.program}" cannot be filtered on "${d}"`
  for (const name of Object.keys(s.intervene)) if (!programs.resolve(name)) return `cannot intervene on "${name}": there is no such program`
  return null
}

export interface Step {
  id: number
  sessionId: string
  parent: number | null
  message: Message
  state: State
  stateHash: string
  callId: string | null
  error: string | null
  at: number
}

export interface Found { step: number; message: Message; index: number; row: Record<string, unknown> | null; value?: unknown }

// ── the session, run ─────────────────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import type { CallOptions } from './runtime.js'
import type { GraphStore } from './store.js'

type Call = <T>(name: string, request: Record<string, unknown>, options?: CallOptions) => Promise<{ value: T; callId: string }>

export function sessions(store: GraphStore, programs: Registry, grains: () => Grains, call: Call) {
  const need = (id: string) => store.getSession(id) ?? refuse(`there is no session "${id}"`)

  /** A data session for one person — with the id given, or a new one; opening one that exists returns it. `who` is
   *  recorded so the session's answers are asked as them. */
  function open(options: { id?: string; who?: Record<string, unknown>; title?: string } = {}): string {
    const id = options.id ?? randomUUID()
    if (!store.getSession(id)) store.openSession(id, options.who ?? null, options.title ?? null)
    return id
  }

  /** Whether a session exists. */
  const exists = (id: string) => !!store.getSession(id)

  /** Apply a message to the current step — or to `from`, which branches — answer the new state, and record both. A
   *  message that cannot apply, or a state that cannot be asked, is refused before anything runs and recorded as such;
   *  the current step does not move. An answer that fails is recorded with its error; the current step does not move. */
  async function apply(sessionId: string, message: Message, options: { from?: number; access?: CallOptions['access'] } = {}) {
    const session = need(sessionId)
    const all = store.steps(sessionId)
    const fromId = options.from ?? session.currentStep
    const base = fromId == null ? null : all.find((s) => s.id === fromId) ?? refuse(`step ${fromId} is not in this session`)
    let state: State
    try {
      state = applyMessage(base?.state ?? null, message, programs)
      const problem = stateProblem(state, programs, grains())
      if (problem) refuse(problem)
    } catch (e: any) {
      const id = store.addStep({ sessionId, parent: base?.id ?? null, message, state: base?.state ?? {}, stateHash: '', callId: null, error: String(e.message) }, false)
      return { step: id, refused: String(e.message), state: base?.state ?? null }
    }
    const asked: CallOptions = { assume: state.assume, intervene: state.intervene, today: state.asOf, who: session.who ?? undefined, access: options.access }
    try {
      const r = await call<unknown>(state.program, state.request, asked)
      // A next step is offered only if it could be applied to this state: one that could not is dropped, and said.
      const answer = r.value as { nextSteps?: Array<{ label: string; message: Message }>; dropped?: string[] }
      if (answer && Array.isArray(answer.nextSteps)) {
        const kept: typeof answer.nextSteps = []
        const dropped: string[] = []
        for (const step of answer.nextSteps) {
          try {
            const problem = stateProblem(applyMessage(state, step.message, programs), programs, grains())
            if (problem) throw new Error(problem)
            kept.push(step)
          } catch (e: any) { dropped.push(`${step.label}: ${e.message}`) }
        }
        answer.nextSteps = kept
        if (dropped.length) answer.dropped = dropped
      }
      const id = store.addStep({ sessionId, parent: base?.id ?? null, message, state, stateHash: stateHash(state), callId: r.callId, error: null }, true)
      return { step: id, state, callId: r.callId, value: r.value }
    } catch (e: any) {
      const id = store.addStep({ sessionId, parent: base?.id ?? null, message, state, stateHash: stateHash(state), callId: e.callId ?? null, error: String(e.message) }, false)
      return { step: id, state, callId: e.callId ?? null, error: String(e.message) }
    }
  }

  /** Make an earlier step the current one: the next message applies there. */
  function goTo(sessionId: string, step: number): void {
    need(sessionId)
    if (!store.steps(sessionId).some((s) => s.id === step)) refuse(`step ${step} is not in this session`)
    store.moveCurrent(sessionId, step)
  }

  function history(sessionId: string) {
    const session = need(sessionId)
    return { current: session.currentStep, steps: store.steps(sessionId) }
  }

  // ── WHAT THE PERSON WAS SHOWN ────────────────────────────────────────────────────────────────────────────────
  // "The third customer", "the one at 38%", "that supplier from before" point at an answer the person saw. `find`
  // searches the session's answers: a row by position in a step's answer as it was shown; rows where a column holds a
  // value; rows whose text contains words. Newest steps first.
  function find(sessionId: string, q: { step?: number; row?: number; column?: string; equals?: unknown; text?: string; limit?: number }): Found[] {
    const session = need(sessionId)
    const answered = store.steps(sessionId).filter((s) => s.callId && !s.error)
    const inScope = q.step != null || q.row != null ? answered.filter((s) => s.id === (q.step ?? session.currentStep)) : [...answered].reverse()
    const out: Found[] = []
    const limit = q.limit ?? 50
    for (const s of inScope) {
      const output: any = store.getCall(s.callId!)?.output
      if (output == null) continue
      const rows: Record<string, unknown>[] | null = Array.isArray(output?.rows) ? output.rows : Array.isArray(output) ? output : null
      if (!rows) {
        if (q.text && JSON.stringify(output).toLowerCase().includes(q.text.toLowerCase())) out.push({ step: s.id, message: s.message, index: -1, row: null, value: output })
        continue
      }
      if (q.row != null) {
        const row = rows[q.row - 1]
        if (!row) refuse(`step ${s.id}'s answer has ${rows.length} row(s); there is no row ${q.row}`)
        return [{ step: s.id, message: s.message, index: q.row, row }]
      }
      rows.forEach((row, i) => {
        if (out.length >= limit) return
        const byColumn = q.column != null && String(row[q.column]) === String(q.equals)
        const byText = q.text != null && Object.values(row).some((v) => typeof v === 'string' && v.toLowerCase().includes(q.text!.toLowerCase()))
        if ((q.column != null && byColumn && (q.text == null || byText)) || (q.column == null && byText)) out.push({ step: s.id, message: s.message, index: i + 1, row })
      })
      if (out.length >= limit) break
    }
    return out
  }

  return { open, exists, apply, goTo, history, find }
}
