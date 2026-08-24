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
//   ICA_HARNESS=opencode          (opencode | pi | claude-code; default opencode)
//   ICA_OC_URL=http://127.0.0.1:4096   (opencode: share ONE standalone server, no per-engine spawn)
//   pnpm exec tsx engine.ts

import WebSocket from 'ws'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execProgram } from './exec-program.js'
import { createSession, prepareWorkspace, type Session, type Harness, type RunHandlers } from './ica/index.js'
import { createSemanticModeller, promptVersion as semanticPromptVersion } from './agents/semantic-model/index.js'
import { createReflex } from './agents/reflex/index.js'
import { createNarrator, capResultData } from './agents/narrator/index.js'
import { createAnalyst, promptVersion as analystPromptVersion } from './agents/analyst/index.js'
import { createConnector, promptVersion as connectorPromptVersion } from './agents/connector/index.js'
import { createGroundingAgent, promptVersion as groundingPromptVersion } from './agents/grounding/index.js'
import { openAnswers, normalizeQuestion } from './answers.js'
import { followUpCues } from './followup.js'
import { forgetProgram } from './forget.js'
import { log, readJsonSafe } from './log.js'
import { createInspector } from './inspect.js'
import { NodeStore, ROOT, ensureRoot, ensureConceptTree, ensureBasisSeed, intentId, SqliteVecIndex, indexText, backfillMissing, hybridSearch } from '@superatom/node-store'
import { bgeEmbedder } from './embed.js'

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
const WORKSPACE = join(WORKSPACE_ROOT, PROJECT)   // the project's home: seams + programs/ + out/ + its DBs
const KEY = process.env.ICA_KEY || ''
const HARNESS = (process.env.ICA_HARNESS as Harness) || 'opencode'   // read AFTER .env is loaded
// ONE fleet switch for the four WORK agents (analyst/semantic/connector/grounding): ICA_AGENT_HARNESS =
// claude-code | codex | opencode picks the brain for ALL of them, and each agent's MODEL is INHERITED from
// that harness (claude-code→claude-sonnet-5, codex→gpt-5.6-terra) — you don't set a model. Any single agent
// can still be pinned with ICA_<AGENT>_HARNESS / _MODEL, which wins. Reflex is independent (own opencode-go).
const HARNESS_MODEL: Partial<Record<Harness, string>> = { 'claude-code': 'claude-sonnet-5', codex: 'gpt-5.6-terra' }
const FLEET_HARNESS = (process.env.ICA_AGENT_HARNESS as Harness) || 'claude-code'
const FLEET_MODEL   = process.env.ICA_AGENT_MODEL     // optional: force a model for the fleet harness (rarely needed)
// Resolve one agent: its own harness override → the fleet harness; its model override → the fleet model (only
// when it shares the fleet's harness) → the harness's own default model.
const agentCfg = (name: string): { harness: Harness; model: string | undefined } => {
  const harness = (process.env[`ICA_${name}_HARNESS`] as Harness) || FLEET_HARNESS
  const model = process.env[`ICA_${name}_MODEL`]
    || (harness === FLEET_HARNESS ? FLEET_MODEL : undefined)
    || HARNESS_MODEL[harness]
  return { harness, model }
}
const { harness: ANALYST_HARNESS,   model: ANALYST_MODEL }   = agentCfg('ANALYST')
const { harness: SEMANTIC_HARNESS,  model: SEMANTIC_MODEL }  = agentCfg('SEMANTIC')
const { harness: CONNECTOR_HARNESS, model: CONNECTOR_MODEL } = agentCfg('CONNECTOR')
const { harness: GROUNDING_HARNESS, model: GROUNDING_MODEL } = agentCfg('GROUNDING')
// Where the connector agent writes bridges (shared with the datasource-manager, which loads them by absolute
// path). Defaults to the project's COMMITTED inputs folder so connector-written bridges land beside any
// hand-authored ones (one place, no duplicate); on Fly override via env to the mounted volume.
const DATASOURCES_DIR  = process.env.DATASOURCES_DIR || join(VM_ROOT, 'projects', PROJECT, 'datasources')
const MODEL = process.env.ICA_MODEL                  // undefined → the harness's own default (e.g. opencode glm-5.2)
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
let busy = false
let reply: any = null                                // who to stream the current turn back to
let curChannel = ''                                  // non-empty when the current turn came from a chat channel (Teams/…) — deliver the answer to the durable channel consumer, not a live socket
let hub: WebSocket | null = null

let semanticBusy = false
let analystBusy = false
let connectorBusy = false
let groundingBusy = false

// ── Semantic-model consolidation (System 4) state ─────────────────────────────
// This is the SEMANTIC-MODEL consolidation specifically — the bottom layer (meaning + the implementation
// embedded in units). It is deliberately NOT "the" consolidation: other consolidation tasks (higher layers)
// will come later, so everything here is namespaced `semanticConsolidate*` to keep them distinct.
//
// The modeler runs OFFLINE over the stream of finished analyses. A watermark (a finished_at value, stored in
// answers.engine_meta) marks how far it has consumed. The trigger is a TIMER, not a per-question signal: a
// single interval, started at boot and always running, that checks "is there anything past the watermark?"
// and drains it. This is robust to restarts — if the server stops with un-consolidated answers and comes
// back days later with no new questions, the timer still catches up (a finished-question signal might never
// arrive; the timer always does). While a pass is running the tick is a no-op (single-runner) — the timer
// keeps ticking but does nothing until the current pass finishes, then the next tick continues.
const SEMANTIC_CONSOLIDATE_WM_KEY = 'semantic_model:consolidation_watermark'
// TODO: once this is proven, bump the default interval to 3 minutes (180000) so a real burst of questions
// coalesces into ONE consolidation pass. Kept short (30s) for now so testing is fast — you don't want to
// wait 3 min to see the modeler wake.
const SEMANTIC_CONSOLIDATE_INTERVAL_MS = Number(process.env.SEMANTIC_CONSOLIDATE_INTERVAL_MS || 30000)
// A batch that makes the agent SESSION crash is retried at most this many times (across ticks), then skipped
// so a poison batch can never retry forever. Tracked in answers.engine_meta; reset on any clean pass.
const SEMANTIC_CONSOLIDATE_FAIL_KEY = 'semantic_model:consolidation_failstreak'
const SEMANTIC_CONSOLIDATE_MAX_FAILS = 3
let semanticConsolidating = false

// Every question + answer for this project, in one sqlite the ENGINE owns (the LLM never writes it).
// Enables deterministic reuse ("already answered?") + full history + agent session ids. See answers.ts.
// SCOPED BY PROJECT so a shared-box multi-project dev setup never commingles answers, agent sessions, or the
// consolidation watermark across projects (on Fly each Machine is one project, so this is naturally isolated too).
// ── BOOTSTRAP: guarantee the engine's environment BEFORE opening any store or connecting. On a fresh
// machine the per-project dirs don't exist yet; opening a sqlite in a missing dir throws. We create them
// here, explicitly, and fail LOUD + clean (not a cryptic driver stack) if the volume isn't writable.
// Every SQLite file lives under <workspace>/db/ (organized-by-concern workspace; the seams open them there).
for (const d of [WORKSPACE, join(WORKSPACE, 'db'), join(DATA_ROOT, PROJECT), join(DATA_ROOT, PROJECT, 'db')]) {
  try { mkdirSync(d, { recursive: true }) }
  catch (e: any) { console.error(`[ica] FATAL bootstrap: cannot create ${d}: ${e?.message ?? e}`); process.exit(1) }
}

