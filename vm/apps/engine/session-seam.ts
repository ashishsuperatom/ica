// SESSIONS — an agent's sessions of blocks, run on its programs. These payloads come here (the other session:* messages
// belong to the chat):
//
//   session:agents                                  → session:agents   { agents: [{ id, name, ui, look, starts }], map }   the
//                                                     project's map, only the places whose agent one may use (null: none)
//   session:open   { session, agent, startAt? }     → session:view     { view }   startAt: one of the agent's starting points
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
// An agent is a node of the composition graph (kind "agent", platform-types AgentSpec), read from this engine's replica
// of the platform's graph; its programs are names or
// hashes in the project's program store (programs/store), loaded into one STATE engine whose data goes through the
// datasource manager. Each session is logged in sessions/<session>/session.jsonl.

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { placeForRunning, pick } from './knowledge.js'
import { checkAgent, checkMap, checkObject, checkOp, type AgentSpec, type Intent, type ProjectMap } from '@superatom/platform-types'
import { ProgramStore, ProgramError, loadPackage, linked } from '@superatom/programs'
import { createStateEngine, StateRefusal, type StateEngine } from '@superatom/state'
import { createSessions, memoryLog, fileLog, history, replay, SessionRefusal, type SessionLog, type SessionView } from '@superatom/session'
import { openStore, GovernanceRefusal, publishedUpto, type Store } from '@superatom/composition-graph/node'
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
  /** The composition graph's replica (graph-replica.ts), where agents are kept (kind "agent"); by default
   *  <projectDir>/db/composition.sqlite. */
  graphFile?: string
  /** Nodes written in the platform's graph for a person (graph-replica.ts write): the engine never writes the graph. */
  graphWrite?: (who: Record<string, unknown>, writes: { name: string; kind: string; body: unknown; reason: string; scope?: string }[]) => Promise<any[]>
  /** Long work made visible (activity.ts); without it, nothing is reported. */
  activities?: ReturnType<typeof import('./activity.js').createActivities>
  /** The reader's data access policies for a source (access.ts); without it, reads carry none. */
  access?: { policiesFor(who: Who, source: string): Promise<unknown[]> }
  /** The project's own application (app/server), for a program that stands on its views (services.app); without it, none. */
  app?: (payload: Record<string, unknown>, from: any) => Promise<any>
  /** Words answered by the session's agent (the composer on the agent's domain); without it, a session takes only controls. */
  ask?: (o: { session: string; text: string; context: string; domain: string | null; from: any; reqId?: string; qid?: string; channel?: string }) => Promise<{ markdown: string | null; blocks: unknown[]; stopped?: boolean }>
  /** A session's file from the platform, by its hash (its person put it in through their UserDO). */
  fetchAttachment?: (session: string, hash: string) => Promise<Uint8Array>
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
  // A change the agent asked for that is not a valid op is left out — the answer still stands, and says so.
  if (intent?.ops) {
    const bad = intent.ops.flatMap((op: unknown, i: number) => checkOp(op, `change ${i + 1}`))
    if (bad.length) { problem = `_A change this answer asked for was not made: ${bad[0]}._`; delete intent.ops }
  }
  return { markdown: kept.join('\n').trim(), intent: intent && (intent.ops || intent.call || intent.action) ? intent : null, ...(problem ? { problem } : {}) }
}

export class SessionSeamRefusal extends Error {}

const pathOfView = (v: SessionView, block: string) => { const out: string[] = []; for (let b: string | null = block; b; b = v.blocks.find((x) => x.id === b)?.parent ?? null) out.unshift(b); return out }
/** A step's intent in words: what was run, taken or set. */
const describe = (i: Intent) => i.call ? `ran ${i.call.package}.${i.call.fn}` : i.action ? `took ${i.action.package} · ${i.action.id}` : (i.ops ?? []).map((o: any) => `${o.op} ${o.path}${'value' in o ? ` = ${JSON.stringify(o.value)}` : ''}`).join(', ') || 'a change'

/** The messages this seam takes (session:new, session:load and session:compact are the chat's). */
export const SESSION_MESSAGES = new Set(['view:open', 'view:intent', 'session:keep', 'session:agents', 'session:open', 'session:intent', 'session:goto', 'session:get', 'session:file', 'session:fork', 'session:start', 'session:attach'])


