// ── ICA engine — a HUB CLIENT (opens no ports) ───────────────────────────────
// The engine is hosted where nothing listens. It connects OUT to the DO hub over
// WebSocket as role 'code-engine' and does everything through it:
//   receive { payload, from }  →  handle  →  reply { to: from, payload }
// The browser UI (served by the Cloudflare worker) talks to the DO as 'runtime'; the DO
// relays. There is NO HTTP server here. The ICA itself is a swappable harness (opencode /
// pi / claude-code) behind one `Session` interface — this file only speaks the hub protocol.
//
//   ICA_HUB=ws://localhost:5174   (local sa-worker DO; prod: wss://superatom.site)
//   ICA_PROJECT=<projectId>       (the DO project id)
//   ICA_KEY=<per-project key>     (sk-proj-…; the code-engine credential)
//   ICA_OC_URL=http://127.0.0.1:4096   (opencode: share ONE standalone server, no per-engine spawn)
//   pnpm exec tsx engine.ts

// FIRST IMPORT, deliberately: it installs the fetch dispatcher, and anything that fetches before it runs
// would bypass the proxy. Does nothing unless HTTPS_PROXY is set.
import './ica/proxy-dispatcher.js'
import { fetchBoxCredentials, isFleetBox } from './ica/box-credentials.js'
import WebSocket from 'ws'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { writeFile, rm, readdir, stat, mkdir, cp } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createSession, prepareWorkspace, type Session, type Harness, type RunHandlers } from './ica/index.js'
import { agentConfig, describeConfig, useCache, receive, applied, type AgentName } from './config/index.js'
import { createNarrator, capResultData, stripCode, type Narrator } from './agents/narrator/index.js'
import { createAnalyst, promptVersion as analystPromptVersion } from './agents/analyst/index.js'
import { promptVersion as composerPromptVersion, createComposer, type Composer } from './agents/composer/index.js'
import { createConnector, promptVersion as connectorPromptVersion } from './agents/connector/index.js'
import { createGroundingAgent, promptVersion as groundingPromptVersion } from './agents/grounding/index.js'
import { openAnswers } from './answers.js'
import { log, readJsonSafe } from './log.js'
import { createInspector } from './inspect.js'
import { NodeStore } from '@superatom/node-store'
import { openProjectGraph } from './graph/project.js'
import type { Engine as GraphEngine } from '@superatom/graph'
// TYPE-ONLY, and it must stay that way: the deploy bundles package vm/ alone, so this path does not exist in a
// built image. tsx erases a type-only import, which is why the container runs without it. Making it a value
// import would break every deploy while working perfectly here.
import type { EngineMsgType } from '../../../clients/protocol.js'
import { buildDatasourceIndex } from './datasource-index/build.js'
import type { AgentEvent } from './ica/session.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
try { process.loadEnvFile(join(__dirname, '.env')) } catch { /* no .env — rely on the ambient environment */ }
// Resilience: a stray async error from a flaky agent CLI/harness (a PTY that vanished, an opencode server
// that timed out starting) must NEVER take the engine down. Fly would restart it, but crash-looping drops
// the in-flight answer and looks like "nothing happened" to the user. Log it and keep serving.
process.on('unhandledRejection', (r: any) => log.error('engine', 'unhandledRejection (kept alive)', r))
process.on('uncaughtException',  (e: any) => log.error('engine', 'uncaughtException (kept alive)', e))

const HUB = process.env.ICA_HUB || 'ws://localhost:5174'
const PROJECT = process.env.ICA_PROJECT || ''
// Persistence roots. All GENERATED per-project state lives under ONE root, OUTSIDE the engine code app:
//   <STATE_ROOT>/<projectId>/ — the workspace (seams, programs/, out/) AND the project's DBs together
//   (project.sqlite · grounding.sqlite · answers.sqlite). Committed per-project INPUTS (the datasource
//   bridges) live separately in <repo>/projects/<projectId>/. Env-overridable so Fly points them at the
//   mounted VOLUME (else state would sit on the ephemeral container layer and be wiped on every restart);
//   the existing per-root env vars still win, so Fly's layout is unchanged.
const VM_ROOT = join(__dirname, '..', '..')                              // apps/engine → the vm monorepo root
// Outside the repository, so an agent working in its workspace is not one directory away from the engine's source.
const STATE_ROOT = process.env.ENGINE_STATE_DIR ?? join(homedir(), '.superatom', 'state')
const WORKSPACE_ROOT = process.env.ENGINE_WORKSPACE_DIR ?? STATE_ROOT
const DATA_ROOT = process.env.ENGINE_DATA_DIR ?? STATE_ROOT              // answers.sqlite co-locates with the workspace

// THE PROFILE THIS MACHINE LAST ADOPTED, read before any agent config is resolved. Without it a box whose
// control plane is briefly unreachable would boot on the git default — quietly running different agents than
// it was configured with, and working well enough that nobody looks.
useCache(join(STATE_ROOT, PROJECT))
// SEGREGATION (see ica/workspace.ts): the agent's write-root and the engine's DBs are SIBLING folders under the
// project home, so the agent's cwd never contains our SQLite files.
const WORKSPACE = join(WORKSPACE_ROOT, PROJECT, 'workspace')   // the AGENT's cwd: seams + programs/ + out/
// ── WHERE A CONVERSATION'S WORK LIVES ──────────────────────────────────────────────────────────────────────
// One folder per conversation, holding the programs written for it and each turn's output. A program encodes
// the scope and filters of the question that produced it, so one conversation's work is not another's to read
// or to re-run.
//
// The composer works here directly — its session is the conversation's. The analyst cannot: it is ONE shared
// session serving everyone, and a destination that moved under it every turn would be a target it can neither
// see nor check. So it always writes to the same place, and the engine files what it built into the
// conversation that asked for it. Filing is the engine's job precisely because the analyst must not have to
// know which conversation it is serving.
const SESSIONS = join(WORKSPACE_ROOT, PROJECT, 'sessions')
const sessionHome = (sid: string) => join(SESSIONS, sid)
const DB_DIR    = join(WORKSPACE_ROOT, PROJECT, 'db')          // ENGINE-private DBs — a sibling, NOT under WORKSPACE
// Committed per-project CONFIG (index seeds, datasource notes) — distinct from generated state above.
const PROJECT_DIR = process.env.ENGINE_PROJECT_DIR ?? join(__dirname, '..', '..', 'projects', PROJECT)
const KEY = process.env.ICA_KEY || ''
// ONE fleet switch for the WORK agents (analyst/connector/grounding): ICA_AGENT_HARNESS =
// claude-code | codex | opencode picks the brain for ALL of them, and each agent's MODEL is INHERITED from
// that harness (claude-code→claude-sonnet-5, codex→gpt-5.6-terra) — you don't set a model. Any single agent
// can still be pinned with ICA_<AGENT>_HARNESS / _MODEL, which wins. Reflex is independent (own opencode-go).
// The PROFILE decides (apps/engine/config): default.json, replaced per agent by the project's own profile.
// Read here only for REPORTING — each agent asks the resolver for its own configuration when it is built, so
// nothing hands an agent half of its identity.
// Where the connector agent writes bridges (shared with the datasource-manager, which loads them by absolute
// path). Defaults to the project's COMMITTED inputs folder so connector-written bridges land beside any
// hand-authored ones (one place, no duplicate); on Fly override via env to the mounted volume.
const DATASOURCES_DIR  = process.env.DATASOURCES_DIR || join(VM_ROOT, 'projects', PROJECT, 'datasources')
const OC_URL = process.env.ICA_OC_URL                // opencode: connect to a shared standalone server
const DATASOURCE = process.env.DATASOURCE_URL || 'http://localhost:4000'   // the one data seam

// Singleton identity for the hub's fencing logic: instanceId is stable for THIS process; epoch is the
// boot time, so a freshly-started engine has a HIGHER epoch and deterministically wins the code-engine
// slot, while a zombie/older instance is fenced out — no register→evict→reconnect war. See ProjectDO.register.
const INSTANCE_ID = randomUUID()
const EPOCH = Date.now()

if (!PROJECT || !KEY) {
  console.error('[ica] need ICA_PROJECT + ICA_KEY (+ optional ICA_HUB). The engine connects OUT to the hub as role code-engine and opens no ports.')
  process.exit(1)
}