const answers = openAnswers(join(DATA_ROOT, PROJECT, 'db', 'answers.sqlite'))
const genId = () => 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

// ── INTENT GRAPH (the new spine) ──────────────────────────────────────────────
// A tree of questions (intent nodes) linked by follow_up edges, in the same node-store.
// Matching is POSITIONAL: a session sits at a node; the next question either matches an
// existing child (hit → re-run its program, no LLM) or is new (miss → analyst builds it,
// and we mint the node below). Node id = hash(parent, normalised question) → deterministic.
// ONE project database. The intent graph + concepts + units are all just nodes/edges in the project's
// node-store, which lives in project.sqlite alongside the rest of the project's graph — not a separate file.
const graph = new NodeStore(join(WORKSPACE, 'db', 'project.sqlite'))
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
ensureConceptTree(graph)   // concept tree root + place any orphan concept under it (structural)
ensureBasisSeed(graph)     // plant the grounded three-plane axis vocabulary (subject / operation / mode)
// The FRONT DOOR: every question is routed here first — reuse a program on a basis match, else build.
const reflex = createReflex({ cwd: WORKSPACE })   // the reflex agent — the fast front door
// READ-ONLY window into the graph + answer history + the files behind them, served over the hub to the
// admin console. The engine runs on a Fly VM with nothing listening, so this is the only way to see
// what it knows without SSH. It answers `inspect:req` and never writes anything. See inspect.ts.
const inspector = createInspector({
  graph, answers, workspace: WORKSPACE, dataRoot: join(DATA_ROOT, PROJECT), projectId: PROJECT,
  datasourceUrl: DATASOURCE,
  runtime: () => ({
    harness: HARNESS,
    agents: {
      analyst:   { harness: ANALYST_HARNESS,   model: ANALYST_MODEL,   busy: analystBusy },
      semantic:  { harness: SEMANTIC_HARNESS,  model: SEMANTIC_MODEL,  busy: semanticBusy, consolidating: semanticConsolidating },
      connector: { harness: CONNECTOR_HARNESS, model: CONNECTOR_MODEL, busy: connectorBusy },
      grounding: { harness: GROUNDING_HARNESS, model: GROUNDING_MODEL, busy: groundingBusy },
      reflex:    { harness: process.env.ICA_REFLEX_HARNESS ?? 'opencode', model: process.env.ICA_REFLEX_MODEL ?? 'deepseek-v4-flash' },
    },
    consolidateIntervalMs: SEMANTIC_CONSOLIDATE_INTERVAL_MS,
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

// ── Agent slots — one uniform session lifecycle per agent ─────────────────────
// A slot owns EVERYTHING about an agent's session: lazy create on first use; RESUME the prior session
// only if the instruction hash is unchanged (else start fresh — deterministic, decided here in the
// engine, not by the agent); persist the live id; and expose newSession() (reset) + compact(). The rest
// of the engine just calls slot.get() / newSession() / compact() — no scattered lifecycle code.
type Agent = { session: Session }
function makeAgentSlot<A extends Agent>(role: string, promptVersion: () => Promise<string>, create: (resumeId?: string) => Promise<A>) {
  let agent: A | null = null, building: Promise<A> | null = null, ver = ''
  // Persist the live session id so a restart can --resume it. IMPORTANT: only call this AFTER a real turn.
  // Claude writes a session's transcript to disk only once the session has conversed; persisting at mere
  // CREATION (e.g. at warm-up) stores an id with no transcript → the next boot's --resume fails with
  // "No conversation found". So creation does NOT persist — the callers persist after an actual run.
  const persist = () => { if (agent) answers.setAgentSession(PROJECT, role, 'claude-code', agent.session.sessionId?.(), ver, Date.now()) }
  async function get(): Promise<A> {
    if (agent) return agent
    if (!building) building = (async () => {
      ver = await promptVersion()                                            // deterministic hash of the instruction files
      const prev = answers.getAgentSession(PROJECT, role)
      const resumeId = prev?.promptVersion === ver ? prev.sessionId : undefined   // resume ONLY if instructions unchanged
      if (prev && prev.promptVersion !== ver) console.log(`[ica] ${role}: instructions changed → fresh session`)
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
const analystSlot  = makeAgentSlot('analyst',  analystPromptVersion,  (resumeId) => listSources().then(sources => createAnalyst({ root: WORKSPACE_ROOT, projectId: PROJECT, sources, managerUrl: DATASOURCE, ica: { harness: ANALYST_HARNESS, model: ANALYST_MODEL, resumeId } })))
const semanticSlot = makeAgentSlot('semantic', semanticPromptVersion, (resumeId) => listSources().then(sources => createSemanticModeller({ root: WORKSPACE_ROOT, projectId: PROJECT, sources, managerUrl: DATASOURCE, ica: { harness: SEMANTIC_HARNESS, model: SEMANTIC_MODEL, resumeId } })))
const connectorSlot = makeAgentSlot('connector', connectorPromptVersion, (resumeId) => createConnector({ root: WORKSPACE_ROOT, projectId: PROJECT, managerUrl: DATASOURCE, datasourcesDir: DATASOURCES_DIR, ica: { harness: CONNECTOR_HARNESS, model: CONNECTOR_MODEL, resumeId } }))
// COLD by design: never warmed at boot (below); spun up only when the admin triggers a grounding build.
const groundingSlot = makeAgentSlot('grounding', groundingPromptVersion, (resumeId) => listSources().then(sources => createGroundingAgent({ root: WORKSPACE_ROOT, projectId: PROJECT, sources, managerUrl: DATASOURCE, ica: { harness: GROUNDING_HARNESS, model: GROUNDING_MODEL, resumeId } })))
console.log(`[ica] analyst=${ANALYST_HARNESS ?? 'claude-code'}:${ANALYST_MODEL ?? 'claude-sonnet-5'} · modeler=${SEMANTIC_HARNESS ?? 'claude-code'}:${SEMANTIC_MODEL ?? 'claude-sonnet-5'} · connector=${CONNECTOR_HARNESS}:${CONNECTOR_MODEL} · grounding=${GROUNDING_HARNESS}:${GROUNDING_MODEL} (cold)`)
// Live analyst state, kept so a (re)connecting client can RE-SYNC after a reload (the engine stores
// no history — this is just the current run + last result, replayed on demand).
let curQuestion = '', curCategory = '', curSid = ''
let lastAnswer: any = null, lastTiming: any = null, lastCategory = ''

const emit = (to: any, msg: unknown) => { if (hub?.readyState === WebSocket.OPEN) hub.send(JSON.stringify({ to, payload: msg })) }

// Reuse a saved program (SYS-1, no LLM): run it against CURRENT data, emit the answer, persist. Shared by
// the positional exact-hit and the reflex catalog-match. Returns false on failure so the caller rebuilds.
async function reuseProgram(programDir: string, params: any, category: string,
  ctx: { sid: string; qid: string; question: string; norm: string; t0: number; nodeId: string }): Promise<boolean> {
  const { sid, qid, question, norm, t0, nodeId } = ctx
  emit(reply, { t: 'analyst:category', category, sid })
  emit(reply, { t: 'analyst:status', text: 'Re-running the saved program…', question, sid, qid })
  const ka = setInterval(() => { if (reply) emit(reply, { t: 'tick', sid }) }, 8000)
  try {
    // Fresh subprocess (see exec-program.ts): a program edited by a prior modify is cached stale in this
    // long-lived tsx process, so an in-process reuse would re-run yesterday's code. Spawn it clean.
    const rr = await execProgram(WORKSPACE, programDir, params ?? {})
    const out = rr.output as any
    const answer = { ...out, status: out?.status ?? 'answered' }
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
    let escalate = false, why = ''
    if (doubtReason) { escalate = true; why = `program raised doubt — ${doubtReason}` }
    else {
      // Otherwise the reflex REVIEWS whether the (confident-looking) answer actually answers the question.
      try { const v = await reflex.review(question, answer); escalate = v.verdict === 'escalate'; why = v.reason ?? '' }
      catch (e: any) { escalate = emptyRun; why = 'reviewer unavailable' + (emptyRun ? ' + degenerate answer' : ''); log.warn('reflex-review', `review failed for ${programDir}`, e) }
    }
    if (escalate) {
      clearInterval(ka)
      log.info('reflex-review', `reused ${programDir} did not answer → escalating to the analyst`, why)
      return false   // fall through to the analyst build (analyse handles the rebuild)
    }
    lastAnswer = answer; lastTiming = timing; lastCategory = category
    emit(reply, { t: 'analyst:answer', category, answer, timing, sid, qid, reused: true })
    if (curChannel) emit({ type: 'channel' }, { t: 'channel:answer', channel: curChannel, qid, answer, category })   // durable delivery to the chat channel
    // Follow-ups persisted on the node when it was first built → replay them on reuse (no analyst involved).
    const fu = (graph.getNode(nodeId)?.props as any)?.followups
    if (Array.isArray(fu) && fu.length && reply) emit(reply, { t: 'followups', items: fu, qid, sid })
    emit(reply, { t: 'analyst:done', sid })
    answers.save({ qid, sessionId: sid, question, norm, category, status: 'answered', answer, createdAt: Date.now(), finishedAt: Date.now(), programDir, params })
    const n = graph.getNode(nodeId); if (n) graph.putNode({ ...n, props: { ...(n.props as any), lastShapeHash: (rr as any).finalShapeHash ?? (n.props as any)?.lastShapeHash } })
    setPosition(sid, nodeId)
    clearInterval(ka)
    analystBusy = false; busy = false; curQuestion = ''
    console.log(`[ica] REUSE ${programDir} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return true
  } catch (e: any) {
    clearInterval(ka)
    console.log(`[ica] reuse of ${programDir} failed (${e?.message ?? e}) — rebuilding via the analyst`)
    return false
  }
}

// Answer a question: classify → analyst ICA (per-category SYSTEM.md, semantic-model-first) → stream
// the raw claude terminal to the "Analyst" tab and emit the final structured answer.
async function analyse(question: string, from: any, sid = '', qidIn = '', channel = '') {
  if (analystBusy) { emit(from, { t: 'analyst:status', text: 'Already answering a question — one at a time.' }); return }
  if (!question.trim()) return
  // ── EXPLICIT EDIT prefix ──────────────────────────────────────────────────────
  // An input that, after any leading whitespace, begins with "edit:" or "modify:" (case-insensitive) is the
  // user DIRECTLY telling us to modify the current answer — a deterministic override with NO reflex guessing.
  // We detect it here in the engine (we never tell the reflex about the prefix) and strip it so everything
  // downstream — the analyst instruction, logs, the node — sees only the clean change request.
  const editMatch = /^(?:edit|modify)\s*:/i.exec(question.replace(/^\s+/, ''))
  const explicitEdit = !!editMatch
  if (editMatch) question = (question.replace(/^\s+/, '').slice(editMatch[0].length).trim()) || question
  // Stream everything to `reply` (re-targetable): a reload reconnects and sessions:list points reply
  // at the new connection, so the in-flight run's output + final answer reach the reloaded client.
  analystBusy = true; busy = true; reply = from; curChannel = channel
  const norm = normalizeQuestion(question)
  // ONE id end to end: the UI mints it and sends it; we use it verbatim (agent writes ./out/<qid>.json,
  // DB keys on it). Fall back to minting our own if a non-UI caller omitted it. Trust-but-verify: if the
  // client id already maps to a DIFFERENT question (a client bug), don't overwrite — mint a fresh one.
  let qid = qidIn || genId()
  if (qidIn) { const ex = answers.get(qidIn); if (ex && ex.norm !== norm) qid = genId() }
  curQuestion = question; curSid = sid; curCategory = ''; lastAnswer = null
  const t0 = Date.now()

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
  const cues = explicitEdit ? [] : followUpCues(question)
  const rootQuestion = !explicitEdit && cues.length === 0
  const matchId = rootQuestion ? intentId(ROOT, question) : nid
  if (!explicitEdit) console.log(`[ica] regex: ${rootQuestion ? 'ROOT → reuse-match at ROOT' : `FOLLOW-UP (${cues.join(',')}) → reuse-match @ ${pos === ROOT ? 'ROOT' : pos.slice(0, 14)}`}`)
  const hitNode = graph.getNode(matchId)
  const hp: any = hitNode?.props
  if (!explicitEdit && hp?.program && existsSync(join(WORKSPACE, hp.program, 'program.ts'))) {
    if (await reuseProgram(hp.program, hp.params, hp.category, { sid, qid, question, norm, t0, nodeId: matchId })) return
    // failed → fall through to rebuild via the analyst
  }

  // ── Routing: MODIFY is DETERMINISTIC (explicit "edit:"/"modify:" prefix only) — never guessed. Otherwise the
  // REFLEX (stateless) classifies REUSE vs BUILD; it has no "modify" decision. The SAME question is a reuse.
  const curNode = pos !== ROOT ? graph.getNode(pos) : null
  const curQ = curNode ? ((curNode.props as any)?.question ?? curNode.summary) : undefined
  let overlapHint: { program: string; relation: string } | undefined   // a related program the reflex flagged → a pointer for the analyst to adapt
  let reflexPlacement: string | undefined                               // 'root' or an intentId — where the reflex says this question's node hangs
  let modifyTarget: { programDir: string; prevQuestion?: string } | null = null
  if (explicitEdit) {
    // The user explicitly prefixed "edit:"/"modify:" — edit the current node's program in place; if there's
    // nothing on screen to edit, fall through to a normal build.
    const curProgram = (curNode?.props as any)?.program
    if (curNode && curProgram && existsSync(join(WORKSPACE, curProgram, 'program.ts'))) {
      modifyTarget = { programDir: curProgram, prevQuestion: curQ }
      console.log(`[ica] explicit edit → editing ${modifyTarget.programDir} in place (node ${pos.slice(0, 14)})`)
    } else {
      console.log('[ica] explicit edit, but no current program to edit → building fresh')
    }
  } else {
    try {
      // Semantic retrieval: hand the reflex the top-K most-similar EXISTING intents (candidates), not the catalog.
      const candidates = vectors
        ? (await hybridSearch(graph, vectors, bgeEmbedder, question, { kind: 'intent', limit: 8 }))
            .map(h => { const p = graph.getNode(h.id)?.props as any; return { intentId: h.id, question: (p?.question ?? h.label ?? '') as string, program: p?.program, params: p?.params } })
        : []
      const route = await reflex.route(graph, question, candidates, { firstInSession: pos === ROOT, currentIntentId: pos === ROOT ? undefined : pos, currentQuestion: curQ })
      reflexPlacement = route.placement
      if (route.decision === 'build' && route.adapt) overlapHint = { program: route.adapt.program, relation: 'related' }
      console.log(`[ica] reflex: ${route.decision}${route.decision === 'reuse' ? ` → ${route.program}` : route.adapt ? ` (adapt ${route.adapt.program})` : ''} · place=${route.placement === 'root' ? 'ROOT' : route.placement.slice(0, 14)}`)
      if (route.decision === 'reuse' && existsSync(join(WORKSPACE, route.program, 'program.ts'))) {
        const cat = (graph.getNode(route.intentId)?.props as any)?.category ?? 'analysis'
        if (await reuseProgram(route.program, route.params, cat, { sid, qid, question, norm, t0, nodeId: route.intentId })) return
        // failed → fall through to rebuild
      }
    } catch (e: any) {
      console.log(`[ica] reflex failed (${e?.message ?? e}) — building via the analyst`)
    }
  }

  emit(reply, { t: 'analyst:status', text: 'Classifying…', question, sid, qid })
  // Liveness keepalive: the UI arms a 25s watchdog and re-arms on every message. Claude-code's PTY streams
  // constantly so it's always fed, but SDK harnesses (codex) reason/exec silently for long stretches — and
  // the gap-loop model build is silent too. Tick every 8s for the whole turn so the watchdog never false-fires.
  let keepalive: ReturnType<typeof setInterval> | null = setInterval(() => { if (reply) emit(reply, { t: 'tick', sid }) }, 8000)
  // ── Receptionist narration (a SEPARATE throwaway agent): while the analyst works behind the scenes, translate
  // its raw activity into business-language 'narration' beats for the USER UI. Fresh per question; best-effort — a
  // narration failure must NEVER affect the answer.
  let narrator: ReturnType<typeof createNarrator> | null = null
  let narrationTimer: ReturnType<typeof setInterval> | null = null
  const narrationBuf: string[] = []
  let narrating = false
  try {
    const analyst = await analystSlot.get()
    // Tell the UI how to render this harness's stream. claude-code now has BOTH: a STRUCTURED event view
    // (from its JSONL transcript — the default) AND the raw PTY terminal (on demand). So announce 'events'
    // when the session exposes events() (claude + codex), plus `pty:true` when a raw terminal is available
    // (claude only) so the UI can offer a "Terminal" toggle. A pure event harness (codex) has no PTY.
    emit(reply, { t: 'analyst:stream', kind: analyst.session.events ? 'events' : (analyst.session.kind ?? 'events'), pty: analyst.session.kind === 'pty', sid })
    // Kick off the narration: an immediate opener, then every few seconds translate whatever the analyst just did
    // into ONE business line. Overlap-guarded (skip a tick if the previous narrate is still running).
    narrator = createNarrator({ cwd: WORKSPACE })
    if (reply) emit(reply, { t: 'narration', text: 'Looking into your question…', qid, sid })
    narrationTimer = setInterval(async () => {
      if (narrating || !reply || narrationBuf.length === 0) return
      narrating = true
      const activity = narrationBuf.splice(0).join('\n')
      try {
        // TIMEOUT the narrate call: if the narrator (deepseek) hangs, `finally` would never run, `narrating`
        // would stay true, and EVERY later tick early-returns → narration frozen on one line while the analyst
        // keeps working. Race it so a hung beat is abandoned (settles in the background) and the guard clears.
        const line = await Promise.race([narrator!.narrate(question, activity), new Promise<null>((res) => setTimeout(() => res(null), 20000))])
        if (line) {
          if (reply) emit(reply, { t: 'narration', text: line, qid, sid })
          if (channel) emit({ type: 'channel' }, { t: 'channel:narration', channel, qid, text: line })   // stream to the chat channel (Teams/…) as a tiny message
        }
      } catch { /* narration is best-effort */ } finally { narrating = false }
    }, 4000)
    const handlers = {
      onCategory: (c: string) => { curCategory = c; emit(reply, { t: 'analyst:category', category: c, sid }) },
      onOutput: (chunk: string) => {
        // PTY bytes are the RAW-TERMINAL view — streamed ONLY to viewers who explicitly opened the terminal
        // (termViewers). The default view is driven by onEvent below (structured, from the JSONL), so a claude
        // run streams clean events by default and the PTY never reaches a client that didn't ask for it.
        if (!termViewers.analyst.size) return
        const m = { t: 'analyst:chunk', text: chunk }
        for (const v of termViewers.analyst) emit(v, m)
      },
      onNarration: (text: string) => { if (reply) emit(reply, { t: 'analyst:progress', text, sid }) },  // clean prose → New chat progress
      // Structured events (codex/SDK harnesses only — claude PTY uses onOutput above). The session already
      // normalizes + buffers these (session.events()); the engine just mirrors each one live to the asker and
      // any attached viewers, same as onOutput. Reconnect replay is handled in resyncAnalyst via events().
      onEvent: (ev) => {
        const m = { t: 'analyst:event', ev, sid }
        if (reply) emit(reply, m)
        for (const v of termViewers.analyst) if (v !== reply) emit(v, m)
        // Narrator digest — feed ONLY the business signal: commands + their RESULTS (query outputs = the
        // findings) and the analyst's own prose. SKIP file events (program code / diffs / paths) — that's pure
        // machinery the narrator must hide anyway: big input bloat + a leak risk, with no business value (every
        // real figure is already in a command's result).
        // Feed the narrator the SIGNAL only: the analyst's own PROSE (already business-ish), plus the OUTPUT of a
        // genuine DATA RUN (a tsx/node query). NEVER feed raw command text or file-read/plumbing output (cat/ls/
        // grep… = machinery) — it's noise, and it tempts the model to echo tool-call syntax (the Teams DSML leak).
        if (ev.kind === 'message' && ev.text?.trim()) narrationBuf.push(ev.text.trim().slice(0, 600))
        else if (ev.kind === 'command' && ev.output?.trim() && /\b(tsx|node|run\.mjs|query\.mjs|program\.ts)\b/.test(ev.command || '')) narrationBuf.push(('RESULT: ' + capResultData(ev.output)).slice(0, 1800))
      },
    }
    const hint = overlapHint ? `An existing program is a ${overlapHint.relation} of this question: ${overlapHint.program}. Open it and reuse what fits, or ignore it.` : undefined
    // LAST-RESORT backstop, deliberately BIG. The real fix for stuck turns is the prompt (foreground-only, no
    // background/sub-agents — see generate-system.ts). But if claude STILL wedges — a query in a retry loop, or
    // a background step it waits on — its "done" signal never fires and ask() would hang forever (the user sees
    // narration but never an answer). This cap is a safety net, NOT a guillotine: it's set high so a legitimately
    // slow question is never cut, and when it DOES fire it recovers the answer the agent almost certainly already
    // wrote to out/<qid>/answer.json (so a completed-but-not-signalled answer is never lost) and resets the stuck
    // session so the next question starts clean. Tune via ANALYST_MAX_TURN_MS.
    const MAX_TURN_MS = Number(process.env.ANALYST_MAX_TURN_MS) || 30 * 60 * 1000
    const TIMED_OUT = Symbol('analyst-timeout')
    const askP = analyst.ask(question, handlers, { qid, modify: modifyTarget ?? undefined, hint })
    askP.catch(() => {})   // if we abandon it on timeout, don't leak an unhandled rejection
    let capT: ReturnType<typeof setTimeout> | undefined
    const raced: any = await Promise.race([askP, new Promise((res) => { capT = setTimeout(() => res(TIMED_OUT), MAX_TURN_MS) })])
    if (capT) clearTimeout(capT)
    let r: any
    if (raced === TIMED_OUT) {
      const recovered = await readJsonSafe<any>(join(WORKSPACE, 'out', qid, 'answer.json'), null, 'analyst')
      log.warn('analyst', `turn exceeded ${(MAX_TURN_MS / 1000) | 0}s for ${qid} — ${recovered ? 'recovered the written answer' : 'nothing written'}; resetting the stuck session`)
      try { (analyst as any).session?.reset?.() } catch { /* best-effort */ }
      r = { answer: recovered ?? { status: 'error', answer: 'That one took too long and was stopped — please try again.' }, category: recovered?.category ?? 'analysis', ms: Date.now() - t0, lastLines: '' }
    } else {
      r = raced
    }
    console.log(`[ica] analyst · ${r.category} · ${(r.ms / 1000).toFixed(1)}s · status=${r.answer?.status ?? 'no-json'}`)

    // The analyst is self-sufficient: it answers from the semantic model when a unit/concept fits, and does
    // its OWN analysis over the data when nothing fits. It NEVER blocks on the model-builder — the modeler is
    // now an OFFLINE consolidation pass (System 4) that studies the stream of finished answers and grows the
    // model behind the scenes. So there is no synchronous gap loop here anymore; the analyst's answer is final.

    // Timing metadata for the answer card: total wall time.
    const timing = { ms: Date.now() - t0 }
    lastAnswer = r.answer; lastTiming = timing; lastCategory = r.category
    // Capture the PROGRAM the agent built (its built.json pointer) so a repeat of this question re-runs
    // that program (fresh query) instead of re-invoking the LLM.
    let programDir: string | undefined, programParams: any, programTerms: any[] = [], programFollowups: string[] = []
    const b = await readJsonSafe<any>(join(WORKSPACE, 'out', qid, 'built.json'), null, 'analyst')   // absent = unknowable/gap (no program)
    if (b) { programDir = b.programDir; programParams = b.params; programTerms = Array.isArray(b.terms) ? b.terms : []; programFollowups = Array.isArray(b.followups) ? b.followups.filter((x: any) => typeof x === 'string' && x.trim()).slice(0, 3) : [] }
    emit(reply, { t: 'analyst:answer', category: r.category, answer: r.answer, lastLines: r.lastLines, timing, sid, qid })
    if (channel) emit({ type: 'channel' }, { t: 'channel:answer', channel, qid, answer: r.answer, category: r.category })   // durable delivery to the chat channel
    // Follow-ups are NICE-TO-HAVE — emitted AFTER the answer, never gating or delaying it. The UI reveals them on
    // a delay so the user reads the answer first. Persisted on the node below → free on a later reuse (no analyst).
    if (programFollowups.length && reply) emit(reply, { t: 'followups', items: programFollowups, qid, sid })
    // PERSIST: the engine reads the agent's file result and writes the DB — the agent never touches the DB.
    // finishedAt is stamped HERE, deterministically, the moment the analyst's artifact is in hand — this is
    // the cursor the offline modeler consolidates by (never a time the agent self-reports).
    // For a MODIFY the answer belongs to the ORIGINAL question (the node we edited), not the edit instruction.
    const savedQ = modifyTarget && curNode ? (curNode.summary ?? curQ ?? question) : question
    const savedNorm = modifyTarget && curNode ? (((curNode.props as any)?.question as string) ?? norm) : norm
    answers.save({ qid, sessionId: sid, question: savedQ, norm: savedNorm, category: r.category, status: r.answer?.status ?? 'error', answer: r.answer, createdAt: Date.now(), finishedAt: Date.now(), programDir: programDir ?? modifyTarget?.programDir, params: programParams })
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
      const parent = (reflexPlacement && reflexPlacement !== 'root' && graph.getNode(reflexPlacement)) ? reflexPlacement : ROOT
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
      console.log(`[ica] intent node ${nodeId.slice(0, 14)} under ${parent === ROOT ? 'ROOT' : parent.slice(0, 14)} (reflex-placed)${programDir ? ` · program ${programDir}` : ' · no program'}`)
      // OBSERVE-only: did the cheap exact-match regex agree with where the reflex placed the node?
      if (!explicitEdit) console.log(`[ica] regex-check: guessed ${rootQuestion ? 'ROOT' : 'FOLLOW-UP'} · reflex placed ${parent === ROOT ? 'ROOT' : 'FOLLOW-UP'} → ${rootQuestion === (parent === ROOT) ? 'MATCH ✓' : 'MISMATCH ✗'}`)
    }
    // PROGRAM NODE — the program's OWN identity in the DB (kind:'program'), distinct from the question/intent
    // node. props.dir is the pointer to where the program lives; props.authoredBy records WHO wrote it —
    // engine-known and deterministic (never the LLM). Stamped ONLY here, on the analyst build/edit path —
    // never on reuse (reuse is captured separately in program_runs). Upserted by slug, so reuse/rebuild dedupe
    // to one node. Additive: the intent node keeps props.program, so the reflex catalog is unaffected.
    const authoredProgramDir = programDir ?? modifyTarget?.programDir
    if (authoredProgramDir && builtIntentId) {
      const slug = authoredProgramDir.replace(/^programs\//, '')
      const authoredBy = { harness: ANALYST_HARNESS, provider: process.env.ICA_ANALYST_PROVIDER || null, model: ANALYST_MODEL ?? null, at: Date.now() }
      graph.putNode({ id: `prog:${slug}`, kind: 'program', label: slug, summary: authoredProgramDir,
        props: { dir: authoredProgramDir, authoredBy, category: r.category } })
      graph.putEdge({ from: builtIntentId, to: `prog:${slug}`, type: 'program' })
    }
    // No explicit wake needed — the always-running consolidation timer picks this up on its next tick. That
    // is deliberate: the timer, not this signal, is the guarantee (it survives restarts and missed signals).
  } catch (e: any) {
    lastAnswer = { status: 'cannot_answer', answer: `Failed: ${e?.message ?? e}`, missing: 'engine error' }
    emit(reply, { t: 'analyst:answer', answer: lastAnswer, sid })
  } finally {
    if (keepalive) { clearInterval(keepalive); keepalive = null }
    if (narrationTimer) { clearInterval(narrationTimer); narrationTimer = null }
    if (narrator) { narrator.stop(); narrator = null }
    curQuestion = ''
    emit(reply, { t: 'analyst:done', sid })
    analystSlot.persist(); semanticSlot.persist()   // capture the live ids (incl. any resume-fallback)
    analystBusy = false; busy = false
  }
}

async function listSources(): Promise<string[]> {
  try { const r = await fetch(`${DATASOURCE}/sources`); const j: any = await r.json(); return (j.sources || []).map((s: any) => s.id) }
  catch { return [] }
}

// Run the semantic-model agent and stream its raw claude-code terminal to the UI panel.
async function buildSemanticModel(from: any) {
  if (semanticBusy) { emit(from, { t: 'semantic:status', text: 'Semantic model build already running.' }); return }
  semanticBusy = true
  const sources = await listSources()
  emit(from, { t: 'semantic:status', text: `Building semantic model — sources: ${sources.join(', ') || '(none)'}` })
  try {
    const semantic = await semanticSlot.get()
    announceKind('semantic', from, semantic)   // tell the panel which renderer: 'pty' (claude) or 'events' (codex)
    const r = await semantic.buildFirstPass(agentStream('semantic', from))
    emit(from, { t: 'semantic:done', summary: r.lastLines })
    console.log(`[ica] semantic build done in ${(r.ms / 1000).toFixed(1)}s`)
  } catch (e: any) {
    emit(from, { t: 'semantic:status', text: `Semantic build failed: ${e?.message ?? e}` })
  } finally { semanticSlot.persist(); semanticBusy = false }
}

// The admin's GROUNDING agent — a COLD claude-code session (spun up on demand, never warmed) that builds
// this project's value→id resolution indexes. Streamed RAW (PTY) to the admin's xterm, same machinery as the
// modeler/connector. It reads data via the seam and persists via build(config) on grounding.mjs; it never
// answers user questions and never touches the semantic model.
async function handleGrounding(from: any, rebuild = false) {
  if (groundingBusy) { emit(from, { t: 'grounding:status', text: 'Grounding build already running.' }); return }
  groundingBusy = true
  // EXPLICIT clean rebuild only: wipe the grounding DB so the agent starts empty. A normal build is ADDITIVE
  // (upsert-on-top, never destructive) — this deliberate reset is the one place a wipe happens. Safe here because
  // the grounding agent is COLD (no store open between builds).
  if (rebuild) {
    const db = join(WORKSPACE, 'db', 'grounding.sqlite')
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

// The admin's CONNECTOR agent — a claude-code session streamed RAW (PTY) to the admin's xterm (no [[ui]]
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
type Which = 'analyst' | 'semantic' | 'connector' | 'grounding'
const normWhich = (w: any): Which => (w === 'connector' ? 'connector' : w === 'grounding' ? 'grounding' : w === 'semantic' ? 'semantic' : 'analyst')
const slotFor = (w: Which) => (w === 'connector' ? connectorSlot : w === 'grounding' ? groundingSlot : w === 'semantic' ? semanticSlot : analystSlot)
const termChunkT = (w: Which) => (w === 'connector' ? 'connector:chunk' : w === 'grounding' ? 'grounding:chunk' : w === 'semantic' ? 'semantic:chunk' : 'analyst:chunk')

// Standard streaming for the from-based agent flows (semantic/connector/grounding): forward BOTH the harness's
// text chunks (the pty view) AND its structured events (the codex/events view) to the requester, tagged by agent.
// The console renders per the kind we announce with `<w>:stream` — which is the SESSION's real kind, so a codex
// agent gets the event view and a claude agent gets the terminal, with no per-flow hardcoding.
const agentStream = (w: Which, from: any): RunHandlers => ({
  onOutput: (chunk) => emit(from, { t: `${w}:chunk`, text: chunk }),
  onEvent: (ev) => emit(from, { t: `${w}:event`, ev }),
})
const announceKind = (w: Which, from: any, agent: any) => emit(from, { t: `${w}:stream`, kind: agent?.session?.kind ?? 'events' })
const isAgentBusy = (w: Which) => (w === 'connector' ? connectorBusy : w === 'grounding' ? groundingBusy : w === 'semantic' ? semanticBusy : analystBusy)
const termViewers: Record<Which, Set<any>> = { analyst: new Set(), semantic: new Set(), connector: new Set(), grounding: new Set() }
const termUnsub: Record<Which, (() => void) | null> = { analyst: null, semantic: null, connector: null, grounding: null }
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
    if (evs.length) emit(from, { t: `${w}:events`, events: evs, replace: true })
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
// blocks the analyst (separate busy flags). If the modeler is busy with a manual build, this tick skips and
// the next one retries. When it does run, it drains ALL pending batches (a 3-day backlog is processed in
// order, 50 at a time) until nothing is left past the watermark.
async function semanticConsolidateTick() {
  if (semanticConsolidating || semanticBusy) return            // already consolidating, or modeler busy → no-op; next tick retries
  const wmPeek = Number(answers.getMeta(SEMANTIC_CONSOLIDATE_WM_KEY) ?? '0')
  if (!answers.sinceFinished(wmPeek, 1).length) return         // nothing past the watermark → cheap exit, no session spin-up
  semanticConsolidating = true; semanticBusy = true            // hold the modeler mutex for the whole drain
  try {
    for (;;) {
      const wm = Number(answers.getMeta(SEMANTIC_CONSOLIDATE_WM_KEY) ?? '0')
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
        console.log(`[semantic-consolidation] ${batch.length} answer(s) since wm=${wm} — all already-consolidated repeats; skipping the modeler`)
        answers.setMeta(SEMANTIC_CONSOLIDATE_WM_KEY, nextWm)
        continue
      }
      const batchId = 'b_' + Date.now().toString(36)
      const items = fresh.map((r) => ({ question: r.question, status: r.status, programDir: r.programDir, usedNodes: (r.answer as any)?.usedNodes }))
      console.log(`[semantic-consolidation] ${batchId}: ${items.length} new program(s) of ${batch.length} answer(s) since wm=${wm}`)
      if (reply) emit(reply, { t: 'semantic:status', text: `Consolidating ${items.length} recent answer(s) into the model…` })
      try {
        const semantic = await semanticSlot.get()
        // Same dual-view as the analyst: announce the STRUCTURED view (from the modeler's JSONL) + whether a raw
        // terminal exists; stream events by default; the PTY (semantic:chunk) goes ONLY to explicit terminal viewers.
        const semViewers = () => { const s = new Set(termViewers.semantic); if (reply) s.add(reply); return s }
        if (reply) emit(reply, { t: 'semantic:stream', kind: semantic.session.events ? 'events' : (semantic.session.kind ?? 'events'), pty: semantic.session.kind === 'pty' })
        const r = await semantic.consolidate(items, batchId, {
          onEvent: (ev) => { for (const v of semViewers()) emit(v, { t: 'semantic:event', ev }) },
          onOutput: (chunk) => { if (termViewers.semantic.size) for (const v of termViewers.semantic) emit(v, { t: 'semantic:chunk', text: chunk }) },
        })
        // Advance PAST the last finished_at we consumed → those rows never re-enter a batch (strictly-greater cursor).
        answers.setMeta(SEMANTIC_CONSOLIDATE_WM_KEY, nextWm)
        answers.setMeta(SEMANTIC_CONSOLIDATE_FAIL_KEY, '0')     // clean pass → reset the failure streak
        console.log(`[semantic-consolidation] ${batchId} done in ${(r.ms / 1000).toFixed(1)}s`)
        if (reply) emit(reply, { t: 'semantic:status', text: 'Model consolidated ✓' })
      } catch (e: any) {
        // The agent SESSION errored (a crash, not a compaction — those are handled inside consolidate()).
        // Do NOT advance the watermark yet: a transient error should be retried. But bound it — after
        // MAX_FAILS consecutive failures on the SAME batch, skip it (advance past) so a poison batch can
        // never retry forever and burn money. The skipped analyses' concepts resurface if re-asked.
        const streak = Number(answers.getMeta(SEMANTIC_CONSOLIDATE_FAIL_KEY) ?? '0') + 1
        console.log(`[semantic-consolidation] ${batchId} FAILED (streak ${streak}/${SEMANTIC_CONSOLIDATE_MAX_FAILS}): ${e?.message ?? e}`)
        if (streak >= SEMANTIC_CONSOLIDATE_MAX_FAILS) {
          console.log(`[semantic-consolidation] skipping poison batch — advancing watermark past ${nextWm}`)
          answers.setMeta(SEMANTIC_CONSOLIDATE_WM_KEY, nextWm); answers.setMeta(SEMANTIC_CONSOLIDATE_FAIL_KEY, '0')
        } else {
          answers.setMeta(SEMANTIC_CONSOLIDATE_FAIL_KEY, String(streak))
        }
        break                                                    // stop this drain; the next tick retries (or has moved on if skipped)
      }
    }
  } catch (e: any) {
    console.log(`[semantic-consolidation] error: ${e?.message ?? e}`)
  } finally { semanticConsolidating = false; semanticBusy = false; semanticSlot.persist() }
}

// A client (re)connected (e.g. after reload). Replay the live analyst state so it doesn't see a blank
// screen while the run continues server-side: the terminal buffer, and either the in-flight run
// (re-targeted to this connection) or the last completed answer.
function resyncAnalyst(from: any) {
  emit(from, { t: 'sessions:res', sessions: [] })   // UI keeps its own chat list (localStorage); this is just the ack
  const aSession = analystSlot.session(), sSession = semanticSlot.session()
  if (!aSession) return
  const kind = aSession.events ? 'events' : (aSession.kind ?? 'events')
  emit(from, { t: 'analyst:stream', kind, pty: aSession.kind === 'pty' })   // which renderer + whether a raw terminal exists
  // Repaint the STRUCTURED event log by default (claude + codex); the raw PTY screen is replayed only when the
  // client explicitly opens the terminal (term:attach), so PTY bytes never reach a client that didn't ask.
  if (aSession.events) {
    const evs = aSession.events()
    if (evs.length) emit(from, { t: 'analyst:events', events: evs, replace: true })
  } else {
    const buf = aSession.buffer()
    if (buf) emit(from, { t: 'analyst:chunk', text: buf, replace: true })
  }
  if (sSession) {                                                          // repaint the semantic view too (e.g. mid consolidation)
    emit(from, { t: 'semantic:stream', kind: sSession.events ? 'events' : (sSession.kind ?? 'events'), pty: sSession.kind === 'pty' })
    if (sSession.events) { const evs = sSession.events(); if (evs.length) emit(from, { t: 'semantic:events', events: evs, replace: true }) }
    else { const sbuf = sSession.buffer(); if (sbuf) emit(from, { t: 'semantic:chunk', text: sbuf, replace: true }) }
    if (semanticBusy) emit(from, { t: 'semantic:status', text: 'Building the model…' })
  }
  if (analystBusy) {
    reply = from                                                          // re-target the running run to this (new) connection
    emit(from, { t: 'analyst:status', text: curCategory ? `Answering — ${curCategory}…` : 'Answering…', question: curQuestion, sid: curSid })
    if (curCategory) emit(from, { t: 'analyst:category', category: curCategory, sid: curSid })
  } else if (lastAnswer) {
    emit(from, { t: 'analyst:answer', category: lastCategory, answer: lastAnswer, timing: lastTiming, sid: curSid, replay: true })
    emit(from, { t: 'analyst:done', sid: curSid })
  }
}

async function handle(payload: any, from: any) {
  if (payload.t === 'analyse') { analyse(String(payload.question || ''), from, String(payload.sessionId || ''), String(payload.questionId || ''), String(payload.channel || '')) }   // UI supplies both ids; channel set for chat-channel turns
  else if (payload.t === 'semantic:build') { buildSemanticModel(from) }                      // build/refine the semantic model (watchable)
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
  else if (payload.t === 'sessions:list' || payload.t === 'analyst:sync') { resyncAnalyst(from) }   // (re)connect → replay the live analyst state
  else if (payload.t === 'session:load') { emit(from, { t: 'session:load:res', items: [] }) }
  else if (payload.t === 'suggestions:req') { emit(from, { t: 'suggestions:res', suggestions: { groups: [] } }) }
  else if (payload.t === 'ui:resize') {   // UI fitted its terminal → resize the matching agent's PTY (claude-code)
    const slot = slotFor(normWhich(payload.which))
    slot.session()?.resize?.(Number(payload.cols) || 120, Number(payload.rows) || 40)
  }
  else if (payload.t === 'session:new') {   // UI button → fresh session for that agent (drop resume + history)
    const slot = payload.role === 'semantic' ? semanticSlot : analystSlot
    slot.newSession(); emit(from, { t: 'session:reset', role: payload.role || 'analyst' })
  }
  else if (payload.t === 'session:compact') {   // UI button → compact (shrink context) of that agent's session
    const role = payload.role === 'semantic' ? 'semantic' : 'analyst'
    const slot = role === 'semantic' ? semanticSlot : analystSlot
    const chunkT = role === 'semantic' ? 'semantic:chunk' : 'analyst:chunk'
    emit(from, { t: role === 'semantic' ? 'semantic:status' : 'analyst:status', text: 'Compacting context…' })
    slot.compact({ onOutput: (chunk) => emit(from, { t: chunkT, text: chunk }) })
      .then(() => emit(from, { t: role === 'semantic' ? 'semantic:status' : 'analyst:status', text: 'Compacted ✓' }))
      .catch((e: any) => emit(from, { t: role === 'semantic' ? 'semantic:status' : 'analyst:status', text: `Compact failed: ${e?.message ?? e}` }))
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
    try { const r = await fetch(`${DATASOURCE}/sources`, { signal: AbortSignal.timeout(4000) }); sources = ((await r.json())?.sources ?? []).length } catch { /* manager may still be warming — not fatal */ }
    return { ok: true, detail: `stores ok · workspace ok · datasources=${sources}` }
  } catch (e: any) { return { ok: false, detail: e?.message ?? String(e) } }
}

let reconnectDelay = 1000
function connect() {
  const url = `${HUB}/_ws/${encodeURIComponent(PROJECT)}?key=${encodeURIComponent(KEY)}`
  console.log(`[ica] connecting to hub ${url} as code-engine (no ports opened)`)
  const ws = new WebSocket(url)
  hub = ws
  ws.on('open', () => {
    reconnectDelay = 1000   // stable connection → reset backoff
    // machineId lets the hub self-heal which Fly machine it tracks (survives recreate/resize). Fly injects
    // FLY_MACHINE_ID automatically; undefined off-Fly (EC2/Docker) so it's simply omitted there.
    ws.send(JSON.stringify({ type: 'hello', key: KEY, role: 'code-engine', instanceId: INSTANCE_ID, epoch: EPOCH, machineId: process.env.FLY_MACHINE_ID }))
  })
  ws.on('message', async (raw) => {
    let m: any; try { m = JSON.parse(raw.toString()) } catch { return }
    const t = m.payload?.t
    if (t === 'welcome') {
      console.log(`[ica] registered (${m.payload.wsId}) — running self-check…`)
      // Only claim READY after the self-check passes. The hub/DO can trust this signal to mean the engine
      // can actually answer, not merely that a socket is open.
      selfCheck().then((res) => {
        if (ws !== hub || ws.readyState !== WebSocket.OPEN) return
        if (res.ok) { console.log(`[ica] READY — ${res.detail}`); ws.send(JSON.stringify({ type: 'ready', instanceId: INSTANCE_ID, epoch: EPOCH, detail: res.detail })) }
        else { console.error(`[ica] NOT READY — self-check failed: ${res.detail}`); ws.send(JSON.stringify({ type: 'not_ready', instanceId: INSTANCE_ID, detail: res.detail })) }
      })
      return
    }
    if (t === 'fenced')     { console.log('[ica] fenced — a newer engine holds this role (obsolete instance)'); return }
    if (t === 'superseded') { console.log('[ica] superseded by our own reconnection'); return }
    if (t === 'evicted')    { console.log('[ica] evicted — a newer connection took the role'); return }
    if (m.payload) await handle(m.payload, m.from)
  })
  ws.on('close', (code: number) => {
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
setInterval(() => { if (hub?.readyState === WebSocket.OPEN) hub.send(JSON.stringify({ type: 'heartbeat', busy })) }, 12000)
// Semantic-model consolidation heartbeat: ALWAYS running from boot, independent of any question signal. Every
// tick it checks for analyses past the watermark and drains them — so a restart with a backlog (even days
// later, with no new question asked) still gets consolidated. A no-op while a pass is in flight or the
// modeler is otherwise busy. (This is the SEMANTIC-MODEL consolidation; other layers get their own timers.)
setInterval(() => { semanticConsolidateTick().catch((e) => console.log('[semantic-consolidation] tick error:', e?.message ?? e)) }, SEMANTIC_CONSOLIDATE_INTERVAL_MS)
// ── Eager agent warm-up ───────────────────────────────────────────────────────
// The ESSENTIAL agents are pre-spawned at boot, not lazily on the first question. On a Fly VM that
// suspends/resumes to save money, a lazily-spawned claude costs ~10-15s on the FIRST question after a
// cold resume; warming here pays that once, at boot, so questions are always fast. (With Fly *suspend* =
// memory snapshot, warm agents even survive the suspend/resume — no re-spawn.) Only these four are warmed:
// analyst (answers), connector (data sources), modeler (consolidation), reflex (front door). Other
// agents stay on-demand. Fire-and-forget + per-agent logs so they're visible in the boot log; failures are
// non-fatal (the agent just falls back to lazy spawn on first use).
let warmed = false
async function warmEssentialAgents() {
  if (warmed) return; warmed = true
  console.log('[ica] warming essential agents (analyst · connector · modeler · reflex)…')
  const warm = async (name: string, p: Promise<unknown>): Promise<{ name: string; ok: boolean; ms: number }> => {
    const t0 = Date.now()
    try { await p; const ms = Date.now() - t0; console.log(`[ica] warm: ${name} ready (${(ms / 1000).toFixed(1)}s)`); return { name, ok: true, ms } }
    catch (e: any) { console.warn(`[ica] warm: ${name} failed (falls back to lazy) — ${e?.message ?? e}`); return { name, ok: false, ms: Date.now() - t0 } }
  }
  const results = await Promise.all([
    warm('reflex', (reflex as any).warmup?.() ?? Promise.resolve()),
    warm('analyst',   analystSlot.get().then(a => a.session.warmup?.())),
    warm('connector', connectorSlot.get().then(a => a.session.warmup?.())),
    warm('modeler',   semanticSlot.get().then(a => a.session.warmup?.())),
  ])
  // ONE unmistakable line the user can look for: the engine has finished booting and every essential agent
  // is up (or which one failed). "Fully ready" vs "ready with warnings" — never ambiguous.
  const allOk = results.every(r => r.ok)
  const roster = results.map(r => `${r.name} ${r.ok ? '✓' : '✗'} ${(r.ms / 1000).toFixed(1)}s`).join(' · ')
  const sources = await listSources().then(s => s.length).catch(() => 0)
  const bar = '═'.repeat(64)
  console.log(`\n${bar}`)
  console.log(`  ${allOk ? '✅ ENGINE FULLY READY' : '⚠️  ENGINE READY (with warnings)'} — project ${PROJECT}`)
  console.log(`     agents: ${roster}`)
  console.log(`     datasources=${sources} · idle, waiting for questions`)
  console.log(`${bar}\n`)
}
// Give the datasource manager a moment to come up (analyst/modeler read its /sources at create), then warm.
setTimeout(() => { warmEssentialAgents().catch((e) => console.warn('[ica] warm-up error:', e?.message ?? e)) }, 4000)

// On shutdown: stop our session — the harness reaps whatever binary/server it started (opencode
// reaps its server only if it owns it). Delay exit so any close() SIGTERM reaches the binary.
const shutdown = () => {
  // Graceful goodbye: free the singleton slot NOW so the replacement process connects into an empty slot
  // (no restart-window eviction war). Then stop sessions and exit.
  try { if (hub?.readyState === WebSocket.OPEN) hub.send(JSON.stringify({ type: 'bye', instanceId: INSTANCE_ID })) } catch { /* socket already gone */ }
  analystSlot.stop(); semanticSlot.stop(); connectorSlot.stop(); groundingSlot.stop(); setTimeout(() => process.exit(0), 300)
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
connect()
