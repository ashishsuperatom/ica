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
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { writeFile, rm, readdir, stat } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { execProgram, answerView } from './exec-program.js'
import { createSession, prepareWorkspace, type Session, type Harness, type RunHandlers } from './ica/index.js'
import { agentConfig, describeConfig, useCache, receive, applied, type AgentName } from './config/index.js'
import { createNarrator, capResultData, stripCode, type Narrator } from './agents/narrator/index.js'
import { createAnalyst, promptVersion as analystPromptVersion } from './agents/analyst/index.js'
import { promptVersion as composerPromptVersion, createComposer, type Composer } from './agents/composer/index.js'
import { createConnector, promptVersion as connectorPromptVersion } from './agents/connector/index.js'
import { createGroundingAgent, promptVersion as groundingPromptVersion } from './agents/grounding/index.js'
import { createConceptModeller, promptVersion as modellerPromptVersion } from './agents/concept-modeller/index.js'
import { openAnswers, normalizeQuestion } from './answers.js'
import { followUpCues } from './followup.js'
import { forgetProgram } from './forget.js'
import { log, readJsonSafe } from './log.js'
import { createInspector } from './inspect.js'
import { NodeStore, ROOT, ensureRoot, intentId, SqliteVecIndex, indexText, backfillMissing, hybridSearch } from '@superatom/node-store'
import { bgeEmbedder } from './embed.js'
// TYPE-ONLY, and it must stay that way: the deploy bundles package vm/ alone, so this path does not exist in a
// built image. tsx erases a type-only import, which is why the container runs without it. Making it a value
// import would break every deploy while working perfectly here.
import type { EngineMsgType } from '../../../clients/protocol.js'
import { buildDatasourceIndex } from './datasource-index/build.js'
import { parseVerb, VERBS, type ProgramTarget } from './verbs/index.js'
import type { AgentEvent } from './ica/session.js'
import { diffAnswers, checkReport, checkAnswer, resolveProgramSubject, type CheckDiff } from './verbs/check.js'
import { collectProgramFiles, programAnswer } from './verbs/program.js'
import { parseView, findView, viewDir, viewLabel, viewPrompt } from './verbs/view.js'
import { watchProgramEvents, describeProgramEvent } from './program-events.js'

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
const STATE_ROOT = process.env.ENGINE_STATE_DIR ?? join(VM_ROOT, '.state')
const WORKSPACE_ROOT = process.env.ENGINE_WORKSPACE_DIR ?? STATE_ROOT
const DATA_ROOT = process.env.ENGINE_DATA_DIR ?? STATE_ROOT              // answers.sqlite co-locates with the workspace

// THE PROFILE THIS MACHINE LAST ADOPTED, read before any agent config is resolved. Without it a box whose
// control plane is briefly unreachable would boot on the git default — quietly running different agents than
// it was configured with, and working well enough that nobody looks.
useCache(join(STATE_ROOT, PROJECT))
// SEGREGATION (see ica/workspace.ts): the agent's write-root and the engine's DBs are SIBLING folders under the
// project home, so the agent's cwd never contains our SQLite files.
const WORKSPACE = join(WORKSPACE_ROOT, PROJECT, 'workspace')   // the AGENT's cwd: seams + programs/ + out/
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
// stream target (reply) + channel are LOCAL per analyse() call now — no cross-session clobber. curQuestion/
// lastAnswer below stay global as a best-effort reconnect-status snapshot only, never for answer routing.
const busySessions = new Set<string>()
// THE TURN IN FLIGHT, per session — so it can be STOPPED. A question can run for minutes across two agents; a
// person who has changed their mind should not have to wait it out, and the machine should not keep spending
// on an answer nobody wants. `stop()` is filled in by the turn itself, which is the only thing that knows what
// it currently owns (which agent is working, the narrator, the timers).
const inflight = new Map<string, { qid: string; stop: (why: string) => void; agentRunningProgram: boolean }>()
/** Does this spool line belong to this turn? One workspace serves every chat in a project, so the spool is
 *  shared and the question is real: with two people asking at once, guessing wrong shows one of them the
 *  other's query.
 *
 *  A run the ENGINE started says so — it stamps SA_QID, and the answer is exact. A run the AGENT started from
 *  its own shell cannot: its environment comes from the agent's session, not from the turn. For those we use
 *  the only thing we do know — which sessions have a run.mjs command in flight — and deliver ONLY when exactly
 *  one does. When it is ambiguous nobody is shown it, because a missing line is a gap and a wrong line is a
 *  lie about someone else's data. */
function ownsProgramEvent(sid: string, qid: string, ev: { qid?: unknown; sid?: unknown }): boolean {
  if (typeof ev.qid === 'string' && ev.qid) return ev.qid === qid          // stamped: exact
  if (typeof ev.sid === 'string' && ev.sid) return ev.sid === sid          // stamped by session only
  const candidates = [...inflight.entries()].filter(([, t]) => t.agentRunningProgram)
  return candidates.length === 1 && candidates[0][0] === sid
}

export function stopTurn(sid: string, why = 'the user stopped it'): boolean {
  const t = inflight.get(sid)
  if (!t) return false
  t.stop(why)
  return true
}
let connectorBusy = false
let groundingBusy = false
let indexBusy = false   // the datasource-index build — one at a time per project

// ── Semantic-model consolidation (System 4) state ─────────────────────────────
// This is the SEMANTIC-MODEL consolidation specifically — the bottom layer (meaning + the implementation
// embedded in units). It is deliberately NOT "the" consolidation: other consolidation tasks (higher layers)
// will come later, so everything here is namespaced `conceptConsolidate*` to keep them distinct.
//
// The concept modeller runs OFFLINE over the stream of finished analyses. A watermark (a finished_at value, stored in
// answers.engine_meta) marks how far it has consumed. The trigger is a TIMER, not a per-question signal: a
// single interval, started at boot and always running, that checks "is there anything past the watermark?"
// and drains it. This is robust to restarts — if the server stops with un-consolidated answers and comes
// back days later with no new questions, the timer still catches up (a finished-question signal might never
// arrive; the timer always does). While a pass is running the tick is a no-op (single-runner) — the timer
// keeps ticking but does nothing until the current pass finishes, then the next tick continues.
const CONCEPT_CONSOLIDATE_WM_KEY = 'concept_model:consolidation_watermark'
// TODO: once this is proven, bump the default interval to 3 minutes (180000) so a real burst of questions
// coalesces into ONE consolidation pass. Kept short (30s) for now so testing is fast — you don't want to
// wait 3 min to see the concept modeller wake.
const CONCEPT_CONSOLIDATE_INTERVAL_MS = Number(process.env.CONCEPT_CONSOLIDATE_INTERVAL_MS || 30000)
// A batch that makes the agent SESSION crash is retried at most this many times (across ticks), then skipped
// so a poison batch can never retry forever. Tracked in answers.engine_meta; reset on any clean pass.
const CONCEPT_CONSOLIDATE_FAIL_KEY = 'concept_model:consolidation_failstreak'
const CONCEPT_CONSOLIDATE_MAX_FAILS = 3
// The offline consolidator is WIRED to the concept modeller (System 4): each tick hands a batch of finished
// analyses to consolidateBatch(), which spins up the modeller to distil verified concepts. Set false to make
// the tick inert (it then never advances the watermark, so no backlog is consumed).
const CONSOLIDATOR_WIRED = true
let conceptConsolidating = false

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

// ── INTENT GRAPH (the new spine) ──────────────────────────────────────────────
// A tree of questions (intent nodes) linked by follow_up edges, in the same node-store.
// Matching is POSITIONAL: a session sits at a node; the next question either matches an
// existing child (hit → re-run its program, no LLM) or is new (miss → analyst builds it,
// and we mint the node below). Node id = hash(parent, normalised question) → deterministic.
// ONE project database. The intent graph + concepts + units are all just nodes/edges in the project's
// node-store, which lives in project.sqlite alongside the rest of the project's graph — not a separate file.
const graph = new NodeStore(join(DB_DIR, 'project.sqlite'))

// ── CONCEPT SPECIFICITY (CSS-like) ─────────────────────────────────────────────
// A concept's NAME is its set of "selector words". The concept whose selector the question COVERS THE MOST wins
// (most-specific match), falling back to fewer-word / more-general concepts when the specific combination isn't
// present. Pure lexical over the node-store (no vectors). Returns NAMES only — the agent opens the winner via
// find-concept. Dynamic count: the top specificity tier (within 1 of the best), capped.
// The engine-side concept ranker lived here — lexical specificity unioned with vector recall — and went with
// span firing: the agent searches for its own concepts now. Deleted rather than kept, because it read
// listKind('concept'), which after the index change returns BODIES including ones no name points at any more.
// Dead code that would be subtly wrong if revived is worse than no code.
// Semantic index (sqlite-vec) over the SAME db — GUARDED: if the native extension or model isn't present on
// this host yet, semantic search is simply disabled (FTS keeps working), never a crash. See embed.ts.
let vectors: SqliteVecIndex | null = null
try { vectors = new SqliteVecIndex(graph.db, bgeEmbedder.id, bgeEmbedder.dim) }
catch (e: any) { console.warn('[semantic] sqlite-vec unavailable — semantic index disabled:', e?.message ?? e) }
// Backfill pre-existing intents on boot so semantic reuse can search history, not just newly-built ones.
// Best-effort + non-blocking (never delays boot); degrades silently if the model/native deps aren't present.
if (vectors) void backfillMissing(graph, vectors, bgeEmbedder, { kind: 'intent' })
  .then(n => { if (n) log.info('semantic', `backfilled ${n} intent embedding(s)`) })
  .catch(e => log.warn('semantic', 'intent backfill failed', e))
ensureRoot(graph)
// The FRONT DOOR: every question is routed here first — reuse a program on a match, else build.
// READ-ONLY window into the graph + answer history + the files behind them, served over the hub to the
// admin console. The engine runs on a Fly VM with nothing listening, so this is the only way to see
// what it knows without SSH. It answers `inspect:req` and never writes anything. See inspect.ts.
const inspector = createInspector({
  graph, answers, workspace: WORKSPACE, dataRoot: join(DATA_ROOT, PROJECT), projectId: PROJECT,
  datasourceUrl: DATASOURCE,
  runtime: () => ({
    agents: {
      analyst:   { ...agentConfig('analyst'),   busy: busySessions.size > 0 },
      connector: { ...agentConfig('connector'), busy: connectorBusy },
      grounding: { ...agentConfig('grounding'), busy: groundingBusy },
    },
    consolidating: conceptConsolidating,
    consolidateIntervalMs: CONCEPT_CONSOLIDATE_INTERVAL_MS,
    uptimeMs: Date.now() - EPOCH,
  }),
})
// sessionId → current intent node id (default ROOT). Kept in memory for the hot path, but PERSISTED per
// session in project.sqlite so it survives engine restarts / image rolls — otherwise a restart forgets which
// answer each session is "on", and edit:/modify would have nothing to target (falls through to build). Scoped
// by session_id: switching chats in the UI (each chat = one sessionId) resolves to THAT chat's node, and a
// brand-new session is absent → ROOT. We never carry one session's position into another.
const position = new Map<string, string>()
graph.db.exec(`CREATE TABLE IF NOT EXISTS session_position (session_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, updated_at INTEGER)`)
const _posUpsert = graph.db.prepare(`INSERT INTO session_position (session_id, node_id, updated_at) VALUES (?,?,?)
  ON CONFLICT(session_id) DO UPDATE SET node_id=excluded.node_id, updated_at=excluded.updated_at`)
for (const r of graph.db.prepare(`SELECT session_id, node_id FROM session_position`).all() as any[]) {
  if (graph.getNode(r.node_id)) position.set(r.session_id, r.node_id)   // skip a persisted node that no longer exists
}
const setPosition = (sid: string, nodeId: string) => { position.set(sid, nodeId); try { _posUpsert.run(sid, nodeId, Date.now()) } catch { /* position is best-effort; a write failure must not break answering */ } }

// ── WHAT IS ON SCREEN, per chat ───────────────────────────────────────────────
// The question that was answered and the program that answered it. `edit:`, `explain:`, `check:` and
// `program:` all act on "the thing I am looking at", and each of them used to work that out for itself by
// reaching into the current INTENT NODE — four hand-rolled lookups with four different fallbacks.
//
// That coupling was wrong twice over. The intent graph is a map of QUESTIONS and it moves for reasons of its
// own; and a view (`view: customer 431`) is deliberately not in it at all, so a verb reading the graph would
// act on whatever unrelated question happened to be there instead.
//
// So it is one record, written by every path that PUTS an answer on screen — a question, a reused program, a
// view — and untouched by the verbs that only REPORT on one. It moves when a new answer arrives and at no
// other time, which is exactly what "the last thing I asked" means to the person reading it.
interface OnScreen { qid: string; question: string; programDir?: string; params?: unknown }
graph.db.exec(`CREATE TABLE IF NOT EXISTS session_screen (session_id TEXT PRIMARY KEY, qid TEXT NOT NULL, question TEXT NOT NULL, program_dir TEXT, params_json TEXT, updated_at INTEGER)`)
const _screenGet = graph.db.prepare(`SELECT qid, question, program_dir, params_json FROM session_screen WHERE session_id = ?`)
const _screenSet = graph.db.prepare(`INSERT INTO session_screen (session_id, qid, question, program_dir, params_json, updated_at) VALUES (?,?,?,?,?,?)
  ON CONFLICT(session_id) DO UPDATE SET qid=excluded.qid, question=excluded.question, program_dir=excluded.program_dir, params_json=excluded.params_json, updated_at=excluded.updated_at`)