// ── ONE ICA session for this project (this engine serves one project) ─────────
// The engine only picks the harness — each harness manages ITS OWN binary/server lifecycle
// internally (opencode ensures `opencode serve`; codex spawns the codex CLI per turn; claude-code
// runs a PTY; pi is in-process). The engine never touches a server directly.
let hub: WebSocket | null = null

// PER-SESSION answer lock: DIFFERENT sessions answer CONCURRENTLY; one session still answers one at a time. The
// stream target (reply) + channel are LOCAL per analyse() call — no cross-session clobber. curQuestion below stays
// global as a best-effort reconnect-status snapshot only, never for answer routing.
const busySessions = new Set<string>()
// THE TURN IN FLIGHT, per session — so it can be STOPPED. A question can run for minutes across two agents; a
// person who has changed their mind should not have to wait it out, and the machine should not keep spending
// on an answer nobody wants. `stop()` is filled in by the turn itself, which is the only thing that knows what
// it currently owns (which agent is working, the narrator, the timers).
const inflight = new Map<string, { qid: string; stop: (why: string) => void }>()
export function stopTurn(sid: string, why = 'the user stopped it'): boolean {
  const t = inflight.get(sid)
  if (!t) return false
  t.stop(why)
  return true
}
let connectorBusy = false
let groundingBusy = false
let indexBusy = false   // the datasource-index build — one at a time per project

// Every question + answer for this project, in one sqlite the ENGINE owns (the LLM never writes it).
// Enables deterministic reuse ("already answered?") + full history + agent session ids. See answers.ts.
// SCOPED BY PROJECT so a shared-box multi-project dev setup never commingles answers, agent sessions, or the
// consolidation watermark across projects (on Fly each Machine is one project, so this is naturally isolated too).
// ── BOOTSTRAP: guarantee the engine's environment BEFORE opening any store or connecting. On a fresh
// machine the per-project dirs don't exist yet; opening a sqlite in a missing dir throws. We create them
// here, explicitly, and fail LOUD + clean (not a cryptic driver stack) if the volume isn't writable.
// Every SQLite file lives in DB_DIR — a SIBLING of the workspace, never inside it (segregation).
for (const d of [WORKSPACE, DB_DIR]) {
  try { mkdirSync(d, { recursive: true }) }
  catch (e: any) { console.error(`[ica] FATAL bootstrap: cannot create ${d}: ${e?.message ?? e}`); process.exit(1) }
}

const answers = openAnswers(join(DB_DIR, 'answers.sqlite'))
const genId = () => 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

// ── THE PROJECT'S GRAPH ───────────────────────────────────────────────────────────────────────────────────
// Programs, their memory, and every conversation's data session — one SQLite file in DB_DIR (graph/project.ts).
// Opened on first use rather than at boot, because it reads the data sources' dialects from the manager, and the
// manager may come up after the engine.
let graphEngine: Promise<GraphEngine> | null = null
const getGraph = () => (graphEngine ??= openProjectGraph({ dbDir: DB_DIR, projectDir: PROJECT_DIR, managerUrl: DATASOURCE })
  .catch((e) => { graphEngine = null; throw e }))

// The datasource index: every source's tables and columns, searchable by the agents' ./find-schema.
const indexStore = new NodeStore(join(DB_DIR, 'project.sqlite'))

// READ-ONLY window into the engine for the admin console, answered over the hub (inspect:req). See inspect.ts.
const inspector = createInspector({
  graph: indexStore, answers, workspace: WORKSPACE, dataRoot: join(DATA_ROOT, PROJECT), projectId: PROJECT,
  datasourceUrl: DATASOURCE,
  runtime: () => ({
    agents: {
      analyst:   { ...agentConfig('analyst'),   busy: busySessions.size > 0 },
      connector: { ...agentConfig('connector'), busy: connectorBusy },
      grounding: { ...agentConfig('grounding'), busy: groundingBusy },
    },
    consolidating: false,
    consolidateIntervalMs: 0,
    uptimeMs: Date.now() - EPOCH,
  }),
})

// ── Agent slots — one uniform session lifecycle per agent ─────────────────────
// A slot owns EVERYTHING about an agent's session: lazy create on first use; RESUME the prior session
// only if the instruction hash is unchanged (else start fresh — deterministic, decided here in the
// engine, not by the agent); persist the live id; and expose newSession() (reset) + compact(). The rest
// of the engine just calls slot.get() / newSession() / compact() — no scattered lifecycle code.
type Agent = { session: Session }
function makeAgentSlot<A extends Agent>(role: string, promptVersion: () => Promise<string>, create: (resumeId?: string) => Promise<A>,
                                        agentName?: AgentName) {
  let agent: A | null = null, building: Promise<A> | null = null, ver = ''
  // WHAT THIS AGENT WAS BUILT WITH. A session is bound to its harness, provider and model at the moment it is
  // created — a process is already running by the time a profile changes, and no message can turn a pi session
  // into an opencode one. So the change is applied the only way it can be: the NEXT session is built from the
  // new profile, and this string is how we notice we need one.
  //
  // Not merged into the prompt hash, though the two are close cousins. A changed PROMPT means the session's
  // instructions are stale, and not resuming it is enough. A changed MODEL means the running process is the
  // wrong process, and it has to go. Same signal, different remedy — so they stay separate.
  const configStamp = () => {
    if (!agentName) return ''
    const c = agentConfig(agentName)
    return `${c.harness}/${c.provider}/${c.model}`
  }
  let builtWith = ''
  // Persist the live session id so a restart can --resume it. IMPORTANT: only call this AFTER a real turn.
  // Claude writes a session's transcript to disk only once the session has conversed; persisting at mere
  // CREATION (e.g. at warm-up) stores an id with no transcript → the next boot's --resume fails with
  // "No conversation found". So creation does NOT persist — the callers persist after an actual run.
  const persist = () => { if (agent) answers.setAgentSession(PROJECT, role, 'claude-code', agent.session.sessionId?.(), ver, Date.now()) }
  async function get(): Promise<A> {
    // A profile change since this agent was built means the process itself is wrong — stop it and fall through
    // to a fresh one. Checked HERE rather than pushed from the config handler because this is the only moment
    // that is safe: whatever was mid-turn has finished with the old session, and nothing is interrupted.
    const want = configStamp()
    if (agent && builtWith && want !== builtWith) {
      console.log(`[ica] ${role}: profile changed (${builtWith} → ${want}) → rebuilding`)
      try { agent.session.stop() } catch { /* it may already be gone */ }
      agent = null; building = null
      answers.clearAgentSession(PROJECT, role)   // a transcript from another model is not ours to resume
    }
    if (agent) return agent
    if (!building) building = (async () => {
      ver = await promptVersion()                                            // deterministic hash of the instruction files
      const prev = answers.getAgentSession(PROJECT, role)
      const resumeId = prev?.promptVersion === ver ? prev.sessionId : undefined   // resume ONLY if instructions unchanged
      if (prev && prev.promptVersion !== ver) console.log(`[ica] ${role}: instructions changed → fresh session`)
      builtWith = configStamp()
      agent = await create(resumeId); return agent   // NOT persisted here — see persist() note above
    })()
    return building
  }
  return {
    get, persist,
    session: () => agent?.session ?? null,
    newSession() {   // a fresh session on demand (the UI button), even if instructions are unchanged
      const s = agent?.session
      if (s?.reset) { s.reset(); persist() }                                 // harness resets in place — keep the warm agent
      else { try { s?.stop() } catch {}; agent = null; building = null; answers.clearAgentSession(PROJECT, role) }
      console.log(`[ica] ${role}: new session`)
    },
    async compact(h?: RunHandlers) { return (await get()).session.compact(h) },
    stop() { try { agent?.session.stop() } catch {} },
    // Fully tear DOWN: kill the underlying session/PTY AND drop the agent so its memory is freed and the next
    // get() spins up a fresh one. For a COLD one-shot agent (grounding), call this after its run so nothing lingers.
    dispose() { try { agent?.session.stop() } catch {}; agent = null; building = null },
  }
}
const analystSlot  = makeAgentSlot('analyst',  analystPromptVersion,  (resumeId) => listSources().then(sources => createAnalyst({ root: WORKSPACE_ROOT, projectId: PROJECT, sources, managerUrl: DATASOURCE, projectDir: PROJECT_DIR, ica: { resumeId } })), 'analyst')
// The COMPOSER (System 2), ONE PER SESSION: each chat session gets its own composer (a cheap opencode CLIENT
// session on the shared server, so N sessions ≈ free). Created on the session's first question, reused for the
// session; only the in-flight question needs memory. Idle sessions are disposed by the sweep below.
const composersBySession = new Map<string, { composer: Promise<Composer>; lastUsed: number; builtWith: string }>()
const composerStamp = () => { const c = agentConfig('composer'); return `${c.harness}/${c.provider}/${c.model}` }
function getComposer(sid: string): Promise<Composer> {
  let e = composersBySession.get(sid)
  // A composer built before a profile change is running the old harness and model. It is dropped at the next
  // question rather than the moment the change arrives, because the change can land mid-answer and killing a
  // composer that is halfway through a question loses the answer to make a setting current a minute sooner.
  // The chat keeps its history; only the agent behind it is new — which is what changing a model means anyway.
  const want = composerStamp()
  if (e && e.builtWith !== want) {
    console.log(`[ica] composer: profile changed (${e.builtWith} → ${want}) → fresh session for ${sid.slice(0, 8)}`)
    const old = e.composer
    composersBySession.delete(sid)
    old.then(c => { try { c.session.stop() } catch {} }).catch(() => {})
    e = undefined
  }
  if (!e) {
    e = { composer: createComposer({ root: WORKSPACE_ROOT, projectId: PROJECT, managerUrl: DATASOURCE, projectDir: PROJECT_DIR, sessionId: sid, ica: { baseUrl: OC_URL } }),
          lastUsed: Date.now(), builtWith: want }
    composersBySession.set(sid, e)
    console.log(`[ica] composer: new session ${sid.slice(0, 8)} (live composers: ${composersBySession.size})`)
  }
  e.lastUsed = Date.now()
  return e.composer
}
// Dispose a session's composer only after it has been genuinely idle this long — lastUsed is bumped on EVERY
// question for that session (see getComposer), so an active chat is never closed; a session that goes quiet for
// 60 min is torn down (freeing its opencode session), and the next question in it transparently wakes a fresh one.
const COMPOSER_IDLE_MS = Number(process.env.ICA_COMPOSER_IDLE_MS) || 60 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [sid, e] of composersBySession) {
    if (now - e.lastUsed < COMPOSER_IDLE_MS) continue
    composersBySession.delete(sid)
    e.composer.then(c => { try { c.session.stop() } catch {} }).catch(() => {})
    console.log(`[ica] composer: disposed idle session ${sid.slice(0, 8)} (live composers: ${composersBySession.size})`)
  }
}, 5 * 60 * 1000).unref?.()
const connectorSlot = makeAgentSlot('connector', connectorPromptVersion, (resumeId) => createConnector({ root: WORKSPACE_ROOT, projectId: PROJECT, managerUrl: DATASOURCE, datasourcesDir: DATASOURCES_DIR, ica: { resumeId } }), 'connector')
// COLD by design: never warmed at boot (below); spun up only when the admin triggers a grounding build.
const groundingSlot = makeAgentSlot('grounding', groundingPromptVersion, (resumeId) => listSources().then(sources => createGroundingAgent({ root: WORKSPACE_ROOT, projectId: PROJECT, sources, managerUrl: DATASOURCE, ica: { resumeId } })), 'grounding')
for (const line of describeConfig()) console.log(`[config] ${line}`)
// Live analyst state, kept so a (re)connecting client can RE-SYNC after a reload (the engine stores
// no history — this is just the current run + last result, replayed on demand).
let curQuestion = '', curSid = ''

