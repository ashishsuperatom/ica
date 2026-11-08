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

import { configuration } from './configuration.js'
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync, renameSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { createProgramRuns, programId } from './program-runs.js'
import { placeForRunning } from './knowledge.js'
import { checkAgent, checkMap, checkObject, checkOp, type AgentSpec, type Intent, type ProjectMap } from '@superatom/platform-types'
import { ProgramStore, ProgramError, loadPackage, linked } from '@superatom/programs'
import type { ProgramServices } from '@superatom/state'
import { createStateEngine, StateRefusal, type StateEngine } from '@superatom/state'
import { createSessions, memoryLog, fileLog, history, pathTo, replay, SessionRefusal, type SessionLog, type SessionView } from '@superatom/session'
import { openStore, GovernanceRefusal, publishedUpto, graphAt, type Store } from '@superatom/composition-graph/node'
import { cardOf, type SaidBlock } from './answer-card.js'
import { lint, fixed } from './lint.js'
import { whoIs, type Who } from './identity.js'
import { asReader, currentReader, AccessRefusal } from './access.js'
import { asSystem, MANAGER_KEY } from './manager.js'
import { childEnv } from './child-env.js'
import { agentUser } from './agent-user.js'
import { signTicket } from '@superatom/datasource-manager/ticket'
import { devOf, inDev, currentDev } from './dev.js'
import type { Found, NodeView } from './intent.js'
import type { ToolSocket } from './tool-socket.js'
import { ownerOf, QUESTION_MAX_CHARS, QUEUE_MAX_CHARS } from '@superatom/platform-types'
import type { Role } from './app-seam.js'
import { offeredNext, dataOf } from './intent-checks.js'

/** What a program's error output says went wrong: the thrown error's line (Error: …, TypeError: …), else the first line
 *  that is not the runtime's own (a stack frame, Node's version, the caret under the code). */
