// A person's warehouse queries, kept in their own UserDO: every run recorded (the same SQL is one entry, run again), named
// ones saved, per warehouse and per project — nobody else's list, nothing mixed between projects.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const harness = `
export { UserDO } from '../user-do.ts'
export default { async fetch(req, env) {
  const u = new URL(req.url); const who = u.pathname.split('/')[1]
  return env.USER.get(env.USER.idFromName(who)).fetch(new Request('http://do' + u.pathname.slice(who.length + 1) + u.search, req))
} }`
let mf: Miniflare
const call = async (path: string, init?: RequestInit) => (await mf.dispatchFetch(`http://x${path}`, init)).json() as Promise<any>
const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) })

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'], durableObjects: { USER: { className: 'UserDO', useSQLite: true } } })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('a person\'s warehouse queries', () => {
  it('records each run once per SQL, keeps a few rows of the last answer, and names one when saved', async () => {
    const a = await post('/user:ana/warehouse/runs', { org: 'o1', project: '', sql: 'SELECT 1 AS n', columns: [{ name: 'n', type: 'double' }], rows: 1, sample: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }] })
    const again = await post('/user:ana/warehouse/runs', { org: 'o1', project: '', sql: 'SELECT 1 AS n', rows: 1, sample: [] })
    expect(again.id).toBe(a.id)
    let list = (await call('/user:ana/warehouse/queries?org=o1&project=')).queries
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: '', runs: 2, lastRows: 1, columns: [{ name: 'n', type: 'double' }] })
    const saved = await post('/user:ana/warehouse/queries', { org: 'o1', project: '', id: a.id, name: 'One' })
    expect(saved.error).toMatch(/SQL/)
    const ok = await post('/user:ana/warehouse/queries', { org: 'o1', project: '', id: a.id, name: 'One', sql: 'SELECT 1 AS n' })
    expect(ok).toMatchObject({ id: a.id, name: 'One' })
    await post('/user:ana/warehouse/runs', { org: 'o1', project: '', sql: 'SELECT 2 AS m', rows: 1 })
    list = (await call('/user:ana/warehouse/queries?org=o1&project=')).queries
    expect(list.map((q: any) => q.name)).toEqual(['One', ''])   // saved first, then recent
  })
  it('keeps each person, warehouse and project apart', async () => {
    await post('/user:ana/warehouse/runs', { org: 'o1', project: 'p1', sql: 'SELECT 3 AS k', rows: 1 })
    expect((await call('/user:ana/warehouse/queries?org=o1&project=p1')).queries.map((q: any) => q.sql)).toEqual(['SELECT 3 AS k'])
    expect((await call('/user:ana/warehouse/queries?org=o2&project=')).queries).toEqual([])
    expect((await call('/user:bo/warehouse/queries?org=o1&project=')).queries).toEqual([])
  })
  it('removes one of one\'s queries, and only in its own place', async () => {
    const [q] = (await call('/user:ana/warehouse/queries?org=o1&project=p1')).queries
    await call(`/user:ana/warehouse/queries/${q.id}?org=o1&project=`, { method: 'DELETE' })   // the wrong place: nothing goes
    expect((await call('/user:ana/warehouse/queries?org=o1&project=p1')).queries).toHaveLength(1)
    await call(`/user:ana/warehouse/queries/${q.id}?org=o1&project=p1`, { method: 'DELETE' })
    expect((await call('/user:ana/warehouse/queries?org=o1&project=p1')).queries).toEqual([])
  })
})