// Outbound is RESILIENT to a brief hub flap: if the socket is momentarily down (reconnecting), queue the frame
// and flush it once we're re-registered — otherwise an answer/log emitted in a down window is lost forever and
// the user sees "engine went silent" with no answer. Bounded so a long outage can't grow memory without limit.
// (The 12s heartbeat uses hub.send directly, NOT this — a stale heartbeat is useless. Ticks DO queue, which is
// fine: a flushed tick simply re-arms the client watchdog, so a flap no longer trips a false "engine went silent".)
let outbox: string[] = []
const MAX_OUTBOX = 1000
// Every frame the engine puts on the wire goes through here, and `t` must be a type the protocol knows about.
// clients/protocol.ts calls itself the single canonical description of this wire, but nothing imported it, so it
// drifted: it still described analyst:status/stream/category/progress/done long after those became agent:*.
// A type-only import costs nothing at runtime and turns that drift into a compile error.
const emit = (to: any, msg: { t: EngineMsgType; [k: string]: unknown }) => {
  const frame = JSON.stringify({ to, payload: msg })
  if (hub?.readyState === WebSocket.OPEN) hub.send(frame)
  else { outbox.push(frame); if (outbox.length > MAX_OUTBOX) outbox.shift() }
}
function flushOutbox() {
  if (!outbox.length || hub?.readyState !== WebSocket.OPEN) return
  const pending = outbox; outbox = []
  for (const frame of pending) { try { hub!.send(frame) } catch { /* socket died mid-flush; the rest waits for the next reconnect */ } }
}

/** Does this answer match the shape the UI actually renders? Returns what is wrong, or '' if it is fine.
 *
 *  The renderer reads `headline.display`, `figures[]`, `table.columns/rows`, `sections[]`, `caveat`. An agent
 *  that writes `headline` as a STRING gets none of that: the card draws nothing, or stringifies an object and
 *  shows "[object Object]". That is not hypothetical — it reached a user, because nothing between the agent
 *  and the screen ever checked, and the answer was stored in the database in that state too.
 *
 *  Deliberately narrow: it flags shapes that CANNOT render, not answers it dislikes. A quiet answer is fine;
 *  an unrenderable one is a bug, and it should say so rather than reach the screen. */

// A NARRATION BEAT, SENT SO A RECONNECT CANNOT LOSE IT.
//
// `reply` is the wsId of the socket that asked. It is the right address until the browser reconnects — then
// every beat, and the answer, keep going to a socket that no longer exists. That is why a user watching a
// healthy ten-minute turn saw an empty analysis card: the beats were produced, logged, and addressed to a
// dead client. Agent LOG rows never had this problem because they travel by CHANNEL, which the DO fans to the
// question's OWNER rather than to one connection.
//
// So beats go both ways: to `reply` (still the fast path for the asking tab) and to the owner-scoped channel
// (which survives reconnects). The client dedupes on qid+text.
const emitBeat = (reply: any, text: string, qid: string, sid: string) => {
  console.log(`[beat] ${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`)
  if (reply) emit(reply, { t: 'narration', text, qid, sid })
  emit({ type: 'log', channel: 'narration' }, { t: 'narration', text, qid, sid })
}

/** Did this command go and GET something — a query, an introspection, a program run — as opposed to shuffling
 *  files about? Only the first kind is worth narrating: it produces findings, where reading a file produces
 *  machinery the narrator is meant to hide.
 *
 *  Matched on what the command DOES, never on how a harness spells it. The previous test was
 *  `/\b(tsx|node|run\.mjs|query\.mjs|program\.ts)\b/`, which described opencode's and claude's command lines.
 *  pi wraps everything as `bash ./query …` and `read …`, so nothing matched, the narrator was fed nothing, and
 *  a turn that was working produced no narration at all — a harness change silently removing a feature.
 *
 *  pi also emits assistant prose only when the turn ENDS, so on that harness these results are the only live
 *  signal there is. */
export function isDataCall(command?: string): boolean {
  const c = String(command ?? '').toLowerCase()
  if (!c) return false
  if (/^\s*(bash\s+)?(read|ls|cat|head|tail|grep|find|write|edit|mkdir|touch|rm|mv|cp)\b/.test(c)) return false
  return /\b(query|introspect|resolve|find-schema|sources|try|ask|members|find|catalog)\b/.test(c)
}

