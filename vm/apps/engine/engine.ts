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
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { execProgram, answerView } from './exec-program.js'
import { createSession, prepareWorkspace, type Session, type Harness, type RunHandlers } from './ica/index.js'
import { createNarrator, capResultData, stripCode } from './agents/narrator/index.js'
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
import { createSpanFirer } from './retrieval/span-firing.js'
// TYPE-ONLY, and it must stay that way: the deploy bundles package vm/ alone, so this path does not exist in a
// built image. tsx erases a type-only import, which is why the container runs without it. Making it a value
// import would break every deploy while working perfectly here.
import type { EngineMsgType } from '../../../clients/protocol.js'
import { buildDatasourceIndex } from './datasource-index/build.js'

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
// SEGREGATION (see ica/workspace.ts): the agent's write-root and the engine's DBs are SIBLING folders under the
// project home, so the agent's cwd never contains our SQLite files.
const WORKSPACE = join(WORKSPACE_ROOT, PROJECT, 'workspace')   // the AGENT's cwd: seams + programs/ + out/
const DB_DIR    = join(WORKSPACE_ROOT, PROJECT, 'db')          // ENGINE-private DBs — a sibling, NOT under WORKSPACE
// Committed per-project CONFIG (index seeds, datasource notes) — distinct from generated state above.
const PROJECT_DIR = process.env.ENGINE_PROJECT_DIR ?? join(__dirname, '..', '..', 'projects', PROJECT)
const KEY = process.env.ICA_KEY || ''
const HARNESS = (process.env.ICA_HARNESS as Harness) || 'opencode'   // read AFTER .env is loaded
// ONE fleet switch for the WORK agents (analyst/connector/grounding): ICA_AGENT_HARNESS =
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
const { harness: CONNECTOR_HARNESS, model: CONNECTOR_MODEL } = agentCfg('CONNECTOR')
const { harness: GROUNDING_HARNESS, model: GROUNDING_MODEL } = agentCfg('GROUNDING')
const { harness: MODELLER_HARNESS,  model: MODELLER_MODEL }  = agentCfg('MODELLER')   // the concept modeller (System 4)
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
let hub: WebSocket | null = null

// PER-SESSION answer lock: DIFFERENT sessions answer CONCURRENTLY; one session still answers one at a time. The
// stream target (reply) + channel are LOCAL per analyse() call now — no cross-session clobber. curQuestion/
// lastAnswer below stay global as a best-effort reconnect-status snapshot only, never for answer routing.
const busySessions = new Set<string>()
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
const CONCEPT_STOP = new Set(('a an the of on in for by per to and or is are was be with as at this that it id ' +
  'what which who how me my we our you your can do get give show tell find value from over under across').split(' '))
// Light stem so word-FORMS match (rate/rates/rating -> rat, charge/charged -> charg, bill/billing -> bill).
// Morphology only — deliberately NOT synonyms (bill != charge). If a question uses a different word than the
// concept name, it simply won't match; we keep it simple rather than maintain a synonym layer.
const stem = (w: string): string => {
  for (const suf of ['ing', 'ed', 'es', 's', 'ly']) { if (w.endsWith(suf) && w.length - suf.length >= 3) { w = w.slice(0, -suf.length); break } }
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}
const conceptWords = (s: string): Set<string> =>
  new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !CONCEPT_STOP.has(w)).map(stem))
