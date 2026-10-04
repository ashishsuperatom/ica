// The Durable Objects' migrations (migrations.ts) run in REAL Durable Object SQLite — Miniflare, the same runtime
// wrangler uses — not a stand-in: a new ProjectDO gets all of them; one kept by the earlier _schema_version ladder is
// adopted at its version and only the rest run; a reopen with nothing pending applies nothing; the Org and Global
// objects adopt their old shapes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

// A Worker with one test DO: each request names a scenario; the DO runs it on its own storage and answers JSON.
const harness = `
import { DurableObject } from 'cloudflare:workers'
import { migrate, durableObjectDb } from '../../../../vm/packages/migrate/src/index.js'
import { PROJECT_MIGRATIONS, ORG_MIGRATIONS, GLOBAL_MIGRATIONS, adoptProjectSchemaVersion } from '../migrations.js'
const LISTS = { project: PROJECT_MIGRATIONS, org: ORG_MIGRATIONS, global: GLOBAL_MIGRATIONS }
export class TestDO extends DurableObject {
  async fetch(req) {
    const u = new URL(req.url)
    const sql = this.ctx.storage.sql
    const rows = (q, ...p) => [...sql.exec(q, ...p)]
    try {
      const step = u.searchParams.get('step')
      if (step === 'legacy-project') {
        // what the old ladder left at version N: its first N steps, and _schema_version = N
        const n = Number(u.searchParams.get('n'))
        this.ctx.storage.transactionSync(() => { for (const m of PROJECT_MIGRATIONS.slice(0, n)) { if (typeof m.up === 'string') sql.exec(m.up); else m.up(durableObjectDb(this.ctx.storage)) } })
        sql.exec('CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL DEFAULT 0)')
        sql.exec('INSERT INTO _schema_version (version) VALUES (?)', n)
        return Response.json({ ok: true })
      }
      if (step === 'legacy-org') { sql.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()))"); sql.exec("INSERT INTO projects (id, name, created_by) VALUES ('p1', 'kept', 'me')"); return Response.json({ ok: true }) }
      if (step === 'migrate') {
        const kind = u.searchParams.get('kind')
        const r = migrate(durableObjectDb(this.ctx.storage), LISTS[kind], { name: kind, adopt: kind === 'project' ? adoptProjectSchemaVersion : undefined })
        return Response.json(r)
      }
      if (step === 'look') {
        return Response.json({
          tables: rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name),
          migrations: rows('SELECT id, applied_at FROM _migrations ORDER BY id').map((r) => [r.id, String(r.applied_at).startsWith('adopted') ? 'adopted' : 'ran']),
          roles: (() => { try { return rows('SELECT id FROM roles ORDER BY id').map((r) => r.id) } catch { return null } })(),
          projectCols: (() => { try { return rows("SELECT name FROM pragma_table_info('projects')").map((r) => r.name) } catch (e) { return String(e) } })(),
          kept: (() => { try { return rows("SELECT name FROM projects WHERE id = 'p1'").map((r) => r.name) } catch { return null } })(),
        })
      }
      return new Response('unknown step', { status: 400 })
    } catch (e) { return Response.json({ error: String(e && e.message || e) }, { status: 500 }) }
  }
}
export default { fetch(req, env) { const u = new URL(req.url); return env.T.get(env.T.idFromName(u.searchParams.get('do'))).fetch(req) } }
`

let mf: Miniflare
const ask = async (q: Record<string, string | number>) => {
  const r = await mf.dispatchFetch(`http://x/?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`)
  const body: any = await r.json()
  if (body.error) throw new Error(body.error)
  return body
}

beforeAll(async () => {
  const out = await build({ stdin: { contents: harness, resolveDir: here, loader: 'js' }, bundle: true, format: 'esm', write: false, platform: 'neutral', external: ['cloudflare:workers'] })
  mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-06-01', durableObjects: { T: { className: 'TestDO', useSQLite: true } } })
}, 60_000)
afterAll(async () => { await mf?.dispose() })

describe('Durable Object migrations, in real DO SQLite', () => {
  it('a new ProjectDO gets all 15 migrations, the roles seeded', async () => {
    expect(await ask({ do: 'fresh', step: 'migrate', kind: 'project' })).toEqual({ applied: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], current: 15 })
    const look = await ask({ do: 'fresh', step: 'look' })
    expect(look.migrations.every(([, how]: any) => how === 'ran')).toBe(true)
    expect(look.roles).toEqual(['admin', 'member', 'viewer'])
    for (const t of ['fly_machine', 'answer_buffer', 'access', 'dashboards', 'dashboard_builds', 'engine_running', 'profile', 'agent_keys', 'audit_log']) expect(look.tables).toContain(t)
    expect(look.tables).not.toContain('dashboard_builds_v14')
  })

  it('a reopen with nothing pending applies nothing', async () => {
    expect(await ask({ do: 'fresh', step: 'migrate', kind: 'project' })).toEqual({ applied: [], current: 15 })
  })

  it('a ProjectDO the old ladder left at version 6 is adopted there: only 7–15 run', async () => {
    await ask({ do: 'legacy6', step: 'legacy-project', n: 6 })
    expect(await ask({ do: 'legacy6', step: 'migrate', kind: 'project' })).toEqual({ applied: [7, 8, 9, 10, 11, 12, 13, 14, 15], current: 15 })
    const look = await ask({ do: 'legacy6', step: 'look' })
    expect(look.migrations.slice(0, 6).every(([, how]: any) => how === 'adopted')).toBe(true)
    expect(look.migrations.slice(6).every(([, how]: any) => how === 'ran')).toBe(true)
  })

  it('a ProjectDO the old ladder left at 14 is adopted whole: only 15 runs', async () => {
    await ask({ do: 'legacy14', step: 'legacy-project', n: 14 })
    expect(await ask({ do: 'legacy14', step: 'migrate', kind: 'project' })).toEqual({ applied: [15], current: 15 })
  })

  it('an OrgDO from before the deleted column is adopted: the column added, its rows kept', async () => {
    await ask({ do: 'org-old', step: 'legacy-org' })
    expect(await ask({ do: 'org-old', step: 'migrate', kind: 'org' })).toEqual({ applied: [1], current: 1 })
    const look = await ask({ do: 'org-old', step: 'look' })
    expect(look.projectCols).toContain('deleted')
    expect(look.kept).toEqual(['kept'])
  })

  it('a new GlobalDO gets its tables, the login codes among them', async () => {
    expect(await ask({ do: 'global', step: 'migrate', kind: 'global' })).toEqual({ applied: [1], current: 1 })
    const look = await ask({ do: 'global', step: 'look' })
    for (const t of ['superatom_users', 'organizations', 'domains', 'model_catalogue', 'mobile_login_code']) expect(look.tables).toContain(t)
  })
})