// ── Agent-lane protocol ──────────────────────────────────────────────────────
// ONE wire vocabulary for EVERY agent lane (composer, analyst — and any future autonomous agent). A lane is an
// observable work stream; the UI is a generic consumer that hardcodes no agent. Frames:
//   agent:hello  {lane, label, hue, streamKind, pty, interactive, controls} — the lane announces what it IS
//   agent:event  {lane, ev}          — one work atom (ev.kind: command|message|reasoning|file|turn|user|segment)
//   agent:events {lane, events}      — full replay on reconnect
//   agent:status {lane, text?|category?|progress?|state?} — the live "what it's doing" line + lifecycle
// The raw-terminal byte stream (`analyst:chunk`) and the user-facing product (`narration`, `session:step`) are
// different protocols and keep their names.
const A = (verb: 'hello' | 'event' | 'events' | 'status' | 'chunk', lane: string, body: Record<string, any> = {}) =>
  ({ t: `agent:${verb}` as EngineMsgType, lane, ...body })

// ── A QUESTION, ANSWERED AS A STEP OF THE PERSON'S DATA SESSION ─────────────────────────────────────────────
//
// Each conversation has two sessions side by side: the agent's (the harness transcript, one per conversation) and
// the data session (packages/graph, session.ts) — the states the person's questions have become, each with its
// answer. A turn goes to the composer, which turns what was said into a message and applies it to the data session
// with ./ask; it defines whatever program the message needs first, or hands the question to the analyst with
// ./escalate. The turn ends when a step has been applied, and the engine delivers that step.
async function analyse(question: string, from: any, sid = '', qidIn = '', channel = '') {
  if (busySessions.has(sid)) {
    emit(from, A('status', 'analyst', { text: 'Already answering a question in this chat — one at a time.', sid })); return
  }
  if (!question.trim()) return
  busySessions.add(sid)
  const reply = from
  // LIVENESS, FROM THE FIRST MOMENT: the UI's watchdog re-arms on any message, so a tick covers the silences.
  let keepalive: ReturnType<typeof setInterval> | null = setInterval(() => { if (reply) emit(reply, { t: 'tick', sid }) }, 8000)
  const qid = qidIn || genId()
  curQuestion = question; curSid = sid
  const t0 = Date.now()
  let narrator = null as Narrator | null
  let narrationTimer: ReturnType<typeof setInterval> | null = null
  let stopped: string | null = null
  let stopSession: (() => void) | null = null
  let workingAgent = 'engine'
  const stopThisTurn = (why: string) => {
    if (stopped) return
    stopped = why
    console.log(`[ica] STOP requested for ${qid.slice(0, 8)} (${workingAgent}) — ${why}`)
    try { narrator?.stop() } catch { /* best-effort */ }
    if (narrationTimer) { clearInterval(narrationTimer); narrationTimer = null }
    try { stopSession?.() } catch { /* best-effort */ }
    emit(reply, A('status', 'analyst', { text: 'Stopped.', sid, qid }))
    emit(reply, { t: 'session:step', sid, qid, stopped: why, timing: { ms: Date.now() - t0 } })
  }
  inflight.set(sid, { qid, stop: stopThisTurn })

  const narrationBuf: string[] = []
  let narrating = false
  let lastDoing = ''
  const saidBeats: string[] = []
  try {
    // The person's data session is this conversation's: the same id as the harness session.
    const graph = await getGraph()
    graph.sessions.open({ id: sid, who: from?.userId ? { id: from.userId } : undefined })

    const analyst = await analystSlot.get()
    emit(reply, A('hello', 'composer', { label: 'Composer', hue: '#4a90d9', streamKind: 'events', pty: false, interactive: false, sid }))
    emit(reply, A('hello', 'analyst', { label: 'Analyst', hue: '#c08a2b', streamKind: analyst.session.events ? 'events' : (analyst.session.kind ?? 'events'), pty: analyst.session.kind === 'pty', interactive: true, controls: ['terminal', 'compact', 'new'], sid }))
    emitBeat(reply, 'Looking into your question…', qid, sid)

    narrator = createNarrator({ cwd: WORKSPACE })
    narrationTimer = setInterval(async () => {
      if (stopped || narrating || !reply || narrationBuf.length === 0) return
      narrating = true
      const activity = narrationBuf.splice(0).join('\n')
      try {
        const line = await Promise.race([narrator!.narrate(question, activity, saidBeats.slice(-3)), new Promise<null>((res) => setTimeout(() => res(null), 20000))])
        if (line) {
          saidBeats.push(line)
          emitBeat(reply, line, qid, sid)
          if (channel) emit({ type: 'channel' }, { t: 'channel:narration', channel, qid, text: line })
        }
      } catch { /* narration is best-effort */ } finally { narrating = false }
    }, 4000)

    let currentAgent: 'composer' | 'analyst' = 'composer'
    const stepStarted = new Map<string, number>()
    const emitLog = (msg: any) => emit({ type: 'log', channel: currentAgent === 'composer' ? 'composer-log' : 'analyst-log' }, { ...msg, qid, sid, agent: currentAgent })
    for (const lane of ['composer-log', 'analyst-log'])
      emit({ type: 'log', channel: lane }, A('event', lane === 'composer-log' ? 'composer' : 'analyst', { ev: { kind: 'user', id: qid, text: question, done: true }, qid, sid }))
    const handlers: RunHandlers = {
      onOutput: (chunk: string) => emitLog({ t: 'analyst:chunk', text: chunk }),
      onNarration: (text: string) => { if (reply) emitBeat(reply, text, qid, sid) },
      onEvent: (ev: AgentEvent) => {
        ev.at ??= Date.now()
        if (ev.kind === 'command' && ev.id) {
          if (ev.done || ev.status === 'completed' || ev.status === 'failed') {
            const startedAt = stepStarted.get(ev.id)
            if (startedAt !== undefined) { ev.ms ??= ev.at - startedAt; stepStarted.delete(ev.id) }
          } else if (!stepStarted.has(ev.id)) stepStarted.set(ev.id, ev.at)
        }
        emitLog(A('event', currentAgent, { ev }))
        if (ev.kind === 'message' && ev.text?.trim()) { const prose = stripCode(ev.text); if (prose) narrationBuf.push(prose.slice(0, 600)) }
        else if (ev.kind === 'command') {
          const cmd = ev.command?.trim().replace(/\s+/g, ' ')
          if (cmd && cmd !== lastDoing) { lastDoing = cmd; narrationBuf.push(('DOING: ' + cmd).slice(0, 200)) }
          if (ev.output?.trim() && isDataCall(ev.command)) narrationBuf.push(('RESULT: ' + capResultData(ev.output)).slice(0, 1800))
        }
      },
    }

    // A last-resort cap, so a wedged agent cannot hold the conversation's lock for good.
    const MAX_TURN_MS = Number(process.env.ANALYST_MAX_TURN_MS) || 30 * 60 * 1000
    const capped = async <T,>(p: Promise<T>, onTimeout: () => T): Promise<T> => {
      p.catch(() => {})
      let timer: ReturnType<typeof setTimeout> | undefined
      const TIMED_OUT = Symbol('timeout')
      const r = await Promise.race([p, new Promise<typeof TIMED_OUT>((res) => { timer = setTimeout(() => res(TIMED_OUT), MAX_TURN_MS) })])
      if (timer) clearTimeout(timer)
      return r === TIMED_OUT ? onTimeout() : (r as T)
    }

    const composer = await getComposer(sid)
    workingAgent = 'composer'; stopSession = () => { try { (composer as any).session?.reset?.() } catch { /* best-effort */ } }
    let done = await capped(composer.ask(question, handlers, { qid, sessionId: sid }), () => {
      try { (composer as any).session?.reset?.() } catch { /* best-effort */ }
      return { escalate: { reason: 'the composer did not finish in time' }, ms: Date.now() - t0 }
    })
    if (!stopped && done.escalate) {
      console.log(`[ica] composer → escalate · ${done.escalate.reason}`)
      currentAgent = 'analyst'; workingAgent = 'analyst'
      emit(reply, A('status', 'analyst', { progress: 'Handing off to the analyst for deeper analysis…', sid }))
      stopSession = () => { try { (analyst as any).session?.reset?.() } catch { /* best-effort */ } }
      done = await capped(analyst.ask(question, handlers, { qid, sessionId: sid, reason: done.escalate.reason }), () => {
        try { (analyst as any).session?.reset?.() } catch { /* best-effort */ }
        return { escalate: { reason: 'the analyst did not finish in time' }, ms: Date.now() - t0 }
      })
    }
    if (stopped) { console.log(`[ica] ${qid.slice(0, 8)} stopped after ${((Date.now() - t0) / 1000).toFixed(1)}s`); return }

    const timing = { ms: Date.now() - t0 }
    if (!done.step) {
      const why = done.escalate?.reason ?? 'no step was applied'
      emit(reply, { t: 'session:step', sid, qid, error: `This question was not answered: ${why}`, timing })
      return
    }
    // THE STEP AS THE DATA SESSION HOLDS IT — never as the agent described it.
    const step = graph.sessions.history(sid).steps.find((s) => s.id === done.step)
    const call = step?.callId ? graph.store.getCall(step.callId) : null
    const delivered = {
      t: 'session:step' as const, sid, qid, step: step?.id, parent: step?.parent ?? null, message: step?.message, state: step?.state,
      answer: call?.output ?? null, caveats: call?.caveats ?? [], ...(step?.error ? { error: step.error } : {}), timing, by: workingAgent,
    }
    emit(reply, delivered)
    console.log(`[ica] ${workingAgent} · step ${step?.id} · ${(timing.ms / 1000).toFixed(1)}s${step?.error ? ` · ${step.error.slice(0, 120)}` : ''}`)
  } catch (e: any) {
    emit(reply, { t: 'session:step', sid, qid, error: `Failed: ${e?.message ?? e}`, timing: { ms: Date.now() - t0 } })
  } finally {
    if (keepalive) { clearInterval(keepalive); keepalive = null }
    if (narrationTimer) { clearInterval(narrationTimer); narrationTimer = null }
    try { narrator?.stop() } catch { /* best-effort */ }
    curQuestion = ''
    emit(reply, A('status', 'analyst', { state: 'done', sid }))
    analystSlot.persist()
    busySessions.delete(sid)
    if (inflight.get(sid)?.qid === qid) inflight.delete(sid)
  }
}

