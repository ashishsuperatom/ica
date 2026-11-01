#!/usr/bin/env node
// END TO END, THE INTENT GRAPH (docs/intent-graph.md) — against a real project and its running engine, through sacli (the
// platform's own door) and the engine's log. Real agents answer: a run takes minutes.
//
//   node scripts/e2e/intents.mjs [core|people|permissions|greeting|all] --profile proc-demo --other proc-limited --engine <pm2 name>
//       [--q1 "…" --refine "…" --q2 "…" --q1b "…"]
//
// core         a new question → the analyst answers, the node is made; a refinement → the same intent, the composer;
//              another question → a new intent, and the one before closes (a clone of the conversation keeps what it
//              learnt: the person's variant); the first question in a new session → matched, answered by the composer
// people       another person asking it answers with the project's way (unverified); approved by a curator → verified
// permissions  a person without project.develop asking for a program → told which permission it needs, nothing built
// greeting     not a request: answered, no node
//
// Prints ✓ / ✗ per check; exits 1 when any failed.

import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SACLI = join(ROOT, 'cli', 'dist', 'sacli.mjs')
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const PROFILE = opt('profile', 'proc-demo'), OTHER = opt('other', 'proc-limited'), ENGINE = opt('engine', 'sa-engine-procurement-intelligence')
const Q1 = opt('q1', 'How many RFQs are open right now?')
const Q1B = opt('q1b', 'how many RFQs are open at the moment?')
const REFINE = opt('refine', 'Show them as a table with their buyer and closing date')
const Q2 = opt('q2', 'Which suppliers have submitted the most bids?')
const which = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'all'
const RUN = Date.now().toString(36)

let failed = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && detail ? ` — ${String(detail).slice(0, 400)}` : ''}`); if (!cond) failed++ }
const sacli = (a, profile = PROFILE) => {
  const r = spawnSync(process.execPath, [SACLI, '--profile', profile, ...a, '--no-daemon'], { encoding: 'utf8', input: '', timeout: 1_200_000 })
  return { code: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').replace(/^— profile.*$/m, '').trim() }
}
const json = (a, profile) => { const r = sacli([...a, '--json'], profile); try { return JSON.parse(r.out) } catch { return { error: r.err || r.out } } }
const ask = (text, session, profile = PROFILE) => {
  const t0 = Date.now()
  const r = json(['ask', text, '--session', session, '--timeout', '1100'], profile)
  const a = r.answer ?? {}
  console.log(`    · ${profile} «${text.slice(0, 60)}» → ${a.node ? `${a.node.how} ${a.node.id} "${a.node.title}" by ${a.node.agent}` : 'no node'} (${Math.round((Date.now() - t0) / 1000)}s)${r.error ? ` — ${String(r.error).slice(0, 200)}` : ''}`)
  return { ...a, error: r.error }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const engineLog = () => { try { return execFileSync('pm2', ['logs', ENGINE, '--nostream', '--lines', '600', '--raw'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) } catch (e) { return String(e.stdout ?? '') } }
async function until(f, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await wait(5000) } return null }
const show = (id) => json(['intent', 'show', id])

const state = {}

async function core() {
  console.log('core')
  const s = `e2e-int-${RUN}-a`
  const a1 = ask(Q1, s)
  ok('a new question is answered by the analyst, at a node made for it', a1.node?.how === 'made' && a1.node?.agent === 'analyst' && !!a1.markdown, JSON.stringify(a1.node ?? a1.error))
  const a2 = ask(REFINE, s)
  ok('a refinement of the answer stays in the same intent, answered by the composer', a2.node?.id === a1.node?.id && a2.node?.how === 'same' && a2.node?.agent === 'composer', JSON.stringify(a2.node ?? a2.error))
  const a3 = ask(Q2, s)
  ok('another question is another intent', !!a3.node && a3.node.id !== a1.node?.id, JSON.stringify(a3.node ?? a3.error))
  const closed = await until(() => engineLog().split('\n').find((l) => l.includes(`closed ${a1.node?.id}`)), 12 * 60_000)
  ok('the intent before closed in a clone of the conversation', !!closed, 'no "closed" line in the engine log within 12 minutes')
  if (closed) console.log(`    · ${closed.replace(/^.*\[intent\]/, '[intent]').slice(0, 300)}`)
  const n = show(a1.node?.id)
  const mine = (n.variants ?? []).find((v) => !v.deprecated)
  ok('what it learnt is kept as the person\'s variant of the node', !!mine?.process, JSON.stringify(n.error ?? n.variants))
  state.node = a1.node?.id; state.owner = mine?.owner; state.version = mine?.version
  const a4 = ask(Q1B, `e2e-int-${RUN}-b`)
  ok('the same question in a new session is matched to the node and answered by the composer', a4.node?.id === a1.node?.id && a4.node?.how === 'matched' && a4.node?.agent === 'composer', JSON.stringify(a4.node ?? a4.error))
  ok('the answer offers next intents (or the node has no ways out yet)', Array.isArray(a4.next) || !(n.edges ?? []).length, JSON.stringify(a4.next))
}

async function people() {
  console.log('people')
  if (!state.node) { ok('core ran first (the node to ask again)', false); return }
  const b1 = ask(Q1, `e2e-int-${RUN}-c`, OTHER)
  ok('another person is matched to the same node, with the project\'s way — not yet approved', b1.node?.id === state.node && b1.node?.how === 'matched' && b1.node?.verified === false, JSON.stringify(b1.node ?? b1.error))
  const ap = sacli(['intent', 'approve', state.node, state.owner, String(state.version), '--why', 'e2e'])
  ok('a curator approves a person\'s way as the project\'s', ap.code === 0, ap.err || ap.out)
  const b2 = ask(Q1, `e2e-int-${RUN}-d`, OTHER)
  ok('then the other person answers with the approved way', b2.node?.id === state.node && b2.node?.verified === true, JSON.stringify(b2.node ?? b2.error))
}

async function permissions() {
  console.log('permissions')
  const r = ask('Build me a program that lists the RFQs closing this week.', `e2e-int-${RUN}-e`, OTHER)
  ok('a person without project.develop asking for a program is told which permission it needs', /project\.develop/.test(r.markdown ?? ''), (r.markdown ?? r.error ?? '').slice(0, 300))
}

async function greeting() {
  console.log('greeting')
  const r = ask('hi', `e2e-int-${RUN}-f`)
  ok('a greeting is answered, at no node', !!r.markdown && !r.node, JSON.stringify(r.node ?? r.error))
}

const steps = { core, people, permissions, greeting }
for (const k of which === 'all' ? Object.keys(steps) : [which]) await steps[k]()
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
