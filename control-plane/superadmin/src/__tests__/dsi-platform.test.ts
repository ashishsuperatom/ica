// Each source's index, held by the platform (docs/platform-architecture.md, "Data sources and their index"), through the
// REAL ProjectDO in Miniflare — one test per rule: the engine builds, the platform keeps every change (as of any time),
// checkpoints let a build resume, a failure is never emptiness, one build at a time, people describe and disable over
// the hub, the replica pulls by cursor, and the snapshot is remade only when the index changed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { projectJobs, STALE_AFTER_MS } from '../jobs.ts'
import { PROJECT_MIGRATIONS } from '../migrations.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const PID = '11111111-2222-3333-4444-555555555555'
const SECRET = 's3cret'
const harness = `
import { routeSocket } from '../ws-route.ts'
export { ProjectDO } from '../project-do.ts'
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:${PID}'))
  if (u.pathname.startsWith('/_ws/')) return routeSocket(req, env, '${PID}')
  const fwd = new Request('http://do' + u.pathname.slice(3) + u.search, req); fwd.headers.set('x-sa-project', '${PID}'); return stub.fetch(fwd)
} }`
let mf: Miniflare
const jwt = (claims: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}
async function socket(hello: Record<string, unknown>) {
  const r = await mf.dispatchFetch(`http://x/_ws/${PID}${hello.token ? `?token=${hello.token}` : ''}`, { headers: { upgrade: 'websocket' } })
  const ws = r.webSocket!
  const got: any[] = []
  ws.addEventListener('message', (e: any) => got.push(JSON.parse(String(e.data))))
  ws.accept()
  ws.send(JSON.stringify({ type: 'hello', ...hello }))
  const until = async (pred: (m: any) => boolean, ms = 8000) => {
    const t = Date.now()
    for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error(`nothing matched; got ${JSON.stringify(got.map((x) => x.payload?.t))}`); await new Promise((r) => setTimeout(r, 15)) }
  }
  await until((m) => m.payload?.t === 'welcome')
  let n = 0
  /** A person's message, answered by the hub. */
  const ask = async (payload: any) => { const reqId = `q${++n}-${Math.random()}`; ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { ...payload, reqId } })); return (await until((m) => m.payload?.reqId === reqId)).payload }
  /** The engine's own message to the hub (type at the top), answered when it carries a reqId. */
  const tell = (msg: any) => ws.send(JSON.stringify(msg))
  const call = async (msg: any) => { const reqId = `e${++n}-${Math.random()}`; tell({ ...msg, reqId }); return (await until((m) => m.payload?.reqId === reqId)).payload }
  return { ws, got, until, ask, tell, call }
}
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true }, USER: { className: 'UserDO', useSQLite: true } }, r2Buckets: ['PACKAGES'], bindings: { JWT_SECRET: SECRET } })
  await mf.dispatchFetch('http://x/do/setup', { method: 'POST', body: JSON.stringify({ apiKey: 'ek', provider: 'external', name: 'P' }) })
  for (const [email, roleId] of [['admin@test.io', 'admin'], ['mem@test.io', 'member']]) await mf.dispatchFetch('http://x/do/access', { method: 'POST', body: JSON.stringify({ email, roleId }) })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

const cols = (...names: string[]) => names.map((name) => ({ name, type: 'int' }))