async function listSources(): Promise<string[]> {
  try { const r = await fetch(`${DATASOURCE}/sources`); const j: any = await r.json(); return (j.sources || []).map((s: any) => s.id) }
  catch { return [] }
}

// The admin's GROUNDING agent — a COLD claude-code session (spun up on demand, never warmed) that builds
// this project's value→id resolution indexes. Streamed RAW (PTY) to the admin's xterm, same machinery as the
// modeler/connector. It reads data via the seam and persists via build(config) on grounding.mjs; it never
// answers user questions and never touches the semantic model.
// ── DATASOURCE INDEX — admin-triggered ──────────────────────────────────────
// The index (what tables and fields each source has) used to be a manual CLI run on the box, which meant a new
// project could not be made useful without someone with shell access. Same builder, driven from the console,
// streaming its progress back so the admin can watch rather than guess. Resumable: re-running continues.
async function handleIndexBuild(from: any, opts: { rebuild?: boolean; only?: string }) {
  if (indexBusy) { emit(from, { t: 'index:status', text: 'An index build is already running.' }); return }
  indexBusy = true
  const t0 = Date.now()
  try {
    // Per-project seed tables, when the project ships them (a source with no catalog to enumerate).
    let seedTables: Record<string, string[]> = {}
    try { seedTables = JSON.parse(readFileSync(join(PROJECT_DIR, 'datasources', 'index-seeds.json'), 'utf8')) }
    catch { /* none — the source's own catalog is enough */ }
    emit(from, { t: 'index:status', text: `Building the datasource index${opts.only ? ` for ${opts.only}` : ''}${opts.rebuild ? ' (from empty)' : ' (resuming)'}…` })
    const r = await buildDatasourceIndex({
      store: indexStore, managerUrl: DATASOURCE, seedTables, only: opts.only, wipe: !!opts.rebuild,
      log: (line) => emit(from, { t: 'index:line', text: line }),
    })
    const total = r.sources.reduce((n, x) => n + x.fields, 0)
    emit(from, { t: 'index:done', ok: true, sources: r.sources, totals: r.totals, ms: Date.now() - t0 })
    console.log(`[ica] datasource index built in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${total} fields across ${r.sources.length} source(s)`)
  } catch (e: any) {
    emit(from, { t: 'index:done', ok: false, error: e?.message ?? String(e), ms: Date.now() - t0 })
    console.warn(`[ica] datasource index build failed: ${e?.message ?? e}`)
  } finally { indexBusy = false }
}

async function handleGrounding(from: any, rebuild = false) {
  if (groundingBusy) { emit(from, { t: 'grounding:status', text: 'Grounding build already running.' }); return }
  groundingBusy = true
  // EXPLICIT clean rebuild only: wipe the grounding DB so the agent starts empty. A normal build is ADDITIVE
  // (upsert-on-top, never destructive) — this deliberate reset is the one place a wipe happens. Safe here because
  // the grounding agent is COLD (no store open between builds).
  if (rebuild) {
    const db = join(DB_DIR, 'grounding.sqlite')
    for (const f of [db, `${db}-wal`, `${db}-shm`]) { try { rmSync(f) } catch { /* not there */ } }
    emit(from, { t: 'grounding:status', text: 'Cleared existing grounding — rebuilding from empty.' })
  }
  const sources = await listSources()
  emit(from, { t: 'grounding:status', text: `Building grounding indexes — sources: ${sources.join(', ') || '(none)'}` })
  try {
    const grounding = await groundingSlot.get()
    announceKind('grounding', from, grounding)   // real session kind (grounding may be codex now, not always pty)
    const r = await grounding.build(agentStream('grounding', from))
    emit(from, { t: 'grounding:done', summary: r.note })
    console.log(`[ica] grounding build done in ${(r.ms / 1000).toFixed(1)}s`)
  } catch (e: any) {
    emit(from, { t: 'grounding:status', text: `Grounding build failed: ${e?.message ?? e}` })
  } finally {
    // COLD agent: once the build is done, tear the ICA all the way down — kill its claude-code PTY and drop
    // the session so it holds no memory. It is never resumed; a future build spins up a fresh one.
    groundingSlot.dispose(); groundingBusy = false
    log.info('grounding', 'build finished — grounding agent torn down (PTY closed, memory freed)')
  }
}

// The admin's CONNECTOR agent — a claude-code session streamed RAW (PTY) to the admin's xterm (no
// narration; the admin just watches it work). Same ICA machinery as analyst/modeler. The session persists,
// so the admin's follow-up replies continue the same conversation.
async function handleConnector(text: string, from: any) {
  if (!text.trim()) return
  if (connectorBusy) { emit(from, { t: 'connector:status', text: 'The connector is busy — one message at a time.' }); return }
  connectorBusy = true
  emit(from, { t: 'connector:status', text: 'Working…' })
  try {
    const connector = await connectorSlot.get()
    announceKind('connector', from, connector)   // real session kind: 'pty' (claude) or 'events' (codex)
    const r = await connector.ask(text, agentStream('connector', from))
    console.log(`[ica] connector · ${(r.ms / 1000).toFixed(1)}s`)
  } catch (e: any) {
    emit(from, { t: 'connector:status', text: `Connector failed: ${e?.message ?? e}` })
  } finally { connectorSlot.persist(); connectorBusy = false; emit(from, { t: 'connector:done' }) }
}

// ── Interactive terminal passthrough (raw PTY <-> UI xterm) ───────────────────
// Any UI can open a LIVE, TYPEABLE terminal into a claude agent's PTY (analyst + modeler in the user UI,
// connector in the admin). This is how a user runs `/login` straight from the browser xterm — no SSH, and
// copy/paste just works. attach = replay the current screen + stream every byte; input = raw keystrokes/paste
// back to the PTY. claude auth is SHARED across all three agents (one $HOME on the volume), so a login in any
// one authenticates them all. To avoid double output, the raw stream is emitted only while the agent is IDLE
// — during a run the existing per-run stream already feeds the asker.
type Which = 'analyst' | 'connector' | 'grounding'
const normWhich = (w: any): Which => (w === 'connector' ? 'connector' : w === 'grounding' ? 'grounding' : 'analyst')
const slotFor = (w: Which) => (w === 'connector' ? connectorSlot : w === 'grounding' ? groundingSlot : analystSlot)
const termChunkT = (w: Which) => (w === 'connector' ? 'connector:chunk' : w === 'grounding' ? 'grounding:chunk' : 'analyst:chunk')

