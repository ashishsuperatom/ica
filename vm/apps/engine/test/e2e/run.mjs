// ⚠️  TEST-ONLY orchestrator — never production. Boots the local hub + manager + engine on localhost against a
// THROWAWAY project (e2e-local) on the local SQLite source, waits for the engine to report READY, sends ONE
// question over the local hub (as the UI would), prints the answer, and points at the artifacts to inspect.
//
// Safety: the engine connects to whatever ICA_* say and shell env beats its .env (verified), so we set the test
// values here. The guard below ABORTS if anything points off-localhost, so this can never touch production.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE_DIR = join(HERE, '..', '..')                         // vm/apps/engine
const VM_ROOT = join(ENGINE_DIR, '..', '..')                      // vm/  — the monorepo root (node_modules lives here)
const MANAGER_DIR = join(ENGINE_DIR, '..', 'datasources', 'manager')
const SCRATCH = process.env.E2E_SCRATCH || '/tmp/sa-e2e'          // DB + manager data — OUTSIDE the workspace on purpose
const PROJECT = 'e2e-local'
const HUB_PORT = 5174, MGR_PORT = 4000
const QUESTION = process.argv[2] || 'How many employees are in each department?'
const KEEP = process.argv.includes('--keep')                      // leave services running for inspection

const env = {
  ...process.env,
  ICA_HUB: `ws://localhost:${HUB_PORT}`,
  ICA_PROJECT: PROJECT,
  ICA_KEY: 'test-key',
  ICA_HARNESS: 'opencode',
  ICA_OC_URL: process.env.ICA_OC_URL || 'http://127.0.0.1:4096',  // reuse a running `opencode serve`
  DATASOURCE_URL: `http://localhost:${MGR_PORT}`,
  DATASOURCE_PORT: String(MGR_PORT),
  // The state dir MUST live inside the monorepo so a generated program can resolve `@superatom/scaffold` etc. via
  // node_modules walk-up (exactly as the real vm/.state does). A /tmp state dir can't, and every program-run fails.
  ENGINE_STATE_DIR: join(VM_ROOT, '.state-e2e'),
  DATASOURCE_DATA_DIR: join(SCRATCH, 'mgr-data'),
  E2E_DB: join(SCRATCH, 'employees.db'),
  SOURCES: JSON.stringify({ EMPLOYEES: join(HERE, 'bridge.mjs') }),
  TEST_HUB_PORT: String(HUB_PORT),
}
// HARD GUARD — localhost only, never production.
for (const [k, v] of [['ICA_HUB', env.ICA_HUB], ['DATASOURCE_URL', env.DATASOURCE_URL]]) {
  if (!/localhost|127\.0\.0\.1/.test(v)) { console.error(`ABORT: ${k}=${v} is not localhost — this rig is TEST-ONLY`); process.exit(1) }
}
if (/superatom\.site/.test(env.ICA_HUB)) { console.error('ABORT: refusing to point at production'); process.exit(1) }

mkdirSync(SCRATCH, { recursive: true })
const kids = []
const spawnSvc = (name, cmd, args, cwd) => {
  // detached → own process group, so we can kill the WHOLE tree (pnpm exec → tsx → node). A plain SIGTERM to the
  // pnpm wrapper leaves the real engine/manager orphaned (learned that the hard way).
  const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const tag = (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`))
  p.stdout.on('data', tag); p.stderr.on('data', tag)
  kids.push(p); return p
}
const cleanup = () => { for (const p of kids) { try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} } } }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(0) })

console.log(`\n=== TEST-ONLY E2E RIG · project=${PROJECT} · scratch=${SCRATCH} ===`)
console.log(`Q: "${QUESTION}"\n`)

// 1) hub  2) manager  3) engine
spawnSvc('hub', 'node', [join(HERE, 'hub.mjs')], HERE)
spawnSvc('manager', 'pnpm', ['exec', 'tsx', 'src/index.ts'], MANAGER_DIR)
await new Promise((r) => setTimeout(r, 3000))
spawnSvc('engine', 'pnpm', ['exec', 'tsx', 'engine.ts'], ENGINE_DIR)

// Client: connect to the hub, wait for engine READY, ask, collect the answer.
const ws = new WebSocket(`ws://localhost:${HUB_PORT}/client`)
const qid = 'e2e-' + Math.floor(Date.now() / 1000)
let ready = false, answered = false
const deadline = Date.now() + 8 * 60 * 1000   // generous: engine warmup (~1-2m) + build (~2-3m)

ws.on('open', () => ws.send(JSON.stringify({ type: 'client-hello' })))
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()) } catch { return }
  const p = m.payload || {}
  if (p.t === 'engine:ready' && !ready) {
    ready = true
    console.log(`\n>>> engine READY — asking the question now\n`)
    ws.send(JSON.stringify({ payload: { t: 'analyse', question: QUESTION, sessionId: 'e2e-sess', questionId: qid } }))
  }
  if (p.t === 'narration')       console.log(`   · beat: ${p.text}`)
  if (p.t === 'analyst:progress')console.log(`   · progress: ${p.text}`)
  if (p.t === 'analyst:answer') {
    answered = true
    console.log(`\n=== ANSWER (category: ${p.category}) ===`)
    console.log(typeof p.answer === 'string' ? p.answer : JSON.stringify(p.answer, null, 2))
    reportArtifacts()
    if (!KEEP) { cleanup(); process.exit(0) }
  }
})

function reportArtifacts() {
  const outDir = join(env.ENGINE_STATE_DIR, PROJECT, 'out', qid)
  console.log(`\n=== ARTIFACTS ===`)
  console.log(`out dir: ${outDir}`)
  try { for (const f of readdirSync(outDir)) console.log(`  - ${f}`) } catch { console.log('  (no out dir yet)') }
  console.log(`\nInspect the claude analyst transcript under ~/.claude/projects/ (workspace ${join(env.ENGINE_STATE_DIR, PROJECT)}).`)
}

const timer = setInterval(() => {
  if (Date.now() > deadline && !answered) { console.error('\nTIMED OUT waiting for an answer.'); reportArtifacts(); cleanup(); process.exit(1) }
}, 5000)
timer.unref?.()