// THE DATABASE IS THE STATE — there is no in-memory copy. It was a Map hydrated at boot and written through,
// which survives a restart but adds a second place the truth can live: a failed write leaves memory ahead of
// disk, and every later read agrees with the wrong one. A row read costs microseconds and happens once a turn.
const getOnScreen = (sid: string): OnScreen | null => {
  const r = _screenGet.get(sid) as { qid: string; question: string; program_dir: string | null; params_json: string | null } | undefined
  if (!r) return null
  let params: unknown
  if (r.params_json) { try { params = JSON.parse(r.params_json) } catch { /* unreadable params are no params */ } }
  return { qid: r.qid, question: r.question, programDir: r.program_dir ?? undefined, params }
}
const setOnScreen = (sid: string, v: OnScreen) => {
  try { _screenSet.run(sid, v.qid, v.question, v.programDir ?? null, v.params === undefined ? null : JSON.stringify(v.params), Date.now()) }
  catch (e: any) {
    // NOT swallowed. The answer still reaches the user, but every verb that follows will act on the PREVIOUS
    // answer — an edit applied to the wrong program is a silent wrong action, so it is said out loud.
    log.error('session', `could not record what is on screen for ${sid} — edit/check/explain will target the previous answer`, e)
  }
}

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
const analystSlot  = makeAgentSlot('analyst',  analystPromptVersion,  (resumeId) => listSources().then(sources => createAnalyst({ root: WORKSPACE_ROOT, projectId: PROJECT, sources, managerUrl: DATASOURCE, ica: { resumeId } })), 'analyst')
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
    e = { composer: createComposer({ root: WORKSPACE_ROOT, projectId: PROJECT, managerUrl: DATASOURCE, ica: { baseUrl: OC_URL } }),
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
// The CONCEPT MODELLER (System 4 — "sleep"): LAZY, never warmed at boot — spun up only when the offline
// consolidation tick has a batch to study, then it distils verified concepts from finished analyses.
const modellerSlot = makeAgentSlot('modeller', modellerPromptVersion, (resumeId) => listSources().then(sources => createConceptModeller({ root: WORKSPACE_ROOT, projectId: PROJECT, sources, managerUrl: DATASOURCE, ica: { resumeId } })), 'modeller')
for (const line of describeConfig()) console.log(`[config] ${line}`)
// Live analyst state, kept so a (re)connecting client can RE-SYNC after a reload (the engine stores
// no history — this is just the current run + last result, replayed on demand).
let curQuestion = '', curCategory = '', curSid = ''
let lastAnswer: any = null, lastTiming: any = null, lastCategory = ''

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
export function answerShapeProblem(a: any): string {
  if (!a || typeof a !== 'object') return 'answer is not an object'
  if (a.status && a.status !== 'answered') return ''            // cannot_answer / uncertain carry prose, not a card
  if (typeof a.headline === 'string') return 'headline is a string — the renderer needs { label, display, value }'
  if (a.headline && typeof a.headline === 'object' && !a.headline.display) return 'headline has no `display`'
  // The unit envelope, left unwrapped: `answer` holding the whole view-model instead of prose. The card prints
  // it as "[object Object]" and finds no headline or sections beside it, so the KPI and every table vanish.
  if (a.answer && typeof a.answer === 'object' && !Array.isArray(a.answer)) {
    return 'answer is a nested object — the unit envelope was not unwrapped (expected prose text or an array)'
  }
  // Deliberately NOT flagging unknown keys: an answer may carry extra data the renderer ignores, and treating
  // that as an error would cry wolf on perfectly good answers.
  const prose = typeof a.answer === 'string' || Array.isArray(a.answer) ? a.answer : null
  const renders = a.headline?.display || a.figures?.length || a.table?.columns || a.sections?.length || prose
  return renders ? '' : 'nothing renderable — no headline, figures, table, sections or text'
}

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
  return /\b(query|introspect|resolve|find-concept|get-concept|find-schema|find-program|get-program|sources|run\.mjs|program\.ts|tsx|node)\b/.test(c)
}

/** The concepts a program taught us — read from the provenance every concept already records.
 *
 *  A concept keeps `provenance: [{question, program}]`, so this link has existed all along; it was simply
 *  never traversable, and nothing could go from a program back to what it produced.
 *
 *  It matters on an EDIT. A program is wrong because something is wrong — and when that something is a concept,
 *  fixing the program alone leaves the bad knowledge in place to be built from again. `P&L revenue (GL
 *  definition)` states nine account numbers in its prose AND says they must never be assumed; that
 *  contradiction has since reached three separate programs. Editing any one of them would not have touched it.
 *
 *  Names only. The agent reads the ones it cares about with ./get-concept — the same way it finds any other. */