// Standard streaming for the from-based agent flows (semantic/connector/grounding): forward BOTH the harness's
// text chunks (the pty view) AND its structured events (the codex/events view) to the requester, tagged by agent.
// The console renders per the kind we announce with `<w>:stream` — which is the SESSION's real kind, so a codex
// agent gets the event view and a claude agent gets the terminal, with no per-flow hardcoding.
// One vocabulary for every agent's STRUCTURED work, admin console included: the lane frames, keyed by `lane`.
// Raw terminal BYTES keep their own `<agent>:chunk` type — a byte stream for an xterm is a different thing from
// a structured event, and the analyst's is read by the user app too.
const agentStream = (w: Which, from: any): RunHandlers => ({
  onOutput: (chunk) => emit(from, { t: `${w}:chunk` as EngineMsgType, text: chunk }),
  onEvent: (ev) => emit(from, A('event', w, { ev })),
})
const announceKind = (w: Which, from: any, agent: any) =>
  emit(from, A('hello', w, { streamKind: agent?.session?.kind ?? 'events', pty: agent?.session?.kind === 'pty' }))
const isAgentBusy = (w: Which) => (w === 'connector' ? connectorBusy : w === 'grounding' ? groundingBusy : busySessions.size > 0)
const termViewers: Record<Which, Set<any>> = { analyst: new Set(), connector: new Set(), grounding: new Set() }
const termUnsub: Record<Which, (() => void) | null> = { analyst: null, connector: null, grounding: null }
async function attachTerminal(w: Which, from: any) {
  termViewers[w].add(from)
  const agent = await slotFor(w).get()
  const t = termChunkT(w)
  const kind = agent.session.kind ?? 'events'
  emit(from, { t: 'term:stream', which: w, kind })                          // the REAL kind (was hardcoded 'pty')
  if (kind === 'events') {
    // codex/SDK: replay the structured EVENT LOG (the last turns' work) — the text buffer + raw byte passthrough
    // don't apply. So a reload shows the previous events, just like claude's screen replay below.
    const evs = agent.session.events?.() ?? []
    if (evs.length) emit(from, A('events', w, { events: evs, replace: true }))
    return
  }
  emit(from, { t, text: agent.session.buffer?.() ?? '', replace: true })    // claude (pty): replay the current screen (incl. any login prompt)
  if (!termUnsub[w] && agent.session.onRaw) {
    termUnsub[w] = agent.session.onRaw((d: string) => {
      if (isAgentBusy(w)) return                                             // during a run, the per-run stream already feeds output
      for (const v of termViewers[w]) emit(v, { t, text: d })
    })
  }
}
function inputTerminal(w: Which, data: string) {
  if (!data) return
  void slotFor(w).get().then(a => a.session.input?.(data)).catch(() => {})
}

// A client (re)connected (e.g. after reload). Replay the live analyst state so it doesn't see a blank
// screen while the run continues server-side: the terminal buffer, and either the in-flight run
// (re-targeted to this connection) or the last completed answer.
// `full` (a real reconnect, analyst:sync) repaints the whole event log; a plain sessions:list is just a SIDEBAR
// refresh (e.g. after each answer) and must NOT replay events — that full-replace carries the harness transcript,
// which has no question dividers, so it would wipe the UI-synthesized [data-qlog] markers the log-nav depends on.
function resyncAnalyst(from: any, full = false) {
  emit(from, { t: 'sessions:res', sessions: [] })   // UI keeps its own chat list (localStorage); this is just the ack
  const aSession = analystSlot.session()
  if (!aSession) return
  const kind = aSession.events ? 'events' : (aSession.kind ?? 'events')
  if (full) {
    emit(from, A('hello', 'analyst', { label: 'Analyst', hue: '#c08a2b', streamKind: kind, pty: aSession.kind === 'pty', interactive: true, controls: ['terminal', 'compact', 'new'] }))
    // Repaint the STRUCTURED event log by default (claude + codex); the raw PTY screen is replayed only when the
    // client explicitly opens the terminal (term:attach), so PTY bytes never reach a client that didn't ask.
    if (aSession.events) {
      const evs = aSession.events()
      if (evs.length) emit(from, A('events', 'analyst', { events: evs, replace: true }))
    } else {
      const buf = aSession.buffer()
      if (buf) emit(from, { t: 'analyst:chunk', text: buf, replace: true })
    }
  }
  if (busySessions.size > 0) {
    // No reply re-target under per-session concurrency (that would steal another session's live stream). A
    // reconnecting client recovers a missed step from the durable ProjectDO buffer instead.
    emit(from, A('status', 'analyst', { text: 'Answering…', question: curQuestion, sid: curSid }))
  }
}

async function handle(payload: any, from: any) {
  if (payload.t === 'analyse') { analyse(String(payload.question || ''), from, String(payload.sessionId || ''), String(payload.questionId || ''), String(payload.channel || '')) }   // UI supplies both ids; channel set for chat-channel turns
  else if (payload.t === 'index:build') { handleIndexBuild(from, { rebuild: !!payload.rebuild, only: payload.only ? String(payload.only) : undefined }) }   // admin console → build/refresh the datasource index
  else if (payload.t === 'grounding:build') { handleGrounding(from, !!payload.rebuild) }        // admin console → grounding agent builds (rebuild:true = wipe first, else additive)
  else if (payload.t === 'connector:ask') { handleConnector(String(payload.text || ''), from) }   // admin console → connector agent (raw PTY back)
  else if (payload.t === 'term:attach') { attachTerminal(normWhich(payload.which), from) }         // open a live typeable terminal into an agent's PTY (e.g. /login)
  else if (payload.t === 'term:detach') { termViewers[normWhich(payload.which)]?.delete(from) }    // UI switched away from the raw terminal → stop streaming PTY bytes to it
  else if (payload.t === 'term:input')  { inputTerminal(normWhich(payload.which), String(payload.data ?? '')) }   // raw keystrokes/paste → the agent's PTY
  // ── Admin INSPECTOR (read-only) ─────────────────────────────────────────────
  // One request type, many views (see inspect.ts). reqId is echoed back so the admin UI can have
  // several panels in flight on the ONE shared project socket without confusing the replies.
  else if (payload.t === 'inspect:req') {
    inspector.handle(payload).then((res) => emit(from, { t: 'inspect:res', reqId: payload.reqId, view: payload.view ?? 'overview', ...res }))
  }
  // STOP the turn running in this session. Deliberately not scoped to a qid: the person is looking at one chat
  // and wants what is happening in it to stop, and by the time the message arrives the turn may have moved from
  // the composer to the analyst. Answering `stopped:false` when nothing was running is information, not an error.
  else if (payload.t === 'turn:stop') {
    const sid = String(payload.sessionId || '')
    const did = stopTurn(sid, String(payload.reason || 'the user stopped it'))
    emit(from, { t: 'turn:stopped', sessionId: sid, stopped: did })
  }
  else if (payload.t === 'analyst:sync') { resyncAnalyst(from, true) }   // real (re)connect → full replay of the live analyst log
  else if (payload.t === 'sessions:list') { resyncAnalyst(from, false) }   // sidebar refresh only → NO event replay (keeps the question dividers)
  else if (payload.t === 'session:load') { emit(from, { t: 'session:load:res', items: [] }) }
  else if (payload.t === 'suggestions:req') { emit(from, { t: 'suggestions:res', suggestions: { groups: [] } }) }
  else if (payload.t === 'ui:resize') {   // UI fitted its terminal → resize the matching agent's PTY (claude-code)
    const slot = slotFor(normWhich(payload.which))
    slot.session()?.resize?.(Number(payload.cols) || 120, Number(payload.rows) || 40)
  }
  else if (payload.t === 'session:new') {   // UI button → fresh session for the analyst (drop resume + history)
    analystSlot.newSession(); emit(from, { t: 'session:reset', role: 'analyst' })
  }
  else if (payload.t === 'session:compact') {   // UI button → compact (shrink context) of the analyst's session
    emit(from, A('status', 'analyst', { text: 'Compacting context…' }))
    analystSlot.compact({ onOutput: (chunk) => emit(from, { t: 'analyst:chunk', text: chunk }) })
      .then(() => emit(from, A('status', 'analyst', { text: 'Compacted ✓' })))
      .catch((e: any) => emit(from, A('status', 'analyst', { text: `Compact failed: ${e?.message ?? e}` })))
  }
  else if (payload.t === 'suggest') { /* as-you-type — later (fast-router) */ }
}