/** A starting point's fields over the agent's start, slice by slice. */
export const mergeStart = (base: Record<string, Record<string, unknown>>, over: Record<string, Record<string, unknown>>) =>
  Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(over)])].map((k) => [k, { ...(base[k] ?? {}), ...(over[k] ?? {}) }]))

/** Where an agent starts: its start, or one of its starting points (refused when it declares no such point). */
function startOf(spec: AgentSpec, startAt: unknown) {
  if (!startAt) return spec.start
  const at = (spec.starts ?? []).find((x) => x.key === String(startAt))
  if (!at) throw new SessionSeamRefusal(`${spec.name} has no starting point "${String(startAt)}"`)
  return mergeStart(spec.start ?? {}, at.start)
}

/** A STATE a browser sends, made the engine's own: the agent's current packages only (their builds, not the browser's
 *  pins), each slice checked against its package's schema, everything else dropped. */
function ownState(given: any, engine: { start(over?: Record<string, Record<string, unknown>>): SessionView['state'] }, packages: { name: string; spec: { schema: any } }[]): SessionView['state'] {
  const over: Record<string, Record<string, unknown>> = {}
  for (const p of packages) {
    const slice = given?.[p.name]
    if (slice === undefined) continue
    const bad = checkObject(p.spec.schema, slice, p.name)
    if (bad.length) throw new SessionSeamRefusal(`the view's STATE does not fit ${p.name}: ${bad.slice(0, 3).join('; ')}`)
    over[p.name] = slice
  }
  return engine.start(over)
}

/** What a session is started with (a dashboard's view, a page's words), from the payload that opens it. */
const contextOf = (p: any): { context?: string } => (typeof p?.context === 'string' && p.context.trim() ? { context: p.context.trim().slice(0, 20_000) } : {})

