// SESSIONS — an agent's sessions of blocks, run on its programs. These payloads come here (the other session:* messages
// belong to the chat):
//
//   session:agents                                  → session:agents   { agents: [{ id, name, ui }] }
//   session:open   { session, agent }               → session:view     { view }
//   session:intent { session, ops?|action?|call?, to, block? }
//                                                  → session:view     { view, result: { block, opened, answer, stale? } }
//   session:goto   { session, block }               → session:view     { view }
//   session:get    { session, asOf? }               → session:view     { view }
//   session:file   { hash, path }                   → session:file     { hash, path, text }   a program's React side, file by file
//
// Every session:view also carries `cards` (each answer in the history as the answer card every surface draws, by answer
// id), `actions` (what the agent's programs offer: run, and each action they suggest, as intents a screen can send) and
// `uis` (each program's React side: its hash and the blocks it draws, loaded with session:file).
//
// A refusal is session:refused { reason } — a sentence, never a different answer. Who is asking is the hub's word
// (`from.userId`), never the payload's: a session is one user's, and only they change it.
//
// An agent is a file in the project home, agents/<id>.json (platform-types AgentSpec); its programs are names or
// hashes in the project's program store (programs/store), loaded into one STATE engine whose data goes through the
// datasource manager. Each session is logged in sessions/<session>/session.jsonl.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkAgent, type AgentSpec, type Intent } from '@superatom/platform-types'
import { ProgramStore, ProgramError, loadPackage } from '@superatom/programs'
import { createStateEngine, StateRefusal, type StateEngine } from '@superatom/state'
import { createSessions, fileLog, history, replay, SessionRefusal, type SessionView } from '@superatom/session'
import { cardOf } from './answer-card.js'

export interface SessionSeamDeps {
  projectDir: string
  /** The datasource manager's address. */
  datasource: string
  send: (to: any, msg: Record<string, unknown>) => void
}

export class SessionSeamRefusal extends Error {}

/** The messages this seam takes (session:new, session:load and session:compact are the chat's). */
export const SESSION_MESSAGES = new Set(['session:agents', 'session:open', 'session:intent', 'session:goto', 'session:get', 'session:file'])