describe('each source\'s index, held by the platform', () => {
  let eng: Awaited<ReturnType<typeof socket>>, admin: Awaited<ReturnType<typeof socket>>, mem: Awaited<ReturnType<typeof socket>>
  let t0 = ''

  it('rule 1 & 5: the engine plans, puts table by table (each a checkpoint), and a resume is told what is done', async () => {
    eng = await socket({ role: 'code-engine', key: 'ek', instanceId: 'e1', epoch: 1 })
    admin = await socket({ role: 'runtime', token: jwt({ userId: 'adm', email: 'admin@test.io', role: 'user' }) })
    mem = await socket({ role: 'runtime', token: jwt({ userId: 'mem', email: 'mem@test.io', role: 'user' }) })
    expect((await eng.call({ type: 'dsi:plan', source: 'ERP', phase: 1, tables: ['orders', 'customer', 'empty'], complete: true })).done).toEqual([])
    eng.tell({ type: 'dsi:put', source: 'ERP', phase: 1, table: 'orders', fields: [{ name: 'id', type: 'int', key: true }, { name: 'total', type: 'money', description: 'the order total' }] })
    eng.tell({ type: 'dsi:put', source: 'ERP', phase: 1, table: 'customer', fields: cols('id', 'name') })
    await settle(200)
    t0 = new Date().toISOString()
    await settle(50)
    // the engine went away mid-build; the resumed build is told what it need not do again
    const again = await eng.call({ type: 'dsi:plan', source: 'ERP', phase: 1, tables: ['orders', 'customer', 'empty'], complete: true })
    expect(again.done.sort()).toEqual(['customer', 'orders'])
    // fresh starts the phase over
    expect((await eng.call({ type: 'dsi:plan', source: 'ERP', phase: 1, tables: ['orders', 'customer', 'empty'], complete: true, fresh: true })).done).toEqual([])
    const items = (await admin.ask({ t: 'dsi:show', source: 'ERP' })).items
    expect(items.map((i: any) => `${i.table}.${i.field}`)).toEqual(['customer.', 'customer.id', 'customer.name', 'orders.', 'orders.id', 'orders.total'])
  })

  it('rule 6: a table that could not be read changes nothing; only a complete list marks tables gone', async () => {
    eng.tell({ type: 'dsi:failed', source: 'ERP', phase: 1, table: 'empty', error: 'timeout' })
    await settle(200)
    expect((await admin.ask({ t: 'dsi:show', source: 'ERP', table: 'empty' })).items).toEqual([])
    const stats = (await admin.ask({ t: 'dsi:stats' })).sources.find((s: any) => s.source === 'ERP')
    expect(stats.phases[0]).toMatchObject({ phase: 1, planned: 3, failed: 1 })
    // a partial list (a targeted look, or a catalog that failed) removes nothing
    await eng.call({ type: 'dsi:plan', source: 'ERP', phase: 1, tables: ['orders'], complete: false })
    expect((await admin.ask({ t: 'dsi:show', source: 'ERP', table: 'customer' })).items.every((i: any) => !i.gone)).toBe(true)
  })

  it('rule 3: every change is kept — a table gone is marked, never deleted, and the index reads as it was at any time', async () => {
    eng.tell({ type: 'dsi:put', source: 'ERP', phase: 1, table: 'orders', fields: [{ name: 'id', type: 'bigint', key: true }, { name: 'total', type: 'money', description: 'the order total' }] })
    await eng.call({ type: 'dsi:plan', source: 'ERP', phase: 1, tables: ['orders'], complete: true })   // customer left the source
    const now = (await admin.ask({ t: 'dsi:show', source: 'ERP' })).items
    expect(now.find((i: any) => i.table === 'orders' && i.field === 'id').type).toBe('bigint')
    expect(now.filter((i: any) => i.table === 'customer').every((i: any) => i.gone)).toBe(true)
    const then = (await admin.ask({ t: 'dsi:show', source: 'ERP', asOf: t0 })).items
    expect(then.find((i: any) => i.table === 'orders' && i.field === 'id').type).toBe('int')
    expect(then.filter((i: any) => i.table === 'customer').every((i: any) => !i.gone)).toBe(true)
    // seen again: back, with what it had
    eng.tell({ type: 'dsi:put', source: 'ERP', phase: 1, table: 'customer', fields: cols('id', 'name') })
    await settle(200)
    expect((await admin.ask({ t: 'dsi:show', source: 'ERP', table: 'customer' })).items.every((i: any) => !i.gone)).toBe(true)
  })

  it('rule 2: three descriptions kept apart; a person\'s wins, then the source\'s, then an AI\'s; whoever writes says which', async () => {
    expect((await admin.ask({ t: 'dsi:describe', source: 'ERP', table: 'orders', field: 'total', text: 'x' })).reason).toMatch(/by "human" or "ai"/)
    await admin.ask({ t: 'dsi:describe', source: 'ERP', table: 'orders', field: 'total', text: 'total in AUD, tax included', by: 'ai' })
    let doc = JSON.parse(await (await mf.dispatchFetch('http://x/do/dsi/snapshot')).text())
    const total = () => doc.sources[0].tables.find((t: any) => t.table === 'orders').fields.find((f: any) => f.field === 'total')
    expect(total()).toMatchObject({ description: 'the order total', descSource: 'the order total', descAi: 'total in AUD, tax included' })   // the source's beats an AI's
    await admin.ask({ t: 'dsi:describe', source: 'ERP', table: 'orders', field: 'total', text: 'Order value incl. GST', by: 'human' })
    doc = JSON.parse(await (await mf.dispatchFetch('http://x/do/dsi/snapshot')).text())
    expect(total().description).toBe('Order value incl. GST')
    // a rebuild never overwrites a person's or an AI's description
    eng.tell({ type: 'dsi:put', source: 'ERP', phase: 1, table: 'orders', fields: [{ name: 'id', type: 'bigint', key: true }, { name: 'total', type: 'money', description: 'the order total' }] })
    await settle(200)
    doc = JSON.parse(await (await mf.dispatchFetch('http://x/do/dsi/snapshot')).text())
    expect(total()).toMatchObject({ descHuman: 'Order value incl. GST', descAi: 'total in AUD, tax included' })
    expect((await mem.ask({ t: 'dsi:describe', source: 'ERP', table: 'orders', field: 'total', text: 'y', by: 'human' })).reason).toMatch(/needs project.data/)
  })

  it('rule 4: a table or a field is disabled, never deleted; a person\'s choice beats the build\'s empty-table rule', async () => {
    expect((await admin.ask({ t: 'dsi:enable', source: 'ERP', table: 'customer', enabled: false })).item).toMatchObject({ enabled: false, enabledBy: 'person', gone: false })
    expect((await admin.ask({ t: 'dsi:enable', source: 'ERP', table: 'orders', field: 'id', enabled: false })).item.enabled).toBe(false)
    // phase 2: an empty table is disabled by the build; one a person enabled stays as they set it
    await admin.ask({ t: 'dsi:enable', source: 'ERP', table: 'customer', enabled: true })
    eng.tell({ type: 'dsi:rows', source: 'ERP', counts: { orders: 0, customer: 0 } })
    await settle(200)
    const items = (await admin.ask({ t: 'dsi:show', source: 'ERP' })).items
    expect(items.find((i: any) => i.table === 'orders' && i.field === '')).toMatchObject({ rows: 0, enabled: false, enabledBy: 'auto' })
    expect(items.find((i: any) => i.table === 'customer' && i.field === '')).toMatchObject({ rows: 0, enabled: true, enabledBy: 'person' })
    eng.tell({ type: 'dsi:rows', source: 'ERP', counts: { orders: 12 } })   // rows again: the build enables what it disabled
    await settle(200)
    expect((await admin.ask({ t: 'dsi:show', source: 'ERP', table: 'orders' })).items.find((i: any) => i.field === '').enabled).toBe(true)
  })

  it('rule 10: the replica pulls what changed after its cursor, in pages, and is told when something changed', async () => {
    const all = await eng.call({ type: 'dsi:pull', cursor: 0 })
    expect(all.items.length).toBeGreaterThan(0)
    expect(all.more).toBe(false)
    const none = await eng.call({ type: 'dsi:pull', cursor: all.cursor })
    expect(none).toMatchObject({ items: [], cursor: all.cursor })
    await admin.ask({ t: 'dsi:enable', source: 'ERP', table: 'orders', field: 'total', enabled: false })
    await eng.until((m) => m.payload?.t === 'dsi:changed' && m.payload.cursor > all.cursor)
    const next = await eng.call({ type: 'dsi:pull', cursor: all.cursor })
    expect(next.items.map((i: any) => `${i.table}.${i.field}:${i.enabled}`)).toEqual(['orders.total:false'])
  })

  it('rule 11: the snapshot is one file, remade only when the index changed', async () => {
    const a = await mf.dispatchFetch('http://x/do/dsi/snapshot'); const ca = a.headers.get('x-dsi-cursor'); await a.text()
    const b = await mf.dispatchFetch('http://x/do/dsi/snapshot'); expect(b.headers.get('x-dsi-cursor')).toBe(ca); await b.text()
    await admin.ask({ t: 'dsi:enable', source: 'ERP', table: 'orders', field: 'total', enabled: true })
    const c = await mf.dispatchFetch('http://x/do/dsi/snapshot'); expect(Number(c.headers.get('x-dsi-cursor'))).toBeGreaterThan(Number(ca)); await c.text()
  })

  it('rule 7 & 9: one build at a time — a second is told the one running; its heartbeat and stages reach the admins', async () => {
    const s1 = await eng.call({ type: 'job:start', kind: 'dsi.build', lease: 'dsi' })
    expect(s1.t).toBe('job:started')
    expect((await eng.call({ type: 'job:start', kind: 'dsi.build', lease: 'dsi' })).t).toBe('job:busy')
    eng.tell({ type: 'job:beat', id: s1.job.id, stage: 'phase 1 · ERP', doing: 'reading orders', counts: { sources: { done: 0, total: 1 }, tables: { done: 1, total: 3 } } })
    const seen = await admin.until((m) => m.payload?.t === 'job:update' && m.payload.job.doing === 'reading orders')
    expect(seen.payload.job.counts.tables).toEqual({ done: 1, total: 3 })
    // asked again by a person while it runs: the answer is the job running, nothing new starts
    const asked = await admin.ask({ t: 'dsi:build', sources: ['ERP'] })
    expect(asked).toMatchObject({ asked: false, running: { id: s1.job.id } })
    expect((await mem.ask({ t: 'dsi:build' })).reason).toMatch(/needs project.manage/)
    eng.tell({ type: 'job:end', id: s1.job.id, state: 'done', detail: '3 tables' })
    await admin.until((m) => m.payload?.t === 'job:update' && m.payload.job.state === 'done')
    expect((await admin.ask({ t: 'dsi:build', sources: ['ERP'] })).asked).toBe(true)
    expect((await eng.until((m) => m.payload?.t === 'dsi:build')).payload.sources).toEqual(['ERP'])
  })

  it('rule 8: an engine back with a source whose build never finished is asked to build it', async () => {
    await mf.dispatchFetch('http://x/do/connections', { method: 'POST', headers: { 'x-sa-actor': JSON.stringify({ kind: 'user', id: 'admin@test.io', email: 'admin@test.io' }), 'x-sa-caps': JSON.stringify(['project.data', 'project.connect', 'project.view']) },
      body: JSON.stringify({ connector: 'code', name: 'WAREHOUSE', values: {}, kind: 'sql', dialect: 'mssql', description: 'the data warehouse' }) })
    eng.got.length = 0
    eng.tell({ type: 'dsi:resume' })
    const b = await eng.until((m) => m.payload?.t === 'dsi:build')
    expect(b.payload.sources).toEqual(['WAREHOUSE'])
    const list = (await (await mf.dispatchFetch('http://x/do/connections', { headers: { 'x-sa-actor': JSON.stringify({ kind: 'user', id: 'admin@test.io', email: 'admin@test.io' }), 'x-sa-caps': JSON.stringify(['project.data']) } })).json() as any).connections
    expect(list.find((c: any) => c.name === 'WAREHOUSE')).toMatchObject({ kind: 'sql', dialect: 'mssql', description: 'the data warehouse', auth: 'shared' })
  })
})