/** A structured intent from a screen's payload (ops, an action or a call), for a session or a view. */
function structured(p: any, session: string, by: string, to: 'current' | 'new'): Intent {
  return {
    id: `int_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, session, kind: 'structured',
    ...(p?.ops ? { ops: p.ops } : {}), ...(p?.action ? { action: p.action } : {}), ...(p?.call ? { call: p.call } : {}),
    to, ...(p?.block ? { block: String(p.block) } : {}), by, at: new Date().toISOString(),
  }
}

export function createSessionSeam(d: SessionSeamDeps) {
  const graphFile = d.graphFile ?? join(d.projectDir, 'db', 'composition.sqlite')
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
  // A program's write: rows appended to one table of a source that takes writes — through the manager, which records it
  // (and by whom) and forgets that source's cached reads. Only programs write; an agent's tool reads.
  const append = async (id: string, table: string, rows: Record<string, unknown>[]) => {
    const reader = currentReader()
    const r = await fetch(d.datasource + '/append', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, table, rows, by: reader?.id ?? null }) })
    const p: any = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }))
    if (!r.ok || p?.error) throw new Error(p?.error ?? `${r.status}`)
    return { rows: Number(p.rows ?? 0) }
  }
  // Who the work is for: what a program records beside a decision it writes (a correction's author). Null for the
  // platform's own work.
  const who = () => { const r = currentReader(); return r ? { id: r.id, ...(r.email ? { email: r.email } : {}) } : null }

  // Agents are nodes of the composition graph (owned, scoped, governed, versioned, kept by the platform).
  // Read from the replica; reopened when the replica is rebuilt (a new file: graph-replica.ts sets a wrong one aside).
  let graph: { store: Store; ino: number } | null = null
  const graphStore = () => {
    if (!existsSync(graphFile)) return null
    const ino = statSync(graphFile).ino
    if (graph?.ino !== ino) { graph?.store.close(); graph = { store: openStore(graphFile), ino } }
    return graph.store
  }
  const fromNode = (n: { name: string; body: any; scope: string; owner: string | null }): AgentSpec => ({
    id: n.name, name: String(n.body.title ?? n.name), scope: n.scope as AgentSpec['scope'], owner: n.owner ?? 'platform', domain: n.body.domain,
    programs: n.body.programs ?? [], tools: n.body.tools ?? [], ...(n.body.start ? { start: n.body.start } : {}), ui: { start: n.body.ui?.start ?? '' }, ica: n.body.ica ?? 'composer', ...(n.body.isDefault ? { isDefault: true } : {}),
    look: { ...(n.body.icon ? { icon: n.body.icon } : {}), ...(n.body.accent ? { accent: n.body.accent } : {}), ...(n.body.says ? { says: n.body.says } : {}), ...(n.body.main?.label ? { main: { label: String(n.body.main.label), ...(n.body.main.says ? { says: String(n.body.main.says) } : {}) } } : {}) }, starts: Array.isArray(n.body.starts) ? n.body.starts : [],
  })
  // What everyone sees is the graph's published version; an agent in a person's own scope (made from their session) is
  // theirs at once, as it is now.
  const agentNode = (s: Store, name: string) => {
    const now = s.get(name)
    const upto = publishedUpto(s)
    if (upto === undefined || (now?.kind === 'agent' && now.scope.startsWith('user:'))) return now
    return s.get(name, undefined, upto)
  }
  function graphAgents(): AgentSpec[] {
    const s = graphStore(); if (!s) return []
    const upto = publishedUpto(s)
    const names = new Set([...s.names('agent', upto === undefined ? {} : { upto }), ...s.names('agent').filter((x) => x.scope.startsWith('user:'))].map((x) => x.name))
    return [...names].map((n) => agentNode(s, n)).filter((n): n is NonNullable<typeof n> => !!n && n.kind === 'agent').map(fromNode)
  }

  function readAgent(id: string): AgentSpec {
    if (!/^[\w-]+$/.test(id)) throw new SessionSeamRefusal(`"${id}" is not an agent id`)
    const gs = graphStore()
    const node = gs ? agentNode(gs, id) : null
    if (node?.kind === 'agent') {
      const spec = fromNode(node)
      const bad = checkAgent(spec)
      if (bad.length) throw new SessionSeamRefusal(`agent "${id}": ${bad.join('; ')}`)
      return spec
    }
    throw new SessionSeamRefusal(`there is no agent "${id}"`)
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
      // The project's application, asked as the reader: a program standing on the project's existing views (its question in its slice).
      const app = async (payload: Record<string, unknown>) => {
        if (!d.app) throw new Error('this project has no application')
        const r = currentReader()
        return d.app(payload, { id: 'program', type: 'runtime', userId: r ? String(r.id).replace(/^user:/, '') : null, email: (r as any)?.email })
      }
      const engine = createStateEngine(packages as any, { services: { query, append, who, program, app } })
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
    return graphAgents().filter((a) => !checkAgent(a).length).map((a) => ({ id: a.id, name: a.name, scope: a.scope, ui: a.ui, isDefault: !!a.isDefault, look: a.look ?? {}, starts: (a.starts ?? []).map((x) => ({ key: x.key, label: x.label, says: x.says ?? '' })) }))
  }

  /** The project's map as this person sees it: only the places whose agent they may use, and no empty section. */
  function mapFor(shown: Set<string>): ProjectMap | null {
    const s = graphStore(); if (!s) return null
    const node = agentNode(s, 'map')
    if (node?.kind !== 'map' || checkMap(node.body).length) return null
    const body = node.body as ProjectMap
    const sections = body.sections.map((x) => ({ label: x.label, items: x.items.filter((it) => shown.has(it.agent)) })).filter((x) => x.items.length)
    return { sections }
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
    // Each program's React side, and the library builds it links (name → hash): where its @lib/<name> imports lead.
    const uis = (rt?.packages ?? []).map((p) => { const m = store.manifest(p.hash); return { package: p.name, hash: p.hash, entry: m.ui.bundle, blocks: m.ui.blocks, head: m.ui.head ?? [], ...(m.uses?.length ? { uses: Object.fromEntries(linked(store, m.uses).map((l) => [l.name, l.hash])) } : {}) } })
    // The functions each package offers, so a screen knows where a row click or a control may go.
    const functions = Object.fromEntries((rt?.packages ?? []).map((p) => [p.name, (p.spec.functions ?? []).map((f: any) => f.name)]))
    return { t: 'session:view', view: v, cards, actions, uis, functions, ...extra }
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
  async function answerWords(view: SessionView, session: string, words: string, block: string | null, from: any, user: string, reqId?: string, o: { qid?: string; channel?: string; screen?: string } = {}) {
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
    // What the session was started with and the files it holds go with every question.
    const folder = join(d.projectDir, 'sessions', session)
    const started = view.context ? `What this session was started with:\n${view.context}` : ''
    const files = view.attachments?.length ? `The session's files (read them as you need):\n${view.attachments.map((a) => `- ${join(folder, 'attachments', a.name)} (${a.type}, ${a.size} bytes)`).join('\n')}` : ''
    const looking = o.screen ? `What the person is looking at:\n${o.screen}` : ''
    const context = [looking, started, files, `The step's STATE:\n${JSON.stringify(state)}`, answerNow ? `What the step shows now:\n${answerNow}` : '', INTENT_CONTRACT, docs ? `The programs:\n${docs}` : ''].filter(Boolean).join('\n\n')
    const qid = o.qid ?? `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    // The default agent answers from whichever domain the words reach; any other agent from its own.
    const said = await asReader(who, () => d.ask!({ session, text, context, domain: spec.isDefault ? null : spec.domain, from, reqId, qid, channel: o.channel }))
    if ((said as any).stopped) throw new SessionSeamRefusal('stopped')
    const { markdown, intent: asked, problem } = intentOf(said.markdown ?? '')
    const blocks: Record<string, Record<string, unknown>> = {}
    for (const b of (said.blocks ?? []) as any[]) if (b?.marker && b.block && typeof b.block === 'object') blocks[String(b.marker).trim()] = b.block
    const li: Intent = {
      id: `int_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, session, kind: 'language', text,
      result: { markdown: [markdown || (said.markdown ? '' : 'No answer came back.'), problem].filter(Boolean).join('\n\n'), files: [], ...(asked?.ops ? { ops: asked.ops } : {}), ...(Object.keys(blocks).length ? { blocks } : {}) } as any,
      ...(asked?.call ? { call: asked.call } : {}), ...(asked?.action ? { action: asked.action } : {}),
      to: asked?.to ?? (asked && !asked.call && !asked.action ? 'current' : 'new'), block: at, by: user, at: new Date().toISOString(), qid,
    }
    // A change that is well formed but cannot be applied (a slice the programs do not have, …) does not cost the answer:
    // it is applied without the change, and says so.
    try { return await asReader(who, () => rtSessions.intent(li)) }
    catch (e: any) {
      if (!li.result?.ops?.length || !(e instanceof StateRefusal || e instanceof SessionRefusal)) throw e
      const without: Intent = { ...li, result: { ...li.result, ops: undefined, markdown: [li.result.markdown, `_A change this answer asked for was not made: ${e.message}._`].filter(Boolean).join('\n\n') } }
      return asReader(who, () => rtSessions.intent(without))
    }
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
      if (t === 'session:agents') {
        const list = agents().filter((a) => visible(a.scope))
        return reply({ t: 'session:agents', agents: list, map: mapFor(new Set(list.map((a) => a.id))) })
      }
      const user = userOf(from)
      if (t === 'session:file') { const hash = String(payload.hash ?? ''), path = String(payload.path ?? ''); return reply({ t: 'session:file', hash, path, text: programFile(hash, path) }) }
      // ── VIEWS: an agent browsed without a session ("Views and sessions — one thread, two homes"). The browser keeps the
      //    thread; each step is computed here from the STATE it is given, in a throwaway session (the same code as a
      //    session's, so the same meaning), and nothing is kept.
      if (t === 'view:open' || t === 'view:intent') {
        // The agent's current program builds — never the browser's pins — and the browser's STATE made the engine's own.
        const { engine, spec, packages } = await runtimeFor(String(payload.agent ?? ''))
        if (!visible(spec.scope)) throw new SessionSeamRefusal(`there is no agent "${spec.id}"`)
        const state = payload.state && typeof payload.state === 'object' ? ownState(payload.state, engine, packages) : undefined
        const tmp = createSessions({ log: memoryLog(), engine })
        const who = whoIs(from)
        const run = packages.map((p) => p.name)
        let v: SessionView
        if (t === 'view:open') v = await asReader(who, () => tmp.openAndRun({ session: 'view', user, agent: spec.id, ...(state ? { state } : { start: startOf(spec, payload.startAt) }), run }))
        else {
          if (!state) throw new SessionSeamRefusal('a view step starts from the STATE it is at')
          tmp.open({ session: 'view', user, agent: spec.id, state })
          v = (await asReader(who, () => tmp.intent(structured(payload, 'view', user, 'current')))).session
        }
        return reply(await present(v, { t: 'view:view' }))
      }
      const session = String(payload.session ?? '')
      if (!/^[\w-]{1,80}$/.test(session)) throw new SessionSeamRefusal('a session message names its session')
      // A browsed view becoming a session (a question, a decision, an agent made from it): its path written as the
      // session's first steps by replaying exactly what was done — the opening, each step's intent, each change made in
      // place — so every STATE and answer in the history is this engine's own, not the browser's word.
      if (t === 'session:keep') {
        const path = Array.isArray(payload.path) ? payload.path as any[] : []
        if (!path.length || path.length > 50) throw new SessionSeamRefusal('a kept view names the path to its step (at most 50 steps)')
        const root = path[0]?.open ?? {}
        const { sessions: rt, engine, spec, packages } = await runtimeFor(String(payload.agent ?? ''))
        if (!visible(spec.scope)) throw new SessionSeamRefusal(`there is no agent "${spec.id}"`)
        const who = whoIs(from)
        const rootState = root.state && typeof root.state === 'object' ? ownState(root.state, engine, packages) : undefined
        let v = await asReader(who, () => rt.openAndRun({ session, user, agent: spec.id, ...(rootState ? { state: rootState } : { start: startOf(spec, root.startAt) }), run: packages.map((p) => p.name) }))
        for (const [i, step] of path.entries()) {
          if (i > 0) v = (await asReader(who, () => rt.intent(structured({ ...step.intent, block: v.leaf }, session, user, 'new')))).session
          for (const e of Array.isArray(step.edits) ? step.edits : []) v = (await asReader(who, () => rt.intent(structured({ ...e, block: v.leaf }, session, user, 'current')))).session
        }
        return reply(await present(v))
      }
      if (t === 'session:open') {
        const { sessions, spec, packages } = await runtimeFor(String(payload.agent ?? ''))
        if (!visible(spec.scope)) throw new SessionSeamRefusal(`there is no agent "${spec.id}"`)
        // An agent opens on its starting screen: its programs run, as a dashboard opens with its data (unless asked not to).
        const run = payload.run === false ? [] : packages.map((p) => p.name)
        // A starting point the agent declares opens on its own STATE (its fields over the agent's start, slice by slice).
        const start = startOf(spec, payload.startAt)
        return reply(await present(await asReader(whoIs(from), () => sessions.openAndRun({ session, user, agent: spec.id, start, run, ...contextOf(payload) }))))
      }
      // A question from home, with no agent picked: the agent its words reach (else the default one) opens a session on it.
      if (t === 'session:start') {
        const { agent, how } = await agentFor(String(payload.text ?? ''), visible)
        const { sessions: rt, packages } = await runtimeFor(agent.id)
        const opened = await asReader(whoIs(from), () => rt.openAndRun({ session, user, agent: agent.id, start: agent.start, run: packages.map((p) => p.name), ...contextOf(payload) }))
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
      // A FILE ADDED TO THE SESSION. Its person put it in through their UserDO, which kept it on the platform by its hash;
      // what comes here is where it is (name, hash, size, type). It is read into the session's attachments folder and
      // recorded in the log — its agent is told of it with every question.
      if (t === 'session:attach') {
        const name = String(payload.name ?? '').trim(), hash = String(payload.hash ?? '')
        if (!/^[\w][\w .()-]{0,119}$/.test(name) || name.includes('..')) throw new SessionSeamRefusal('a file is named plainly (letters, digits, spaces, . _ - ( ), at most 120)')
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new SessionSeamRefusal('a file is named by its hash')
        if (!d.fetchAttachment) throw new SessionSeamRefusal('this engine cannot read files from the platform')
        const bytes = Buffer.from(await d.fetchAttachment(session, hash))
        if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new SessionSeamRefusal('the file read is not the one its hash names')
        const dir = join(d.projectDir, 'sessions', session, 'attachments')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, name), bytes)
        const entry = { t: 'attachment' as const, at: new Date().toISOString(), name, hash, size: bytes.length, type: String(payload.type ?? 'application/octet-stream').slice(0, 100) }
        log.append(session, entry)
        return reply({ t: 'session:attached', session, name: entry.name, hash: entry.hash, size: entry.size, type: entry.type })
      }
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
        if (!d.graphWrite) throw new SessionSeamRefusal('this engine cannot reach the platform\'s graph')
        // Written in the platform's graph, as the person: its governance decides; this replica gets them by its next pull.
        const results = await d.graphWrite({ ...who }, [
          { name: concept, kind: 'concept', body: { title: `What was learned in "${title}"`, form: 'worked', items }, reason: why, scope },
          { name: domain, kind: 'domain', body: { ...(base.body as any), concepts: [...((base.body as any).concepts ?? []), concept], forkedFrom: spec.domain }, reason: why, scope },
          { name, kind: 'agent', body: { title, domain, programs: spec.programs, tools: spec.tools ?? [], ica: spec.ica, ...(spec.start ? { start: spec.start } : {}), ui: spec.ui, forkedFrom: spec.id, fromSession: session }, reason: why, scope },
        ]).catch((e: any) => { throw new SessionSeamRefusal(e?.message ?? String(e)) })
        return reply({ t: 'session:forked', agent: name, concept, domain, scope, node: results.at(-1) })
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
        const r = d.activities ? await d.activities.around(who.id, 'session.run', `Running ${intent.call ? `${intent.call.package}.${intent.call.fn}` : intent.action ? `${intent.action.package} · ${intent.action.id}` : 'a change'}`, work, (x) => x.answer ? x.answer.markdown.split('\n')[0].slice(0, 160) : 'done') : await work()
        return reply(await present(r.session, { result: { block: r.block, opened: r.opened, answer: r.answer, ...(r.stale ? { stale: true } : {}) } }))
      }
      throw new SessionSeamRefusal(`there is no ${t}`)
    } catch (e: any) {
      if (e instanceof SessionSeamRefusal || e instanceof SessionRefusal || e instanceof ProgramError || e instanceof StateRefusal || e instanceof AccessRefusal || e instanceof GovernanceRefusal) return reply({ t: 'session:refused', reason: e.message })
      console.error('[session]', e?.stack ?? e)
      return reply({ t: 'session:refused', reason: `the session could not do that: ${e?.message ?? e}` })
    }
  }

  /** A question in a session by its id, from any door (a chat, the phone, a chat channel): the session is opened first
   *  if it is new — on the agent chosen, else the one its words reach — then the words are its next turn, the same as
   *  words typed in it. The session's answer, and which agent gave it. */
  async function ask(o: { session: string; text: string; from: any; qid: string; agent?: string; channel?: string; context?: string; screen?: string; domain?: string | null; reqId?: string }) {
    if (!/^[\w-]{1,80}$/.test(o.session)) throw new SessionSeamRefusal(`"${o.session}" is not a session id`)
    const user = userOf(o.from)
    const visible = (scope: string) => { try { const w = whoIs(o.from); return w.admin || scope === 'global' || w.scopes.includes(scope) } catch { return scope === 'global' } }
    let view = replay(log.read(o.session))
    let routed: { agent: string; name: string; how: string } | null = null
    if (!view) {
      const ofDomain = !o.agent && o.domain ? graphAgents().find((a) => !a.isDefault && a.domain === o.domain && visible(a.scope)) : undefined
      const picked = o.agent ? { agent: readAgent(o.agent), how: 'chosen' } : ofDomain ? { agent: ofDomain, how: 'chosen' } : await agentFor(o.text, visible)
      if (!visible(picked.agent.scope)) throw new SessionSeamRefusal(`there is no agent "${picked.agent.id}"`)
      const { sessions: rt, packages } = await runtimeFor(picked.agent.id)
      view = await asReader(whoIs(o.from), () => rt.openAndRun({ session: o.session, user, agent: picked.agent.id, start: picked.agent.start, run: packages.map((p) => p.name), ...contextOf(o) }))
      routed = { agent: picked.agent.id, name: picked.agent.name, how: picked.how }
    } else viewOf(view, user)
    const r = await answerWords(view, o.session, o.text, null, o.from, user, o.reqId, { qid: o.qid, channel: o.channel, screen: o.screen })
    const spec = readAgent(view.agent)
    return { answer: r.answer, agent: routed ?? { agent: spec.id, name: spec.name, how: 'session' } }
  }

  return { handle, agents, ask }
}