function conceptsFromProgram(programDir: string): string[] {
  const want = programDir.replace(/^programs\//, '')
  const out = new Set<string>()   // a concept is versioned, so the same name can appear as several nodes
  for (const n of graph.nodesByKind('concept')) {
    const prov = (n.props as any)?.provenance
    if (!Array.isArray(prov)) continue
    if (prov.some((p: any) => String(p?.program ?? '').replace(/^programs\//, '') === want)) out.add(n.label)
  }
  return [...out]
}

// ── What produced an answer ─────────────────────────────────────────────────
// An answer that cannot be attributed cannot be evaluated: when one changes, the question is always whether the
// DATA moved, a PROMPT changed, a CONCEPT was rewritten, or the ENGINE was rebuilt — and without this we are
// guessing. Cheap to record, and it is the difference between "it ran" and "that change helped".
// buildId: the image's own id when running from one (the Dockerfile writes /app/BUILD_ID), else the git sha.
let BUILD: { buildId: string; prompts: Record<string, string> } | null = null
async function buildIdentity(): Promise<{ buildId: string; prompts: Record<string, string> }> {
  if (BUILD) return BUILD
  let buildId = 'dev'
  try { buildId = readFileSync('/app/BUILD_ID', 'utf8').trim() } catch {
    try { buildId = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { /* not a checkout */ }
  }
  const prompts: Record<string, string> = {}
  for (const [role, fn] of [['analyst', analystPromptVersion], ['composer', composerPromptVersion], ['modeller', modellerPromptVersion]] as const) {
    try { prompts[role] = await (fn as any)() } catch { /* a version we cannot read is simply absent */ }
  }
  return (BUILD = { buildId, prompts })
}

// ── Agent-lane protocol ──────────────────────────────────────────────────────
// ONE wire vocabulary for EVERY agent lane (composer, analyst, concept-modeller — and any future autonomous
// agent). A lane is an observable work stream; the UI is a generic consumer that hardcodes no agent. Frames:
//   agent:hello  {lane, label, hue, streamKind, pty, interactive, controls} — the lane announces what it IS
//   agent:event  {lane, ev}          — one work atom (ev.kind: command|message|reasoning|file|turn|user|segment)
//   agent:events {lane, events}      — full replay on reconnect
//   agent:status {lane, text?|category?|progress?|state?} — the live "what it's doing" line + lifecycle
// The raw-terminal byte stream (`analyst:chunk`) and the user-facing product (`narration`, `analyst:answer`,
// gaps/enriching) are DIFFERENT protocols and keep their names. `lane` is the routing key: asker-direct frames
// (status/hello/events) carry no channel, so the UI needs `lane` to place them. Implementation is free to move;
// this shape is the contract.
const A = (verb: 'hello' | 'event' | 'events' | 'status' | 'chunk', lane: string, body: Record<string, any> = {}) =>
  ({ t: `agent:${verb}` as EngineMsgType, lane, ...body })

// The recent conversation, for canonicalisation only — enough to resolve what a follow-up points AT ("those",
// "the third one"). Compact on purpose: the last couple of turns, each one question + a short answer digest.
// UNUSED since the reflex was removed — the canonicaliser that used it is gone. Kept only until the next clean-up pass.
function sessionContext(sid: string, turns = 2): string {
  try {
    const rows = answers.bySession(sid).slice(-turns)
    if (!rows.length) return ''
    return rows.map(r => {
      const a: any = r.answer
      const lines = Array.isArray(a?.answer) ? a.answer.join(' ') : (a?.answer ?? '')
      const head = a?.headline?.display ? ` [${a.headline.display}]` : ''
      const rowsTxt = a?.sections?.find((s: any) => s.kind === 'table')?.rows?.slice(0, 5)
        ?.map((row: any[]) => row.join(' | ')).join('\n   ') ?? ''
      return `Q: ${r.question}\nA:${head} ${String(lines).slice(0, 300)}${rowsTxt ? '\n   ' + rowsTxt : ''}`
    }).join('\n\n')
  } catch { return '' }
}

// Find a program whose DECLARED canonical question is the one just asked. Exact on the normalised string — the
// canonical form is generated by the same instruction on both sides, so a true match IS the same sentence; a
// near-miss is deliberately not a match (it goes to the composer, which can judge with tools).
// Every placeholder in the stored form must be bound by the params we extracted: a program that expects
// <months> and receives nothing would silently run on its DEFAULT window and answer a different question.
// UNUSED since the reflex was removed — exact canonical matching moved into the composer (./find-program). Kept only until the next clean-up pass.
function findByCanonical(canonical: string): { program: string; category?: string; nodeId: string } | null {
  // Match the canonical FORM, whole and as written — normalised only for case, spacing and trailing punctuation
  // (normalizeQuestion), which is the same normalisation the rest of the engine uses on questions.
  // No parsing of the sentence: the canonicaliser already returns the parameters as data, and the names a
  // program was actually written against live in its own meta.inputs — which the composer reads. Taking the
  // sentence apart to guess a mapping was inventing a fragile step to recover something already in hand.
  const want = normalizeQuestion(canonical)
  if (!want) return null
  for (const n of graph.nodesByKind('program')) {
    const p: any = n.props ?? {}
    const forms: string[] = Array.isArray(p.canonicalQuestions) ? p.canonicalQuestions : []
    if (!forms.some(f => normalizeQuestion(String(f)) === want)) continue
    if (!p.dir || !existsSync(join(WORKSPACE, p.dir, 'program.ts'))) continue
    return { program: p.dir, category: p.category, nodeId: n.id }
  }
  return null
}

// UNUSED since every question began going through the composer — kept for one clean-up pass, not called.
// Reuse a saved program (SYS-1, no LLM): run it against CURRENT data, emit the answer, persist. Shared by
// the positional exact-hit and the reflex catalog-match. Returns false on failure so the caller rebuilds.
async function reuseProgram(programDir: string, params: any, category: string,
  ctx: { sid: string; qid: string; question: string; norm: string; t0: number; nodeId: string; reply: any; channel: string; route?: string }): Promise<boolean> {
  const { sid, qid, question, norm, t0, nodeId, reply, channel } = ctx
  const route = ctx.route ?? 'verbatim'
  emit(reply, A('status', 'analyst', { category, sid }))
  emit(reply, A('status', 'analyst', { text: 'Re-running the saved program…', question, sid, qid }))
  const ka = setInterval(() => { if (reply) emit(reply, { t: 'tick', sid }) }, 8000)
  try {
    // Fresh subprocess (see exec-program.ts): a program edited by a prior modify is cached stale in this
    // long-lived tsx process, so an in-process reuse would re-run yesterday's code. Spawn it clean.
    const rr = await execProgram(WORKSPACE, programDir, params ?? {}, { qid, sid })
    const answer = answerView(rr.output)   // out of the unit envelope — see answerView
    const out = answer                      // downstream shape checks read the VIEW, not the envelope
    const timing = { ms: Date.now() - t0, reused: true }
    // Deterministic AUDIT of this run (no LLM): the input at this moment, the output's shape, and a rough
    // "degenerate" flag (answered-but-nothing-came-back) so we can later see how the program behaves + count failures.
    const emptyRun = answer.status === 'answered' && (out?.table?.rows?.length ?? 0) === 0 && out?.headline?.value == null && !(out?.figures?.length)
    answers.recordRun({ programDir, qid, question, params, status: answer.status, empty: emptyRun, shapeHash: (rr as any).finalShapeHash, ms: timing.ms })
    // ── The missing edge: REVIEW the reused answer before shipping it ─────────────
    // A saved program can run cleanly and still not answer the question (a stale interpretation, a name that
    // now resolves to two things, an empty result). The reflex looks at what came back and decides whether it
    // genuinely answers; if not, we hand UP to the analyst instead of shipping a non-answer. Fail-open: if the
    // reviewer errors, escalate only the clearly-degenerate runs (don't flood the analyst when review is down).
    // First, PROGRAM SELF-DOUBT: a program that couldn't confidently answer (an input outside its assumptions,
    // a reference that resolved to more than one thing) says so — status 'uncertain' or a `doubt` field. That
    // is a definitive raised hand, so we escalate deterministically without even asking the reviewer.
    const doubtReason = answer.status === 'uncertain'
      ? (typeof (out as any)?.doubt === 'string' ? (out as any).doubt : (out as any)?.doubt?.reason ?? 'the program was not confident')
      : ((out as any)?.doubt != null ? (typeof (out as any).doubt === 'string' ? (out as any).doubt : (out as any).doubt?.reason ?? 'the program flagged doubt') : null)
    // DETERMINISTIC ONLY. A separate reviewing agent used to read the answer here and judge whether it really
    // answered; it is gone, and with it the ability to catch a well-formed answer that is simply about the
    // wrong thing. What remains catches the cases a machine can see for certain: the program said it was not
    // confident, or it came back with nothing to show. Anything subtler now reaches the user — which is the
    // trade accepted when the front door became one agent.
    let escalate = false, why = ''
    if (doubtReason) { escalate = true; why = `program raised doubt — ${doubtReason}` }
    else if (emptyRun) { escalate = true; why = 'the run produced nothing to show' }
    if (escalate) {
      clearInterval(ka)
      log.info('reuse', `reused ${programDir} did not answer → escalating`, why)
      return false   // fall through to the analyst build (analyse handles the rebuild)
    }
    lastAnswer = answer; lastTiming = timing; lastCategory = category
    emit(reply, { t: 'analyst:answer', category, answer, timing, sid, qid, reused: true })   // user-facing product — NOT a lane frame
    if (channel) emit({ type: 'channel' }, { t: 'channel:answer', channel, qid, answer, category })   // durable delivery to the chat channel
    // Follow-ups persisted on the node when it was first built → replay them on reuse (no analyst involved).
    const fu = (graph.getNode(nodeId)?.props as any)?.followups
    if (Array.isArray(fu) && fu.length && reply) emit(reply, { t: 'followups', items: fu, qid, sid })
    emit(reply, A('status', 'analyst', { state: 'done', sid }))
    answers.save({ qid, sessionId: sid, question, norm, category, status: 'answered', answer, createdAt: Date.now(), finishedAt: Date.now(), programDir, params, build: await buildIdentity(), route })
    setOnScreen(sid, { qid, question, programDir, params })   // a reused answer is on screen exactly like a fresh one
    const n = graph.getNode(nodeId); if (n) graph.putNode({ ...n, props: { ...(n.props as any), lastShapeHash: (rr as any).finalShapeHash ?? (n.props as any)?.lastShapeHash } })
    setPosition(sid, nodeId)
    clearInterval(ka)
    busySessions.delete(sid); curQuestion = ''
    console.log(`[ica] REUSE ${programDir} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return true
  } catch (e: any) {
    clearInterval(ka)
    console.log(`[ica] reuse of ${programDir} failed (${e?.message ?? e}) — rebuilding via the analyst`)
    return false
  }
}

// Answer a question: classify → analyst ICA (per-category SYSTEM.md) → stream
// the raw claude terminal to the "Analyst" tab and emit the final structured answer.
async function analyse(question: string, from: any, sid = '', qidIn = '', channel = '') {
  console.log(`[ica][session] analyse sid="${sid}" pos=${(position.get(sid) || 'ROOT').slice(0, 14)} busy=[${[...busySessions].map(s => `"${s}"`).join(',')}] q="${question.slice(0, 50)}"`)
  if (busySessions.has(sid)) {
    console.log(`[ica][session] REJECTED (one-at-a-time) sid="${sid}" — locked sessions: [${[...busySessions].map(s => `"${s}"`).join(',')}]`)
    emit(from, A('status', 'analyst', { text: 'Already answering a question in this chat — one at a time.', sid })); return
  }
  if (!question.trim()) return
  // ── VERB prefix ───────────────────────────────────────────────────────────────
  // A leading `edit:` / `modify:` / `explain:` is the user DIRECTLY saying what kind of turn this is —
  // deterministic routing, nothing guessed. See verbs.ts for the rule and why the set is closed.
  //
  // The prefix is KEPT. `question` is the clean text to act on, `askedRaw` is what they actually typed, and the
  // raw form is what goes into the prompt and the logs. Stripping it and discarding it meant that afterwards —
  // reading a log, or an agent reading its own history — nothing distinguished an `edit:` turn from an ordinary
  // one. Now the literal verb is in the transcript, so "when was explain asked?" is a search.
  const verb = parseVerb(question)
  const explicitEdit = verb?.verb === 'edit'
  const explicitExplain = verb?.verb === 'explain'
  const explicitRun     = verb?.verb === 'run'
  const explicitCheck   = verb?.verb === 'check'
  const explicitProgram = verb?.verb === 'program'
  const explicitView    = verb?.verb === 'view'
  const askedRaw = verb ? verb.raw : question
  if (verb) question = verb.rest
  // Stream everything to `reply` (re-targetable): a reload reconnects and sessions:list points reply
  // at the new connection, so the in-flight run's output + final answer reach the reloaded client.
  busySessions.add(sid)
  const reply = from                                   // LOCAL to this turn — no cross-session clobber (channel is the param)
  // LIVENESS, FROM THE FIRST MOMENT. The UI arms a 25s watchdog on asking and re-arms on any message, so this
  // tick is the only thing telling it the engine is alive between steps. It used to be armed AFTER
  // canonicalisation and concept retrieval — tens of seconds — leaving a silent window at the START of every
  // turn, exactly where the watchdog is most likely to fire.
  //
  // The cost was never a stray message. The watchdog calls endTurn(), which clears `busy`, and `busy` is what
  // draws the thinking line and its timer. So one early gap told the user the engine had died, removed the
  // only sign it was working, and left it that way for the rest of a turn that ran fine for ten more minutes.
  let keepalive: ReturnType<typeof setInterval> | null = setInterval(() => { if (reply) emit(reply, { t: 'tick', sid }) }, 8000)
  const norm = normalizeQuestion(question)
  // ONE id end to end: the UI mints it and sends it; we use it verbatim (agent writes ./out/<qid>.json,
  // DB keys on it). Fall back to minting our own if a non-UI caller omitted it. Trust-but-verify: if the
  // client id already maps to a DIFFERENT question (a client bug), don't overwrite — mint a fresh one.
  let qid = qidIn || genId()
  if (qidIn) { const ex = answers.get(qidIn); if (ex && ex.norm !== norm) qid = genId() }
  curQuestion = question; curSid = sid; curCategory = ''; lastAnswer = null
  const t0 = Date.now()
  // Declared HERE, above the stop closure that reads them, rather than with the rest of the narration state
  // two hundred lines below — a closure referring to a variable declared later works at runtime only because
  // it runs later, which is a poor thing to rely on.
  //
  // `null as Narrator | null` rather than `: Narrator | null = null`, and it is not noise: the only assignment
  // is inside startNarrator, a nested function, so from the outer scope the checker holds the initialiser's
  // narrowed `null` and every later use collapses to `never`. Annotating the initialiser keeps the union.
  let narrator = null as Narrator | null
  let narrationTimer: ReturnType<typeof setInterval> | null = null
  // STOPPING. Checked wherever this turn is about to produce something, because a promise already in flight
  // cannot be un-awaited: we tell the agent to stop, stop showing its output, and discard whatever eventually
  // comes back. All three matter — killing the agent alone would still let a late answer land on screen, and a
  // flag alone would leave the model running and billing.
  let stopped: string | null = null
  let stopSession: (() => void) | null = null          // set once we know which agent is working
  let workingAgent = 'engine'                          // for the log and the record; the inner currentAgent is out of scope here
  const stopThisTurn = (why: string) => {
    if (stopped) return
    stopped = why
    console.log(`[ica] STOP requested for ${qid.slice(0, 8)} (${workingAgent}) — ${why}`)
    try { narrator?.stop() } catch { /* best-effort */ }
    if (narrationTimer) { clearInterval(narrationTimer); narrationTimer = null }
    // Tell whichever agent is working to abandon the turn. reset() is the harness's own "drop this session";
    // it is optional, so a harness without it keeps running and we simply ignore its answer.
    try { stopSession?.() } catch { /* best-effort */ }
    emit(reply, A('status', 'analyst', { text: 'Stopped.', sid, qid }))
    emit(reply, { t: 'analyst:answer', category: 'stopped', sid, qid, timing: { ms: Date.now() - t0 },
      answer: { status: 'answered', category: 'stopped', answer: 'Stopped — nothing was saved for this question.' } })
  }
  inflight.set(sid, { qid, stop: stopThisTurn, agentRunningProgram: false })
  // WATCH FOR A PROGRAM RUNNING, for the whole turn. Not only around execProgram: the long runs are the ones
  // the AGENT starts from its own shell while authoring, and those are exactly the minutes that look like a
  // hang. run.mjs writes the same trace either way; this reads it and sends it on.
  const unwatchPrograms = watchProgramEvents(WORKSPACE, (ev) => {
    if (stopped || !reply) return
    if (!ownsProgramEvent(sid, qid, ev)) return
    const text = describeProgramEvent(ev)
    if (!text) return
    const msg = { t: 'program:event' as const, ev: { ...ev, text }, qid, sid }
    // TWO AUDIENCES, and the split is what each event is FOR.
    //
    // A program STARTING, ENDING or FAILING answers the question that made us build this: is anything actually
    // happening? Two or three lines per run, and everyone gets them — a client that opts out of the rest still
    // knows the silence is a program working and not a hang.
    //
    // Everything else — each unit, each decision, each query — is operator detail, and it is the volume: a real
    // program emits dozens. It goes to the `program` channel, so a client receives it only by asking. Later a
    // preference can simply stop asking, with nothing to change here.
    if (ev.t === 'program:start' || ev.t === 'program:end' || ev.t === 'program:failed') emit(reply, msg)
    else emit({ type: 'log', channel: 'program' }, msg)
  })
  // SAY WHAT KIND OF TURN THIS IS, IMMEDIATELY. The card that shows while the work runs had "Analysis" written
  // into it, so a check: or an explain: announced itself as an analysis for its whole duration and only became
  // what it was once finished. The verb is known here, before anything has been done — so it is said here. An
  // ordinary question stays as it was: its category is a judgement the agent makes, and it arrives later.
  if (verb) emit(reply, A('status', 'analyst', { category: VERBS[verb.verb].category, sid, qid }))

  // ── INTENT GRAPH match at the current position (SYS-1 fast path, no LLM) ──────
  // Position = where this session currently sits in the tree. hash(pos, question) is the
  // node id, so re-asking the same thing at the same place hits the same node; the same
  // words at a different position is a different node (context = position). A hit re-runs
  // the node's program — a FRESH query against current data, never the stored answer.
  const pos = position.get(sid) || ROOT
  const nid = intentId(pos, question)   // real-position node id — the reflex/build path uses this, UNCHANGED
  // The ONLY new determination — a small regex (no model, no network): is this a self-contained ROOT question or a
  // FOLLOW-UP? It is used for exactly ONE thing here: the fast REUSE lookup below. A root question is matched at
  // ROOT, so an exact repeat of a standalone question re-runs its saved program WITHOUT the reflex classifier. It
  // NEVER creates or places a node — a miss falls straight through to the unchanged reflex+build path, which alone
  // decides node identity/placement (still the reflex agent's job). For now we only OBSERVE whether the regex
  // agreed with where the analyst ends up placing the node (logged at the build site) to see if we were right.
  // The cue regex is a SAFETY GATE, which is what its own header calls it — not a router. Used as a router it
  // looked the question up at `intentId(pos, question)`, a key nothing writes (nodes are placed by the reflex,
  // overwhelmingly at ROOT), so a question it called a follow-up could never hit this path however often it was
  // asked. And it is wrong about 1 in 6: "In <source>, what's our total invoice amount this year, and the top 5
  // customers by it?" reads as a follow-up to it and is entirely self-contained.
  // So: cues fire → SKIP this text-identical shortcut and let canonicalisation handle it, which resolves what the
  // question points at using the conversation. Cues quiet → the question stands alone, and identical text means
  // the same question.
  const cues = explicitEdit ? [] : followUpCues(question)
  const rootQuestion = !explicitEdit && cues.length === 0
  // The cue regex no longer gates any lookup — it only suggests where this question's node hangs, and the
  // agent's own placement still wins. Kept because the guess is logged against that placement, which is how
  // we know it is wrong about one in six.
  if (!explicitEdit) console.log(`[ica] regex: ${rootQuestion ? 'reads as self-contained' : `reads as FOLLOW-UP (${cues.join(',')})`}`)
  // NO LOOKUP HERE. The composer canonicalises the question and searches with `./find-program` itself, so a
  // pre-match in the engine finds nothing it would have missed — an identical question produces an identical
  // stored form, which ranks first in that search anyway.
  //
  // And matching raw text was unsafe for a FOLLOW-UP. It looked the question up at ROOT, so "what about 2025?"
  // would be matched as though it stood alone and could collide with the same words from an unrelated thread.
  // The only guard was the follow-up cue regex, which this file's own notes admit is wrong about one time in
  // six. Canonicalisation is what solves that — it resolves what a follow-up points AT using the conversation
  // and searches with a sentence that stands on its own — so putting a raw-text match in front of it puts back
  // the very problem it exists to remove.

  // FIRST SIGN OF LIFE, before any model call. Canonicalisation alone is ~2s and retrieval follows it, so the
  // asker used to sit in silence until the analyst slot was warm — the turn felt stalled before it had begun.
  emitBeat(reply, 'Looking into your question…', qid, sid)

  // ── CANONICAL MATCH — retrieval only ────────────────────────────────────────────────────────────────────
  // The question is normalised to its CANONICAL form (a no-tools completion, ~1-2s) and matched against the forms
  // programs declared when they were built. Both sides are then the same shape, so "…last 12 months?" and
  // "…last 6 months?" are the SAME string differing only in a parameter — no similarity threshold to tune.
  // This FINDS; it never runs and never ships. The match is handed to the composer, which owns deciding whether
  // it truly fits, running it, and verifying the output — one place with the conversation in front of it, instead
  // of two components that can each answer.
  // The question with everything it points AT written in ("their project managers" → the managers of which
  // projects). The engine resolves this to match on it; handing the agent the fragment instead is why the
  // composer once escalated with "'their' has nothing to bind to" while the engine already knew the answer.
  // NO CANONICALISER HERE. The composer states the canonical form itself, as its first step, and looks up
  // matching programs with `./find-program` — so the form it searches with, the candidates it saw, the run and
  // the result all sit in ONE session and ONE log. A separate agent doing it up front was invisible to the
  // composer: it could not see what had been matched or why, and neither could anyone reading the tape.
  //
  // The exact-repeat fast path above is untouched and needs no agent — it keys on the NORMALISED question.
  let resolvedQuestion: string | undefined

  // ── Routing: MODIFY is DETERMINISTIC (explicit "edit:"/"modify:" prefix only) — never guessed. Otherwise the
  // REFLEX (stateless) classifies REUSE vs BUILD; it has no "modify" decision. The SAME question is a reuse.
  const curNode = pos !== ROOT ? graph.getNode(pos) : null
  const curQ = curNode ? ((curNode.props as any)?.question ?? curNode.summary) : undefined
  let placement: string | undefined                               // 'root' or an intentId — where this question's node hangs
  // `sim` = cosine similarity to the asked question (0..1) — the number that says HOW CLOSE this candidate is.
  // `score` is only the RRF rank-fusion value used for ordering; it is a position, not a measure of fit.
  let programCandidates: { question: string; program?: string; score: number; sim: number | null }[] = []   // engine-searched matches handed to the composer
  let modifyTarget: ProgramTarget | null = null
  // ── WHAT THIS VERB ACTS ON ────────────────────────────────────────────────────────────────────────────
  // Resolved ONCE, from the session's record of what is on screen, for every verb that needs it. Each used to
  // work it out itself from the intent node, with a different fallback each time — and a view is not in that
  // graph at all, so those lookups would have found an unrelated question.
  //
  // A program whose file is gone is the same as no program: it cannot be explained, checked, edited or shown.
  const screen = getOnScreen(sid)
  const target: ProgramTarget | null =
    screen?.programDir && existsSync(join(WORKSPACE, screen.programDir, 'program.ts'))
      ? { programDir: screen.programDir, question: screen.question, params: screen.params, qid: screen.qid,
          concepts: conceptsFromProgram(screen.programDir) }
      : null
  if (verb && VERBS[verb.verb].needsCurrentProgram && !target) console.log(`[ica] ${verb.verb}, but nothing has been answered in this chat yet`)

  // How `run:` and `check:` find the program they act on. Both take a subject — the answer on screen, a
  // question id, or a program name — and an answer row already carries the programDir AND the params it was
  // run with, so any past answer re-runs exactly, with nothing guessed and no model in the path.
  const subjectLookups = {
    onScreen: target,
    answerFor: (q: string) => { const r = answers.get(q); return r ? { programDir: r.programDir, params: r.params, question: r.question, answer: r.answer, createdAt: r.createdAt } : null },
    latestForProgram: (d: string) => { const r = answers.latestForProgram(d); return r ? { qid: r.qid, params: r.params, question: r.question, answer: r.answer, createdAt: r.createdAt } : null },
    programExists: (d: string) => existsSync(join(WORKSPACE, d, 'program.ts')),
  }

  let explainTarget: ProgramTarget | null = null
  // Set here but ACTED ON inside the try below — the try that owns the `finally` starts further down, so
  // returning from here would skip it and leave the session flagged busy for good.
  if (explicitExplain) { explainTarget = target; if (target) console.log(`[ica] explain → ${target.programDir}`) }
  if (explicitEdit) {
    // The concepts this program taught travel WITH the edit: a fault is often in one of them, and a fix that
    // stops at the program leaves the next build to inherit it. With nothing on screen, fall through and build.
    modifyTarget = target
    if (target) console.log(`[ica] explicit edit → editing ${target.programDir} in place${target.concepts?.length ? ` · it taught: ${target.concepts.join(', ')}` : ''}`)
    else console.log('[ica] explicit edit, but no current program to edit → building fresh')
  } else if (!explicitExplain && !explicitRun && !explicitCheck && !explicitProgram && !explicitView) {
    // Explain and check both report on a program that is already chosen — searching for candidates or ranking
    // concepts would be work whose result nothing reads, on the two verbs meant to come back quickly.
    // NO reflex routing. The exact-match fast-path above already handled exact repeats (no LLM). For everything
    // else the ENGINE searches (semantic) and hands the composer the candidate programs + scores — the composer
    // judges (reuse a strong match / compose from concepts / escalate). Placement is the regex heuristic: a
    // self-contained question is a new ROOT topic; a follow-up hangs under the current node.
    placement = rootQuestion ? 'root' : pos
    const phaseT0 = Date.now()
    try {
      const hits = vectors ? await hybridSearch(graph, vectors, bgeEmbedder, question, { kind: 'intent', limit: 6 }) : []
      programCandidates = hits
        .map(h => { const p = graph.getNode(h.id)?.props as any; return { question: (p?.question ?? h.label ?? '') as string, program: p?.program as string | undefined, score: h.score, sim: h.sim } })
        .filter(c => c.program && existsSync(join(WORKSPACE, c.program!, 'program.ts')))
      const top = programCandidates[0]
      console.log(`[ica] search: ${programCandidates.length} program candidate(s)${top ? ` · top ${top.program} (sim ${top.sim == null ? 'n/a' : top.sim.toFixed(2)})` : ''} → composer · ${Date.now() - phaseT0}ms`)
    } catch (e: any) {
      console.log(`[ica] candidate search failed (${e?.message ?? e}) — composer builds from concepts`)
    }
    // NO ENGINE-SIDE CONCEPT RETRIEVAL. The engine used to pre-search concepts and hand the agent a shortlist of
    // six names. Two retrievers ran on every question — specificity (lexical, ~250ms) and span firing (a model
    // forward pass per 2-4-gram of the question, MEASURED at 8.4s, 8.6s and 16.5s on three consecutive real
    // questions) — and only one was used. Span firing was 93-96% of everything that happened before the composer
    // was even asked, and on all three it surfaced what the 250ms lexical pass had already ranked first; on one
    // of them every span came back unexplained, because most 2-grams of a sentence are function words that
    // cannot match a concept name by construction.
    //
    // The agent searches for itself now. `./find-concept` is full-text over the concept store, it answers in
    // milliseconds, and the phrase the AGENT chooses is a better cue than n-grams of the user's wording — it is
    // the agent's current hypothesis, formed after seeing the problem. It can also search more than once, which
    // a single pre-fire never could.
  }

  // Liveness keepalive: the UI arms a 25s watchdog and re-arms on every message. Claude-code's PTY streams
  // constantly so it's always fed, but SDK harnesses (codex) reason/exec silently for long stretches — and
  // the gap-loop model build is silent too. Tick every 8s for the whole turn so the watchdog never false-fires.
  // (armed at the top of the turn — see where `reply` is taken)
  // ── Receptionist narration (a SEPARATE throwaway agent): while the analyst works behind the scenes, translate
  // its raw activity into business-language 'narration' beats for the USER UI. Fresh per question; best-effort — a
  // narration failure must NEVER affect the answer.
  const narrationBuf: string[] = []
  let narrating = false
  let lastDoing = ''                 // the last command announced, so a re-emitted event doesn't repeat it
  const saidBeats: string[] = []     // beats already shown — carried into each single-shot narrate call
  let firstBeatAt = 0                // when the user first saw anything, so the opening gap is measurable
  let firstActivityAt = 0            // when the AGENT first did anything — the other half of that gap
  let agentAskedAt = 0               // when we actually handed the question over, so THINKING time is separable
  try {
    const analyst = await analystSlot.get()
    // Tell the UI how to render this harness's stream. claude-code now has BOTH: a STRUCTURED event view
    // (from its JSONL transcript — the default) AND the raw PTY terminal (on demand). So announce 'events'
    // when the session exposes events() (claude + codex), plus `pty:true` when a raw terminal is available
    // (claude only) so the UI can offer a "Terminal" toggle. A pure event harness (codex) has no PTY.
    // Both lanes announce themselves (agent:hello). Composer runs first (events-only, read-only); the analyst
    // lane declares its raw-terminal capability + interactive controls so the UI can offer them generically.
    emit(reply, A('hello', 'composer', { label: 'Composer', hue: '#4a90d9', streamKind: 'events', pty: false, interactive: false, sid }))
    emit(reply, A('hello', 'analyst', { label: 'Analyst', hue: '#c08a2b', streamKind: analyst.session.events ? 'events' : (analyst.session.kind ?? 'events'), pty: analyst.session.kind === 'pty', interactive: true, controls: ['terminal', 'compact', 'new'], sid }))
    // Kick off the narration: an immediate opener, then every few seconds translate whatever the analyst just did
    // into ONE business line. Overlap-guarded (skip a tick if the previous narrate is still running).
    // The deepseek NARRATOR runs for BOTH agents — it is the only source of user-facing progress there is.
    // The route is fixed: every question goes to the composer, which escalates to the analyst when it must,
    // and the narrator covers the whole of it.
    const startNarrator = () => {
      narrator = createNarrator({ cwd: WORKSPACE })
      // Which context strategy this turn ran under, said once per question — an A/B is only worth running if
      // you can tell afterwards which arm produced the beats you were reading.
      console.log(`[beat] narrator context = ${narrator.context}`)
      narrationTimer = setInterval(async () => {
        if (stopped || narrating || !reply || narrationBuf.length === 0) return
        narrating = true
        const activity = narrationBuf.splice(0).join('\n')
        // TIMED IN THREE PARTS, because "the narrator is slow" can mean any of them and they have different
        // fixes. `waited` is taken BEFORE the call, so it already excludes the call — subtracting it again
        // reported a negative wait.
        // fixes: how long before there was anything to narrate at all (the agent had not done anything yet),
        // how long the narrating model took, and the total to the first line the user sees.
        const waited = Date.now() - t0
        const callT0 = Date.now()
        try {
          // TIMEOUT the narrate call so a hung beat (deepseek) can't freeze narration (finally never running).
          const line = await Promise.race([narrator!.narrate(question, activity, saidBeats.slice(-3)), new Promise<null>((res) => setTimeout(() => res(null), 20000))])
          const callMs = Date.now() - callT0
          console.log(`[beat] ${line ? 'wrote' : 'produced nothing'} in ${callMs}ms · activity ${activity.length} chars · ${firstBeatAt ? `+${((Date.now() - t0) / 1000).toFixed(1)}s into the turn` : `FIRST BEAT at +${((Date.now() - t0) / 1000).toFixed(1)}s (${(((firstActivityAt || Date.now()) - t0) / 1000).toFixed(1)}s of it before the agent did anything)`}`)
          if (line) {
            if (!firstBeatAt) firstBeatAt = Date.now()
            saidBeats.push(line)
            emitBeat(reply, line, qid, sid)
            if (channel) emit({ type: 'channel' }, { t: 'channel:narration', channel, qid, text: line })   // stream to the chat channel (Teams/…)
          }
        } catch { /* narration is best-effort */ } finally { narrating = false }
      }, 4000)
    }
    // Whose events these are — the composer runs first, the analyst only if it escalates. Every event/progress
    // line carries `agent` so the UI can colour + separate composer vs analyst, and interleave the narrator.
    let currentAgent: 'composer' | 'analyst' = 'composer'
    // When each in-flight step began, by event id — drained as each completes, so it holds only what is running.
    const stepStarted = new Map<string, number>()
    // Agent-LOG emission: the engine LABELS each structured event / PTY chunk with its channel (composer-log while
    // the composer runs, analyst-log while the analyst runs) + the qid, and sends it ONCE. The DO fans it to the
    // OWNER's attached devices only (never another user, never a device that didn't attach). The engine no longer
    // tracks who's watching — that decision moved to the DO.
    const emitLog = (msg: any) => emit({ type: 'log', channel: currentAgent === 'composer' ? 'composer-log' : 'analyst-log' }, { ...msg, qid, sid, agent: currentAgent })
    // The QUESTION is a unit boundary IN the lane stream — emitted to both lanes up front, keyed by qid. Being
    // real lane data (not a UI-synthesized marker) it survives replay/reload, and any lane gets its dividers the
    // same way. The UI merges by id, so its own optimistic marker collapses into this one.
    for (const channel of ['composer-log', 'analyst-log'])
      emit({ type: 'log', channel }, A('event', channel === 'composer-log' ? 'composer' : 'analyst',
        { ev: { kind: 'user', id: qid, text: question, done: true }, qid, sid }))
    const handlers = {
      onCategory: (c: string) => { curCategory = c; emit(reply, A('status', currentAgent, { category: c, sid })) },
      onOutput: (chunk: string) => emitLog({ t: 'analyst:chunk', text: chunk }),   // raw PTY bytes → the terminal surface (own protocol, not a lane frame)
      onNarration: (text: string) => {
        if (!reply) return
        // A progress line the ENGINE raises on the agent's behalf (e.g. the composer's "Running the numbers…").
        // Agents do not narrate themselves — the deepseek narrator does that, for both of them. During the
        // composer phase such a line is a business beat; during the analyst's it is a side progress line.
        if (currentAgent === 'composer') emitBeat(reply, text, qid, sid)
        else emit(reply, A('status', 'analyst', { progress: text, sid }))
      },
      // Structured events (codex/SDK harnesses only — claude PTY uses onOutput above). The session already
      // normalizes + buffers these (session.events()); the engine just mirrors each one live to the asker and
      // any attached viewers, same as onOutput. Reconnect replay is handled in resyncAnalyst via events().
      onEvent: (ev: AgentEvent) => {
        // TIME every step in ONE place, so every harness is measured the same way and the numbers are
        // comparable. A command spans two events (in_progress → completed); the duration belongs on the one
        // that closes it.
        ev.at ??= Date.now()
        if (ev.kind === 'command' && ev.id) {
          if (ev.done || ev.status === 'completed' || ev.status === 'failed') {
            const startedAt = stepStarted.get(ev.id)
            if (startedAt !== undefined) { ev.ms ??= ev.at - startedAt; stepStarted.delete(ev.id) }
          } else if (!stepStarted.has(ev.id)) stepStarted.set(ev.id, ev.at)
        }
        emitLog(A('event', currentAgent, { ev }))   // structured event → the agent's log channel (composer-log / analyst-log)
        // Narrator digest — feed ONLY the business signal: commands + their RESULTS (query outputs = the
        // findings) and the analyst's own prose. SKIP file events (program code / diffs / paths) — that's pure
        // machinery the narrator must hide anyway: big input bloat + a leak risk, with no business value (every
        // real figure is already in a command's result).
        // Feed the narrator the SIGNAL only: the analyst's own PROSE (already business-ish), plus the OUTPUT of a
        // genuine DATA RUN (a tsx/node query). NEVER feed raw command text or file-read/plumbing output (cat/ls/
        // grep… = machinery) — it's noise, and it tempts the model to echo tool-call syntax (the Teams DSML leak).
        // The analyst's prose often EMBEDS program source/diffs while it explains its code — strip that out so the
        // narrator never even sees machinery (defence in depth with isCleanBeat on the output side).
        if (!firstActivityAt && (ev.kind === 'message' || ev.kind === 'command')) {
          firstActivityAt = Date.now()
          // THE AGENT'S OWN LATENCY, measured from the moment it was handed the question rather than from the
          // start of the turn — everything before that is ours (retrieval, warm-up) and is already timed above.
          // This number alone is the model thinking before it does anything.
          const thinking = agentAskedAt ? firstActivityAt - agentAskedAt : -1
          console.log(`[beat] agent's first action at +${((firstActivityAt - t0) / 1000).toFixed(1)}s into the turn` +
            (thinking >= 0 ? ` · ${(thinking / 1000).toFixed(1)}s of thinking after being asked` : '') +
            ` (${ev.kind}) — nothing could be narrated before this`)
        }
        if (ev.kind === 'message' && ev.text?.trim()) { const prose = stripCode(ev.text); if (prose) narrationBuf.push(prose.slice(0, 600)) }
        else if (ev.kind === 'command') {
          // Is the AGENT running a program right now? Its own run.mjs invocations cannot stamp the spool with
          // whose turn they are, so this flag is what lets an unstamped line be attributed — and only when this
          // is the one session with a run in flight. See ownsProgramEvent.
          if (/\brun\.mjs\b/.test(String((ev as { command?: string }).command ?? ''))) {
            const t = inflight.get(sid)
            if (t) t.agentRunningProgram = ev.status !== 'completed' && ev.status !== 'failed'
          }
          // WHAT IT IS DOING — every command, as one short line. This used to be withheld entirely, and the
          // opening of a turn is mostly exploration (find-schema, a listing, reading a program), so for the
          // first stretch of every question the buffer stayed empty and the narrator had nothing to say. That
          // silence is what reads as the system being slow: it is working, and saying nothing about it.
          const cmd = ev.command?.trim().replace(/\s+/g, ' ')
          if (cmd && cmd !== lastDoing) { lastDoing = cmd; narrationBuf.push(('DOING: ' + cmd).slice(0, 200)) }
          // WHAT CAME BACK — only for a genuine data call. A file read's output is program source, and feeding
          // source to a small model is how program text once reached a user's screen; the command line above
          // already says a file was read, which is the part the narrator needs.
          if (ev.output?.trim() && isDataCall(ev.command)) narrationBuf.push(('RESULT: ' + capResultData(ev.output)).slice(0, 1800))
        }
      },
    }
    // The analyst does its OWN search (find-concept) and is a strong model (Sonnet),
    // so we deliberately do NOT hand it the engine's "closest program" pointer. That pointer is a RANK-based RRF
    // top, not a real-relevance match, and injecting it ANCHORED the analyst onto look-alike programs (e.g. an
    // actual-billable-hours program for a forecast question). The analyst starts from the question alone; only the
    // faster composer gets the candidate list.
    // LAST-RESORT backstop, deliberately BIG. The real fix for stuck turns is the prompt (foreground-only, no
    // background/sub-agents — see generate-system.ts). But if claude STILL wedges — a query in a retry loop, or
    // a background step it waits on — its "done" signal never fires and ask() would hang forever (the user sees
    // narration but never an answer). This cap is a safety net, NOT a guillotine: it's set high so a legitimately
    // slow question is never cut, and when it DOES fire it recovers the answer the agent almost certainly already
    // wrote to out/<qid>/answer.json (so a completed-but-not-signalled answer is never lost) and resets the stuck
    // session so the next question starts clean. Tune via ANALYST_MAX_TURN_MS.
    const MAX_TURN_MS = Number(process.env.ANALYST_MAX_TURN_MS) || 30 * 60 * 1000
    const TIMED_OUT = Symbol('analyst-timeout')
    let r: any
    // ── SYSTEM 2 FIRST: the COMPOSER composes this from existing concepts (fast, cheap). It shares this workspace
    // and writes the same out/<qid>/{built,answer}.json, so a composed result flows through the IDENTICAL
    // post-processing below. Skip for a MODIFY (the composer doesn't edit). On escalation → the analyst (System 3).
    let authoredBy: 'composer' | 'analyst' = 'analyst'
    let escalateReason: string | undefined   // the composer's note on WHY it escalated — handed to the analyst as a non-authoritative hint
    // ── EXPLAIN — report on the answer on screen, then stop. ────────────────────────────────────────────────
    // Placed INSIDE this try so the return runs the finally (which clears the keepalive and, crucially, the
    // busy flag — returning from outside it would leave the chat wedged on "already answering").
    //
    // It returns BEFORE the persistence below on purpose. An explain turn must leave no answer row, no intent
    // node and no program: the graph is the retrieval substrate, and an "explain: …" node in it could later be
    // matched and hand somebody an explanation when they asked for a number.
    //
    // No narrator either. It exists to translate a long silent build into progress; an explanation is a short
    // read of files that ends in the text itself, so a second model inventing progress lines over the top of it
    // would be pure noise. The liveness tick still says we are alive.
    if (explicitExplain) {
      if (!explainTarget) {
        emit(reply, { t: 'analyst:answer', category: 'analysis', sid, qid, timing: { ms: Date.now() - t0 },
          answer: { status: 'answered', category: 'analysis', answer: VERBS.explain.nothingToActOn } })
        return
      }
      currentAgent = 'composer'
      const composer = await getComposer(sid)
      // SEND EVERY EVENT, LET THE CLIENT CHOOSE. An explain turn IS the agent talking, so its events belong in
      // the conversation rather than in an agent lane somebody has to go and attach to. All of them go — a
      // message, a tool call, a file read — as `verb:event`, and the client renders what it wants: today
      // only `kind: 'message'`, which is the explanation itself. Showing the tool calls becomes a client
      // change with nothing to alter here.
      //
      // This is explain ONLY. An ordinary question does not push its events at the asker; those stay in the
      // agent lanes, for whoever has chosen to watch one.
      const streamed = { ...handlers, onEvent: (ev: any) => {
        handlers.onEvent?.(ev)                       // the agent lane still gets it, exactly as before
        emit(reply, { t: 'verb:event', verb: 'explain', ev, qid, sid })
      } }
      workingAgent = 'composer'; stopSession = () => { try { (composer as any).session?.reset?.() } catch { /* best-effort */ } }
      const c = await composer.ask(question, streamed, { qid, explain: explainTarget, raw: askedRaw })
      if (stopped) return                                     // stopThisTurn already told the user
      const cat = VERBS.explain.category
      const timing = { ms: Date.now() - t0 }
      lastAnswer = c.answer; lastTiming = timing; lastCategory = cat
      console.log(`[ica] explain · ${(c.ms / 1000).toFixed(1)}s · ${explainTarget.programDir}`)
      emit(reply, { t: 'analyst:answer', category: cat, answer: c.answer, timing, sid, qid })
      if (channel) emit({ type: 'channel' }, { t: 'channel:answer', channel, qid, answer: c.answer, category: cat })
      return
    }

    // ── RUN — the program again, and its answer. Nothing else. ─────────────────────────────────────────────
    // Deliberately NOT check:. "What is it now?" and "has it changed?" are different questions, and answering
    // the first with a diff hands back a comparison nobody asked for, with the figures it is about left out.
    // No model here either: the program and its parameters are both recorded, so this is execution and nothing
    // more.
    if (explicitRun) {
      const found = resolveProgramSubject(verb!.rest, subjectLookups)
      if ('error' in found) {
        console.log(`[ica] run — ${found.error}`)
        emit(reply, { t: 'analyst:answer', category: VERBS.run.category, sid, qid, timing: { ms: Date.now() - t0 },
          answer: { status: 'answered', category: VERBS.run.category, answer: found.error } })
        return
      }
      const { programDir: dir, params, question: subjectQ, qid: subjectQid } = found.subject
      const beat = (text: string) => emit(reply, { t: 'verb:event', verb: 'run', ev: { kind: 'message', text, done: true }, qid, sid })
      beat(`Running ${dir}${params && Object.keys(params as any).length ? ` with ${JSON.stringify(params)}` : ''}.`)
      let answer: any
      const runT0 = Date.now()
      try {
        const rr = await execProgram(WORKSPACE, dir, params, { qid, sid })
        answer = answerView(rr.output)
        answers.recordRun({ programDir: dir, qid, question: subjectQ ?? question, params, status: answer.status, shapeHash: (rr as any).finalShapeHash, ms: Date.now() - runT0 })
        // The answer as the program returned it, with one line saying where it came from — a re-run should
        // look like the answer, because that is what it is.
        const ran = `Re-ran \`${dir}\` · ${((Date.now() - runT0) / 1000).toFixed(1)}s`
        answer = { ...answer, scope: answer.scope ? `${answer.scope} · ${ran}` : ran }
        // It becomes what is on screen, so explain:/edit:/check: act on it — carrying the ORIGINAL qid, not
        // this turn's, because that is the row holding the saved answer a later check: compares against.
        if (subjectQid) setOnScreen(sid, { qid: subjectQid, question: subjectQ ?? question, programDir: dir, params })
        console.log(`[ica] run · ${dir} · ${((Date.now() - runT0) / 1000).toFixed(1)}s`)
      } catch (e: any) {
        answer = { status: 'answered', category: VERBS.run.category,
          answer: `**It no longer runs.** \`${dir}\` failed:\n\n\`\`\`\n${String(e?.message ?? e).slice(0, 600)}\n\`\`\`` }
        console.log(`[ica] run · ${dir} · FAILED TO RUN · ${String(e?.message ?? e).slice(0, 120)}`)
      }
      const timing = { ms: Date.now() - t0 }
      const cat = VERBS.run.category
      lastAnswer = answer; lastTiming = timing; lastCategory = cat
      emit(reply, { t: 'analyst:answer', category: cat, answer, timing, sid, qid })
      if (channel) emit({ type: 'channel' }, { t: 'channel:answer', channel, qid, answer, category: cat })
      return
    }

    // ── CHECK — re-run the same program with the same parameters and report what moved. ─────────────────────
    // No agent at all: running the program is computation and comparing the numbers is arithmetic. A model here
    // would be the one part of the answer nobody could check.
    if (explicitCheck) {
      // WHICH PROGRAM — the answer on screen, or one the user named after the colon (a question id, or a
      // program name). Both are lookups in tables we already keep, so re-running any past answer costs no
      // model: an answer row carries the programDir AND the params it was run with.
      const found = resolveProgramSubject(verb!.rest, subjectLookups)
      if ('error' in found) {
        console.log(`[ica] check — ${found.error}`)
        emit(reply, { t: 'analyst:answer', category: VERBS.check.category, sid, qid, timing: { ms: Date.now() - t0 },
          answer: { status: 'answered', category: VERBS.check.category, answer: found.error } })
        return
      }
      const { programDir: dir, params, baseline } = found.subject
      // Check has no agent, so nothing produces events for it — the engine says what it is doing itself, on the
      // same channel and in the same shape as an agent turn. The user asked for this by name; they should see
      // it working whether or not a model happens to be involved.
      const beat = (text: string) => emit(reply, { t: 'verb:event', verb: 'check', ev: { kind: 'message', text, done: true }, qid, sid })
      beat(baseline ? `Re-running ${dir} with the parameters it was answered with.` : `Running ${dir}.`)
      let answer: any
      const runT0 = Date.now()
      try {
        const rr = await execProgram(WORKSPACE, dir, params, { qid, sid })
        const now = answerView(rr.output)
        let diff: CheckDiff | undefined
        if (baseline) { beat('Comparing what came back against the saved answer.'); diff = diffAnswers(baseline.answer, now) }
        answers.recordRun({ programDir: dir, qid, question, params, status: now.status, shapeHash: (rr as any).finalShapeHash, ms: Date.now() - runT0 })
        // The fresh answer IS the card; the comparison rides on top of it as a first section. We ran the
        // program to compare it, so withholding the result it produced would be describing figures the reader
        // cannot see — and re-running to SEE the current numbers is half of why anyone presses this.
        answer = checkAnswer(checkReport({ programDir: dir, params, answeredAt: baseline?.createdAt, ms: Date.now() - runT0, diff }), dir, now)
        console.log(`[ica] check · ${dir} · ${diff ? (diff.changed ? `${diff.movements.length} moved` : 'unchanged') : 're-run, no baseline'} · ${((Date.now() - runT0) / 1000).toFixed(1)}s`)
      } catch (e: any) {
        // A program that no longer runs is itself the finding, and the most important one check can report.
        answer = checkAnswer(`**It no longer runs.** Re-running \`${dir}\`${baseline ? ' with the parameters it was answered with' : ''} failed:\n\n\`\`\`\n${String(e?.message ?? e).slice(0, 600)}\n\`\`\`\n\nAnything already on screen was produced before this broke, so it is still what it was — but the program behind it cannot be re-run as it stands.`, dir)
        console.log(`[ica] check · ${dir} · FAILED TO RUN · ${String(e?.message ?? e).slice(0, 120)}`)
      }
      const timing = { ms: Date.now() - t0 }
      const cat = VERBS.check.category
      lastAnswer = answer; lastTiming = timing; lastCategory = cat
      emit(reply, { t: 'analyst:answer', category: cat, answer, timing, sid, qid })
      if (channel) emit({ type: 'channel' }, { t: 'channel:answer', channel, qid, answer, category: cat })
      return
    }

    // ── VIEW — look at one thing. ───────────────────────────────────────────────────────────────────────────
    // The one verb that names its own subject rather than acting on what is on screen, and the one that
    // reuses by KEY: (kind, lens) is a directory, so finding the program is existsSync and nothing more. Built
    // once per pair, then run with no model involved for every entity of that kind, ever.
    if (explicitView) {
      const v = parseView(question)
      if (!v) {
        emit(reply, { t: 'analyst:answer', category: VERBS.view.category, sid, qid, timing: { ms: Date.now() - t0 },
          answer: { status: 'answered', category: VERBS.view.category, answer: VERBS.view.nothingToActOn } })
        return
      }
      const existing = findView(WORKSPACE, v)
      const dir = existing ?? viewDir(v)
      const params = { id: v.id }
      const say = (text: string) => emit(reply, { t: 'verb:event', verb: 'view', ev: { kind: 'message', text, done: true }, qid, sid })

      // BUILD, only the first time this (kind, lens) is ever asked for.
      if (!existing) {
        console.log(`[ica] view → ${dir} does not exist yet · building it once`)
        say(`No ${v.lens === 'canonical' ? '' : v.lens + ' '}view of a ${v.type} yet — building one. It will be instant from now on.`)
        startNarrator()
        currentAgent = 'composer'
        const composer = await getComposer(sid)
        workingAgent = 'composer'
        stopSession = () => { try { (composer as any).session?.reset?.() } catch { /* best-effort */ } }
        const built = await composer.ask(viewLabel(v), handlers, { qid, sid, build: viewPrompt({ v, dir, builtRel: `./out/${qid}/built.json` }) })
        if (stopped) return
        if (built.escalate || !findView(WORKSPACE, v)) {
          // FAIL LOUDLY, AND LEAVE NOTHING BEHIND. A giving-up build still writes files — an observed one left
          // a well-formed program.ts calling three units, having written one. findView only asks whether
          // program.ts exists, so the next click would have found that and run it. A directory that exists is
          // taken as a built view, so a build that did not finish must not leave one.
          await rm(join(WORKSPACE, dir), { recursive: true, force: true }).catch(() => {})
          const why = built.escalate?.reason ?? 'the program was not written where it was asked for'
          console.log(`[ica] view → could not build ${dir} · ${why}`)
          emit(reply, { t: 'analyst:answer', category: VERBS.view.category, sid, qid, timing: { ms: Date.now() - t0 },
            answer: { status: 'cannot_answer', category: VERBS.view.category, answer: `I could not build a view of a ${v.type} — ${why}` } })
          return
        }
      }

      // RUN it — the path every asking after the first takes, and the first one too once it is built.
      let answer: any
      const runT0 = Date.now()
      try {
        const rr = await execProgram(WORKSPACE, dir, params, { qid, sid })
        answer = answerView(rr.output)
        answers.recordRun({ programDir: dir, qid, question: viewLabel(v), params, status: answer.status, shapeHash: (rr as any).finalShapeHash, ms: Date.now() - runT0 })
        console.log(`[ica] view · ${dir} · ${existing ? 'reused' : 'built'} · ${((Date.now() - runT0) / 1000).toFixed(1)}s`)
      } catch (e: any) {
        console.log(`[ica] view · ${dir} · FAILED TO RUN · ${String(e?.message ?? e).slice(0, 160)}`)
        answer = { status: 'cannot_answer', category: VERBS.view.category,
                   answer: `The view of ${viewLabel(v)} failed to run: ${String(e?.message ?? e).slice(0, 300)}` }
      }
      const timing = { ms: Date.now() - t0 }
      lastAnswer = answer; lastTiming = timing; lastCategory = VERBS.view.category
      // A view IS an answer, so it becomes what is on screen — which is what lets `edit:` improve it, and
      // `explain:`/`check:`/`program:` act on it, with no special case for views anywhere.
      answers.save({ qid, sessionId: sid, question: viewLabel(v), norm: normalizeQuestion(viewLabel(v)), category: VERBS.view.category,
        status: answer.status ?? 'error', answer, createdAt: Date.now(), finishedAt: Date.now(), programDir: dir, params, build: await buildIdentity(), route: 'view' })
      setOnScreen(sid, { qid, question: viewLabel(v), programDir: dir, params })
      emit(reply, { t: 'analyst:answer', category: VERBS.view.category, answer, timing, sid, qid })
      if (channel) emit({ type: 'channel' }, { t: 'channel:answer', channel, qid, answer, category: VERBS.view.category })
      return
    }

    // ── PROGRAM — show the source behind the answer on screen. ──────────────────────────────────────────────
    // Reading files: no agent, no narrator, nothing persisted. The program stops being something you have to
    // open the admin console to read.
    //
    // No walking back through the session to find it, either: explain/check/program never persist and never
    // move the position, so `pos` still points at the last real question even after several of them in a row.
    if (explicitProgram) {
      const dir = target?.programDir
      if (!dir) {
        console.log('[ica] program, but there is nothing on screen with a program behind it')
        emit(reply, { t: 'analyst:answer', category: VERBS.program.category, sid, qid, timing: { ms: Date.now() - t0 },
          answer: { status: 'answered', category: VERBS.program.category, answer: VERBS.program.nothingToActOn } })
        return
      }
      const files = await collectProgramFiles(WORKSPACE, dir)
      const answer = programAnswer(dir, files, target?.params)
      const timing = { ms: Date.now() - t0 }
      lastAnswer = answer; lastTiming = timing; lastCategory = VERBS.program.category
      console.log(`[ica] program · ${dir} · ${files.length} file(s)`)
      emit(reply, { t: 'analyst:answer', category: VERBS.program.category, answer, timing, sid, qid })
      if (channel) emit({ type: 'channel' }, { t: 'channel:answer', channel, qid, answer, category: VERBS.program.category })
      return
    }

    // The narrator is ALWAYS-ON for a question: it turns whichever agent is working (the composer, then the
    // analyst on escalation) into the live progress the user follows. Agents write nothing user-facing.
    startNarrator()
    {
      // The COMPOSER handles both a fresh question (compose/reuse) AND a MODIFY (edit the current program in
      // place). It escalates only when it genuinely can't — then the analyst takes over.
      const readyT0 = Date.now()
      const composer = await getComposer(sid)
      // WHERE THE OPENING SILENCE GOES. A cold composer has to build its workspace, assemble a large system
      // prompt and open a session before the model is even asked; a warm one is instant. Logged apart from the
      // model's own first-token latency, because only one of the two is ours to fix.
      console.log(`[ica] composer ready in ${Date.now() - readyT0}ms (question → composer: ${Date.now() - t0}ms)`)
      agentAskedAt = Date.now()
      workingAgent = 'composer'; stopSession = () => { try { (composer as any).session?.reset?.() } catch { /* best-effort */ } }
      // CAPPED, like the analyst below. This await was unbounded: a composer that never returned held the
      // session's busy flag for good, and every later question in that chat was refused with "already
      // answering". The cap is generous — it exists so a turn always ends, not to hurry one along.
      const cAsk = composer.ask(question, handlers, { qid, sid, candidates: programCandidates, modify: modifyTarget ?? undefined, resolvedQuestion })
      cAsk.catch(() => {})   // if we abandon it, don't leak an unhandled rejection
      let cCap: ReturnType<typeof setTimeout> | undefined
      const cRaced: any = await Promise.race([cAsk, new Promise((res) => { cCap = setTimeout(() => res(TIMED_OUT), MAX_TURN_MS) })])
      if (cCap) clearTimeout(cCap)
      if (cRaced === TIMED_OUT) {
        log.warn('composer', `turn exceeded ${(MAX_TURN_MS / 1000) | 0}s for ${qid} — escalating to the analyst and resetting the stuck session`)
        try { (composer as any).session?.reset?.() } catch { /* best-effort */ }
      }
      const c: any = cRaced === TIMED_OUT ? { escalate: { reason: 'the composer did not finish in time' }, ms: Date.now() - t0 } : cRaced
      if (c.escalate) { escalateReason = c.escalate.reason; console.log(`[ica] composer → escalate · ${c.escalate.reason}`) }
      else {
        authoredBy = 'composer'
        r = { answer: c.answer, category: c.category ?? 'analysis', ms: c.ms, lastLines: c.lastLines ?? '' }
        console.log(`[ica] composer${modifyTarget ? ' (modify)' : ''} · ${(c.ms / 1000).toFixed(1)}s · status=${c.answer?.status ?? 'no-json'}`)
      }
    }
    if (!r) {   // composer escalated → the analyst (System 3) handles it (build or modify)
      currentAgent = 'analyst'
      emit(reply, A('status', 'analyst', { progress: 'Handing off to the analyst for deeper analysis…', sid }))
      workingAgent = 'analyst'; stopSession = () => { try { (analyst as any).session?.reset?.() } catch { /* best-effort */ } }
      const askP = analyst.ask(question, handlers, { qid, reason: escalateReason, modify: modifyTarget ?? undefined, resolvedQuestion })
      askP.catch(() => {})   // if we abandon it on timeout, don't leak an unhandled rejection
      let capT: ReturnType<typeof setTimeout> | undefined
      const raced: any = await Promise.race([askP, new Promise((res) => { capT = setTimeout(() => res(TIMED_OUT), MAX_TURN_MS) })])
      if (capT) clearTimeout(capT)
      if (raced === TIMED_OUT) {
        const recovered = await readJsonSafe<any>(join(WORKSPACE, 'out', qid, 'answer.json'), null, 'analyst')
        log.warn('analyst', `turn exceeded ${(MAX_TURN_MS / 1000) | 0}s for ${qid} — ${recovered ? 'recovered the written answer' : 'nothing written'}; resetting the stuck session`)
        try { (analyst as any).session?.reset?.() } catch { /* best-effort */ }
        r = { answer: recovered ?? { status: 'error', answer: 'That one took too long and was stopped — please try again.' }, category: recovered?.category ?? 'analysis', ms: Date.now() - t0, lastLines: '' }
      } else r = raced
      console.log(`[ica] analyst · ${r.category} · ${(r.ms / 1000).toFixed(1)}s · status=${r.answer?.status ?? 'no-json'}`)
    }

    // The analyst is self-sufficient: it answers from the semantic model when a unit/concept fits, and does
    // its OWN analysis over the data when nothing fits. It NEVER blocks on the model-builder — the modeler is
    // now an OFFLINE consolidation pass (System 4) that studies the stream of finished answers and grows the
    // model behind the scenes. So there is no synchronous gap loop here anymore; the analyst's answer is final.

    // Timing metadata for the answer card: total wall time.
    // STOPPED — go no further. The user's answer already went out from stopThisTurn; what must NOT happen is
    // everything below: an answer row, an intent node, an embedding, a program node. A question somebody
    // abandoned should leave the model exactly as it found it, or it becomes a reusable answer to a question
    // nobody wanted answered.
    //
    // The record of the stop goes in the question's own folder, beside whatever the agent had written, so it
    // is visible where anyone debugging this question is already looking.
    if (stopped) {
      await writeFile(join(WORKSPACE, 'out', qid, 'stopped.json'),
        JSON.stringify({ at: Date.now(), reason: stopped, afterMs: Date.now() - t0, agent: workingAgent, question }, null, 2))
        .catch(() => { /* the folder may not exist if we stopped before the agent ran */ })
      console.log(`[ica] ${qid.slice(0, 8)} stopped after ${((Date.now() - t0) / 1000).toFixed(1)}s — nothing persisted`)
      return
    }
    const timing = { ms: Date.now() - t0 }
    lastAnswer = r.answer; lastTiming = timing; lastCategory = r.category
    // Capture the PROGRAM the agent built (its built.json pointer) so a repeat of this question re-runs
    // that program (fresh query) instead of re-invoking the LLM.
    let programDir: string | undefined, programParams: any, programTerms: any[] = [], programFollowups: string[] = []
    let programCanonical: string[] = []   // what the program ANSWERS, in question form — the retrieval substrate
    const b = await readJsonSafe<any>(join(WORKSPACE, 'out', qid, 'built.json'), null, 'analyst')   // absent = unknowable/gap (no program)
    if (b) { programDir = b.programDir; programParams = b.params; programTerms = Array.isArray(b.terms) ? b.terms : []; programFollowups = Array.isArray(b.followups) ? b.followups.filter((x: any) => typeof x === 'string' && x.trim()).slice(0, 3) : []
             programCanonical = Array.isArray(b.canonicalQuestions) ? b.canonicalQuestions.filter((x: any) => typeof x === 'string' && x.trim()).map((x: string) => x.trim()).slice(0, 3) : [] }
    // NB: r.lastLines (the raw claude PTY tail — a garbled, cursor-addressed terminal snapshot) is deliberately NOT
    // sent to the client. It has no user value, isn't stored, and shipping ~20KB of raw terminal per answer is a
    // standing leak risk (a client that didn't strip it would render it). The clean answer is r.answer.
    // NEVER SHIP A SHAPE THE UI CANNOT DRAW — and never do it silently. This is the last point before the
    // answer becomes what the user sees and what the database keeps.
    // Checked here because EVERY route lands on this line — composer, analyst, recovered-after-timeout. The
    // first version of this check only ran on the analyst's answer, and the bug that reached the user came
    // back through the composer.
    const shapeProblem = answerShapeProblem(r.answer)
    if (shapeProblem) console.error(`[answer] SHAPE PROBLEM for qid=${qid} (${authoredBy ?? 'unknown'}): ${shapeProblem}`)
    emit(reply, { t: 'analyst:answer', category: r.category, answer: r.answer, timing, sid, qid, shapeProblem: shapeProblem || undefined })
    if (channel) emit({ type: 'channel' }, { t: 'channel:answer', channel, qid, answer: r.answer, category: r.category })   // durable delivery to the chat channel
    // Follow-ups are NICE-TO-HAVE — emitted AFTER the answer, never gating or delaying it. The UI reveals them on
    // a delay so the user reads the answer first. Persisted on the node below → free on a later reuse (no analyst).
    if (programFollowups.length && reply) emit(reply, { t: 'followups', items: programFollowups, qid, sid })
    // PERSIST: the engine reads the agent's file result and writes the DB — the agent never touches the DB.
    // finishedAt is stamped HERE, deterministically, the moment the analyst's artifact is in hand — this is
    // the cursor the offline modeler consolidates by (never a time the agent self-reports).
    // For a MODIFY the answer belongs to the ORIGINAL question, not to the edit instruction — nobody asked
    // "make it top 5", they asked what they asked and now want it computed differently.
    //
    // Taken from the session record. It used to require a live intent NODE as well, so an edit made when the
    // graph had moved on — or against a view, which is not in the graph at all — silently saved the answer
    // under the edit instruction as if that were the question.
    const savedQ = modifyTarget?.question ?? question
    const savedNorm = modifyTarget?.question ? normalizeQuestion(modifyTarget.question) : norm
    answers.save({ qid, sessionId: sid, question: savedQ, norm: savedNorm, category: r.category, status: r.answer?.status ?? 'error', answer: r.answer, createdAt: Date.now(), finishedAt: Date.now(), programDir: programDir ?? modifyTarget?.programDir, params: programParams, build: await buildIdentity(), route: authoredBy })
    // An EDIT keeps the question it edited: the thing on screen is still that answer, now computed differently.
    setOnScreen(sid, { qid, question: savedQ, programDir: programDir ?? modifyTarget?.programDir, params: programParams })
    // ── INTENT GRAPH ──
    let builtIntentId: string | undefined
    if (modifyTarget && curNode) {
      // MODIFY: update the CURRENT node's program IN PLACE — no new node, no new edge, position unchanged.
      // rawAnalysis (r.lastLines) intentionally NOT stored — it's a garbled TUI snapshot with little value; re-enable here if reworked.
      graph.putNode({ ...curNode, props: { ...(curNode.props as any), program: programDir ?? modifyTarget.programDir, params: programParams, category: r.category, ...(programFollowups.length ? { followups: programFollowups } : {}) } })
      builtIntentId = curNode.id
      console.log(`[ica] modified node ${pos.slice(0, 14)} in place · program ${programDir ?? modifyTarget.programDir}`)
    } else {
      // The REFLEX placed this node (reflexPlacement): 'root' (a new topic under ROOT) or an existing intent's id
      // (a follow-up of it). Default to ROOT if unset (reflex failed). Node id = hash(parent, question).
      const parent = (placement && placement !== 'root' && graph.getNode(placement)) ? placement : ROOT
      const nodeId = intentId(parent, question)
      graph.putNode({ id: nodeId, kind: 'intent', label: question.slice(0, 80), summary: question,
        // rawAnalysis (r.lastLines) intentionally NOT stored — garbled TUI snapshot, low value; re-enable here if reworked.
        props: { question: norm, category: r.category, program: programDir, params: programParams, terms: programTerms, followups: programFollowups } })
      builtIntentId = nodeId
      graph.putEdge({ from: parent, to: nodeId, type: 'follow_up' })
      // Embed-on-build: index this new intent's question for semantic reuse. Best-effort + non-blocking — the
      // answer is already emitted; a failure (or a host without the model) only means this intent isn't
      // semantically searchable, never a broken turn.
      if (vectors) void indexText(vectors, bgeEmbedder, nodeId, norm).catch(e => log.warn('semantic', `embed ${nodeId.slice(0, 14)} failed`, e))
      setPosition(sid, nodeId)
      console.log(`[ica][session] setPosition sid="${sid}" → ${nodeId.slice(0, 14)}  q="${question.slice(0, 40)}"`)
      console.log(`[ica] intent node ${nodeId.slice(0, 14)} under ${parent === ROOT ? 'ROOT' : parent.slice(0, 14)} (placed)${programDir ? ` · program ${programDir}` : ' · no program'}`)
      // OBSERVE-only: did the cheap exact-match regex agree with where the reflex placed the node?
      if (!explicitEdit) console.log(`[ica] regex-check: guessed ${rootQuestion ? 'ROOT' : 'FOLLOW-UP'} · placed ${parent === ROOT ? 'ROOT' : 'FOLLOW-UP'} → ${rootQuestion === (parent === ROOT) ? 'MATCH ✓' : 'MISMATCH ✗'}`)
    }
    // PROGRAM NODE — the program's OWN identity in the DB (kind:'program'), distinct from the question/intent
    // node. props.dir is the pointer to where the program lives; props.authoredBy records WHO wrote it —
    // engine-known and deterministic (never the LLM). Stamped ONLY here, on the analyst build/edit path —
    // never on reuse (reuse is captured separately in program_runs). Upserted by slug, so reuse/rebuild dedupe
    // to one node. Additive: the intent node keeps props.program, so the reflex catalog is unaffected.
    const authoredProgramDir = programDir ?? modifyTarget?.programDir
    if (authoredProgramDir && builtIntentId) {
      const slug = authoredProgramDir.replace(/^programs\//, '')
      // `by` = which SYSTEM/agent authored it (analyst=System 3 discovery; composer=System 2 concept-composition).
      // Deterministic + engine-known (never the LLM), so a later quality diff between authors is debuggable.
      // WHAT ACTUALLY RAN, from the one resolver, in one shape for either author. This used to read the
      // ICA_COMPOSER_* variables with a second set of fallbacks, so on a box that set none of them the record
      // named a harness and model the composer had never run.
      const authoredMeta = { by: authoredBy, ...agentConfig(authoredBy === 'composer' ? 'composer' : 'analyst'), at: Date.now() }
      // canonicalQuestions accumulate on the PROGRAM (not the intent): they describe what this program answers,
      // and a program can be reached by several phrasings. Union with what's already there, so a rebuild/modify
      // ADDS a phrasing rather than dropping the ones already known. The user's real question is kept too — the
      // writer's canonical form can encode its own misreading, so the phrasing actually asked stays in the index.
      // Three sources, unioned: what the WRITER declared, the ENGINE's own canonical form of what was asked (so a
      // later variant matches even when the writer phrased its form differently), and the raw question (the
      // writer's canonical form can encode its own misreading; the words actually typed stay in the index).
      const priorCanon: string[] = ((graph.getNode(`prog:${slug}`)?.props as any)?.canonicalQuestions ?? []) as string[]
      // The composer declares this turn's canonical form in built.json (programCanonical); there is no separate
      // canonicaliser any more, so the raw question is the only other form guaranteed to be here.
      const canonical = Array.from(new Set([...priorCanon, ...programCanonical, question.trim()].filter(Boolean)))
      graph.putNode({ id: `prog:${slug}`, kind: 'program', label: slug, summary: authoredProgramDir,
        props: { dir: authoredProgramDir, authoredBy: authoredMeta, category: r.category, canonicalQuestions: canonical } })
      graph.putEdge({ from: builtIntentId, to: `prog:${slug}`, type: 'program' })
      console.log(`[ica] program ${slug} answers ${canonical.length} question form(s)${programCanonical.length ? '' : ' (writer declared none — user question only)'}`)
      recordConceptsUsed(slug, qid, b?.usedConcepts)
    }
    // No explicit wake needed — the always-running consolidation timer picks this up on its next tick. That
    // is deliberate: the timer, not this signal, is the guarantee (it survives restarts and missed signals).
  } catch (e: any) {
    lastAnswer = { status: 'cannot_answer', answer: `Failed: ${e?.message ?? e}`, missing: 'engine error' }
    emit(reply, { t: 'analyst:answer', answer: lastAnswer, sid })
  } finally {
    if (keepalive) { clearInterval(keepalive); keepalive = null }
    if (narrationTimer) { clearInterval(narrationTimer); narrationTimer = null }
    try { narrator?.stop() } catch { /* best-effort */ }
    narrator = null
    curQuestion = ''
    emit(reply, A('status', 'analyst', { state: 'done', sid }))
    analystSlot.persist()   // capture the live ids (incl. any resume-fallback)
    busySessions.delete(sid)
    if (inflight.get(sid)?.qid === qid) inflight.delete(sid)   // only ours — a newer turn may already own the slot
    unwatchPrograms()
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
      store: graph, managerUrl: DATASOURCE, seedTables, only: opts.only, wipe: !!opts.rebuild,
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

// ── Semantic-model consolidation tick ─────────────────────────────────────────
// Fired by the always-running interval (below). Idempotent and cheap when there's nothing to do. It NEVER
// blocks the analyst (separate busy flags). If the concept modeller is busy with a manual build, this tick skips and
// the next one retries. When it does run, it drains ALL pending batches (a 3-day backlog is processed in
// order, 50 at a time) until nothing is left past the watermark.
// SEAM: process one batch of freshly-finished answers offline. The semantic-model modeler was removed;
// repoint this at the new learning loop (record the verified concept set per solved question + learn
// requires-edges, spec §6/§10/§11). Until then the tick is gated off by CONSOLIDATOR_WIRED.
// Hand one batch of finished analyses to the concept modeller (System 4) → it distils verified concepts.
// Streams the modeller's work to the concept-log channel; returns its timing + summary note.
async function consolidateBatch(items: any[], batchId: string, log: (m: any) => void): Promise<{ ms: number; lastLines?: string }> {
  const modeller = await modellerSlot.get()
  log(A('hello', 'modeler', { label: 'Concept Modeller', hue: '#7fae82', streamKind: modeller.session.events ? 'events' : (modeller.session.kind ?? 'events'), pty: modeller.session.kind === 'pty', interactive: false }))
  try {
    const r = await modeller.consolidate(items, batchId, {
      onEvent: (ev) => log(A('event', 'modeler', { ev })),
      onOutput: (chunk) => log(A('chunk', 'modeler', { text: chunk })),
    })
    log(A('status', 'modeler', { text: `Consolidated ${r.changed} concept(s)` }))
    return { ms: r.ms, lastLines: r.note }
  } finally { modellerSlot.persist() }
}

async function conceptConsolidateTick() {
  if (!CONSOLIDATOR_WIRED) return                              // seam disabled → inert, never advances the watermark (backlog waits)
  if (conceptConsolidating) return                            // already consolidating → no-op; next tick retries
  const wmPeek = Number(answers.getMeta(CONCEPT_CONSOLIDATE_WM_KEY) ?? '0')
  if (!answers.sinceFinished(wmPeek, 1).length) return         // nothing past the watermark → cheap exit
  conceptConsolidating = true                                 // single-runner: hold for the whole drain
  try {
    for (;;) {
      const wm = Number(answers.getMeta(CONCEPT_CONSOLIDATE_WM_KEY) ?? '0')
      const batch = answers.sinceFinished(wm)                   // finished after the watermark, oldest-first
      if (!batch.length) break
      const nextWm = String(Math.max(...batch.map((b) => b.finishedAt ?? wm)))   // where the watermark goes once this batch is done

      // Skip REPEATS: a program already consolidated needs no re-study when re-run on unchanged structure (the
      // modeler models the program's STRUCTURE, not the current numbers). Keep only programs not yet studied,
      // deduped within this batch. An answer with no program (unknowable) has nothing to consolidate.
      const already = new Set(answers.consolidatedProgramDirs(wm))
      const seenInBatch = new Set<string>()
      const fresh = batch.filter((r) => {
        if (!r.programDir || already.has(r.programDir) || seenInBatch.has(r.programDir)) return false
        seenInBatch.add(r.programDir); return true
      })
      if (!fresh.length) {
        // Nothing new — every answer here re-runs an already-consolidated program (or has no program). Advance
        // PAST them WITHOUT spending an agent run. This is the "asked again, nothing changed → don't re-model" case.
        console.log(`[concept-consolidation] ${batch.length} answer(s) since wm=${wm} — all already-consolidated repeats; skipping the modeler`)
        answers.setMeta(CONCEPT_CONSOLIDATE_WM_KEY, nextWm)
        continue
      }
      const batchId = 'b_' + Date.now().toString(36)
      const items = fresh.map((r) => ({ question: r.question, status: r.status, programDir: r.programDir, usedNodes: (r.answer as any)?.usedNodes }))
      console.log(`[concept-consolidation] ${batchId}: ${items.length} new program(s) of ${batch.length} answer(s) since wm=${wm}`)
      // Consolidation is a BACKGROUND, PROJECT-LEVEL task (no asker/qid). Its stream goes to the concept-log
      // channel; the DO delivers it to whoever ATTACHED to that channel (no owner → project-level, not user data).
      const semLog = (msg: any) => emit({ type: 'log', channel: 'concept-log' }, msg)
      semLog(A('status', 'modeler', { text: `Consolidating ${items.length} recent answer(s)…` }))
      try {
        const r = await consolidateBatch(items, batchId, semLog)
        // Advance PAST the last finished_at we consumed → those rows never re-enter a batch (strictly-greater cursor).
        answers.setMeta(CONCEPT_CONSOLIDATE_WM_KEY, nextWm)
        answers.setMeta(CONCEPT_CONSOLIDATE_FAIL_KEY, '0')     // clean pass → reset the failure streak
        console.log(`[concept-consolidation] ${batchId} done in ${(r.ms / 1000).toFixed(1)}s`)
        semLog(A('status', 'modeler', { text: 'Concepts consolidated ✓' }))
      } catch (e: any) {
        // The agent SESSION errored (a crash, not a compaction — those are handled inside consolidate()).
        // Do NOT advance the watermark yet: a transient error should be retried. But bound it — after
        // MAX_FAILS consecutive failures on the SAME batch, skip it (advance past) so a poison batch can
        // never retry forever and burn money. The skipped analyses' concepts resurface if re-asked.
        const streak = Number(answers.getMeta(CONCEPT_CONSOLIDATE_FAIL_KEY) ?? '0') + 1
        console.log(`[concept-consolidation] ${batchId} FAILED (streak ${streak}/${CONCEPT_CONSOLIDATE_MAX_FAILS}): ${e?.message ?? e}`)
        if (streak >= CONCEPT_CONSOLIDATE_MAX_FAILS) {
          console.log(`[concept-consolidation] skipping poison batch — advancing watermark past ${nextWm}`)
          answers.setMeta(CONCEPT_CONSOLIDATE_WM_KEY, nextWm); answers.setMeta(CONCEPT_CONSOLIDATE_FAIL_KEY, '0')
        } else {
          answers.setMeta(CONCEPT_CONSOLIDATE_FAIL_KEY, String(streak))
        }
        break                                                    // stop this drain; the next tick retries (or has moved on if skipped)
      }
    }
  } catch (e: any) {
    console.log(`[concept-consolidation] error: ${e?.message ?? e}`)
  } finally { conceptConsolidating = false }
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
    // reconnecting client recovers a missed answer from the durable ProjectDO answer-buffer instead.
    emit(from, A('status', 'analyst', { text: curCategory ? `Answering — ${curCategory}…` : 'Answering…', question: curQuestion, category: curCategory || undefined, sid: curSid }))
  } else if (lastAnswer) {
    emit(from, { t: 'analyst:answer', category: lastCategory, answer: lastAnswer, timing: lastTiming, sid: curSid, replay: true })
    emit(from, A('status', 'analyst', { state: 'done', sid: curSid }))
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
  else if (payload.t === 'program:forget') {   // admin → completely delete a program + its answers/runs/out, so the question rebuilds
    // Identify by programDir, question text, or a qid it produced. Deterministic, engine-owned (no LLM).
    const res = forgetProgram(answers, WORKSPACE, { programDir: payload.programDir, question: payload.question, qid: payload.qid })
    log[res.ok ? 'info' : 'warn']('engine', 'program:forget', { target: { programDir: payload.programDir, question: payload.question, qid: payload.qid }, ...res })
    emit(from, { t: 'program:forget:res', ...res })
  }
  else if (payload.t === 'suggest') { /* as-you-type — later (fast-router) */ }
}

// Boot self-check: PROVE the engine is operational (store writable + read-back, workspace present, data
// seam reachable) before we tell the hub we're ready. This is what "engine ready" in the DO can trust —
// a socket being open is not the same as the engine being able to actually answer.
async function selfCheck(): Promise<{ ok: boolean; detail: string }> {
  try {
    graph.putNode({ id: 'meta:self-check', kind: 'meta', label: 'self-check', props: { at: Date.now() } })
    if (!graph.getNode('meta:self-check')) return { ok: false, detail: 'graph read-back failed' }
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
// Semantic-model consolidation heartbeat: ALWAYS running from boot, independent of any question signal. Every
// tick it checks for analyses past the watermark and drains them — so a restart with a backlog (even days
// later, with no new question asked) still gets consolidated. A no-op while a pass is in flight or the
// modeler is otherwise busy. (This is the SEMANTIC-MODEL consolidation; other layers get their own timers.)
setInterval(() => { conceptConsolidateTick().catch((e) => console.log('[concept-consolidation] tick error:', e?.message ?? e)) }, CONCEPT_CONSOLIDATE_INTERVAL_MS)
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

// ── WHAT A PROGRAM WAS BUILT FROM ───────────────────────────────────────────────────────────────────────
// Nothing recorded this, so "have the concepts this program rests on changed since it was written" — the one
// question that decides whether reusing it is safe — could not be asked. The agent judged it instead, from a
// similarity score about the QUESTION, which says nothing about whether the program's foundations moved.
//
// TWO RECORDS, deliberately not merged:
//   opened    ./get-concept wrote a line when it was read. Mechanical, certain, and a SUPERSET — opening is
//             not using.
//   declared  the writer named it in built.json. Meaningful, and only as reliable as the writer.
// Opened-but-not-declared is a signal of its own: considered, and rejected. Collapsing the two early would
// turn a mechanical fact into an assumption, so both are kept and each edge says which it is.
//
// STALENESS NEEDS NO VERSION PINNING. A concept's live node carries `valid_from` — when THIS version became
// current — and a program node carries its own. A used concept whose valid_from is later than the program's
// has moved since; that comparison is the whole check, and it works on edges written today.
function recordConceptsUsed(slug: string, qid: string, declared: unknown): void {
  try {
    const names = new Map<string, 'declared' | 'opened' | 'both'>()
    for (const n of Array.isArray(declared) ? declared : []) {
      if (typeof n === 'string' && n.trim()) names.set(n.trim(), 'declared')
    }
    // Opens are keyed by QID, never by time: one workspace serves every question on a project, and two people
    // asking at once would otherwise have their concepts attributed to each other's programs.
    const log = join(WORKSPACE, '..', 'concept-opens.jsonl')   // engine-private, beside the DBs — see prepareWorkspace
    if (existsSync(log)) {
      for (const line of readFileSync(log, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line)
          if (e?.qid !== qid || typeof e?.name !== 'string') continue
          names.set(e.name, names.get(e.name) === 'declared' ? 'both' : 'opened')
        } catch { /* a torn line at the end of an append-only log */ }
      }
    }
    if (!names.size) return
    let written = 0
    for (const [name, how] of names) {
      // THE EDGE POINTS AT THE BODY, NOT THE NAME. A concept is content-addressed, so this reference stays
      // true when the name is later re-pointed at a different body — which is the whole reason the pointer
      // exists. The NAME rides along in the edge's props, so nothing readable is lost: a human reading
      // provenance sees "customer invoice total", and the graph still holds the exact body that was used.
      const idx = graph.getNode(`index:${name.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/(^-|-$)/g, '')}`)
      const target = (idx?.props as any)?.target
      const node = target ? graph.getNode(target) : undefined
      if (!node) continue   // a name that resolves to nothing is not an edge, it is a typo
      graph.putEdge({ from: `prog:${slug}`, to: node.id, type: 'built_from', props: { how, name, at: Date.now() } })
      written++
    }
    const by = [...names.values()]
    console.log(`[ica] program ${slug} built_from ${written} concept(s) · ${by.filter(h => h !== 'opened').length} declared · ${by.filter(h => h !== 'declared').length} opened`)
  } catch (e: any) {
    // Provenance is worth having and never worth an answer.
    console.warn(`[ica] could not record concepts for ${slug} (${e?.message ?? e})`)
  }
}

// ── IS THIS PROJECT'S CONCEPT STORE MIGRATED? ───────────────────────────────────────────────────────────
// Concepts are content-addressed and reached through `index` nodes. A database written before that change has
// concepts and no index — and every seam that finds one searches the index, so the project answers "no
// concepts" to everything. That is indistinguishable from a project that genuinely has none: no error, no
// empty result to notice, just an agent rebuilding from scratch on every question, for ever.
//
// One line at boot, because this is the only moment anyone would see it. It does not migrate on its own: a
// rewrite of every concept in a project is not something a process should decide to do while starting up.
function checkConceptIndex(): void {
  try {
    const concepts = graph.nodesByKind('concept').length
    const indexes = graph.nodesByKind('index').length
    if (concepts > 0 && indexes === 0) {
      console.error(`[ica] ✗ ${concepts} concepts and NO index — this project predates content-addressed concepts.`)
      console.error('[ica]   Every concept is invisible to ./find-concept until it is migrated. Nothing will say so again.')
      console.error(`[ica]   Fix: pnpm exec tsx apps/engine/tools/migrate-concept-index.mts ${PROJECT}          (dry run)`)
      console.error(`[ica]        pnpm exec tsx apps/engine/tools/migrate-concept-index.mts ${PROJECT} --apply`)
    }
  } catch { /* a boot check must never be the reason a boot fails */ }
}

// ── ABANDONED PROGRAM DIRECTORIES ───────────────────────────────────────────────────────────────────────
// A program becomes findable when its turn COMPLETES: built.json is read and a `prog:<slug>` node is written.
// Kill the engine mid-turn and the directory is already on disk with no node — invisible to ./find-program and
// to the engine's own search, but plainly visible to `ls`. So the agent sees a directory that looks like an
// answer to the question it is being asked, and nothing can tell it that program never ran.
//
// TWO CONDITIONS, BOTH REQUIRED, because either alone deletes working code:
//   not registered   — but view.* programs are found by FILE EXISTENCE (verbs/view.ts findView), never by a
//                      node, so they are legitimately absent from the graph. Excluded by name.
//   never ran        — run.mjs writes program.json on a successful run. Six directories here are unregistered
//                      yet ran fine, left behind by graph rebuilds; they are somebody's work and are kept.
// Only a directory that is both was abandoned before it ever produced anything.
//
// And nothing recent: a turn in flight during a restart is exactly the case that creates these, so anything
// touched in the last ten minutes is left alone rather than raced.
async function sweepAbandonedPrograms(): Promise<void> {
  const dir = join(WORKSPACE, 'programs')
  if (!existsSync(dir)) return
  const registered = new Set(graph.nodesByKind('program').map((n) => n.id.replace(/^prog:/, '')))
  const cutoff = Date.now() - 10 * 60_000
  const gone: string[] = []
  try {
    for (const name of await readdir(dir)) {
      if (name.startsWith('.') || name.startsWith('example.') || name.startsWith('view.')) continue
      if (registered.has(name)) continue
      const p = join(dir, name)
      try {
        const st = await stat(p)
        if (!st.isDirectory() || st.mtimeMs > cutoff) continue
        if (existsSync(join(p, 'program.json'))) continue   // it ran once — not abandoned, just unregistered
        await rm(p, { recursive: true, force: true })
        gone.push(name)
      } catch { /* a directory that vanished under us needs no sweeping */ }
    }
  } catch { /* unreadable programs/ is the workspace's problem, not the sweep's */ }
  if (gone.length) console.log(`[ica] removed ${gone.length} abandoned program director${gone.length === 1 ? 'y' : 'ies'} (never ran, not registered): ${gone.join(', ')}`)
}

let warmed = false
async function warmEssentialAgents() {
  // BEFORE any agent is spawned. A credential that arrives after the agent has started is a credential the
  // agent never sees — it inherits this process's environment once, at spawn.
  checkConceptIndex()
  await sweepAbandonedPrograms()
  let credGap: string[] = []
  try { const c = await fetchBoxCredentials(); if (c.fleet) credGap = c.missing }
  catch (e: any) { console.warn(`[ica] box credentials: ${e?.message ?? e} — continuing with whatever this box has`) }

  if (warmed) return; warmed = true
  console.log('[ica] warming essential agents (analyst · connector) and the concept index…')
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
  analystSlot.stop(); connectorSlot.stop(); groundingSlot.stop(); modellerSlot.stop(); setTimeout(() => process.exit(0), 300)
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
connect()