// Favour RECALL, not precision: surface anything plausibly relevant and let the AGENT reject/pick. Two cheap
// recall sources unioned — LEXICAL (name-word overlap) and SEMANTIC (the vector index, which catches paraphrase/
// synonyms for free, no synonym map to maintain). We ORDER by specificity (most name-words covered first) so the
// best is on top, but we do NOT cut the tail — better the agent sees an extra it can ignore than miss the right one.
async function rankConceptsBySpecificity(question: string, cap: number): Promise<string[]> {
  const qw = conceptWords(question)
  if (!qw.size) return []   // boundary: empty / all-stopword question -> surface nothing
  const byId = new Map<string, { name: string; matched: number; cover: number; sem: number }>()
  for (const c of graph.listKind('concept', 1000) as any[]) {
    // Surface ALL live concepts, ordered by specificity — the agent filters (recall over precision).
    const cw = conceptWords(c.label)
    let m = 0; for (const w of cw) if (qw.has(w)) m++
    byId.set(c.id, { name: c.label, matched: m, cover: cw.size ? m / cw.size : 0, sem: 0 })
  }
  if (vectors) {   // semantic recall: rank the vector hits so paraphrase-only matches still surface
    try {
      const hits = await hybridSearch(graph, vectors, bgeEmbedder, question, { kind: 'concept', limit: cap })
      let r = hits.length; for (const h of hits) { const e = byId.get(h.id); if (e) e.sem = r; r-- }
    } catch { /* semantic is optional; lexical still works */ }
  }
  return [...byId.values()]
    .filter(c => c.matched > 0 || c.sem > 0)                                            // lexical OR semantic relevance
    .sort((a, b) => (b.matched - a.matched) || (b.cover - a.cover) || (b.sem - a.sem))  // specificity first, semantic as recall/tiebreak
    .slice(0, cap)
    .map(c => c.name)
}
// Semantic index (sqlite-vec) over the SAME db — GUARDED: if the native extension or model isn't present on
// this host yet, semantic search is simply disabled (FTS keeps working), never a crash. See embed.ts.
let vectors: SqliteVecIndex | null = null
try { vectors = new SqliteVecIndex(graph.db, bgeEmbedder.id, bgeEmbedder.dim) }
catch (e: any) { console.warn('[semantic] sqlite-vec unavailable — semantic index disabled:', e?.message ?? e) }
// §3 span-firing retriever — an A/B alternative to rankConceptsBySpecificity, logged side-by-side for comparison.
const spanFirer = createSpanFirer(graph, bgeEmbedder)
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
    harness: HARNESS,
    agents: {
      analyst:   { harness: ANALYST_HARNESS,   model: ANALYST_MODEL,   busy: busySessions.size > 0 },
      connector: { harness: CONNECTOR_HARNESS, model: CONNECTOR_MODEL, busy: connectorBusy },
      grounding: { harness: GROUNDING_HARNESS, model: GROUNDING_MODEL, busy: groundingBusy },
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
// The COMPOSER (System 2), ONE PER SESSION: each chat session gets its own composer (a cheap opencode CLIENT
// session on the shared server, so N sessions ≈ free). Created on the session's first question, reused for the
// session; only the in-flight question needs memory. Idle sessions are disposed by the sweep below.
const composersBySession = new Map<string, { composer: Promise<Composer>; lastUsed: number }>()
function getComposer(sid: string): Promise<Composer> {
  let e = composersBySession.get(sid)
  if (!e) {
    e = { composer: createComposer({ root: WORKSPACE_ROOT, projectId: PROJECT, managerUrl: DATASOURCE, ica: { baseUrl: OC_URL } }), lastUsed: Date.now() }
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
const connectorSlot = makeAgentSlot('connector', connectorPromptVersion, (resumeId) => createConnector({ root: WORKSPACE_ROOT, projectId: PROJECT, managerUrl: DATASOURCE, datasourcesDir: DATASOURCES_DIR, ica: { harness: CONNECTOR_HARNESS, model: CONNECTOR_MODEL, resumeId } }))
// COLD by design: never warmed at boot (below); spun up only when the admin triggers a grounding build.
const groundingSlot = makeAgentSlot('grounding', groundingPromptVersion, (resumeId) => listSources().then(sources => createGroundingAgent({ root: WORKSPACE_ROOT, projectId: PROJECT, sources, managerUrl: DATASOURCE, ica: { harness: GROUNDING_HARNESS, model: GROUNDING_MODEL, resumeId } })))
// The CONCEPT MODELLER (System 4 — "sleep"): LAZY, never warmed at boot — spun up only when the offline
// consolidation tick has a batch to study, then it distils verified concepts from finished analyses.
const modellerSlot = makeAgentSlot('modeller', modellerPromptVersion, (resumeId) => listSources().then(sources => createConceptModeller({ root: WORKSPACE_ROOT, projectId: PROJECT, sources, managerUrl: DATASOURCE, ica: { harness: MODELLER_HARNESS, model: MODELLER_MODEL, resumeId } })))
console.log(`[ica] analyst=${ANALYST_HARNESS ?? 'claude-code'}:${ANALYST_MODEL ?? 'claude-sonnet-5'} · connector=${CONNECTOR_HARNESS}:${CONNECTOR_MODEL} · grounding=${GROUNDING_HARNESS}:${GROUNDING_MODEL} (cold)`)
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
    const rr = await execProgram(WORKSPACE, programDir, params ?? {})
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
  let conceptNames: string[] = []   // engine-searched CONCEPT names (names only) surfaced to composer + analyst
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
    // NO reflex routing. The exact-match fast-path above already handled exact repeats (no LLM). For everything
    // else the ENGINE searches (semantic) and hands the composer the candidate programs + scores — the composer
    // judges (reuse a strong match / compose from concepts / escalate). Placement is the regex heuristic: a
    // self-contained question is a new ROOT topic; a follow-up hangs under the current node.
    placement = rootQuestion ? 'root' : pos
    try {
      const hits = vectors ? await hybridSearch(graph, vectors, bgeEmbedder, question, { kind: 'intent', limit: 6 }) : []
      programCandidates = hits
        .map(h => { const p = graph.getNode(h.id)?.props as any; return { question: (p?.question ?? h.label ?? '') as string, program: p?.program as string | undefined, score: h.score, sim: h.sim } })
        .filter(c => c.program && existsSync(join(WORKSPACE, c.program!, 'program.ts')))
      const top = programCandidates[0]
      console.log(`[ica] search: ${programCandidates.length} program candidate(s)${top ? ` · top ${top.program} (sim ${top.sim == null ? 'n/a' : top.sim.toFixed(2)})` : ''} → composer`)
    } catch (e: any) {
      console.log(`[ica] candidate search failed (${e?.message ?? e}) — composer builds from concepts`)
    }
    // Surface relevant CONCEPT NAMES by SPECIFICITY (CSS-like: most-question-words-covered wins), names only —
    // the agent opens the winner via find-concept for the method, so we never bias it with a formula.
    try {
      const specificity = await rankConceptsBySpecificity(question, 8)   // current retriever (name-word specificity + semantic recall)
      let fired: { concepts: string[]; scored: { name: string; activation: number }[]; unexplained: string[] } = { concepts: [], scored: [], unexplained: [] }
      try { fired = await spanFirer.fire(question) } catch (e: any) { log.warn('span-firing', 'fire failed', e) }
      // Log BOTH retrievers side-by-side so we can compare which surfaces the right concepts.
      console.log(`[retrieval] specificity → [${specificity.join(', ')}]`)
      console.log(`[retrieval] span-firing → fires [${fired.concepts.join(', ')}]  ·  ranked [${fired.scored.slice(0, 6).map(s => `${s.name} ${s.activation.toFixed(2)}`).join(', ')}]${fired.unexplained.length ? `  ·  unexplained [${fired.unexplained.slice(0, 8).join(' | ')}]` : ''}`)
      // CLEAN A/B — surface EXACTLY ONE retriever, no mixing/fallback. Default = span-firing (B); USE_SPECIFICITY=1 = specificity (A).
      // Span-firing surfaces the concepts that FIRED plus the rest of its own ranking (still one retriever — it just
      // stops discarding what it already scored). Only NAMES travel, and reading one is now a deliberate
      // ./get-concept call, so an extra candidate costs a line and never lands unread in the agent's context.
      // Firing alone was too tight: "which projects are at risk" fired only 'project name, customer, manager and
      // type' (6.23) and dropped 'at-risk project' (5.75) — the concept that defines the question.
      const TOP_CONCEPTS = 6
      const spanNames = Array.from(new Set([...fired.concepts, ...fired.scored.map(s => s.name)])).slice(0, TOP_CONCEPTS)
      conceptNames = process.env.USE_SPECIFICITY ? specificity : spanNames
      if (conceptNames.length) console.log(`[ica] concepts surfaced: ${conceptNames.join(', ')}`)
    } catch (e: any) { console.log(`[ica] concept search failed (${e?.message ?? e})`) }
  }

  // Liveness keepalive: the UI arms a 25s watchdog and re-arms on every message. Claude-code's PTY streams
  // constantly so it's always fed, but SDK harnesses (codex) reason/exec silently for long stretches — and
  // the gap-loop model build is silent too. Tick every 8s for the whole turn so the watchdog never false-fires.
  // (armed at the top of the turn — see where `reply` is taken)
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
    // Both lanes announce themselves (agent:hello). Composer runs first (events-only, read-only); the analyst
    // lane declares its raw-terminal capability + interactive controls so the UI can offer them generically.
    emit(reply, A('hello', 'composer', { label: 'Composer', hue: '#4a90d9', streamKind: 'events', pty: false, interactive: false, sid }))
    emit(reply, A('hello', 'analyst', { label: 'Analyst', hue: '#c08a2b', streamKind: analyst.session.events ? 'events' : (analyst.session.kind ?? 'events'), pty: analyst.session.kind === 'pty', interactive: true, controls: ['terminal', 'compact', 'new'], sid }))
    // Kick off the narration: an immediate opener, then every few seconds translate whatever the analyst just did
    // into ONE business line. Overlap-guarded (skip a tick if the previous narrate is still running).
    // The COMPOSER narrates ITSELF (its [[ui]] lines become beats — see onNarration). The separate deepseek
    // NARRATOR is spun up ONLY when we escalate to the analyst (claude-code has no clean self-narration): it
    // translates the analyst's raw activity into business beats. startNarrator() begins that loop on demand.
    const startNarrator = () => {
      narrator = createNarrator({ cwd: WORKSPACE })
      narrationTimer = setInterval(async () => {
        if (narrating || !reply || narrationBuf.length === 0) return
        narrating = true
        const activity = narrationBuf.splice(0).join('\n')
        try {
          // TIMEOUT the narrate call so a hung beat (deepseek) can't freeze narration (finally never running).
          const line = await Promise.race([narrator!.narrate(question, activity), new Promise<null>((res) => setTimeout(() => res(null), 20000))])
          if (line) {
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
        // The COMPOSER self-narrates — its [[ui]] line IS a business beat, so it drives the analysis tape directly
        // (no separate narrator runs during the composer phase). The ANALYST's [[ui]] is a side progress line; its
        // beats come from the deepseek narrator started on escalation.
        if (currentAgent === 'composer') emitBeat(reply, text, qid, sid)
        else emit(reply, A('status', 'analyst', { progress: text, sid }))
      },
      // Structured events (codex/SDK harnesses only — claude PTY uses onOutput above). The session already
      // normalizes + buffers these (session.events()); the engine just mirrors each one live to the asker and
      // any attached viewers, same as onOutput. Reconnect replay is handled in resyncAnalyst via events().
      onEvent: (ev) => {
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
        if (ev.kind === 'message' && ev.text?.trim()) { const prose = stripCode(ev.text); if (prose) narrationBuf.push(prose.slice(0, 600)) }
        else if (ev.kind === 'command' && ev.output?.trim() && isDataCall(ev.command)) narrationBuf.push(('RESULT: ' + capResultData(ev.output)).slice(0, 1800))
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
    // The narrator is ALWAYS-ON: it turns whichever agent is working (composer first, then the analyst on
    // escalation) into the live progress the user follows. The agents themselves write nothing user-facing.
    startNarrator()
    {
      // The COMPOSER handles both a fresh question (compose/reuse) AND a MODIFY (edit the current program in
      // place). It escalates only when it genuinely can't — then the analyst takes over.
      const composer = await getComposer(sid)
      const c = await composer.ask(question, handlers, { qid, candidates: programCandidates, conceptNames, modify: modifyTarget ?? undefined, resolvedQuestion })
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
      const askP = analyst.ask(question, handlers, { qid, conceptNames, reason: escalateReason, modify: modifyTarget ?? undefined, resolvedQuestion })
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
    // For a MODIFY the answer belongs to the ORIGINAL question (the node we edited), not the edit instruction.
    const savedQ = modifyTarget && curNode ? (curNode.summary ?? curQ ?? question) : question
    const savedNorm = modifyTarget && curNode ? (((curNode.props as any)?.question as string) ?? norm) : norm
    answers.save({ qid, sessionId: sid, question: savedQ, norm: savedNorm, category: r.category, status: r.answer?.status ?? 'error', answer: r.answer, createdAt: Date.now(), finishedAt: Date.now(), programDir: programDir ?? modifyTarget?.programDir, params: programParams, build: await buildIdentity(), route: authoredBy })
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
      const authoredMeta = authoredBy === 'composer'
        ? { by: 'composer', harness: process.env.ICA_COMPOSER_HARNESS || 'opencode', provider: process.env.ICA_COMPOSER_PROVIDER || 'opencode-go', model: process.env.ICA_COMPOSER_MODEL || 'deepseek-v4-flash', at: Date.now() }
        : { by: 'analyst', harness: ANALYST_HARNESS, provider: process.env.ICA_ANALYST_PROVIDER || null, model: ANALYST_MODEL ?? null, at: Date.now() }
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
    emit(reply, A('status', 'analyst', { state: 'done', sid }))
    analystSlot.persist()   // capture the live ids (incl. any resume-fallback)
    busySessions.delete(sid)
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
  // KEEPALIVE. An idle WebSocket is closed at the edge, and this one is idle most of the time — the engine
  // speaks when there is a question and is silent in between. The symptom is a clean register followed by a
  // 1006 about half a minute later, forever. Not cosmetic: every reconnect re-announces presence, and anything
  // in flight is riding a socket that keeps going away underneath it.
  //
  // A literal `ping`, because the Durable Object registers it as an AUTO-RESPONSE pair — Cloudflare answers
  // `pong` at the edge and never wakes the DO, so staying connected costs no compute. The reply is not JSON
  // and the message handler already drops anything that will not parse.
  let beat: ReturnType<typeof setInterval> | null = null
  const stopBeat = () => { if (beat) { clearInterval(beat); beat = null } }
  ws.on('open', () => {
    reconnectDelay = 1000   // stable connection → reset backoff
    stopBeat()
    beat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { try { ws.send('ping') } catch { /* the close handler reconnects */ } } }, 12_000)
    beat.unref?.()
    // machineId lets the hub self-heal which Fly machine it tracks (survives recreate/resize). Fly injects
    // FLY_MACHINE_ID automatically; undefined off-Fly (EC2/Docker) so it's simply omitted there.
    ws.send(JSON.stringify({ type: 'hello', key: KEY, role: 'code-engine', instanceId: INSTANCE_ID, epoch: EPOCH, machineId: process.env.FLY_MACHINE_ID }))
  })
  ws.on('message', async (raw) => {
    let m: any; try { m = JSON.parse(raw.toString()) } catch { return }
    const t = m.payload?.t
    if (t === 'welcome') {
      console.log(`[ica] registered (${m.payload.wsId}) — running self-check…`)
      flushOutbox()   // re-registered → deliver anything queued while the socket was flapping (answers, logs)
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
let warmed = false
async function warmEssentialAgents() {
  if (warmed) return; warmed = true
  console.log('[ica] warming essential agents (analyst · connector)…')
  const warm = async (name: string, p: Promise<unknown>): Promise<{ name: string; ok: boolean; ms: number }> => {
    const t0 = Date.now()
    try { await p; const ms = Date.now() - t0; console.log(`[ica] warm: ${name} ready (${(ms / 1000).toFixed(1)}s)`); return { name, ok: true, ms } }
    catch (e: any) { console.warn(`[ica] warm: ${name} failed (falls back to lazy) — ${e?.message ?? e}`); return { name, ok: false, ms: Date.now() - t0 } }
  }
  const results = await Promise.all([
    warm('analyst',   analystSlot.get().then(a => a.session.warmup?.())),
    warm('connector', connectorSlot.get().then(a => a.session.warmup?.())),
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
  analystSlot.stop(); connectorSlot.stop(); groundingSlot.stop(); modellerSlot.stop(); setTimeout(() => process.exit(0), 300)
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
connect()