describe('jobs: a lease is free again once its heartbeat stops', () => {
  it('a running job with no heartbeat for a minute is stale, and the lease starts a new one', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(String((PROJECT_MIGRATIONS.find((m) => m.id === 39)!.up as string)).replace(/ALTER TABLE connections[^;]*;/g, ''))
    const sql = { exec: (q: string, ...p: unknown[]) => { const st = db.prepare(q); return /^\s*(SELECT|INSERT[\s\S]*RETURNING)/i.test(q) ? st.all(...(p as any[])) : (st.run(...(p as any[])), []) } }
    let clock = Date.parse('2026-10-07T00:00:00Z')
    const jobs = projectJobs({ sql, transactionSync: (f: () => unknown) => f() } as any, () => clock)
    const a = jobs.start({ kind: 'dsi.build', lease: 'dsi', holder: 'e1' })
    expect('job' in a).toBe(true)
    clock += STALE_AFTER_MS - 1000
    expect('busy' in jobs.start({ kind: 'dsi.build', lease: 'dsi', holder: 'e2' })).toBe(true)
    clock += 2000
    const b = jobs.start({ kind: 'dsi.build', lease: 'dsi', holder: 'e2' })
    expect('job' in b).toBe(true)
    expect(jobs.get((a as any).job.id)!.state).toBe('stale')
    expect(() => jobs.beat((a as any).job.id, { stage: 'x' })).toThrow(/stale/)
  })
})
