#!/usr/bin/env node
// END TO END, THE CONNECTORS AND WORKLOADS (docs/connectors-plan.md step 8) — against a real project and its running
// engine, through sacli (the platform's own door) and Docker (the live databases of connectors/test/live/up.sh).
//
//   node scripts/e2e/connectors.mjs [sanity|core|permissions|lifecycle|failure|all] [--profile lab] [--org-profile test-org]
//
// sanity       the engine is connected; every workload reports; every connection reaches its source (its own test)
// core         every source is indexed by its own description; the cache is seen; a question with a known answer
// permissions  a viewer sees workloads but cannot act, and never sees an error's detail; an unknown action is refused
// lifecycle    restart; a connection pinned to an older build: newer said, update, rollback; a process killed comes back
// failure      a database stopped: its test says why, it reads degraded; started again: ready
//
// Needs: the project's engine running (Local Lab: natively, `sacli --profile lab engine start --native`), the live
// databases (connectors/test/live/up.sh) connected to it as SALES_* (see the SALES_ checks), and an organisation key
// profile (for a viewer's key). Prints ✓ / ✗ per check; exits 1 when any failed.

import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SACLI = join(ROOT, 'cli', 'dist', 'sacli.mjs')
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const PROFILE = opt('profile', 'lab'), ORG = opt('org-profile', 'test-org')
const which = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) ?? 'all'
const SQL_SOURCES = ['SALES_PG', 'SALES_MYSQL', 'SALES_MSSQL', 'SALES_ORACLE', 'SALES_CH', 'SALES_MONGO']
const CONTAINER = { SALES_PG: 'sa-live-postgres', SALES_MYSQL: 'sa-live-mysql', SALES_ORACLE: 'sa-live-oracle', SALES_CH: 'sa-live-clickhouse', SALES_MONGO: 'sa-live-mongo', SALES_MSSQL: 'sa-live-mssql' }

