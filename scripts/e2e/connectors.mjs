#!/usr/bin/env node
// END TO END, THE CONNECTORS AND WORKLOADS (docs/connectors-plan.md step 8) — against a real project and its running
// engine, through sacli (the platform's own door) and Docker (the live databases of connectors/test/live/up.sh).
//
//   node scripts/e2e/connectors.mjs [sanity|core|permissions|lifecycle|failure|query|per-user|registry|hierarchy|all] [--profile lab] [--org-profile test-org]
//
// sanity       the engine is connected; every workload reports; every connection reaches its source (its own test)
// core         every source is indexed by its own description; the cache is seen; a question with a known answer
// permissions  a viewer sees workloads but cannot act, and never sees an error's detail; an unknown action is refused
// lifecycle    restart; an older build published to the organisation, a connection moved onto it: newer said, update,
//              rollback; a process killed comes back
// failure      a database stopped: its test says why, it reads degraded; started again: ready
// query        a query of one's own (sacli datasources query): needs project.query; read only; paged, total, complete;
//              the cache said and skipped on request; a document store's own language
// per-user     a connection read with each person's own key: theirs reaches only what their database account may; one
//              who gave none is refused, saying how; back to the shared key
// registry     the organisation's kill switch: a connector blocked → its connections stop being run; unblocked → ready
// hierarchy    equals leave each other alone: an admin cannot revoke a key another admin made; its maker can; one
//              above them both can
//
// Needs: the project's engine running (Local Lab: natively, `sacli --profile lab engine start --native`), the live
// databases (connectors/test/live/up.sh) connected to it as SALES_* (see the SALES_ checks), and an organisation key
// profile holding org.connectors and org.keys (--org-profile test-org-admin), and a person's own key
// holding project.query (--person-profile local-lab: sacli login --browser --project <id>, made after 2026-10-15) for per-user. Prints ✓ / ✗ per check; exits 1 when any failed.

import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SACLI = join(ROOT, 'cli', 'dist', 'sacli.mjs')
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const PROFILE = opt('profile', 'lab'), ORG = opt('org-profile', 'test-org-admin'), PERSON = opt('person-profile', 'local-lab')
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
  // pinned (the one door): an older build published as an organisation connector, the connection moved onto it; a
  // newer version published → newer said → update → rollback → update; then back onto Superatom's own
  const bridges = JSON.parse(execFileSync('git', ['-C', ROOT, 'show', 'ef85e21f:connectors/dist/bridges.json'], { maxBuffer: 64 << 20 }).toString())
  const manifest = { ...JSON.parse(execFileSync('cat', [join(ROOT, 'connectors/bridges/postgres/manifest.json')]).toString()), id: 'e2e-postgres', title: 'PostgreSQL (e2e)' }
  const publishPg = (code) => json(['api', 'POST', `/api/projects/${pid()}/connectors`, '--data', JSON.stringify({ manifest, code })])
  const v1 = publishPg(bridges.postgres.replace('PostgreSQL: LIMIT n', 'PostgreSQL (an older build): LIMIT n'))
  ok('an older build published to the organisation', /^[0-9a-f]{64}$/.test(v1.version ?? ''), JSON.stringify(v1))
  const moved = sacli(['datasources', 'update', 'SALES_PG', '--connector', 'e2e-postgres'])
  ok('a connection moved onto it', moved.code === 0 && /runs e2e-postgres/.test(moved.out), moved.err)
  ok('…and it runs it', !!(await until('moved', () => { const w = one('connection/SALES_PG'); return w?.state === 'ready' && w.version === v1.version.slice(0, 12) })))
  const v2 = publishPg(JSON.parse(execFileSync('cat', [join(ROOT, 'connectors/dist/bridges.json')], { maxBuffer: 64 << 20 }).toString()).postgres)
  ok('a newer version published', /^[0-9a-f]{64}$/.test(v2.version ?? ''), JSON.stringify(v2))
  const newer = await until('newer', () => one('connection/SALES_PG')?.newer)
  ok('its workload says a newer version exists', !!newer)
  ok('update moves it to the newest', /from now on/.test(sacli(['workloads', 'act', 'connection/SALES_PG', 'update']).out))
  ok('…and it runs it', !!(await until('updated', () => { const w = one('connection/SALES_PG'); return w?.state === 'ready' && !w.newer })))
  ok('rollback moves it back', /from now on/.test(sacli(['workloads', 'act', 'connection/SALES_PG', 'rollback']).out))
  ok('…and it runs the older one', !!(await until('back', () => one('connection/SALES_PG')?.newer)))
  sacli(['workloads', 'act', 'connection/SALES_PG', 'update'])
  ok('moved back onto Superatom\'s own', sacli(['datasources', 'update', 'SALES_PG', '--connector', 'postgres']).code === 0)
  ok('…and ready', !!(await until('home', () => one('connection/SALES_PG')?.state === 'ready')))
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