// Boot self-check: PROVE the engine is operational (store writable + read-back, workspace present, data
// seam reachable) before we tell the hub we're ready. This is what "engine ready" in the DO can trust —
// a socket being open is not the same as the engine being able to actually answer.
async function selfCheck(): Promise<{ ok: boolean; detail: string }> {
  try {
    indexStore.putNode({ id: 'meta:self-check', kind: 'meta', label: 'self-check', props: { at: Date.now() } })
    if (!indexStore.getNode('meta:self-check')) return { ok: false, detail: 'store read-back failed' }
    if (!existsSync(WORKSPACE)) return { ok: false, detail: `workspace missing: ${WORKSPACE}` }
    let sources: number | string = 'starting'
    try { const r = await fetch(`${DATASOURCE}/sources`, { signal: AbortSignal.timeout(4000) }); sources = (((await r.json()) as { sources?: unknown[] })?.sources ?? []).length } catch { /* manager may still be warming — not fatal */ }
    return { ok: true, detail: `stores ok · workspace ok · datasources=${sources}` }
  } catch (e: any) { return { ok: false, detail: e?.message ?? String(e) } }
}

let reconnectDelay = 1000
function connect() {
  const url = `${HUB}/_ws/${encodeURIComponent(PROJECT)}?key=${encodeURIComponent(KEY)}`
  // THE KEY NEVER GOES IN THE LOG. It is in the query string because that is the only channel a WebSocket
  // handshake gives us, but `docker logs` is read by anyone who can reach the host, and this key is what
  // authenticates the vault handout for this project — printing it puts every pooled provider credential one
  // `docker logs` away. Log the destination, never the credential.
  console.log(`[ica] connecting to hub ${HUB}/_ws/${PROJECT} as code-engine (no ports opened)`)
  const ws = new WebSocket(url)
  hub = ws
  // KEEPALIVE. An idle WebSocket is closed at the edge, and this one is idle most of the time — the engine
  // speaks when there is a question and is silent in between. The symptom is a clean register followed by a
  // 1006 about half a minute later, forever. Not cosmetic: every reconnect re-announces presence, and anything
  // in flight is riding a socket that keeps going away underneath it.
  //
  // A literal `ping`, because the Durable Object registers it as an AUTO-RESPONSE pair — Cloudflare answers
  // `pong` at the edge and never wakes the DO, so staying connected costs no compute. The reply is not JSON
  // and the message handler already drops anything that will not parse.
  // ── IS THIS SOCKET STILL ALIVE, or only still OPEN? ────────────────────────────────────────────────────
  // readyState is not liveness. A machine that is SUSPENDED and resumed comes back with a socket object that
  // still reads OPEN while its TCP connection died during the freeze — so the keepalive writes `ping` into a
  // dead pipe, which buffers rather than throwing, and TCP can take many minutes to admit it. The engine sits
  // there mute: the hub has already dropped it, a user's question is queued against an engine that will never
  // collect it, and nothing in the log says anything is wrong.
  //
  // That is not hypothetical — it is exactly what an idle-suspend does to this process, which is the normal
  // lifecycle of a Fly box. The datasource bridge noticed its own socket within 40s and reconnected; the hub
  // connection did not, because it had nothing that could tell OPEN from alive.
  //
  // So we require an ANSWER. The hub registers ping→pong as an edge auto-response, so a live connection always
  // replies without waking the Durable Object. Nothing inbound for three missed beats means the socket is
  // gone whatever it claims, and we drop it ourselves rather than wait for TCP.
  const DEAD_AFTER_MS = 45_000
  let lastInbound = Date.now()
  let beat: ReturnType<typeof setInterval> | null = null
  const stopBeat = () => { if (beat) { clearInterval(beat); beat = null } }
  ws.on('open', () => {
    reconnectDelay = 1000   // stable connection → reset backoff
    stopBeat()
    lastInbound = Date.now()
    beat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastInbound > DEAD_AFTER_MS) {
        console.log(`[ica] hub silent for ${Math.round((Date.now() - lastInbound) / 1000)}s — treating the socket as dead and reconnecting`)
        stopBeat()
        // terminate(), not close(): a close handshake needs the peer to answer, and the whole point is that it
        // cannot. terminate() drops it locally and fires 'close', which reconnects.
        try { (ws as any).terminate?.() ?? ws.close() } catch { /* already gone */ }
        return
      }
      try { ws.send('ping') } catch { /* the close handler reconnects */ }
    }, 12_000)
    beat.unref?.()
    // machineId lets the hub self-heal which Fly machine it tracks (survives recreate/resize). Fly injects
    // FLY_MACHINE_ID automatically; undefined off-Fly (EC2/Docker) so it's simply omitted there.
    ws.send(JSON.stringify({ type: 'hello', key: KEY, role: 'code-engine', instanceId: INSTANCE_ID, epoch: EPOCH, machineId: process.env.FLY_MACHINE_ID }))
  })
  ws.on('message', async (raw) => {
    // ANY inbound byte proves the connection is alive — including the bare `pong` the edge sends back, which
    // is not JSON and is dropped below.
    lastInbound = Date.now()
    let m: any; try { m = JSON.parse(raw.toString()) } catch { return }
    const t = m.payload?.t
    if (t === 'welcome') {
      console.log(`[ica] registered (${m.payload.wsId}) — running self-check…`)
      flushOutbox()   // re-registered → deliver anything queued while the socket was flapping (answers, logs)
      // THE PROJECT'S PROFILE, delivered with the welcome. Adopted before warm-up builds any agent, so a box
      // starts on its own configuration rather than adopting it a few seconds late and rebuilding.
      if (m.payload.profile) receive(m.payload.profile, 'project profile')
      reportConfig(ws)
      settleProfile()
      // Only claim READY after the self-check passes. The hub/DO can trust this signal to mean the engine
      // can actually answer, not merely that a socket is open.
      selfCheck().then((res) => {
        if (ws !== hub || ws.readyState !== WebSocket.OPEN) return
        if (res.ok) { console.log(`[ica] READY — ${res.detail}`); ws.send(JSON.stringify({ type: 'ready', instanceId: INSTANCE_ID, epoch: EPOCH, detail: res.detail })) }
        else { console.error(`[ica] NOT READY — self-check failed: ${res.detail}`); ws.send(JSON.stringify({ type: 'not_ready', instanceId: INSTANCE_ID, detail: res.detail })) }
      })
      return
    }
    // A CHANGE PUSHED WHILE WE RUN. Adopted for the next session each agent builds — a turn already in flight
    // keeps the session it started on, because interrupting a running question to change a model is a worse
    // failure than applying the change a minute later.
    if (t === 'config:update') {
      const r = receive(m.payload.profile, `project profile v${m.payload.version}`)
      if (r.ok) {
        // The TABLE, not just a version number. A change arriving while the box runs is exactly when someone
        // needs to see what it changed to, and the version alone sends them to a database to find out.
        console.log(`[config] adopted v${m.payload.version} — agents rebuild on their next session`)
        for (const line of describeConfig()) console.log(`[config] ${line}`)
      }
      reportConfig(ws)
      return
    }
    if (t === 'fenced')     { console.log('[ica] fenced — a newer engine holds this role (obsolete instance)'); return }
    if (t === 'superseded') { console.log('[ica] superseded by our own reconnection'); return }
    if (t === 'evicted')    { console.log('[ica] evicted — a newer connection took the role'); return }
    if (m.payload) await handle(m.payload, m.from)
  })
  ws.on('close', (code: number) => {
    stopBeat()
    if (ws !== hub) return                       // a stale/superseded socket closed — ignore, we already moved on
    if (code === 4006) { console.log('[ica] fenced by a newer engine — not reconnecting'); return }   // don't fight
    const delay = Math.min(reconnectDelay, 30000) + Math.floor(Math.random() * 1000)   // backoff + jitter
    console.log(`[ica] hub disconnected (${code}) — retrying in ${delay}ms`)
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    setTimeout(connect, delay)
  })
  ws.on('error', (e) => console.error('[ica] hub error:', (e as Error).message))
}