let failed = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && detail ? ` — ${String(detail).slice(0, 300)}` : ''}`); if (!cond) failed++ }
const sacli = (a, { key, profile = PROFILE } = {}) => {
  const r = spawnSync(process.execPath, [SACLI, ...(key ? ['--key', key] : ['--profile', profile]), ...a, '--no-daemon'], { encoding: 'utf8', input: '', timeout: 600_000 })
  return { code: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').replace(/^— profile.*$/m, '').trim() }
}
const json = (a, o) => { const r = sacli([...a, '--json'], o); try { return JSON.parse(r.out) } catch { return { error: r.err || r.out } } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const workloads = (o) => json(['workloads'], o).workloads ?? []
const one = (id) => workloads().find((w) => `${w.kind}/${w.id}` === id)
async function until(what, f, ms = 120_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await wait(3000) } return null }
const pid = () => json(['whoami']).project?.id ?? json(['whoami']).project

async function sanity() {
  console.log('sanity')
  const st = sacli(['engine', 'status'])
  ok('the engine is connected', /connected\s+yes/.test(st.out), st.out + st.err)
  const all = workloads()
  ok('every kind reports (engine, connections, agents)', ['engine', 'connection', 'agent'].every((k) => all.some((w) => w.kind === k)), JSON.stringify(all.map((w) => w.kind)))
  for (const w of all.filter((x) => x.kind === 'connection')) {
    const r = sacli(['workloads', 'act', `connection/${w.id}`, 'test'])
    ok(`${w.id} reaches its source (its own test)`, r.code === 0, r.err)
  }
}

async function core() {
  console.log('core')
  const stats = sacli(['dsi', 'stats']).out
  for (const s of SQL_SOURCES) ok(`${s} is indexed from its own description`, new RegExp(`${s}\\s+(4|5)\\s+19\\b`).test(stats), stats.split('\n').find((l) => l.startsWith(s)))
  const cache = json(['workloads', 'inspect', 'connection/SALES_PG', 'cache'])
  ok('a connection\'s cache can be looked into', typeof cache?.entries === 'number' || typeof cache?.data?.entries === 'number', JSON.stringify(cache))
  const a = sacli(['ask', 'How many orders are there in SALES_PG? Just the number.'])
  ok('a question with a known answer (2,000 orders) is answered from the source', /2,?000/.test(a.out), a.out.slice(-300) + a.err)
}

async function permissions() {
  console.log('permissions')
  const p = pid()
  const made = sacli(['keys', 'create', 'e2e viewer', '--project', p, '--can', 'project.view', '--days', '1', '--json'], { profile: ORG })
  let key = null; try { key = JSON.parse(made.out).key } catch { /* below */ }
  ok('a viewer\'s key is made', !!key, made.err)
  if (!key) return
  try {
    const seen = workloads({ key })
    ok('a viewer sees the workloads', seen.length > 0)
    const act = sacli(['workloads', 'act', 'connection/SALES_PG', 'test'], { key })
    ok('a viewer cannot act on one', act.code !== 0 && /needs project\.data/.test(act.err), act.err)
    ok('a viewer never sees an error\'s detail', seen.every((w) => !w.error?.detail))
    const nope = sacli(['workloads', 'act', 'connection/SALES_PG', 'explode'])
    ok('an action a kind does not have is refused, with the ones it has', /has no action "explode" \(it has restart, test/.test(nope.err), nope.err)
  } finally {
    const id = JSON.parse(made.out).id
    if (id) sacli(['keys', 'revoke', id, '--project', p], { profile: ORG })
  }
}

async function lifecycle() {
  console.log('lifecycle')
  const r = sacli(['workloads', 'act', 'connection/SALES_MYSQL', 'restart'])
  ok('a connection restarts on request', r.code === 0 && /loaded again/.test(r.out), r.err)
  ok('…and is ready again', !!(await until('ready', () => one('connection/SALES_MYSQL')?.state === 'ready')))
  // pinned: an older build set by hand → newer said → update → rollback → update
  const bridges = JSON.parse(execFileSync('git', ['-C', ROOT, 'show', 'ef85e21f:connectors/dist/bridges.json'], { maxBuffer: 64 << 20 }).toString())
  const dir = mkdtempSync(join(tmpdir(), 'e2e-')), file = join(dir, 'old.mjs')
  writeFileSync(file, bridges.postgres.replace('PostgreSQL: LIMIT n', 'PostgreSQL (an older build): LIMIT n'))
  ok('a connection pinned to an older build by hand', sacli(['datasources', 'bridge', 'SALES_PG', file]).code === 0)
  const newer = await until('newer', () => one('connection/SALES_PG')?.newer)
  ok('its workload says a newer version exists', !!newer)
  ok('update moves it to the newest', /from now on/.test(sacli(['workloads', 'act', 'connection/SALES_PG', 'update']).out))
  ok('…and it runs it', !!(await until('updated', () => { const w = one('connection/SALES_PG'); return w?.state === 'ready' && !w.newer })))
  ok('rollback moves it back', /from now on/.test(sacli(['workloads', 'act', 'connection/SALES_PG', 'rollback']).out))
  ok('…and it runs the older one', !!(await until('back', () => one('connection/SALES_PG')?.newer)))
  sacli(['workloads', 'act', 'connection/SALES_PG', 'update'])
  // a connection's process killed outright: started again by the manager (the restarts it counts go up)
  await wait(5000)   // let the processes the update and rollback replaced be gone
  const restartsNow = () => workloads().filter((w) => w.kind === 'connection').reduce((n, w) => n + (w.restarts ?? 0), 0)
  const before = restartsNow()
  const alive = execFileSync('ps', ['-eo', 'pid,etime,command']).toString().split('\n').filter((l) => /host\.mjs/.test(l)).map((l) => Number(l.trim().split(/\s+/)[0]))
  let killed = false
  for (const p of alive) { try { process.kill(p, 'SIGKILL'); killed = true; break } catch { /* gone meanwhile */ } }
  ok('a connection process is killed outright', killed, 'no host.mjs process — is the engine running here?')
  if (killed) ok('…started again by the manager (its restarts counted), ready again', !!(await until('restarted', () => restartsNow() > before && workloads().every((w) => w.kind !== 'connection' || w.state === 'ready'), 120_000)))
}

async function failure() {
  console.log('failure')
  const name = 'SALES_CH', c = CONTAINER[name]
  execFileSync('docker', ['stop', c])
  try {
    const t = sacli(['workloads', 'act', `connection/${name}`, 'test'])
    ok('a stopped database: its test says it cannot reach it', t.code !== 0 && /cannot reach its source/.test(t.err), t.err)
    ok('…and it reads degraded', one(`connection/${name}`)?.state === 'degraded')
  } finally { execFileSync('docker', ['start', c]) }
  ok('started again: its test passes', !!(await until('back', () => sacli(['workloads', 'act', `connection/${name}`, 'test']).code === 0, 120_000)))
  ok('…and it reads ready', !!(await until('ready', () => one(`connection/${name}`)?.state === 'ready')))
}

const suites = { sanity, core, permissions, lifecycle, failure }
for (const [n, f] of Object.entries(suites)) if (which === 'all' || which === n) await f()
console.log(failed ? `\n✗ ${failed} check(s) failed` : '\n✓ every check passed')
process.exit(failed ? 1 : 0)
