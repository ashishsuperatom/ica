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
import { execFile } from 'node:child_process'
import { placeForRunning, pick } from './knowledge.js'
import { checkAgent, type AgentSpec, type Intent } from '@superatom/platform-types'
import { ProgramStore, ProgramError, loadPackage } from '@superatom/programs'
import { createStateEngine, StateRefusal, type StateEngine } from '@superatom/state'
import { createSessions, fileLog, history, replay, SessionRefusal, type SessionLog, type SessionView } from '@superatom/session'
import { Store, governance as g, GovernanceRefusal } from '@superatom/composition-graph'
import { cardOf } from './answer-card.js'
import { whoIs, type Who } from './identity.js'
import { asReader, currentReader, AccessRefusal } from './access.js'

export interface SessionSeamDeps {
  projectDir: string
  /** The datasource manager's address. */
  datasource: string
  send: (to: any, msg: Record<string, unknown>) => void
  /** The session log (default: a file per session; the engine passes one that also syncs to the platform). */
  log?: SessionLog
  /** Find a program the store lacks (the engine fetches it from the platform); by default the store only. */
  ensureProgram?: (ref: string) => Promise<string>
  /** The composition graph, where agents are kept (kind "agent"); agents/<id>.json files are read only as a fallback. */
  graphFile?: string
  /** Long work made visible (activity.ts); without it, nothing is reported. */
  activities?: ReturnType<typeof import('./activity.js').createActivities>
  /** The reader's data access policies for a source (access.ts); without it, reads carry none. */
  access?: { policiesFor(who: Who, source: string): Promise<unknown[]> }
  /** Words answered by the session's agent (the composer on the agent's domain); without it, a session takes only controls. */
  ask?: (o: { session: string; text: string; context: string; domain: string | null; from: any; reqId?: string }) => Promise<{ markdown: string | null; blocks: unknown[] }>
}

/** What the agent is told about the step it is answering from, and how its answer may change it. */
export const INTENT_CONTRACT = `To change what this step shows, end your answer with one line:
:::intent {"ops":[{"op":"set","path":"<package>.<field>","value":…}],"to":"current"}
or call a program's function: :::intent {"call":{"package":"<package>","fn":"<function>","params":{…}},"to":"new"}.
"current" changes this step; "new" opens a new step. Paths and functions are the programs' own, below.`

/** The answer's own words, and the intent its last :::intent line asks for (taken out of what is shown). */
export function intentOf(markdown: string): { markdown: string; intent: { ops?: any[]; call?: any; action?: any; to?: 'current' | 'new' } | null; problem?: string } {
  const lines = String(markdown ?? '').split('\n')
  let intent: any = null, problem: string | undefined
  const kept = lines.filter((l) => {
    const m = /^\s*:::intent\s+(\{.*\})\s*$/.exec(l)
    if (!m) return true
    try { const x = JSON.parse(m[1]); if (x && typeof x === 'object') intent = { ...(Array.isArray(x.ops) ? { ops: x.ops } : {}), ...(x.call ? { call: x.call } : {}), ...(x.action ? { action: x.action } : {}), ...(x.to === 'new' || x.to === 'current' ? { to: x.to } : {}) } }
    catch (e: any) { problem = `the answer asked for a change that could not be read: ${e.message}` }
    return false
  })
  return { markdown: kept.join('\n').trim(), intent: intent && (intent.ops || intent.call || intent.action) ? intent : null, ...(problem ? { problem } : {}) }
}

export class SessionSeamRefusal extends Error {}

const pathOfView = (v: SessionView, block: string) => { const out: string[] = []; for (let b: string | null = block; b; b = v.blocks.find((x) => x.id === b)?.parent ?? null) out.unshift(b); return out }
/** A step's intent in words: what was run, taken or set. */
const describe = (i: Intent) => i.call ? `ran ${i.call.package}.${i.call.fn}` : i.action ? `took ${i.action.package} · ${i.action.id}` : (i.ops ?? []).map((o: any) => `${o.op} ${o.path}${'value' in o ? ` = ${JSON.stringify(o.value)}` : ''}`).join(', ') || 'a change'