// Heartbeat: the DO drops its in-memory role registry when it hibernates. A heartbeat keeps
// it warm so this engine STAYS the registered code-engine (else the UI shows "Starting machine…").
setInterval(() => { if (hub?.readyState === WebSocket.OPEN) hub.send(JSON.stringify({ type: 'heartbeat', busy: busySessions.size > 0 })) }, 12000)
// ── Eager agent warm-up ───────────────────────────────────────────────────────
// The ESSENTIAL agents are pre-spawned at boot, not lazily on the first question. On a Fly VM that
// suspends/resumes to save money, a lazily-spawned claude costs ~10-15s on the FIRST question after a
// cold resume; warming here pays that once, at boot, so questions are always fast. (With Fly *suspend* =
// memory snapshot, warm agents even survive the suspend/resume — no re-spawn.) Only these four are warmed:
// analyst (answers), connector (data sources), modeler (consolidation), reflex (front door). Other
// agents stay on-demand. Fire-and-forget + per-agent logs so they're visible in the boot log; failures are
// non-fatal (the agent just falls back to lazy spawn on first use).
// One turn on a disposable claude session, purely to prove the box's credential authenticates. Throws on
// failure so the readiness banner shows it, and names the specific "not logged in" case: that string is what
// a stripped or expired credential looks like from the outside, and reading it as a broken agent has cost
// real hours before.
async function verifyBoxCredential(): Promise<void> {
  const probe = createSession('claude-code-pty', { cwd: WORKSPACE, model: 'claude-haiku-4-5' })
  try {
    const r = await probe.run('Reply with exactly: OK')
    const text = (r?.lastLines ?? '').trim()
    if (/not logged in|please run \/login|login expired|invalid api key/i.test(text)) {
      throw new Error('credential rejected — the agent reports it is not logged in')
    }
    if (!text) throw new Error('no reply — could not confirm the credential works')
  } finally { try { probe.stop() } catch { /* nothing to clean up if it never started */ } }
}

let warmed = false
async function warmEssentialAgents() {
  // BEFORE any agent is spawned. A credential that arrives after the agent has started is a credential the
  // agent never sees — it inherits this process's environment once, at spawn.
  let credGap: string[] = []
  try { const c = await fetchBoxCredentials(); if (c.fleet) credGap = c.missing }
  catch (e: any) { console.warn(`[ica] box credentials: ${e?.message ?? e} — continuing with whatever this box has`) }

  if (warmed) return; warmed = true
  console.log('[ica] warming essential agents (analyst · connector)…')
  const warm = async (name: string, p: Promise<unknown>): Promise<{ name: string; ok: boolean; ms: number }> => {
    const t0 = Date.now()
    try { await p; const ms = Date.now() - t0; console.log(`[ica] warm: ${name} ready (${(ms / 1000).toFixed(1)}s)`); return { name, ok: true, ms } }
    catch (e: any) { console.warn(`[ica] warm: ${name} failed (falls back to lazy) — ${e?.message ?? e}`); return { name, ok: false, ms: Date.now() - t0 } }
  }
  const results = await Promise.all([
    warm('analyst',   analystSlot.get().then(a => a.session.warmup?.())),
    // DOES THE CREDENTIAL ACTUALLY WORK? warm-up above only proves a process started and its prompt appeared,
    // which stays true with no credential at all — that is exactly how a box that could not answer anything
    // reported every agent healthy. One real round trip is the difference between "the TUI is up" and "this
    // box can answer", and boot is the cheapest possible moment to find out: the alternative is finding out
    // from a user's question, hours later, where it reads as an expired token rather than a bad boot.
    //
    // On a THROWAWAY session, never the analyst's — a probe turn on the analyst would sit in its transcript
    // and in the context of every question that followed. And only on a fleet box: a laptop has its own login
    // and gets restarted constantly, so this would be a pointless tax on the inner loop.
    ...(credGap.length === 0 && isFleetBox() ? [warm('credential', verifyBoxCredential())] : []),
    warm('connector', connectorSlot.get().then(a => a.session.warmup?.())),
    // The concept index is an agent-shaped cost even though it is not an agent: every concept's surface forms
    // have to be embedded before the first question can be retrieved for, it is cached in memory only, and so
    // it was rebuilt on the first question after every restart — in the foreground, 27s, while the user waited.
    // Warming it here moves that onto the boot where it belongs and off the question that happened to be first.

  ])
  // ONE unmistakable line the user can look for: the engine has finished booting and every essential agent
  // is up (or which one failed). "Fully ready" vs "ready with warnings" — never ambiguous.
  // A MISSING CREDENTIAL IS NOT READY. Warm-up proves a process started and its prompt appeared, which on a
  // box with no credential is still true — that is how a machine that could not answer a single question
  // printed FULLY READY. The banner is the one line people trust, so anything it cannot back up must not
  // appear in it.
  const allOk = results.every(r => r.ok) && credGap.length === 0
  const roster = results.map(r => `${r.name} ${r.ok ? '✓' : '✗'} ${(r.ms / 1000).toFixed(1)}s`).join(' · ')
  const sources = await listSources().then(s => s.length).catch(() => 0)
  const bar = '═'.repeat(64)
  console.log(`\n${bar}`)
  console.log(`  ${allOk ? '✅ ENGINE FULLY READY' : '⚠️  ENGINE READY (with warnings)'} — project ${PROJECT}`)
  console.log(`     agents: ${roster}`)
  // WHICH BRAIN EACH AGENT IS ON, and which layer decided it. A box running a downloaded profile is otherwise
  // indistinguishable from one running the git default, and "which of the three layers set this" is the first
  // question every configuration bug asks.
  for (const line of describeConfig()) console.log(`     ${line}`)
  if (credGap.length > 0) console.log(`     ✗ NO CREDENTIAL: ${credGap.join(', ')} — those agents cannot answer (retrying the vault)`)
  console.log(`     datasources=${sources} · idle, waiting for questions`)
  console.log(`${bar}\n`)
}
// ── PROFILE ↔ HUB ────────────────────────────────────────────────────────────────────────────────────────
// Tell the hub what we are RUNNING, every time that changes. A UI must be able to distinguish "this profile
// was saved" from "this box is running it" — they differ whenever a machine is asleep, unreachable, or still
// finishing the question it was on, and only the box can answer the second one.
function reportConfig(ws: WebSocket) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'config:applied', ...applied() })) }
  catch { /* the socket is closing; the next welcome reports again */ }
}

// Warm-up must not start before the profile is known, or the first agents get built from the cached (or baked)
// configuration and then need rebuilding a second later. Resolves when the profile arrives, or when the wait
// cap expires — a hub that is slow must delay the box, never strand it, and the cache means what we fall back
// to is this machine's last known configuration rather than the git default.
let profileSettled: (() => void) | null = null
const profileReady = new Promise<void>((res) => { profileSettled = res })
function settleProfile() { profileSettled?.(); profileSettled = null }

// Give the datasource manager a moment to come up (analyst/modeler read its /sources at create), then warm.
setTimeout(() => {
  Promise.race([profileReady, new Promise<void>((r) => setTimeout(r, 5_000).unref?.())])
    .then(() => warmEssentialAgents())
    .catch((e) => console.warn('[ica] warm-up error:', e?.message ?? e))
}, 4000)

// On shutdown: stop our session — the harness reaps whatever binary/server it started (opencode
// reaps its server only if it owns it). Delay exit so any close() SIGTERM reaches the binary.
const shutdown = () => {
  // Graceful goodbye: free the singleton slot NOW so the replacement process connects into an empty slot
  // (no restart-window eviction war). Then stop sessions and exit.
  try { if (hub?.readyState === WebSocket.OPEN) hub.send(JSON.stringify({ type: 'bye', instanceId: INSTANCE_ID })) } catch { /* socket already gone */ }
  analystSlot.stop(); connectorSlot.stop(); groundingSlot.stop(); setTimeout(() => process.exit(0), 300)
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
connect()