// A key for one check, made by the organisation's key and revoked after it (a day's life if the run is cut short).
async function withKey(name, can, f, { by = { profile: ORG }, project = true } = {}) {
  const made = json(['keys', 'create', name, ...(project ? ['--project', pid()] : []), '--can', can.join(','), '--days', '1'], by)
  ok(`a key "${name}" is made (${can.join(', ')})`, !!made.key, made.error)
  if (!made.key) return
  try { return await f(made.key, made.record.id) } finally { sacli(['keys', 'revoke', made.record.id, ...(project ? ['--project', pid()] : [])], by) }
}
const shown = (c) => json(['datasources', 'show', c])

async function query() {
  console.log('query')
  const q = (a, key) => sacli(['datasources', 'query', ...a], { key })
  await withKey('e2e query', ['project.view', 'project.query'], async (key) => {
    const page = q(['SALES_PG', 'SELECT * FROM orders ORDER BY 1', '--page', '3'], key)
    ok('a query of one\'s own, paged: page 3 of 2,000 rows, complete', /rows 201–300 of 2,?000 \(page 3 of 20/.test(page.out) && /complete/.test(page.out), page.out.slice(-300) + page.err)
    const j = json(['datasources', 'query', 'SALES_PG', 'SELECT count(*) AS n FROM orders'], { key })
    ok('…the answer as data (--json): the total, complete', Number(j.rows?.[0]?.n) === 2000 && j.complete === true && j.total === 1, JSON.stringify(j).slice(0, 300))
    const again = json(['datasources', 'query', 'SALES_PG', 'SELECT count(*) AS n FROM orders'], { key })
    ok('…asked again: from the cache, said', again.cache?.hit === true, JSON.stringify(again.cache))
    const fresh = json(['datasources', 'query', 'SALES_PG', 'SELECT count(*) AS n FROM orders', '--fresh'], { key })
    ok('…--fresh reads the source', fresh.cache?.hit === false, JSON.stringify(fresh.cache))
    const del = q(['SALES_PG', 'DELETE FROM customers'], key)
    ok('a change is refused: read only', del.code !== 0 && /READ-ONLY|only SELECT/i.test(del.err), del.err)
    const mongo = q(['SALES_MONGO', JSON.stringify({ collection: 'orders', aggregate: [{ $group: { _id: '$status', n: { $sum: 1 } } }] })], key)
    ok('a document store in its own language (an aggregate)', /rows 1–4 of 4/.test(mongo.out), mongo.out.slice(-300) + mongo.err)
    const none = q(['NOPE', 'SELECT 1'], key)
    ok('a source that is not there is said', none.code !== 0 && /NOPE/.test(none.err), none.err)
  })
  await withKey('e2e no query', ['project.view', 'project.data'], async (key) => {
    const r = q(['SALES_PG', 'SELECT 1'], key)
    ok('a key without project.query is refused, saying so', r.code !== 0 && /needs project\.query/.test(r.err), r.err)
  })
}

// Postgres's own account for one person (the live database's): reads customers and regions only.
const PERSON_DB = { user: 'e2e_person', password: 'E2e-person-2026!' }
function personAccount() {
  const sql = `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PERSON_DB.user}') THEN CREATE ROLE ${PERSON_DB.user} LOGIN PASSWORD '${PERSON_DB.password}'; END IF; END $$;
    GRANT USAGE ON SCHEMA public TO ${PERSON_DB.user}; GRANT SELECT ON customers, regions TO ${PERSON_DB.user}; REVOKE SELECT ON orders FROM ${PERSON_DB.user};`
  execFileSync('docker', ['exec', CONTAINER.SALES_PG, 'psql', '-U', 'sa', '-d', 'sales', '-qc', sql])
}

async function perUser() {
  console.log('per-user')
  personAccount()
  const me = { profile: PERSON }
  const to = sacli(['datasources', 'update', 'SALES_PG', '--auth', 'per-user'])
  ok('the connection is made per-user', to.code === 0 && shown('SALES_PG').auth === 'per-user', to.err)
  try {
    const set = sacli(['datasources', 'my-key', 'SALES_PG', '--set', `user=${PERSON_DB.user}`, '--secret', `password=${PERSON_DB.password}`], me)
    ok('a person gives their own key', set.code === 0, set.err)
    const hosts = () => execFileSync('ps', ['-eo', 'command']).toString().split('\n').filter((l) => /host\.mjs/.test(l)).length
    const before = hosts()
    const mine = await until('mine', () => { const r = sacli(['datasources', 'query', 'SALES_PG', 'SELECT count(*) AS n FROM customers', '--fresh'], me); return r.code === 0 ? r : null }, 60_000)
    ok('the person reads what their account may (customers)', !!mine, 'their read never succeeded')
    const theirs = sacli(['datasources', 'query', 'SALES_PG', 'SELECT count(*) FROM orders', '--fresh'], me)
    ok('…and not what it may not (orders): the database itself refuses them', theirs.code !== 0 && /permission denied|not allowed|refused/i.test(theirs.err), theirs.err)
    ok('…without another process for them (one per connection)', hosts() === before, `${before} → ${hosts()}`)
    await withKey('e2e no person', ['project.view', 'project.query'], async (key) => {
      const r = sacli(['datasources', 'query', 'SALES_PG', 'SELECT 1', '--fresh'], { key })
      ok('a key that acts for no person is refused: nobody\'s key is read with', r.code !== 0 && /each person's own key/i.test(r.err), r.err)
    })
  } finally {
    const back = sacli(['datasources', 'update', 'SALES_PG', '--auth', 'shared'])
    ok('back to the shared key', back.code === 0 && shown('SALES_PG').auth !== 'per-user', back.err)
    ok('…and ready', !!(await until('ready', () => one('connection/SALES_PG')?.state === 'ready')))
  }
}

async function registry() {
  console.log('registry')
  const manifest = { ...JSON.parse(execFileSync('cat', [join(ROOT, 'connectors/bridges/postgres/manifest.json')]).toString()), id: 'e2e-postgres', title: 'PostgreSQL (e2e)' }
  const code = JSON.parse(execFileSync('cat', [join(ROOT, 'connectors/dist/bridges.json')], { maxBuffer: 64 << 20 }).toString()).postgres
  const pub = json(['api', 'POST', `/api/projects/${pid()}/connectors`, '--data', JSON.stringify({ manifest, code })])
  ok('a connector in the organisation\'s registry', /^[0-9a-f]{64}$/.test(pub.version ?? ''), JSON.stringify(pub))
  ok('a connection moved onto it', sacli(['datasources', 'update', 'SALES_PG', '--connector', 'e2e-postgres']).code === 0)
  ok('…and ready', !!(await until('ready', () => one('connection/SALES_PG')?.state === 'ready')))
  try {
    const b = sacli(['connectors', 'block', 'e2e-postgres'], { profile: ORG })
    ok('an organisation admin blocks it', b.code === 0, b.err)
    ok('…its connection says so', !!(await until('said', () => /blocked by the organisation/.test(shown('SALES_PG').state ?? ''), 60_000)), shown('SALES_PG').state)
    ok('…and is no longer run: stopped, saying why', !!(await until('stopped', () => { const w = one('connection/SALES_PG'); return w?.state === 'stopped' && /blocked/.test(w.error?.what ?? '') && !w.version }, 120_000)), JSON.stringify(one('connection/SALES_PG')))
    const pub2 = json(['api', 'POST', `/api/projects/${pid()}/connectors`, '--data', JSON.stringify({ manifest, code: code + '\n// another version' })])
    ok('…and nothing more is published to it', /blocked/.test(pub2.error ?? ''), JSON.stringify(pub2))
    const viewer = sacli(['connectors', 'block', 'acme-crm'])
    ok('a project key cannot block (needs org.connectors)', viewer.code !== 0, viewer.out)
  } finally {
    const u = sacli(['connectors', 'unblock', 'e2e-postgres'], { profile: ORG })
    ok('unblocked', u.code === 0, u.err)
    ok('…run again, ready', !!(await until('back', () => one('connection/SALES_PG')?.state === 'ready', 120_000)))
    ok('moved back onto Superatom\'s own', sacli(['datasources', 'update', 'SALES_PG', '--connector', 'postgres']).code === 0)
    ok('…and ready', !!(await until('home', () => one('connection/SALES_PG')?.state === 'ready')))
  }
}

async function hierarchy() {
  // Keys follow the tree they were made in: a key reaches only the keys below it, whatever it holds — two keys side by
  // side (equals) leave each other's alone; the key above them both reaches either. (People ranked by what their roles
  // hold — one above another, equals apart — are one person's keys here; the ranking itself is people-hierarchy.test.ts.)
  console.log('hierarchy')
  const ADMIN = ['project.view', 'project.data', 'project.keys', 'project.people', 'project.connectors']
  const listed = (key, id) => (json(['keys', 'list'], { key }).keys ?? json(['keys', 'list'], { key }) ?? []).find?.((k) => k.id === id)
  await withKey('e2e admin A', ADMIN, (a) => withKey('e2e admin B', ADMIN, async (b) => {
    const made = json(['keys', 'create', 'e2e made by A', '--can', 'project.view', '--days', '1'], { key: a })
    ok('admin A makes a key', !!made.record?.id, made.error)
    if (!made.record?.id) return
    const seen = listed(b, made.record.id)
    ok('admin B\'s list says it is not theirs to revoke, and why', seen?.mayRevoke === false && /below it/.test(seen?.whyNot ?? ''), JSON.stringify(seen))
    const byB = sacli(['keys', 'revoke', made.record.id], { key: b })
    ok('admin B cannot revoke it (equals leave each other alone)', byB.code !== 0 && /below it/.test(byB.err), byB.err)
    ok('admin A\'s list says it may', listed(a, made.record.id)?.mayRevoke === true)
    const byA = sacli(['keys', 'revoke', made.record.id], { key: a })
    ok('admin A, who made it, revokes it', byA.code === 0, byA.err)
    const again = json(['keys', 'create', 'e2e made by A again', '--can', 'project.view', '--days', '1'], { key: a })
    const byOrg = sacli(['keys', 'revoke', again.record?.id ?? 'none', '--project', pid()], { profile: ORG })
    ok('the organisation\'s key, above them both, revokes one of A\'s', byOrg.code === 0, byOrg.err)
    const over = sacli(['keys', 'create', 'e2e too much', '--can', 'project.view,project.query', '--days', '1'], { key: a })
    ok('a key cannot give more than it holds', over.code !== 0 && /project\.query/.test(over.err), over.err)
  }))
}

const suites = { sanity, core, permissions, lifecycle, failure, query, 'per-user': perUser, registry, hierarchy }
for (const [n, f] of Object.entries(suites)) if (which === 'all' || which === n) await f()
console.log(failed ? `\n✗ ${failed} check(s) failed` : '\n✓ every check passed')
process.exit(failed ? 1 : 0)