export function errorOf(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  const thrown = lines.find((l) => /^(\w+)?Error\b|^Error:/.test(l))
  return thrown ?? lines.find((l) => !/^at\s|^Node\.js v|^\^+$|^file:\/\/|^node:internal|^Error \[ERR_/.test(l)) ?? lines.slice(-1)[0] ?? 'it gave no reason'
}

export interface SessionSeamDeps {
  /** The engine's socket for agents' tools (tool-socket.ts): the composer's find-intent asks through it. */
  tools?: ToolSocket
  /** Interrupt the agent working in a session (app-seam stop): resolves once its turn has ended, with whether one was. */
  stopAgent?: (session: string, why: string) => Promise<boolean>
  projectDir: string
  /** The datasource manager's address. */
  datasource: string
  send: (to: any, msg: Record<string, unknown>) => void
  /** The session log (default: a file per session; the engine passes one that also syncs to the platform). */
  log?: SessionLog
  /** Find a program the store lacks (the engine fetches it from the platform); by default the store only. */
  ensureProgram?: (ref: string, o?: { draft?: boolean }) => Promise<string>
  /** The composition graph's replica (graph-replica.ts), where agents are kept (kind "agent"); by default
   *  <projectDir>/db/composition.sqlite. */
  graphFile?: string
  /** Nodes written in the platform's graph for a person (graph-replica.ts write): the engine never writes the graph. */
  graphWrite?: (who: Record<string, unknown>, writes: { name: string; kind: string; body: unknown; reason: string; scope?: string; publish?: string }[]) => Promise<any[]>
  /** Long work made visible (activity.ts); without it, nothing is reported. */
  activities?: ReturnType<typeof import('./activity.js').createActivities>
  /** Each program as it runs (workloads.ts, kind "program"): running, how its last run ended; stopped on request. */
  workloads?: ReturnType<typeof import('./workloads.js').createWorkloads>
  /** The reader's data access policies for a source (access.ts); without it, reads carry none. */
  access?: { policiesFor(who: Who, source: string): Promise<unknown[]>; version?(): number }
  /** The intent graph (intent.ts): what the composer decides each message with, and what happened kept. */
  intents?: ReturnType<typeof import('./intent.js').createIntents>
  /** What every answer taught, worked out in the background by a clone of the conversation — one learner per session
   *  (intent-learn.ts). */
  intentLearn?: ReturnType<typeof import('./intent-learn.js').createIntentLearn>
  /** The agents of intent nodes (session-agents.ts): builder, connector, the project's own. */
  agents?: ReturnType<typeof import('./session-agents.js').createSessionAgents>
  /** Concepts as text (knowledge.ts composeLinks): what an intent's variant stands on. */
  composeLinks?: (links: { kind: 'domain' | 'concept'; name: string }[], graph?: string, own?: string[]) => Promise<string>
  /** Words answered by one of the session's two agents (app-seam.ts say); without it, a session takes only controls. */
  ask?: (o: { session: string; role: Role; text: string; context: string; from: any; reqId?: string; qid?: string; channel?: string; /** The knowledge version the session is pinned to. */ graph?: string; /** The agent's own domain (the workbench's). */ domain?: string }) => Promise<{ markdown: string | null; blocks: unknown[]; stopped?: boolean; failure?: string; beats?: { text: string; at: number }[]; decision?: { node: string | null }; sent?: { agent: string; message: string } }>
  /** How long one option function may take to say whether its move makes sense at a step, in ms (a setting; left out,
   *  the platform's starting value). */
  optionMs?: number
  /** A session's file from the platform, by its hash (its person put it in through their UserDO). */
  fetchAttachment?: (session: string, hash: string) => Promise<Uint8Array>
}

/** What the agent is told about the step it is answering from, and how its answer may change it. */
export const INTENT_CONTRACT = `To change what this step shows, end your answer with one line:
:::intent {"ops":[{"op":"set","path":"<package>.<field>","value":…}],"to":"current"}
or call a program's function: :::intent {"call":{"package":"<package>","fn":"<function>","params":{…}},"to":"new"}.
"current" changes this step; "new" opens a new step. Paths and functions are the programs' own, below.
An op is a STATE change — set, add or remove a path; a program's own operations go in the params of a call to its function.
Answer the question itself, in words, from the data — query it with your tools when what the step shows does not hold the answer; a view that shows the same thing goes beside the answer.`

/** The answer's own words, and the intent its last :::intent line asks for (taken out of what is shown). */
export function intentOf(markdown: string): { markdown: string; intent: { ops?: any[]; call?: any; to?: 'current' | 'new' } | null; problem?: string } {
  const lines = String(markdown ?? '').split('\n')
  let intent: any = null, problem: string | undefined
  const kept = lines.filter((l) => {
    const m = /^\s*:::intent\s+(\{.*\})\s*$/.exec(l)
    if (!m) return true
    try { const x = JSON.parse(m[1]); if (x && typeof x === 'object') intent = { ...(Array.isArray(x.ops) ? { ops: x.ops } : {}), ...(x.call ? { call: x.call } : {}), ...(x.to === 'new' || x.to === 'current' ? { to: x.to } : {}) } }
    catch (e: any) { problem = `the answer asked for a change that could not be read: ${e.message}` }
    return false
  })
  // A change the agent asked for that is not a valid op is left out — the answer still stands, and says so.
  if (intent?.ops) {
    const bad = intent.ops.flatMap((op: unknown, i: number) => checkOp(op, `change ${i + 1}`))
    if (bad.length) { problem = `${bad[0]}`; delete intent.ops }
  }
  return { markdown: kept.join('\n').trim(), intent: intent && (intent.ops || intent.call) ? intent : null, ...(problem ? { problem } : {}) }
}

export class SessionSeamRefusal extends Error {
  /** A sentence for the person themselves (what they may not do, and who can change it), when the reason is theirs to read. */
  constructor(message: string, readonly plain?: string) { super(message) }
}

/** Which questions each of a session's two agents has seen (by qid), kept in the session's folder: the other agent's
 *  turns are given to it before its next question. */

const pathOfView = (v: SessionView, block: string) => { const out: string[] = []; for (let b: string | null = block; b; b = v.blocks.find((x) => x.id === b)?.parent ?? null) out.unshift(b); return out }
/** A step's intent in words: what was run, taken or set. */
const describe = (i: Intent) => i.call ? `ran ${i.call.package}.${i.call.fn}` : (i.ops ?? []).map((o: any) => `${o.op} ${o.path}${'value' in o ? ` = ${JSON.stringify(o.value)}` : ''}`).join(', ') || 'a change'

/** The messages this seam takes (session:new, session:load and session:compact are the chat's). */
export const SESSION_MESSAGES = new Set(['view:open', 'view:intent', 'session:keep', 'session:agents', 'session:open', 'session:intent', 'session:withdraw', 'session:goto', 'session:get', 'session:file', 'session:fork', 'session:start', 'session:attach'])


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

/** Where an agent starts with fields laid over it (a row elsewhere that opens this agent on the thing it names): only
 *  slices of the agent's own programs and fields their schemas declare — anything else is refused, not dropped. */
function startWith(spec: AgentSpec, startAt: unknown, w: unknown, packages: { name: string; spec: { schema: any } }[]) {
  const base = startOf(spec, startAt) ?? {}
  if (!w || typeof w !== 'object' || Array.isArray(w)) return base
  const over: Record<string, Record<string, unknown>> = {}
  for (const [slice, fields] of Object.entries(w as Record<string, unknown>)) {
    const p = packages.find((x) => x.name === slice)
    if (!p || !fields || typeof fields !== 'object' || Array.isArray(fields)) throw new SessionSeamRefusal(`${spec.name} has no "${slice}" to start with`)
    for (const k of Object.keys(fields)) if (!(k in (p.spec.schema ?? {}))) throw new SessionSeamRefusal(`${slice} has no field "${k}"`)
    over[slice] = fields as Record<string, unknown>
  }
  return mergeStart(base, over)
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

/** A structured intent from a screen's payload (ops or a call), for a session or a view. */
function structured(p: any, session: string, by: string, to: 'current' | 'new'): Intent {
  return {
    id: `int_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, session, kind: 'structured',
    ...(p?.ops ? { ops: p.ops } : {}), ...(p?.call ? { call: p.call } : {}),
    to, ...(p?.block ? { block: String(p.block) } : {}), ...labelOf(p), by, at: new Date().toISOString(),
  }
}
/** The words on the control a person used, kept with what they did. */
const labelOf = (p: any): { label?: string } => (typeof p?.label === 'string' && p.label.trim() ? { label: p.label.trim().slice(0, 120) } : {})

export function createSessionSeam(d: SessionSeamDeps) {
  const seenFile = (session: string) => join(d.projectDir, 'sessions', session, 'agents-seen.json')
  const seenBy = (session: string): Record<string, string[]> => { try { return JSON.parse(readFileSync(seenFile(session), 'utf8')) } catch { return {} } }
  const keepSeen = (session: string, seen: Record<string, string[]>) => { try { mkdirSync(join(d.projectDir, 'sessions', session), { recursive: true }); writeFileSync(seenFile(session), JSON.stringify(seen)) } catch { /* not kept: the agent is told again */ } }
  // The knowledge a session's composer has been given, by link: a node's links are given once, when the path first needs them.
  const given = new Map<string, Set<string>>()
  const graphFile = d.graphFile ?? join(d.projectDir, 'db', 'composition.sqlite')
  const store = new ProgramStore(join(d.projectDir, 'programs', 'store'))
  const log = d.log ?? fileLog(join(d.projectDir, 'sessions'))

  // A domain's programs (the composition graph's), run where the platform places them, for whoever asked: their access
  // goes with the run (SA_TICKET), their output (totals, a page) comes back as JSON. The same run within five minutes
  // is read once. Programs reach a domain's logic this way instead of copying it.
  const placed = new Map<string, Promise<{ dir: string; used: Record<string, string> }>>()
  const runs = new Map<string, { at: number; p: Promise<{ data: unknown; notes: string[] }> }>()
  let sourceIds: string[] | null = null
  // Each program as a workload: running, how its last run ended; stopped on request (program-runs.ts).
  const programRuns = createProgramRuns(d.workloads)
  const program = async (domain: string, file: string, args: (string | number)[] = [], o: { notes?: boolean } = {}) => {
    const { data, notes } = await programRun(domain, file, args)
    return o.notes ? { data, notes } : data
  }
  const placeOf = (domain: string) => (placed.get(domain) ?? placed.set(domain, placeForRunning(d.projectDir, domain, join(d.projectDir, '.programs-run', domain.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')), d.datasource)).get(domain)!).catch((e) => { placed.delete(domain); throw e })
  const settings = async (domain: string) => JSON.parse(await readFile(join((await placeOf(domain)).dir, 'settings.json'), 'utf8')) as Record<string, unknown>
  const programRun = async (domain: string, file: string, args: (string | number)[] = []): Promise<{ data: unknown; notes: string[] }> => {
    if (!/^[\w.-]+\.m?js$/.test(file)) throw new Error(`"${file}" is not a domain's program`)
    const at = await placeOf(domain)
    // Whoever the run is for reads with their ticket (their policies inside it); the platform's own work, as itself.
    const reader = currentReader()
    sourceIds ??= ((await (await fetch(d.datasource + '/sources', asSystem())).json().catch(() => ({}))) as any).sources?.map((s: any) => String(s.id)) ?? []
    const policies: Record<string, unknown[]> = {}
    if (reader && d.access) for (const id of sourceIds!) { const p = await d.access.policiesFor(reader, id); if (p.length) policies[id] = p }
    const whose = JSON.stringify({ principal: reader?.id ?? 'platform', policies })
    const key = `${JSON.stringify(at.used)}|${file}|${args.join(' ')}|${whose}`
    const hit = runs.get(key)
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p
    const ticket = signTicket(MANAGER_KEY, { principal: reader?.id ?? 'platform', email: reader?.email ?? null, policies, access: d.access?.version?.() ?? -1 })
    let child: import('node:child_process').ChildProcess | undefined
    const p = new Promise<{ data: unknown; notes: string[] }>((resolve, reject) => child = execFile(process.execPath, [file, ...args.map(String)], { cwd: at.dir, maxBuffer: 256 * 1024 * 1024, ...(agentUser ? { uid: agentUser.uid, gid: agentUser.gid } : {}), env: childEnv({ NODE_NO_WARNINGS: '1', DATASOURCE_URL: d.datasource, SA_TICKET: ticket }) }, (err, stdout, stderr) => {
      // the error itself, not the runtime's closing lines (Node ends a crash with "Node.js v22…": the cause is above it)
      if (err) return reject(new Error(`${domain}/${file} failed: ${errorOf(String(stderr || err.message))}`))
      const notes = [...new Set(String(stderr ?? '').split('\n').filter((l) => l.startsWith('NOTE: ')).map((l) => l.slice(6)))]
      try { resolve({ data: JSON.parse(String(stdout)), notes }) } catch (e: any) { reject(new Error(`${domain}/${file} did not print JSON: ${e.message}`)) }
    }))
    const ended = programRuns.began(programId(domain, file), child, reader?.email ?? reader?.id ?? null)
    p.then(() => ended(), (e) => ended(String(e?.message ?? e)))
    runs.set(key, { at: Date.now(), p }); p.catch(() => runs.delete(key))
    return p
  }

  // Every read on someone's behalf carries their data access policies; the manager's rewrite applies them.
  // Read with the reader's ticket (their policies; their own key, for a source read with each person's); the platform's
  // own work as itself.
  const readerTicket = async (id: string) => {
    const reader = currentReader()
    if (!reader) return null
    const policies = d.access ? await d.access.policiesFor(reader, id) : []
    return signTicket(MANAGER_KEY, { principal: reader.id, email: reader.email ?? null, policies: policies.length ? { [id]: policies } : {}, access: d.access?.version?.() ?? -1 })
  }
  const withReader = (ticket: string | null, init: RequestInit) => ticket ? { ...init, headers: { ...(init.headers as Record<string, string>), 'x-sa-ticket': ticket } } : asSystem(init)
  const query = async (id: string, sql: string, params: Record<string, unknown> = {}) => {
    const r = await fetch(d.datasource + '/query', withReader(await readerTicket(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, sql, params }) }))
    const p: any = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }))
    if (!r.ok || p?.error) throw new Error(p?.error ?? `${r.status}`)
    return p.rows ?? []
  }
  // A program's write: rows appended to one table of a source that takes writes — through the manager, which records it
  // (and by whom) and forgets that source's cached reads. Only programs write; an agent's tool reads.
  const append = async (id: string, table: string, rows: Record<string, unknown>[]) => {
    const reader = currentReader()
    const r = await fetch(d.datasource + '/append', withReader(await readerTicket(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, table, rows, by: reader?.id ?? null }) }))
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
  // As published — except a person's own, and what the platform itself made (its defaults apply at once: the default
  // agent, the workbench), read as they are now.
  const agentNode = (s: Store, name: string) => {
    const now = s.get(name)
    const upto = publishedUpto(s)
    if (upto === undefined || (now?.kind === 'agent' && now.scope.startsWith('user:')) || s.platformOwns(name)) return now
    return s.get(name, undefined, upto)
  }
  /** The knowledge version a new session is pinned to, checked — "draft" or a version's name, for someone who may
   *  publish — or undefined: the published one. */
  function pinOf(which: unknown, from: any): string | undefined {
    if (which === undefined || which === null || which === '') return undefined
    if (!whoIs(from).admin) throw new SessionSeamRefusal('asking at another version of the knowledge is for someone who may publish')
    const s = graphStore(); if (!s) throw new SessionSeamRefusal('this engine holds no knowledge yet')
    try { return graphAt(s, String(which)).name } catch (e: any) { throw new SessionSeamRefusal(e.message) }
  }
  function graphAgents(): AgentSpec[] {
    const s = graphStore(); if (!s) return []
    const upto = publishedUpto(s)
    const names = new Set([...s.names('agent', upto === undefined ? {} : { upto }), ...s.names('agent').filter((x) => x.scope.startsWith('user:') || s.platformOwns(x.name))].map((x) => x.name))
    const env = currentDev()
    for (const n of Object.keys(env?.agents ?? {})) names.add(n)
    return [...names].map((n) => env?.agents[n] ? { name: n, kind: 'agent', body: env.agents[n], scope: String((env.agents[n] as any).scope ?? 'global'), owner: null } : agentNode(s, n)).filter((n): n is NonNullable<typeof n> => !!n && n.kind === 'agent').map(fromNode)
  }

  function readAgent(id: string): AgentSpec {
    if (!/^[\w-]+$/.test(id)) throw new SessionSeamRefusal(`"${id}" is not an agent id`)
    const gs = graphStore()
    // The asker's attached environment first (docs/dev-mode.md), then what is published.
    const inEnv = currentDev()?.agents[id]
    const node = inEnv ? { name: id, kind: 'agent', body: inEnv, scope: String((inEnv as any).scope ?? 'global'), owner: null } : gs ? agentNode(gs, id) : null
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
  /** The agent's programs: a running session's own builds (its STATE names their hashes); else the newest published —
   *  or, for a session pinned to the draft, the newest builds, unpublished too. */
  async function runtimeFor(agent: string, pinned?: Record<string, string>, draft = false) {
    const spec = readAgent(agent)
    const ensure = d.ensureProgram ?? (async (ref: string) => store.resolve(ref))
    const use = pinned && Object.keys(pinned).length ? await Promise.all(Object.values(pinned).map((h) => ensure(h))) : await Promise.all(spec.programs.map((p) => { const own = currentDev()?.programs[p]; return own ? ensure(own) : ensure(p, { draft }) }))
    const key = `${agent}:${[...use].sort().join(',')}`
    if (!runtimes.has(key)) runtimes.set(key, (async () => {
      const packages = await Promise.all(use.map((h) => loadPackage(store, h)))
      const engine = createStateEngine(packages as any, { services: { query, append, who, program, settings, config: configuration } satisfies ProgramServices })
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
    return graphAgents().filter((a) => !checkAgent(a).length).map((a) => ({ id: a.id, name: a.name, scope: a.scope, ui: a.ui, isDefault: !!a.isDefault, ica: a.ica ?? 'composer', look: a.look ?? {}, starts: (a.starts ?? []).map((x) => ({ key: x.key, label: x.label, says: x.says ?? '' })) }))
  }

  /** The project's map as this person sees it: only the places whose agent they may use, and no empty section. */
  function mapFor(shown: Set<string>): ProjectMap | null {
    const s = graphStore(); if (!s) return null
    const envMap = currentDev()?.map
    const node = envMap !== undefined ? { kind: 'map', body: envMap } : agentNode(s, 'map')
    if (node?.kind !== 'map' || checkMap(node.body).length) return null
    const body = node.body as ProjectMap
    const sections = body.sections.map((x) => ({ label: x.label, items: x.items.filter((it) => shown.has(it.agent)) })).filter((x) => x.items.length)
    return { sections, ...(body.home && shown.has(body.home) ? { home: body.home } : {}) }
  }

  const viewOf = (v: SessionView, user: string) => {
    if (v.user !== user) throw new SessionSeamRefusal(`session ${v.id} is not yours`)
    return v
  }

  /** The next moves on offer at a session's current step: every option function of its programs, given the step (its
   *  STATE, what the session was started with, its answer history down to it), read as the person — computed once per
   *  step as it stands. One that failed or was late is told to the operators; one that offers nothing here is not. */
  const offeredAt = new Map<string, Promise<{ package: string; label: string; why?: string; intent: Record<string, unknown> }[]>>()
  function optionsOf(v: SessionView, engine: StateEngine, who: Who) {
    const at = v.leaf, block = v.blocks.find((b) => b.id === at)
    const key = `${v.id}|${at}|${block?.stateHash}|${block?.answer ?? ''}`
    if (!offeredAt.has(key)) {
      if (offeredAt.size > 200) offeredAt.delete(offeredAt.keys().next().value!)
      const path = new Set(pathTo(v, at))
      const step = { context: v.context ?? '', history: history(v).filter((a) => path.has(a.block)).map((a) => {
        const i = v.intents.find((x) => x.id === a.cause)
        return { ...(i?.kind === 'language' && i.text ? { question: i.text } : {}), markdown: a.markdown, data: dataOf(a.blocks) }
      }) }
      offeredAt.set(key, asReader(who, () => engine.options(v.states[at] ?? v.state, step, { timeoutMs: d.optionMs ?? 1500 })).then(({ offered, left }) => {
        for (const l of left) if (l.why !== 'offers nothing here') console.warn(`[session] ${v.id} · option ${l.package}.${l.fn}() left out: ${l.why}`)
        return offered.map((o) => ({ package: o.package, label: o.option.label, ...(o.option.why ? { why: o.option.why } : {}),
          intent: { ...(o.option.call ? { call: { package: o.package, fn: o.option.call.fn, ...(o.option.call.params ? { params: o.option.call.params } : {}) } } : {}), ...(o.option.ops ? { ops: o.option.ops } : {}), to: o.option.to ?? 'new' } }))
      }, (e) => { offeredAt.delete(key); console.warn(`[session] ${v.id} · options could not be computed: ${e?.message ?? e}`); return [] }))
    }
    return offeredAt.get(key)!
  }

  /** A view as a screen needs it: the session, its answers as cards, and the next moves its programs offer at its step. */
  async function present(v: SessionView, extra: Record<string, unknown> = {}, from?: any) {
    const rt = await runtimeFor(v.agent, v.state.packages).catch(() => null)
    const cards: Record<string, unknown> = {}
    for (const a of history(v)) cards[a.id] = await cardOf(a)
    let who: Who | null = null
    try { who = from ? whoIs(from) : null } catch { /* no one to read as: no options */ }
    const options = rt && who ? await optionsOf(v, rt.engine, who) : []
    // Each program's React side, and the library builds it links (name → hash): where its @lib/<name> imports lead.
    const uis = (rt?.packages ?? []).map((p) => { const m = store.manifest(p.hash); return { package: p.name, hash: p.hash, entry: m.ui.bundle, blocks: m.ui.blocks, head: m.ui.head ?? [], ...(m.ui.as === 'ui' ? { as: 'ui' } : {}), ...(m.uses?.length ? { uses: Object.fromEntries(linked(store, m.uses).map((l) => [l.name, l.hash])) } : {}) } })
    // The functions each package offers, so a screen knows where a row click or a control may go.
    const functions = Object.fromEntries((rt?.packages ?? []).map((p) => [p.name, (p.spec.functions ?? []).map((f: any) => f.name)]))
    // Which session agent takes its messages (the composer's path, or the workbench): the conversation's own kind, for the page.
    return { t: 'session:view', view: v, cards, options, uis, functions, ica: rt?.spec?.ica ?? 'composer', ...extra }
  }

  // A program's React side, file by file: only built programs' web/ files, each program checked against its hash once.
  const verified = new Set<string>()
  function programFile(hash: string, path: string): string {
    if (!/^web\/[\w-]+(\/[\w-]+)*(\.[\w-]+)*\.js$/.test(path)) throw new SessionSeamRefusal(`"${path}" is not a file of a program's React side`)
    if (!store.has(hash)) throw new SessionSeamRefusal(`there is no program ${hash.slice(0, 12)}`)
    if (!verified.has(hash)) { if (!store.verify(hash)) throw new SessionSeamRefusal(`program ${hash.slice(0, 12)} does not match its hash`); verified.add(hash) }
    store.touch(hash)   // its screens in use: kept (the store is a cache — program-seam sweep)
    const file = join(store.dirOf(hash), path)
    if (!existsSync(file)) throw new SessionSeamRefusal(`program ${hash.slice(0, 12)} has no ${path}`)
    return readFileSync(file, 'utf8')
  }

  /** What a person reads when the model behind the agent could not answer (its account refused, …): the reason itself is
   *  the operators' — in the engine's log and the project's Attention — never shown here. */
  const NOT_ANSWERED = 'This could not be answered just now — the service behind the agent did not respond. Try again in a minute; if it keeps happening, tell your administrator.'

  /** An answer with what the linter can fix fixed — the operators told what was (the log, Attention). */
  function lintFixed<T extends { markdown: string | null; blocks?: unknown[] }>(said: T, where: string, who: string): T {
    if (!said.markdown) return said
    const f = fixed({ markdown: said.markdown, blocks: (said.blocks ?? []) as SaidBlock[] })
    if (!f.fixed.length) return said
    console.warn(`[session] ${where} · the answer still broke the answer rules — fixed here: ${f.fixed.join(', ')}`)
    d.activities?.start(who, 'answer', 'An answer broke the answer rules').failed(`fixed by the linter: ${f.fixed.join(', ')}`)
    return { ...said, markdown: f.markdown, blocks: f.blocks }
  }

  /** Words answered by an intent node's agent — when the person may be answered at the node (the platform's word, from
   *  their capabilities stamped on what they sent); progress goes to the asking page as the composer's does. */
  async function answerByAgent(name: string, node: NodeView, session: string, text: string, from: any, caps: string[], qid: string, reqId?: string) {
    const spec = await d.intents!.agent(name)
    if (!spec) return { markdown: `_This is answered by the ${name} agent, which this project does not have._`, blocks: [] as unknown[] }
    const needs = node.needs ?? spec.needs
    if (!node.allowed || !caps.includes(spec.needs)) return { markdown: `_"${node.title}" is answered by the ${spec.title} agent, which you are not given — it needs the "${needs}" permission. Ask an admin of the project._`, blocks: [] as unknown[] }
    const beat = (t: string) => d.send(from, { t: 'narration', text: t, qid, sid: session, reqId })
    beat(`The ${spec.title} agent is working on it…`)
    const turn = await d.agents!.run({ session, spec, text, from, turn: qid, onNarration: (t) => { if (t.trim()) beat(t.trim().slice(0, 300)) } })
    return { markdown: turn.markdown, blocks: [] as unknown[] }
  }

  /** The next intents of an answer found after it (the learner suggested them): kept in the session and sent to the page —
   *  only while that answer is still the session's last; a question asked since, and they are not needed. */
  async function nextLater(session: string, answer: string, from: any, find: () => Promise<NonNullable<import('@superatom/platform-types').Answer['next']>>) {
    const v = replay(log.read(session)); if (!v) return
    if (v.blocks.find((b) => b.id === v.leaf)?.answer !== answer) return
    const had = v.answers.find((a) => a.id === answer)?.next ?? []
    const now = await find()
    if (!now.length || JSON.stringify(now.map((x) => x.id)) === JSON.stringify(had.map((x) => x.id))) return
    log.append(session, { t: 'next', at: new Date().toISOString(), answer, next: now })
    d.send(from, { t: 'answer:next', session, answer, next: now })
    console.log(`[intent] ${session.slice(0, 12)} · ${now.length} next intent${now.length === 1 ? '' : 's'} offered after learning`)
  }

  async function answerWords(view: SessionView, session: string, words: string, block: string | null, from: any, user: string, reqId?: string, o: { qid?: string; channel?: string; screen?: string; /** The files given with it (received into incoming/ under their hashes). */ files?: GivenFile[] } = {}) {
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
    const qid = o.qid ?? `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    // ITS FILES: moved from incoming/ into the question's own in/ folder (beside its answer); one still on its way is waited
    // for a little. The agent is told where each is.
    const inFiles: { name: string; path: string; type: string }[] = []
    for (const f of (o.files ?? []).slice(0, 10)) {
      const from_ = join(folder, 'incoming', f.hash)
      for (let i = 0; i < 60 && !existsSync(from_); i++) await new Promise((r) => setTimeout(r, 250))
      if (!existsSync(from_)) { console.warn(`[session] ${session.slice(0, 12)} · ${qid} · the file "${f.name}" never came`); continue }
      // two files of one name: the later one numbered (report.pdf, report (2).pdf)
      let name = f.name
      for (let n = 2; existsSync(join(folder, qid, 'in', name)); n++) name = f.name.replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`)
      const to = join(folder, qid, 'in', name)
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from_, to)
      let type = 'application/octet-stream'; try { type = readFileSync(`${from_}.type`, 'utf8'); rmSync(`${from_}.type`, { force: true }) } catch { /* not said */ }
      inFiles.push({ name, path: to, type })
    }
    const withFiles = inFiles.length ? `Files given with this question — look at them:\n${inFiles.map((f) => `- ${f.path} (${f.type})`).join('\n')}` : ''
    // where this question's files for the person go (\`:::file out/<name>\` gives each)
    const outFolder = `This question's out/ folder: ${join(folder, qid, 'out')}`
    mkdirSync(join(folder, qid, 'out'), { recursive: true })
    const context = [withFiles, outFolder, looking, started, files, `The step's STATE:\n${JSON.stringify(state)}`, answerNow ? `What the step shows now:\n${answerNow}` : '', INTENT_CONTRACT, docs ? `The programs:\n${docs}` : ''].filter(Boolean).join('\n\n')
    // ── THE INTENT (docs/intent-graph.md). Every message goes to the session's composer first — it is the entry point,
    //    nothing skips it. The platform gives what it decides with: the node the session is at and the candidates (the one
    //    node with the message's exact canonical form, else the best five by their words). The composer decides by meaning:
    //    the same intent, a candidate, a new intent (the analyst answers it), or not a request. A node with an agent of its
    //    own is answered by that agent, for whoever may use it.
    const path = pathTo(view, at)
    const onPath = history(view).filter((a) => path.includes(a.block))
    const turns = onPath.map((a) => ({ a, i: view.intents.find((x) => x.id === a.cause) })).filter((x) => x.i?.kind === 'language')
    const atNode = [...onPath].reverse().find((a) => (a as any).node)?.node as { id: string; title: string; how: string; agent?: string } | undefined
    const caps: string[] = Array.isArray(from?.caps) ? from.caps : []
    const owner = ownerOf(who.id), by = who.email ?? who.id
    // THE WORKBENCH (an agent whose ica is "workbench"): every message is its own — no intent is looked for, matched,
    // made or learnt; its domain is its agent's. For whoever is given it (project.workbench).
    const bench = spec?.ica === 'workbench'
    if (bench && !caps.includes('project.workbench')) throw new SessionSeamRefusal('the workbench is for those given it (project.workbench)', 'You are not given the workbench in this project — a project admin can give it to you.')
    let found: Found | null = null
    if (d.intents && !bench) { try { found = await d.intents.find({ text, at: atNode?.id ?? null, owner, caps }) } catch (e: any) { console.warn(`[intent] ${session.slice(0, 12)} · the platform gave nothing to decide with: ${e?.message ?? e}`) } }
    const seen = seenBy(session)
    const ran = (role: Role) => { seen[role] = [...new Set([...(seen[role] ?? []), qid])]; keepSeen(session, seen) }
    // What a role has not seen of this conversation (the other agent answered it): given before its question.
    const unseen = (role: Role) => {
      const missed = turns.filter((t) => t.i?.qid && !(seen[role] ?? []).includes(t.i.qid))
      return missed.length ? `Earlier in this conversation, answered by the session's other agent (their answers are in the answer history):\n${missed.map((t) => `- asked: ${String(t.i?.text ?? '').slice(0, 400)}\n  answered: ${t.a.markdown.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}` : ''
    }
    // The questions the analyst has not seen (answered by the composer since): given word for word, the answers left in the files.
    const missedBy = (r: Role) => {
      const missed = turns.filter((t) => t.i?.qid && !(seen[r] ?? []).includes(t.i.qid))
      return missed.length ? `Since you last saw this conversation the person asked (each answered — the answers are in the session's answer history, ../ANSWER_HISTORY.jsonl):\n${missed.map((t) => `- ${String(t.i?.text ?? '')}`).join('\n')}\n\nNow they ask the question below: it is yours to work out.` : ''
    }
    const knowledgeOf = async (n: NodeView, role: Role) => {
      const key = `${session}|${role}`, mark = `${n.id}@${n.variant?.owner ?? '-'}:${n.variant?.version ?? 0}`
      const g = given.get(key) ?? new Set<string>(); given.set(key, g)
      if (g.has(mark)) return `(its knowledge was given earlier in this conversation)`
      g.add(mark)
      const v = n.variant
      if (!v) return '(nothing is known about answering it yet)'
      const concepts = v.concepts.length && d.composeLinks ? await d.composeLinks(v.concepts.map((name) => ({ kind: 'concept' as const, name })), view.graph, [owner]).catch(() => '') : ''
      return [v.whose === 'project' ? (v.verified ? 'The project\'s approved way of answering it:' : 'How others in the project answered it (not yet approved — check it as you go):') : 'How this person answers it:',
        v.process ? `The way:\n${v.process}` : '', v.paths.length ? `Where the way divides:\n${v.paths.map((p) => `- when ${p.when}: ${p.how}`).join('\n')}` : '',
        v.show ? `How it is shown:\n${v.show}` : '', concepts ? `What it stands on:\n${concepts}` : '', await experienceOf(n)].filter(Boolean).join('\n\n')
    }
    // WHAT IT HAS MET (Experience): the signals it measures and the scenarios it has seen, each with its expectation — to
    // set this answer beside. The cases themselves are data, read with ./experience when they are needed.
    const experienceOf = async (n: NodeView) => {
      const ex = d.intents ? await d.intents.experience({ node: n.id, owner }) : null
      if (!ex || (!ex.cases && !ex.signals.length)) return 'What it has met: nothing yet — this is among its first answers.'
      return `What it has met (${ex.cases} case${ex.cases === 1 ? '' : 's'}; each one with ./experience ${n.id}):\n${JSON.stringify({ signals: ex.signals, scenarios: ex.scenarios.map(({ at: _a, ...x }) => x) }, null, 1).slice(0, 6000)}`
    }
    const nodeLine = (n: NodeView) => `${n.id}: ${n.title} — ${n.intent.replace(/\s+/g, ' ').slice(0, 300)}`
    const askAs = (role: Role, words: string, ctx: string) => { ran(role); return asReader(who, () => d.ask!({ session, role, text: words, context: ctx, from, reqId, qid, channel: o.channel, ...(view.graph ? { graph: view.graph } : {}), ...(role === 'workbench' && spec?.domain ? { domain: spec.domain } : {}) })) }

    // The composer's turn: the message, with the intent the session is in. How it decides is its role's (the graph's
    // concepts role/composer): it spells the question out in full from the conversation and finds the intents it may be
    // with ./find-intent — searched by those words; the words kept as what the question was understood to be.
    const decideWith = found ? `THE INTENT YOU ARE IN: ${found.here ? `${nodeLine(found.here)}\n${await knowledgeOf(found.here, 'composer')}` : '(none — the conversation starts here)'}` : ''
    let understood: { question: string; found: Found } | null = null
    const findOff = found && d.tools && d.intents ? d.tools.on(qid, 'find-intent', async (args) => {
      const q = String(args.question ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000)
      if (!q) throw new Error('give the question, spelled out in full')
      const f = await d.intents!.find({ text: q, at: atNode?.id ?? null, owner, caps })
      understood = { question: q, found: f }
      const exact = f.exact ? f.candidates[0] : null
      return [`CANDIDATES for "${q}" (found by their words; decide by meaning):\n${f.candidates.map((c) => `- ${nodeLine(c)}${c === exact ? ' (asked in the same words)' : ''}`).join('\n') || '(none)'}`,
        ...(await Promise.all(f.candidates.filter((c) => c.variant).map(async (c) => `The knowledge of ${c.id}:\n${await knowledgeOf(c, 'composer')}`)))].join('\n\n')
    }) : null
    const before = unseen('composer')
    let said: Awaited<ReturnType<typeof askAs>>
    try { said = await askAs(bench ? 'workbench' : 'composer', text, [context, before, decideWith].filter(Boolean).join('\n\n')) } finally { findOff?.() }
    if ((said as any).stopped) throw new SessionSeamRefusal('stopped')
    const dec = (said as any).decision as { node: string | null } | undefined
    const sent = (said as any).sent as { agent: string; message: string } | undefined
    let role: Role = bench ? 'workbench' : 'composer'
    let target: NodeView | null = null
    let how: 'matched' | 'made' | 'same' | null = null
    // What the question was understood to be (the composer's find-intent), and the intents found by it — else, when it did
    // not spell it out, the person's words and what they found (said to the operators).
    const u = understood as { question: string; found: Found } | null
    if (found && !u) console.warn(`[intent] ${session.slice(0, 12)} · ${qid} · the composer did not spell the question out (find-intent): decided by the person's words`)
    if (u) found = { ...u.found, here: found!.here }
    if (found) {
      const cand = found.candidates.find((c) => c.id === dec?.node)
      // A question sent to the analyst is a new intent — unless it is the intent the session is in, in a situation its
      // knowledge does not cover: then it stays there. A candidate the composer could not answer is not a complete match.
      // A question the learner suggested before anyone asked it: its node already stands (same words, nothing learnt yet).
      // The analyst's answer is its first — given at that node, never at a second one made beside it.
      const unanswered = found.exact && found.candidates[0] && !found.candidates[0].passages && !found.candidates[0].system && !found.candidates[0].agent ? found.candidates[0] : null
      if (sent) { if (dec?.node === 'same' && found.here) { target = found.here; how = 'same' } else { how = 'made'; target = unanswered } }
      else if (dec?.node === 'same' && found.here) { target = found.here; how = 'same' }
      else if (cand) { target = cand; how = 'matched' }
      else if (dec?.node === 'none') { how = null }
      else if (!dec?.node && said.markdown && found.here) { target = found.here; how = 'same' }   // it answered without deciding: where it is
      else { how = 'made'; target = unanswered }
      console.log(`[intent] ${session.slice(0, 12)} · ${qid} · composer: ${dec?.node ?? '(no decision)'}${sent ? ` · sent to the ${sent.agent}` : ''} → ${how ?? 'not a request'} ${target ? `${target.id} "${target.title}"` : ''} · candidates ${found.exact ? 'exact ' : ''}${found.candidates.map((c) => c.id).join(', ') || 'none'}`)
    }
    const agentName = target?.agent ?? null
    if (agentName && d.agents) {
      said = await answerByAgent(agentName, target!, session, text, from, caps, qid, reqId) as any
    } else if ((sent || how === 'made') && stopAsked(session)) {
      throw new SessionSeamRefusal('stopped')
    } else if (sent || how === 'made') {
      // The analyst is given the person's question (what the composer sent names it — `current-question` — and the engine
      // fills it in), and, word for word, the questions asked since it last saw the conversation: their answers are in the
      // session's answer history. Its own instructions say what a session is.
      role = 'analyst'
      if (sent) log.append(session, { t: 'handoff', at: new Date().toISOString(), from: 'composer', to: sent.agent, qid, question: text, understood: u?.question ?? null })
      said = await askAs('analyst', text, [missedBy('analyst'), u ? `Understood from the conversation as: ${u.question}` : ''].filter(Boolean).join('\n\n'))
    } else if (how === 'matched' && !said.markdown) {
      // The composer chose a candidate and did not answer: asked again, with that intent's knowledge.
      said = await askAs('composer', `It is the intent ${target!.id}. Answer the message: ${text}`, [context, `THE INTENT: ${nodeLine(target!)}\n${await knowledgeOf(target!, 'composer')}`].join('\n\n'))
    }
    const askAgent = (words: string) => askAs(role, words, role === 'analyst' ? '' : context)
    if ((said as any).stopped) throw new SessionSeamRefusal('stopped')
    // The linter (lint.ts): an answer that breaks the answer rules goes back to the agent once, with every problem said;
    // what is still wrong is fixed where a check can fix it — the operators told either way, the person reads the result.
    const byComposer = !(agentName && d.agents)   // a node agent's note is its own: not the composer's to redo
    const problems = byComposer && said.markdown ? lint({ markdown: said.markdown, blocks: (said.blocks ?? []) as SaidBlock[] }) : []
    if (problems.length) {
      console.warn(`[session] ${session} · ${view.agent} · the answer broke the answer rules — asked again: ${problems.map((p) => p.check).join(', ')}`)
      const again = await askAgent(`Your answer broke the answer rules:\n${problems.map((p) => `- ${p.says}`).join('\n')}\nGive the same answer again with that put right.`)
      if ((again as any).stopped) throw new SessionSeamRefusal('stopped')
      if (again.markdown) said = again
    }
    said = lintFixed(said, `${session} · ${view.agent}`, who.id)
    // A change written wrongly goes back to the agent once, with what was wrong, to be written again — the person sees
    // only the answer that came of it. Still wrong: the answer stands without the change (said plainly, below).
    const first = intentOf(said.markdown ?? '')
    if (first.problem && byComposer) {
      console.warn(`[session] ${session} · ${view.agent} wrote a change that could not be used — asked again: ${first.problem}`)
      const again = await askAgent(`Your answer's :::intent line could not be used: ${first.problem}. Give the same answer again, with the :::intent line written as the contract says — or with none if no change is needed.`)
      if ((again as any).stopped) throw new SessionSeamRefusal('stopped')
      if (again.markdown) said = again
    }
    // Said plainly to the operators: the engine's log, and a failed activity — the project's Attention lists it.
    if (!said.markdown && said.failure) {
      console.warn(`[session] ${session} · ${view.agent} gave no answer — ${said.failure}`)
      d.activities?.start(who.id, 'answer', `Answering in ${view.agent}`).failed(said.failure)
    }
    const { markdown, intent: asked, problem: wrong } = intentOf(said.markdown ?? '')
    // To the operators the reason (the log, a failed activity in Attention); to the person a plain line.
    const unmade = (reason: string) => {
      console.warn(`[session] ${session} · ${view.agent} · a change was not made: ${reason}`)
      d.activities?.start(who.id, 'answer', `Changing a step in ${view.agent}`).failed(reason)
      return `_The view could not be changed to match this answer — ask again, or use the options shown._`
    }
    const problem = wrong ? unmade(wrong) : undefined
    const blocks: Record<string, Record<string, unknown>> = {}
    for (const b of (said.blocks ?? []) as any[]) if (b?.marker && b.block && typeof b.block === 'object') blocks[String(b.marker).trim()] = b.block
    // What happened at the node, kept on the platform before the answer is (its passage; a new node made — by the analyst
    // or the node's agent, never the composer): the answer says which node, and the next intents on offer from it.
    const answered = markdown || said.markdown || ''
    const kept = found && how && answered && d.intents ? await d.intents.pass({
      node: how === 'made' && !target ? null : target!.id,
      ...(how === 'made' && !target ? { body: { title: (u?.question ?? text).replace(/\s+/g, ' ').slice(0, 120), intent: (u?.question ?? text).slice(0, 4000), asked: text.slice(0, 2000), canonical: found.canonical, params: found.params, agent: null } } : {}),
      from: atNode?.id ?? null, session, block: at, question: text, understood: u?.question ?? null, canonical: found.canonical, params: found.params, answer: answered, owner, by, agent: agentName ?? role, how,
    }) : null
    // Learnt from in the background (one learner per session): every intent of the session, this answer included.
    let learning: Promise<void> | null = null
    if (kept && d.intentLearn) {
      const all = [...turns.map((t) => ({ qid: String(t.i?.qid ?? t.a.id), question: String(t.i?.text ?? ''), answer: t.a.markdown, node: (t.a as any).node as { id: string; title?: string; how: string; agent?: string } | undefined })),
        { qid, question: text, answer: answered, node: { id: kept.id, title: kept.title, how: how!, agent: agentName ?? role } }]
      const byNode = new Map<string, { node: string; madeHere: boolean; turns: { qid: string; question: string; answer: string; agent: string }[]; after: { node: string; title: string } | null }>()
      let before: { node: string; title: string } | null = null
      for (const t of all) {
        if (!t.node?.id) continue
        const e = byNode.get(t.node.id) ?? { node: t.node.id, madeHere: t.node.how === 'made', turns: [], after: before && before.node !== t.node.id ? before : null }
        before = { node: t.node.id, title: String((t.node as any).title ?? t.node.id) }
        e.turns.push({ qid: t.qid, question: t.question, answer: t.answer, agent: t.node.agent ?? 'composer' }); byNode.set(t.node.id, e)
      }
      learning = d.intentLearn.answered({ session, who, intents: [...byNode.values()] })
    }
    const node = kept ? { id: kept.id, title: kept.title, how: how!, agent: agentName ?? role, ...(target?.variant ? { verified: target.variant.whose === 'project' ? target.variant.verified : undefined } : {}) } : undefined
    const step = { state, context: view.context ?? '', history: [...turns.map((t) => ({ question: String(t.i?.text ?? ''), markdown: t.a.markdown, data: dataOf(t.a.blocks) })), { question: text, markdown: answered, data: dataOf(blocks) }] }
    const next = kept && d.intents ? await offeredNext(await d.intents.next({ at: kept.id, owner, caps }), step, Object.freeze({ query, who: () => who }) as any, { timeoutMs: d.optionMs ?? 1500, log: (l) => console.warn(l), tried: (r) => d.intents!.tried(kept.id, r) }).catch(() => []) : []
    const li: Intent = {
      id: `int_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, session, kind: 'language', text, ...(inFiles.length ? { files: inFiles.map((f) => ({ name: f.name, type: f.type })) } : {}),
      result: { ...(node ? { node } : {}), ...(next.length ? { next } : {}), markdown: [markdown || (said.markdown ? '' : said.failure ? NOT_ANSWERED : 'No answer came back.'), problem].filter(Boolean).join('\n\n'), files: [], ...(asked?.ops ? { ops: asked.ops } : {}), ...(Object.keys(blocks).length ? { blocks } : {}), ...(said.beats?.length ? { beats: said.beats } : {}) } as any,
      ...(asked?.call ? { call: asked.call } : {}),
      to: asked?.to ?? (asked && !asked.call ? 'current' : 'new'), block: at, by: user, at: new Date().toISOString(), qid,
    }
    // A change that is well formed but cannot be applied (a slice the programs do not have, …) does not cost the answer:
    // it is applied without the change, and says so.
    // a program that failed while running: its reason to the operators (the log, Attention); the answer stands
    const told = <T extends { ran?: { package: string; failed?: string }[] }>(r: T): T => {
      for (const f of r.ran?.filter((x) => x.failed) ?? []) {
        console.warn(`[session] ${session} · ${view.agent} · program ${f.package} failed while running: ${f.failed}`)
        d.activities?.start(who.id, 'answer', `Running ${f.package} in ${view.agent}`).failed(String(f.failed).split('\n')[0])
      }
      // Once the learner has run, an answer still the last one in its session offers the next intents it suggested — kept
      // in the session (so a reload has them) and sent to the page that asked.
      const ans = (r as any).answer?.id as string | undefined
      if (learning && ans && kept) void learning.then(() => nextLater(session, ans, from, async () => offeredNext(await d.intents!.next({ at: kept.id, owner, caps }), step, Object.freeze({ query, who: () => who }) as any, { timeoutMs: d.optionMs ?? 1500, log: (l) => console.warn(l), tried: (x) => d.intents!.tried(kept.id, x) }))).catch((e) => console.warn(`[intent] ${session.slice(0, 12)} · next intents after learning: ${e?.message ?? e}`))
      return r
    }
    try { return told(await asReader(who, () => rtSessions.intent(li))) }
    catch (e: any) {
      if (!li.result?.ops?.length || !(e instanceof StateRefusal || e instanceof SessionRefusal)) throw e
      // Refused by the programs (a slice's own check: a breakdown the model has not, …): the agent is told why, once, in
      // the same turn, and answers again — with a change they accept, or without one. Still refused: as below.
      console.warn(`[session] ${session} · ${view.agent} · the programs refused the change — asked again: ${e.message}`)
      let again = await askAgent(`The change your answer asked for was refused by the programs: ${e.message}. Answer the question again — with a change they accept, or with none, answering it yourself.`)
      if ((again as any).stopped) throw new SessionSeamRefusal('stopped')
      if (again.markdown) {
        again = lintFixed(again, `${session} · ${view.agent}`, who.id)
        const second = intentOf(again.markdown!)
        const blocks2: Record<string, Record<string, unknown>> = {}
        for (const b of (again.blocks ?? []) as any[]) if (b?.marker && b.block && typeof b.block === 'object') blocks2[String(b.marker).trim()] = b.block
        const li2: Intent = { ...li, id: `${li.id}b`,
          result: { ...(node ? { node } : {}), markdown: second.markdown || again.markdown!, files: [], ...(second.intent?.ops ? { ops: second.intent.ops } : {}), ...(Object.keys(blocks2).length ? { blocks: blocks2 } : {}), ...((again as any).beats?.length ? { beats: [...((said as any).beats ?? []), ...(again as any).beats] } : {}) } as any,
          ...(second.intent?.call ? { call: second.intent.call } : { call: undefined }),
          to: second.intent?.to ?? (second.intent && !second.intent.call ? 'current' : 'new') }
        try { return told(await asReader(who, () => rtSessions.intent(li2))) }
        catch (e2: any) {
          if (!li2.result?.ops?.length || !(e2 instanceof StateRefusal || e2 instanceof SessionRefusal)) throw e2
          const without2: Intent = { ...li2, result: { ...li2.result, ops: undefined, markdown: [li2.result.markdown, unmade(e2.message)].filter(Boolean).join('\n\n') } }
          return told(await asReader(who, () => rtSessions.intent(without2)))
        }
      }
      const without: Intent = { ...li, result: { ...li.result, ops: undefined, markdown: [li.result.markdown, unmade(e.message)].filter(Boolean).join('\n\n') } }
      return told(await asReader(who, () => rtSessions.intent(without)))
    }
  }

  /** The agent a session is opened on when none was picked: the project's default agent. A question's words never choose
   *  it — what a question is about is decided at its intent (docs/intent-graph.md), not by a domain. */
  function agentFor(visible: (scope: string) => boolean): { agent: AgentSpec; how: 'default' } {
    const mine = [...graphAgents(), ...agents().map((a) => { try { return readAgent(a.id) } catch { return null } }).filter((a): a is AgentSpec => !!a)].filter((a, i, all) => visible(a.scope) && all.findIndex((x) => x.id === a.id) === i)
    const fallback = mine.find((a) => a.isDefault)
    if (fallback) return { agent: fallback, how: 'default' }
    throw new SessionSeamRefusal('this project has no default agent — an administrator marks one')
  }

  // ── A SESSION'S TURNS: one question at a time; the others wait in order, each removable until it starts ──────────────
  // Held here, in memory, by the engine that runs them: each question keeps its own request open (it is answered as its
  // reply, as any question is); every change is recorded in the session's log (`waiting`, `waited`) and pushed to every
  // page watching the session (`session:turns`) — a page opened or reloaded gets them with the session (session:get).
  // An engine restart ends them, as it ends the turn that was running: the log keeps the record.
  // QUESTIONS ASKED WHILE ONE IS BEING ANSWERED GO TOGETHER: when the turn ends, every one waiting is sent to the agent
  // as one message, in the order asked — the agent takes them as it best can — and each of their requests is answered
  // with that one answer.
  type Reply = Record<string, unknown>
  /** A file given with a question: its name, and the hash it waits under in the session's incoming/ folder. */
  type GivenFile = { name: string; hash: string }
  type Waiting = { qid: string; text: string; at: string; by: string; files: GivenFile[]; go: (t: Turn) => void; drop: (why: string) => void }
  /** A question's turn: it asks (the words to ask, its own first and those that came with it), or it follows one that does. */
  type Turn = { qid: string; waited: boolean; text: string; /** its files — and, asked together, theirs too */ files: GivenFile[]; follow?: Promise<Reply>; done?: (r: Reply) => void }
  const turns = new Map<string, { running: { qid: string; text: string; at: string; by: string; stop?: boolean } | null; queue: Waiting[] }>()
  const watching = new Map<string, Map<string, any>>()
  const watch = (session: string, from: any) => { if (!from?.id) return; const w = watching.get(session) ?? new Map(); w.set(String(from.id), from); watching.set(session, w) }
  const turnsOf = (session: string) => { const x = turns.get(session); return { running: x?.running ? { qid: x.running.qid, text: x.running.text, at: x.running.at } : null, queue: (x?.queue ?? []).map((q) => ({ qid: q.qid, text: q.text, at: q.at })) } }
  /** A step of a session's turn, to every page that has the session open (the one that asked gets it as its progress too). */
  function stepOf(session: string, frame: Record<string, unknown>) { const { reqId: _r, ...rest } = frame; for (const f of watching.get(session)?.values() ?? []) d.send(f, { ...rest, session, live: true }) }
  const pushTurns = (session: string) => { const msg = { t: 'session:turns', session, ...turnsOf(session) }; for (const f of watching.get(session)?.values() ?? []) d.send(f, msg) }
  /** Waits for this question's turn in its session. */
  async function turnFor(session: string, q: { text: string; by: string; from: any; reqId?: string; files?: GivenFile[] }): Promise<Turn> {
    if (q.text.length > QUESTION_MAX_CHARS) throw new SessionSeamRefusal(`a question is at most ${QUESTION_MAX_CHARS} characters — this one is ${q.text.length}`)
    const x = turns.get(session) ?? { running: null, queue: [] }
    const waiting = x.queue.reduce((n, w) => n + w.text.length, 0)
    if (x.running && waiting + q.text.length > QUEUE_MAX_CHARS) throw new SessionSeamRefusal(`what is waiting in this conversation is at most ${QUEUE_MAX_CHARS} characters altogether — wait for the answer, then ask`)
    turns.set(session, x)
    const qid = `tq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at = new Date().toISOString()
    if (!x.running && !x.queue.length) { x.running = { qid, text: q.text, at, by: q.by }; pushTurns(session); return { qid, waited: false, text: q.text, files: q.files ?? [] } }
    return new Promise<Turn>((go, drop) => {
      x.queue.push({ qid, text: q.text, at, by: q.by, files: q.files ?? [], go, drop: (why) => drop(new SessionSeamRefusal(why)) })
      log.append(session, { t: 'waiting', at, qid, text: q.text, by: q.by })
      if (q.from) d.send(q.from, { t: 'session:waiting', session, qid, ahead: x.queue.length, reqId: q.reqId })
      console.log(`[session] ${session.slice(0, 12)} · ${qid} waiting its turn (${x.queue.length} waiting)`)
      pushTurns(session)
    })
  }
  /** The turn is over (answered, refused, stopped): every question waiting starts, together — the first asks them all. */
  function turnOver(session: string) {
    const x = turns.get(session); if (!x) return
    const all = x.queue.splice(0)
    if (!all.length) { turns.delete(session); pushTurns(session); return }
    const at = new Date().toISOString(), text = all.map((q) => q.text).join('\n\n')
    x.running = { qid: all[0].qid, text, at, by: all[0].by }
    for (const q of all) log.append(session, { t: 'waited', at, qid: q.qid, why: 'asked' })
    let done: (r: Reply) => void = () => {}
    const answered = new Promise<Reply>((r) => { done = r })
    all[0].go({ qid: all[0].qid, waited: true, text, files: all.flatMap((q) => q.files).slice(0, 10), done })
    for (const q of all.slice(1)) q.go({ qid: q.qid, waited: true, text, files: [], follow: answered })
    console.log(`[session] ${session.slice(0, 12)} · ${all.length} waiting question${all.length === 1 ? '' : 's'} asked together`)
    pushTurns(session)
  }
  /** A waiting question taken out by its person, before it starts; whether it was there. */
  function withdraw(session: string, qid: string, by: string): boolean {
    const x = turns.get(session), i = x?.queue.findIndex((q) => q.qid === qid) ?? -1
    if (!x || i < 0 || x.queue[i].by !== by) return false
    const [q] = x.queue.splice(i, 1)
    log.append(session, { t: 'waited', at: new Date().toISOString(), qid, why: 'withdrawn' })
    q.drop('withdrawn before it was asked')
    pushTurns(session)
    return true
  }
  /** STOP the turn running in a session (the person's Stop): the agent working on it is interrupted, and a stop that comes
   *  between two of its agents is still taken (the next is not asked). Resolves once it has ended; whether one was running. */
  async function stop(session: string, why: string): Promise<boolean> {
    const x = turns.get(session)
    if (!x?.running) return d.stopAgent ? d.stopAgent(session, why) : false
    x.running.stop = true
    const qid = x.running.qid
    if (d.stopAgent) await d.stopAgent(session, why)
    // ended when this turn is no longer the one running
    for (let i = 0; i < 200 && turns.get(session)?.running?.qid === qid; i++) await new Promise((r) => setTimeout(r, 100))
    return true
  }
  const stopAsked = (session: string) => !!turns.get(session)?.running?.stop

  /** FILES GIVEN BUT NEVER ASKED WITH (a draft let go: a reload, a closed tab) are let go after a day — looked for at most
   *  once an hour, across every session's incoming/ folder. */
  let swept = 0
  function sweepIncoming() {
    if (Date.now() - swept < 3_600_000) return
    swept = Date.now()
    const root = join(d.projectDir, 'sessions'), old = Date.now() - 86_400_000
    let gone = 0
    for (const sid of (() => { try { return readdirSync(root) } catch { return [] } })()) {
      const dir = join(root, sid, 'incoming')
      for (const f of (() => { try { return readdirSync(dir) } catch { return [] } })()) {
        try { if (statSync(join(dir, f)).mtimeMs < old) { rmSync(join(dir, f), { force: true }); gone++ } } catch { /* gone already */ }
      }
    }
    if (gone) console.log(`[session] ${gone} file${gone === 1 ? '' : 's'} given but never asked with, let go`)
  }
  setTimeout(sweepIncoming, 60_000).unref?.()   // and once soon after the engine starts
  /** The files a question names as given with it (sent before it, into incoming/). */
  const filesOf = (payload: any): GivenFile[] => (Array.isArray(payload?.files) ? payload.files : []).slice(0, 10)
    .map((f: any) => ({ name: String(f?.name ?? ''), hash: String(f?.hash ?? '') }))
    .filter((f: GivenFile) => /^[\w][\w .()-]{0,119}$/.test(f.name) && !f.name.includes('..') && /^[0-9a-f]{64}$/.test(f.hash))

  async function handle(payload: any, from: any): Promise<void> { return inDev(devOf(from), () => handleIn(payload, from)) }
  async function handleIn(payload: any, from: any): Promise<void> {
    const t = String(payload.t)
    const reply = (msg: Record<string, unknown>) => { if (msg.t !== 'session:agents') console.log(`[out] ${String(msg.t)} req=${payload.reqId ?? '-'}${msg.reason ? ` — ${String(msg.reason).slice(0, 160)}` : ''}`); return d.send(from, { ...msg, reqId: payload.reqId }) }
    try {
      // Only the agents this asker sees (global, their own, their groups'); an admin sees all.
      const visible = (scope: string) => { try { const w = whoIs(from); return w.admin || scope === 'global' || w.scopes.includes(scope) } catch { return scope === 'global' } }
      if (t === 'session:agents') {
        // A workbench is for those given it (project.workbench): not even listed for anyone else.
        const benches = (Array.isArray(from?.caps) ? from.caps : []).includes('project.workbench')
        const list = agents().filter((a) => visible(a.scope) && (a.ica !== 'workbench' || benches))
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
        if (t === 'view:open') v = await asReader(who, () => tmp.openAndRun({ session: 'view', user, agent: spec.id, ...(state ? { state } : { start: startWith(spec, payload.startAt, payload.with, packages) }), run }))
        else {
          if (!state) throw new SessionSeamRefusal('a view step starts from the STATE it is at')
          tmp.open({ session: 'view', user, agent: spec.id, state })
          v = (await asReader(who, () => tmp.intent(structured(payload, 'view', user, 'current')))).session
        }
        return reply(await present(v, { t: 'view:view' }, from))
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
        let v = await asReader(who, () => rt.openAndRun({ session, user, agent: spec.id, ...(rootState ? { state: rootState } : { start: startWith(spec, root.startAt, root.with, packages) }), run: packages.map((p) => p.name) }))
        for (const [i, step] of path.entries()) {
          if (i > 0) v = (await asReader(who, () => rt.intent(structured({ ...step.intent, block: v.leaf }, session, user, 'new')))).session
          for (const e of Array.isArray(step.edits) ? step.edits : []) v = (await asReader(who, () => rt.intent(structured({ ...e, block: v.leaf }, session, user, 'current')))).session
        }
        return reply(await present(v, {}, from))
      }
      if (t === 'session:open') {
        const graph = pinOf(payload.graph, from)
        const { sessions, spec, packages } = await runtimeFor(String(payload.agent ?? ''), undefined, graph === 'draft')
        if (!visible(spec.scope)) throw new SessionSeamRefusal(`there is no agent "${spec.id}"`)
        // An agent opens on its starting screen: its programs run, as a dashboard opens with its data (unless asked not to).
        const run = payload.run === false ? [] : packages.map((p) => p.name)
        // A starting point the agent declares opens on its own STATE (its fields over the agent's start, slice by slice).
        const start = startOf(spec, payload.startAt)
        return reply(await present(await asReader(whoIs(from), () => sessions.openAndRun({ session, user, agent: spec.id, start, run, ...contextOf(payload), ...(graph ? { graph } : {}) })), {}, from))
      }
      // A question from home, with no agent picked: the default agent opens a session on it.
      if (t === 'session:start') {
        const graph = pinOf(payload.graph, from)
        // The agent the person chose to start with (a conversation's kind: the workbench …), else the default one.
        const chosen = payload.agent ? (() => { try { return readAgent(String(payload.agent)) } catch { return null } })() : null
        if (payload.agent && (!chosen || !visible(chosen.scope))) throw new SessionSeamRefusal(`there is no agent "${String(payload.agent)}"`)
        if (chosen?.ica === 'workbench' && !(Array.isArray(from?.caps) ? from.caps : []).includes('project.workbench')) throw new SessionSeamRefusal('the workbench is for those given it (project.workbench)', 'You are not given the workbench in this project — a project admin can give it to you.')
        const { agent, how } = chosen ? { agent: chosen, how: 'chosen' as const } : agentFor(visible)
        const { sessions: rt, packages } = await runtimeFor(agent.id, undefined, graph === 'draft')
        const opened = await asReader(whoIs(from), () => rt.openAndRun({ session, user, agent: agent.id, start: agent.start, run: packages.map((p) => p.name), ...contextOf(payload), ...(graph ? { graph } : {}) }))
        // The first question is a turn like every other: a page reloaded while it is answered shows it working, a question
        // asked meanwhile waits, and it can be stopped.
        const text = String(payload.text ?? '')
        watch(session, from)
        await turnFor(session, { text, by: user, from, reqId: payload.reqId, files: filesOf(payload) })
        let out: Record<string, unknown>
        try {
          const r = await answerWords(opened, session, text, null, from, user, payload.reqId, { files: filesOf(payload) })
          out = await present(r.session, { routed: { agent: agent.id, name: agent.name, how }, result: { block: r.block, opened: r.opened, answer: r.answer } }, from)
        } catch (e) { turnOver(session); throw e }
        turnOver(session)
        return reply(out)
      }
      if (t === 'session:get') {
        const v = replay(log.read(session), payload.asOf ? String(payload.asOf) : undefined)
        if (!v) throw new SessionSeamRefusal(`there is no session ${session}`)
        viewOf(v, user); watch(session, from)
        return reply({ ...(await present(viewOf(v, user), {}, from)), turns: turnsOf(session) })
      }
      // A question waiting its turn, taken out by the person who asked it.
      if (t === 'session:withdraw') {
        const v = replay(log.read(session)); if (!v) throw new SessionSeamRefusal(`there is no session ${session}`)
        viewOf(v, user)
        return reply({ t: 'session:withdrawn', session, qid: String(payload.qid ?? ''), removed: withdraw(session, String(payload.qid ?? ''), user) })
      }
      // A FILE GIVEN WITH THE NEXT QUESTION (`question`): fetched into the session's incoming/ — the session may not exist yet
      // (a first question carries it) — and moved into that question's in/ folder when it is asked.
      if (t === 'session:attach' && payload.question) {
        const name = String(payload.name ?? '').trim(), hash = String(payload.hash ?? '')
        if (!/^[\w][\w .()-]{0,119}$/.test(name) || name.includes('..')) throw new SessionSeamRefusal('a file is named plainly (letters, digits, spaces, . _ - ( ), at most 120)')
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new SessionSeamRefusal('a file is named by its hash')
        if (!d.fetchAttachment) throw new SessionSeamRefusal('this engine cannot read files from the platform')
        const bytes = Buffer.from(await d.fetchAttachment(session, hash))
        if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new SessionSeamRefusal('the file read is not the one its hash names')
        // a session already begun is its owner's: no one else's files go into it
        const begun = replay(log.read(session)); if (begun) viewOf(begun, user)
        const dir = join(d.projectDir, 'sessions', session, 'incoming')
        mkdirSync(dir, { recursive: true })
        // kept under its hash: the question it goes with names it (name and hash), whatever else waits here
        writeFileSync(join(dir, hash), bytes)
        writeFileSync(join(dir, `${hash}.type`), String(payload.type ?? 'application/octet-stream').slice(0, 100))
        sweepIncoming()
        return reply({ t: 'session:attached', session, name, hash, size: bytes.length, question: true })
      }
      const { sessions, view } = await sessionRuntime(session)
      viewOf(view, user)
      if (t === 'session:goto') return reply(await present(sessions.goTo(session, String(payload.block ?? ''), user), {}, from))
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
          const text = String(payload.text ?? '')
          watch(session, from)
          const turn = await turnFor(session, { text, by: user, from, reqId: payload.reqId, files: filesOf(payload) })
          // Asked together with the questions before it: its answer is theirs.
          if (turn.follow) return reply(await turn.follow)
          let out: Reply = { t: 'session:refused', reason: 'the questions asked together were not answered' }
          // The turn is closed before its reply goes: the turns a page is told are already the next ones when the answer lands.
          try {
            // A question that waited goes at the newest step (what was answered while it waited is before it), with every
            // question that waited beside it.
            const now = turn.waited ? (await sessionRuntime(session)).view : view
            const r = await answerWords(now, session, turn.text, !turn.waited && payload.block ? String(payload.block) : null, from, user, payload.reqId, { files: turn.files })
            out = await present(r.session, { result: { block: r.block, opened: r.opened, answer: r.answer, ...(r.stale ? { stale: true } : {}) } }, from)
          } catch (e: any) { out = { t: 'session:refused', reason: e?.message ?? String(e) }; turn.done?.(out); turnOver(session); throw e }
          turn.done?.(out); turnOver(session)
          return reply(out)
        }
        const intent: Intent = {
          id: `int_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, session, kind: 'structured',
          ...(payload.ops ? { ops: payload.ops } : {}), ...(payload.call ? { call: payload.call } : {}),
          to: payload.to, ...(payload.block ? { block: String(payload.block) } : {}), ...labelOf(payload), by: user, at: new Date().toISOString(),
        }
        const work = () => asReader(who, () => sessions.intent(intent))
        const r = d.activities ? await d.activities.around(who.id, 'session.run', `Running ${intent.call ? `${intent.call.package}.${intent.call.fn}` : 'a change'}`, work, (x) => x.answer ? x.answer.markdown.split('\n')[0].slice(0, 160) : 'done') : await work()
        return reply(await present(r.session, { result: { block: r.block, opened: r.opened, answer: r.answer, ...(r.stale ? { stale: true } : {}) } }, from))
      }
      throw new SessionSeamRefusal(`there is no ${t}`)
    } catch (e: any) {
      if (e instanceof SessionSeamRefusal || e instanceof SessionRefusal || e instanceof ProgramError || e instanceof StateRefusal || e instanceof AccessRefusal || e instanceof GovernanceRefusal) return reply({ t: 'session:refused', reason: e.message, ...(e instanceof SessionSeamRefusal && e.plain ? { plain: e.plain } : {}) })
      console.error('[session]', e?.stack ?? e)
      return reply({ t: 'session:refused', reason: `the session could not do that: ${e?.message ?? e}` })
    }
  }

  /** A question in a session by its id, from any door (a chat, the phone, a chat channel): the session is opened first
   *  if it is new — on the agent chosen, else the one its words reach — then the words are its next turn, the same as
   *  words typed in it. The session's answer, and which agent gave it. */
  async function ask(o: Parameters<typeof askIn>[0]) { return inDev(devOf(o.from), () => askIn(o)) }
  async function askIn(o: { session: string; text: string; from: any; qid: string; agent?: string; channel?: string; context?: string; screen?: string; domain?: string | null; reqId?: string; /** "draft" or a version's name: the knowledge a NEW session reads. */ graph?: string }) {
    if (!/^[\w-]{1,80}$/.test(o.session)) throw new SessionSeamRefusal(`"${o.session}" is not a session id`)
    const user = userOf(o.from)
    const visible = (scope: string) => { try { const w = whoIs(o.from); return w.admin || scope === 'global' || w.scopes.includes(scope) } catch { return scope === 'global' } }
    let view = replay(log.read(o.session))
    let routed: { agent: string; name: string; how: string } | null = null
    if (!view) {
      const ofDomain = !o.agent && o.domain ? graphAgents().find((a) => !a.isDefault && a.domain === o.domain && visible(a.scope)) : undefined
      const graph = pinOf(o.graph, o.from)
      const picked = o.agent ? { agent: readAgent(o.agent), how: 'chosen' } : ofDomain ? { agent: ofDomain, how: 'chosen' } : agentFor(visible)
      if (!visible(picked.agent.scope)) throw new SessionSeamRefusal(`there is no agent "${picked.agent.id}"`)
      const { sessions: rt, packages } = await runtimeFor(picked.agent.id, undefined, graph === 'draft')
      view = await asReader(whoIs(o.from), () => rt.openAndRun({ session: o.session, user, agent: picked.agent.id, start: picked.agent.start, run: packages.map((p) => p.name), ...contextOf(o), ...(graph ? { graph } : {}) }))
      routed = { agent: picked.agent.id, name: picked.agent.name, how: picked.how }
    } else { viewOf(view, user); if (o.graph && (o.graph !== view.graph)) throw new SessionSeamRefusal(`session ${o.session} reads ${view.graph ?? 'the published knowledge'}; a session keeps the version it was opened at — ask in a new session`) }
    // The same turns as a page's: a question from another door waits its turn too.
    const turn = await turnFor(o.session, { text: o.text, by: user, from: o.from, reqId: o.reqId })
    if (turn.follow) { const m: any = await turn.follow; return { answer: m?.result?.answer ?? null, agent: routed ?? { agent: view.agent, name: view.agent, how: 'session' }, graph: view.graph ?? null } }
    let r: Awaited<ReturnType<typeof answerWords>>
    try { r = await answerWords(turn.waited ? replay(log.read(o.session))! : view, o.session, turn.text, null, o.from, user, o.reqId, { qid: o.qid, channel: o.channel, screen: o.screen }); turn.done?.({ result: { answer: r.answer } }) }
    catch (e: any) { turn.done?.({ t: 'session:refused', reason: e?.message ?? String(e) }); throw e }
    finally { turnOver(o.session) }
    const spec = readAgent(view.agent)
    return { answer: r.answer, agent: routed ?? { agent: spec.id, name: spec.name, how: 'session' }, graph: view.graph ?? null }
  }

  return { handle, agents, ask, stop, stepOf }
}