export function createSessionSeam(d: SessionSeamDeps) {
  const agentsDir = join(d.projectDir, 'agents')
  const store = new ProgramStore(join(d.projectDir, 'programs', 'store'))
  const log = fileLog(join(d.projectDir, 'sessions'))

  const query = async (id: string, sql: string, params: Record<string, unknown> = {}) => {
    const r = await fetch(d.datasource + '/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, sql, params }) })
    const p: any = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }))
    if (!r.ok || p?.error) throw new Error(p?.error ?? `${r.status}`)
    return p.rows ?? []
  }

  function readAgent(id: string): AgentSpec {
    if (!/^[\w-]+$/.test(id)) throw new SessionSeamRefusal(`"${id}" is not an agent id`)
    const file = join(agentsDir, `${id}.json`)
    if (!existsSync(file)) throw new SessionSeamRefusal(`there is no agent "${id}"`)
    let spec: AgentSpec
    try { spec = JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { throw new SessionSeamRefusal(`agents/${id}.json is not JSON: ${e.message}`) }
    const bad = checkAgent(spec)
    if (bad.length) throw new SessionSeamRefusal(`agents/${id}.json: ${bad.join('; ')}`)
    if (spec.id !== id) throw new SessionSeamRefusal(`agents/${id}.json calls itself "${spec.id}"`)
    return spec
  }

  // One runtime per agent and program set: the same programs (by hash) give the same engine; a new build of a program
  // makes a new one for sessions opened after it. A session keeps the hashes its STATE names.
  const runtimes = new Map<string, Promise<{ engine: StateEngine; sessions: ReturnType<typeof createSessions>; packages: Awaited<ReturnType<typeof loadPackage>>[] }>>()
  async function runtimeFor(agent: string, pinned?: Record<string, string>) {
    const spec = readAgent(agent)
    const hashes = spec.programs.map((ref) => store.resolve(ref))
    // A session already running names its packages' hashes in its STATE: those, not the newest builds.
    const use = pinned && Object.keys(pinned).length ? Object.values(pinned) : hashes
    const key = `${agent}:${[...use].sort().join(',')}`
    if (!runtimes.has(key)) runtimes.set(key, (async () => {
      const packages = await Promise.all(use.map((h) => loadPackage(store, h)))
      const engine = createStateEngine(packages as any, { services: { query } })
      return { engine, sessions: createSessions({ log, engine }), packages }
    })())
    const r = runtimes.get(key)!
    r.catch(() => runtimes.delete(key))
    return { ...(await r), spec }
  }

  const userOf = (from: any): string => {
    if (!from?.userId) throw new SessionSeamRefusal('the hub did not say who is asking')
    return `user:${from.userId}`
  }

  async function sessionRuntime(session: string) {
    const v = replay(log.read(session))
    if (!v) throw new SessionSeamRefusal(`there is no session ${session}`)
    return { view: v, ...(await runtimeFor(v.agent, v.state.packages)) }
  }

  function agents() {
    if (!existsSync(agentsDir)) return []
    return readdirSync(agentsDir).filter((f) => f.endsWith('.json')).flatMap((f) => {
      try { const a = readAgent(f.slice(0, -5)); return [{ id: a.id, name: a.name, scope: a.scope, ui: a.ui, isDefault: !!a.isDefault }] } catch { return [] }
    })
  }

  const viewOf = (v: SessionView, user: string) => {
    if (v.user !== user) throw new SessionSeamRefusal(`session ${v.id} is not yours`)
    return v
  }

  /** A view as a screen needs it: the session, its answers as cards, and the intents its programs offer. */
  async function present(v: SessionView, extra: Record<string, unknown> = {}) {
    const rt = await runtimeFor(v.agent, v.state.packages).catch(() => null)
    const cards: Record<string, unknown> = {}
    for (const a of history(v)) cards[a.id] = await cardOf(a)
    const actions = (rt?.packages ?? []).flatMap((p) => [
      { package: p.name, label: 'Run', intent: { call: { package: p.name, fn: 'run' }, to: 'current' } },
      ...p.spec.actions.map((a) => ({ package: p.name, label: a.label, intent: { action: { package: p.name, id: a.id }, to: 'current' } })),
    ])
    const uis = (rt?.packages ?? []).map((p) => ({ package: p.name, hash: p.hash, entry: store.manifest(p.hash).ui.bundle, blocks: store.manifest(p.hash).ui.blocks }))
    return { t: 'session:view', view: v, cards, actions, uis, ...extra }
  }

  // A program's React side, file by file: only built programs' web/ files, each program checked against its hash once.
  const verified = new Set<string>()
  function programFile(hash: string, path: string): string {
    if (!/^web\/[\w-]+(\/[\w-]+)*(\.[\w-]+)*\.js$/.test(path)) throw new SessionSeamRefusal(`"${path}" is not a file of a program's React side`)
    if (!store.has(hash)) throw new SessionSeamRefusal(`there is no program ${hash.slice(0, 12)}`)
    if (!verified.has(hash)) { if (!store.verify(hash)) throw new SessionSeamRefusal(`program ${hash.slice(0, 12)} does not match its hash`); verified.add(hash) }
    const file = join(store.dirOf(hash), path)
    if (!existsSync(file)) throw new SessionSeamRefusal(`program ${hash.slice(0, 12)} has no ${path}`)
    return readFileSync(file, 'utf8')
  }

  async function handle(payload: any, from: any): Promise<void> {
    const t = String(payload.t)
    const reply = (msg: Record<string, unknown>) => d.send(from, { ...msg, reqId: payload.reqId })
    try {
      if (t === 'session:agents') return reply({ t: 'session:agents', agents: agents() })
      const user = userOf(from)
      if (t === 'session:file') { const hash = String(payload.hash ?? ''), path = String(payload.path ?? ''); return reply({ t: 'session:file', hash, path, text: programFile(hash, path) }) }
      const session = String(payload.session ?? '')
      if (!/^[\w-]{1,80}$/.test(session)) throw new SessionSeamRefusal('a session message names its session')
      if (t === 'session:open') {
        const { sessions, spec } = await runtimeFor(String(payload.agent ?? ''))
        return reply(await present(sessions.open({ session, user, agent: spec.id, start: spec.start })))
      }
      if (t === 'session:get') {
        const v = replay(log.read(session), payload.asOf ? String(payload.asOf) : undefined)
        if (!v) throw new SessionSeamRefusal(`there is no session ${session}`)
        return reply(await present(viewOf(v, user)))
      }
      const { sessions, view } = await sessionRuntime(session)
      viewOf(view, user)
      if (t === 'session:goto') return reply(await present(sessions.goTo(session, String(payload.block ?? ''), user)))
      if (t === 'session:intent') {
        if (payload.kind === 'language') throw new SessionSeamRefusal('words are answered in the chat for now: a session takes the controls\' intents')
        const intent: Intent = {
          id: `int_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, session, kind: 'structured',
          ...(payload.ops ? { ops: payload.ops } : {}), ...(payload.action ? { action: payload.action } : {}), ...(payload.call ? { call: payload.call } : {}),
          to: payload.to, ...(payload.block ? { block: String(payload.block) } : {}), by: user, at: new Date().toISOString(),
        }
        const r = await sessions.intent(intent)
        return reply(await present(r.session, { result: { block: r.block, opened: r.opened, answer: r.answer, ...(r.stale ? { stale: true } : {}) } }))
      }
      throw new SessionSeamRefusal(`there is no ${t}`)
    } catch (e: any) {
      if (e instanceof SessionSeamRefusal || e instanceof SessionRefusal || e instanceof ProgramError || e instanceof StateRefusal) return reply({ t: 'session:refused', reason: e.message })
      console.error('[session]', e?.stack ?? e)
      return reply({ t: 'session:refused', reason: `the session could not do that: ${e?.message ?? e}` })
    }
  }

  return { handle, agents }
}