/** The messages this seam takes (session:new, session:load and session:compact are the chat's). */
export const SESSION_MESSAGES = new Set(['session:agents', 'session:open', 'session:intent', 'session:goto', 'session:get', 'session:file', 'session:fork', 'session:start'])

export function createSessionSeam(d: SessionSeamDeps) {
  const agentsDir = join(d.projectDir, 'agents')
  const store = new ProgramStore(join(d.projectDir, 'programs', 'store'))
  const log = d.log ?? fileLog(join(d.projectDir, 'sessions'))

  // A domain's programs (the composition graph's), run where the platform places them, for whoever asked: their access
  // goes with the run (SA_READER), their output (totals, a page) comes back as JSON. The same run within five minutes
  // is read once. Programs reach a domain's logic this way instead of copying it.
  const placed = new Map<string, Promise<{ dir: string; used: Record<string, string> }>>()
  const runs = new Map<string, { at: number; p: Promise<unknown> }>()
  let sourceIds: string[] | null = null
  const program = async (domain: string, file: string, args: (string | number)[] = []) => {
    if (!/^[\w.-]+\.m?js$/.test(file)) throw new Error(`"${file}" is not a domain's program`)
    const dir = join(d.projectDir, '.programs-run', domain.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'))
    const at = await (placed.get(domain) ?? placed.set(domain, placeForRunning(d.projectDir, domain, dir, d.datasource)).get(domain)!).catch((e) => { placed.delete(domain); throw e })
    const reader = currentReader()
    let readerJson = ''
    if (reader && d.access) {
      sourceIds ??= ((await (await fetch(d.datasource + '/sources')).json().catch(() => ({}))) as any).sources?.map((s: any) => String(s.id)) ?? []
      const policies: Record<string, unknown[]> = {}
      for (const id of sourceIds!) policies[id] = await d.access.policiesFor(reader, id)
      readerJson = JSON.stringify({ principal: reader.id, policies })
    }
    const key = `${JSON.stringify(at.used)}|${file}|${args.join(' ')}|${readerJson}`
    const hit = runs.get(key)
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p
    const p = new Promise<unknown>((resolve, reject) => execFile(process.execPath, [file, ...args.map(String)], { cwd: at.dir, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1', ...(readerJson ? { SA_READER: readerJson } : {}) } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${domain}/${file} failed: ${String(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`))
      try { resolve(JSON.parse(String(stdout))) } catch (e: any) { reject(new Error(`${domain}/${file} did not print JSON: ${e.message}`)) }
    }))
    runs.set(key, { at: Date.now(), p }); p.catch(() => runs.delete(key))
    return p
  }

  // Every read on someone's behalf carries their data access policies; the manager's rewrite applies them.
  const query = async (id: string, sql: string, params: Record<string, unknown> = {}) => {
    const reader = currentReader()
    const policies = reader && d.access ? await d.access.policiesFor(reader, id) : []
    const r = await fetch(d.datasource + '/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, sql, params, ...(policies.length ? { policies } : {}) }) })
    const p: any = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }))
    if (!r.ok || p?.error) throw new Error(p?.error ?? `${r.status}`)
    return p.rows ?? []
  }

  // Agents are nodes of the composition graph (owned, scoped, governed, versioned, kept by the platform).
  let graph: Store | null = null
  const graphStore = () => { if (!d.graphFile || !existsSync(d.graphFile)) return null; return (graph ??= new Store(d.graphFile)) }
  const fromNode = (n: { name: string; body: any; scope: string; owner: string | null }): AgentSpec => ({
    id: n.name, name: String(n.body.title ?? n.name), scope: n.scope as AgentSpec['scope'], owner: n.owner ?? 'platform', domain: n.body.domain,
    programs: n.body.programs ?? [], tools: n.body.tools ?? [], ...(n.body.start ? { start: n.body.start } : {}), ui: { start: n.body.ui?.start ?? '' }, ica: n.body.ica ?? 'composer', ...(n.body.isDefault ? { isDefault: true } : {}),
  })
  function graphAgents(): AgentSpec[] {
    const s = graphStore(); if (!s) return []
    return s.names('agent').map((x) => fromNode(s.get(x.name)!))
  }

  function readAgent(id: string): AgentSpec {
    if (!/^[\w-]+$/.test(id)) throw new SessionSeamRefusal(`"${id}" is not an agent id`)
    const node = graphStore()?.get(id)
    if (node?.kind === 'agent') return fromNode(node)
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
    const ensure = d.ensureProgram ?? (async (ref: string) => store.resolve(ref))
    // A session already running names its packages' hashes in its STATE: those, not the newest builds.
    const use = pinned && Object.keys(pinned).length ? await Promise.all(Object.values(pinned).map(ensure)) : await Promise.all(spec.programs.map(ensure))
    const key = `${agent}:${[...use].sort().join(',')}`
    if (!runtimes.has(key)) runtimes.set(key, (async () => {
      const packages = await Promise.all(use.map((h) => loadPackage(store, h)))
      const engine = createStateEngine(packages as any, { services: { query, program } })
      return { engine, sessions: createSessions({ log, engine }), packages }
    })())
    const r = runtimes.get(key)!
    r.catch(() => runtimes.delete(key))
    return { ...(await r), spec }
  }

  const userOf = (from: any): string => {
    try { return whoIs(from).id } catch (e) { throw new SessionSeamRefusal((e as Error).message) }
  }


  async function sessionRuntime(session: string) {
    const v = replay(log.read(session))
    if (!v) throw new SessionSeamRefusal(`there is no session ${session}`)
    return { view: v, ...(await runtimeFor(v.agent, v.state.packages)) }
  }

  function agents() {
    const fromGraph = graphAgents()
    const fromFiles = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.json') && !fromGraph.some((a) => a.id === f.slice(0, -5))).flatMap((f) => {
      try { return [readAgent(f.slice(0, -5))] } catch { return [] }
    }) : []
    return [...fromGraph, ...fromFiles].map((a) => ({ id: a.id, name: a.name, scope: a.scope, ui: a.ui, isDefault: !!a.isDefault }))
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

  /** Words in a session: the agent is told the step and its programs, answers, and its :::intent line is applied. */
  async function answerWords(view: SessionView, session: string, words: string, block: string | null, from: any, user: string, reqId?: string) {
    if (!d.ask) throw new SessionSeamRefusal('this engine answers no words in sessions')
    const text = words.trim()
    if (!text) throw new SessionSeamRefusal('a question in words has words')
    const who = whoIs(from)
    const { sessions: rtSessions, packages, spec } = await runtimeFor(view.agent, view.state.packages)
    const at = block ?? view.leaf
    const state = view.states[at]
    if (!state) throw new SessionSeamRefusal(`session ${session} has no block ${at}`)
    const shown = view.blocks.find((b) => b.id === at)?.answer
    const answerNow = shown ? view.answers.find((a) => a.id === shown)?.markdown ?? '' : ''
    const docs = packages.map((p) => `## ${p.name}\n${(() => { try { return store.doc(p.hash) } catch { return '(no doc)' } })()}`).join('\n\n')
    const context = [`The step's STATE:\n${JSON.stringify(state)}`, answerNow ? `What the step shows now:\n${answerNow}` : '', INTENT_CONTRACT, docs ? `The programs:\n${docs}` : ''].filter(Boolean).join('\n\n')
    // The default agent answers from whichever domain the words reach; any other agent from its own.
    const said = await asReader(who, () => d.ask!({ session, text, context, domain: spec.isDefault ? null : spec.domain, from, reqId }))
    const { markdown, intent: asked, problem } = intentOf(said.markdown ?? '')
    const blocks: Record<string, Record<string, unknown>> = {}
    for (const b of (said.blocks ?? []) as any[]) if (b?.marker && b.block && typeof b.block === 'object') blocks[String(b.marker).trim()] = b.block
    const li: Intent = {
      id: `int_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, session, kind: 'language', text,
      result: { markdown: [markdown || (said.markdown ? '' : 'No answer came back.'), problem].filter(Boolean).join('\n\n'), files: [], ...(asked?.ops ? { ops: asked.ops } : {}), ...(Object.keys(blocks).length ? { blocks } : {}) } as any,
      ...(asked?.call ? { call: asked.call } : {}), ...(asked?.action ? { action: asked.action } : {}),
      to: asked?.to ?? (asked && !asked.call && !asked.action ? 'current' : 'new'), block: at, by: user, at: new Date().toISOString(),
    }
    return asReader(who, () => rtSessions.intent(li))
  }

  /** The agent a question goes to when none was picked: the one whose domain its words reach, else the default agent. */
  async function agentFor(text: string, visible: (scope: string) => boolean): Promise<{ agent: AgentSpec; how: 'routed' | 'default' }> {
    const mine = [...graphAgents(), ...agents().map((a) => { try { return readAgent(a.id) } catch { return null } }).filter((a): a is AgentSpec => !!a)].filter((a, i, all) => visible(a.scope) && all.findIndex((x) => x.id === a.id) === i)
    const picked = await pick(d.projectDir, text).catch(() => null)
    const reached = picked?.route?.domain ?? null
    const routed = reached ? mine.find((a) => !a.isDefault && a.domain === reached) : undefined
    if (routed) return { agent: routed, how: 'routed' }
    const fallback = mine.find((a) => a.isDefault)
    if (fallback) return { agent: fallback, how: 'default' }
    throw new SessionSeamRefusal('no agent fits this question and this project has no default agent — an administrator marks one')
  }

  async function handle(payload: any, from: any): Promise<void> {
    const t = String(payload.t)
    const reply = (msg: Record<string, unknown>) => d.send(from, { ...msg, reqId: payload.reqId })
    try {
      // Only the agents this asker sees (global, their own, their groups'); an admin sees all.
      const visible = (scope: string) => { try { const w = whoIs(from); return w.admin || scope === 'global' || w.scopes.includes(scope) } catch { return scope === 'global' } }
      if (t === 'session:agents') return reply({ t: 'session:agents', agents: agents().filter((a) => visible(a.scope)) })
      const user = userOf(from)
      if (t === 'session:file') { const hash = String(payload.hash ?? ''), path = String(payload.path ?? ''); return reply({ t: 'session:file', hash, path, text: programFile(hash, path) }) }
      const session = String(payload.session ?? '')
      if (!/^[\w-]{1,80}$/.test(session)) throw new SessionSeamRefusal('a session message names its session')
      if (t === 'session:open') {
        const { sessions, spec, packages } = await runtimeFor(String(payload.agent ?? ''))
        if (!visible(spec.scope)) throw new SessionSeamRefusal(`there is no agent "${spec.id}"`)
        // An agent opens on its starting screen: its programs run, as a dashboard opens with its data (unless asked not to).
        const run = payload.run === false ? [] : packages.map((p) => p.name)
        return reply(await present(await asReader(whoIs(from), () => sessions.openAndRun({ session, user, agent: spec.id, start: spec.start, run }))))
      }
      // A question from home, with no agent picked: the agent its words reach (else the default one) opens a session on it.
      if (t === 'session:start') {
        const { agent, how } = await agentFor(String(payload.text ?? ''), visible)
        const { sessions: rt, packages } = await runtimeFor(agent.id)
        const opened = await asReader(whoIs(from), () => rt.openAndRun({ session, user, agent: agent.id, start: agent.start, run: packages.map((p) => p.name) }))
        const r = await answerWords(opened, session, String(payload.text ?? ''), null, from, user, payload.reqId)
        return reply(await present(r.session, { routed: { agent: agent.id, name: agent.name, how }, result: { block: r.block, opened: r.opened, answer: r.answer } }))
      }
      if (t === 'session:get') {
        const v = replay(log.read(session), payload.asOf ? String(payload.asOf) : undefined)
        if (!v) throw new SessionSeamRefusal(`there is no session ${session}`)
        return reply(await present(viewOf(v, user)))
      }
      const { sessions, view } = await sessionRuntime(session)
      viewOf(view, user)
      if (t === 'session:goto') return reply(await present(sessions.goTo(session, String(payload.block ?? ''), user)))
      // MAKE AN AGENT FROM THIS SESSION: forked from the session's agent (lineage kept), on a domain of its own — the
      // agent's domain and what this session learned, as worked examples (each question and the steps taken after it).
      // The person's own until it is published; every node written through the graph's governance.
      if (t === 'session:fork') {
        const s = graphStore()
        if (!s) throw new SessionSeamRefusal('this project keeps no composition graph to make an agent in')
        const name = String(payload.name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const title = String(payload.title ?? '').trim()
        if (!name || !title) throw new SessionSeamRefusal('a new agent has a name and a title')
        const spec = readAgent(view.agent)
        const base = s.get(spec.domain)
        if (!base || base.kind !== 'domain') throw new SessionSeamRefusal(`the agent's domain "${spec.domain}" is not in the graph`)
        const items: { question: string; steps: string[] }[] = []
        for (const id of pathOfView(view, view.leaf)) {
          const b = view.blocks.find((x) => x.id === id)!
          const a = b.answer ? view.answers.find((x) => x.id === b.answer) : undefined
          const i = a ? view.intents.find((x) => x.id === a.cause) : undefined
          if (!i) continue
          if (i.kind === 'language') items.push({ question: String(i.text ?? ''), steps: [] })
          else (items.at(-1) ?? (items.push({ question: `Starting from ${spec.name}`, steps: [] }), items.at(-1)!)).steps.push(describe(i))
        }
        if (!items.length) throw new SessionSeamRefusal('this session has no steps to learn from yet')
        const who = whoIs(from)
        const scope = `user:${String(who.id).replace(/^user:/, '')}`
        const concept = `${name}-learned`, domain = `${name}-domain`
        const why = `made from session ${session} of ${spec.id}`
        g.write(s, who, concept, 'concept', { title: `What was learned in "${title}"`, form: 'worked', items }, { reason: why }, { scope: scope as any })
        g.write(s, who, domain, 'domain', { ...(base.body as any), concepts: [...((base.body as any).concepts ?? []), concept], forkedFrom: spec.domain }, { reason: why }, { scope: scope as any })
        const r = g.write(s, who, name, 'agent', { title, domain, programs: spec.programs, tools: spec.tools ?? [], ica: spec.ica, ...(spec.start ? { start: spec.start } : {}), ui: spec.ui, forkedFrom: spec.id, fromSession: session }, { reason: why }, { scope: scope as any })
        return reply({ t: 'session:forked', agent: name, concept, domain, scope, node: r })
      }
      if (t === 'session:intent') {
        const who = whoIs(from)
        if (payload.kind === 'language') {
          const r = await answerWords(view, session, String(payload.text ?? ''), payload.block ? String(payload.block) : null, from, user, payload.reqId)
          return reply(await present(r.session, { result: { block: r.block, opened: r.opened, answer: r.answer, ...(r.stale ? { stale: true } : {}) } }))
        }
        const intent: Intent = {
          id: `int_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, session, kind: 'structured',
          ...(payload.ops ? { ops: payload.ops } : {}), ...(payload.action ? { action: payload.action } : {}), ...(payload.call ? { call: payload.call } : {}),
          to: payload.to, ...(payload.block ? { block: String(payload.block) } : {}), by: user, at: new Date().toISOString(),
        }
        const work = () => asReader(who, () => sessions.intent(intent))
        const r = d.activities ? await d.activities.around(who.id, 'session.run', `Running ${intent.call ? `${intent.call.package}.${intent.call.fn}` : intent.action ? `${intent.action.package} · ${intent.action.id}` : 'a change'} in session ${session}`, work, (x) => x.answer ? x.answer.markdown.split('\n')[0].slice(0, 160) : 'done') : await work()
        return reply(await present(r.session, { result: { block: r.block, opened: r.opened, answer: r.answer, ...(r.stale ? { stale: true } : {}) } }))
      }
      throw new SessionSeamRefusal(`there is no ${t}`)
    } catch (e: any) {
      if (e instanceof SessionSeamRefusal || e instanceof SessionRefusal || e instanceof ProgramError || e instanceof StateRefusal || e instanceof AccessRefusal || e instanceof GovernanceRefusal) return reply({ t: 'session:refused', reason: e.message })
      console.error('[session]', e?.stack ?? e)
      return reply({ t: 'session:refused', reason: `the session could not do that: ${e?.message ?? e}` })
    }
  }

  return { handle, agents }
}
