// ── UserDO — one person, across projects ────────────────────────────────────────────────────────────────────────────
//
// What the platform keeps for a person so it can give them a view of their own: the index of their sessions (in every
// project, with what each is about and when it last changed) and their personal state (preferences, what they pinned —
// keys and JSON values, per project or across all). Their unpublished programs and more come here later; what exactly it
// keeps is still being decided, so it starts with what is certainly theirs.

import { DurableObject } from 'cloudflare:workers'
import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { USER_MIGRATIONS } from './migrations.js'
import { sessionStore } from './session-store.js'
import { personHub } from './user-hub.js'

export class UserDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => { runMigrations(durableObjectDb(this.ctx.storage), USER_MIGRATIONS, { name: 'user' }) })
  }

  private hub() { return personHub(this.ctx, this.env) }
  // The person's tabs and devices (user-hub.ts): their sockets, and what their projects send back.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) { await this.hub().message(ws, message) }
  async webSocketClose(ws: WebSocket) { await this.hub().closed(ws) }
  async webSocketError(ws: WebSocket) { await this.hub().closed(ws) }
  /** RPC from a ProjectDO: a message for this person on one of their links. */
  async deliver(project: string, wsId: string, data: string) { return this.hub().deliver(project, wsId, data) }
  /** RPC from a ProjectDO: the link ends; its tabs close. */
  async closeLink(project: string, wsId: string, code: number, reason: string) { this.hub().closeLink(project, wsId, code, reason) }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') === 'websocket') return this.hub().accept(request)
    const url = new URL(request.url)
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const sql = this.ctx.storage.sql
    if (request.method === 'POST' && url.pathname === '/sessions') {
      const b = await request.json() as { project: string; session: string; agent: string; title: string; blocks: number; answers: number; created: string; updated: string }
      if (!b?.project || !b.session) return json({ error: 'a session names its project and id' }, 400)
      sql.exec(`INSERT INTO sessions (project, session, agent, title, blocks, answers, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (project, session) DO UPDATE SET agent = excluded.agent, title = excluded.title, blocks = excluded.blocks, answers = excluded.answers, updated = excluded.updated`,
        b.project, b.session, b.agent ?? '', b.title ?? '', b.blocks ?? 0, b.answers ?? 0, b.created ?? b.updated, b.updated)
      return json({ ok: true })
    }
    if (request.method === 'GET' && url.pathname === '/sessions') {
      const project = url.searchParams.get('project')
      const rows = [...(project ? sql.exec('SELECT * FROM sessions WHERE project = ? ORDER BY updated DESC LIMIT 200', project) : sql.exec('SELECT * FROM sessions ORDER BY updated DESC LIMIT 200'))]
      return json({ sessions: rows })
    }
    // Personal state: GET /state?project=…  ·  PUT /state { project, key, value }  (project '' = across projects)
    if (url.pathname === '/state') {
      if (request.method === 'GET') {
        const rows = [...sql.exec('SELECT key, value FROM state WHERE project = ?', url.searchParams.get('project') ?? '')]
        return json({ state: Object.fromEntries(rows.map((r) => [String(r.key), JSON.parse(String(r.value))])) })
      }
      if (request.method === 'PUT') {
        const b = await request.json() as { project?: string; key: string; value: unknown }
        if (!b?.key || !/^[\w.-]{1,80}$/.test(b.key)) return json({ error: 'a key is 1–80 letters, digits, dots, dashes or underscores' }, 400)
        const text = JSON.stringify(b.value ?? null)
        if (text.length > 64_000) return json({ error: 'a value is at most 64 KB' }, 400)
        sql.exec('INSERT INTO state (project, key, value, updated) VALUES (?, ?, ?, ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, updated = excluded.updated', b.project ?? '', b.key, text, new Date().toISOString())
        return json({ ok: true })
      }
    }
    // Sessions (session-store.ts), asked by the project's hub: /session/<append|view|upto|artifact|artifacts|artifact/<id>>
    // with ?project&session.
    if (url.pathname.startsWith('/session/')) return this.session(request, url)
    // Warehouse queries: GET /warehouse/queries?org&project · POST /warehouse/runs (the platform records a run) ·
    // POST /warehouse/queries (name or rename one, save a new one) · DELETE /warehouse/queries/<id>?org&project
    if (url.pathname.startsWith('/warehouse/')) return this.warehouseQueries(request, url)
    return json({ error: 'not found' }, 404)
  }

  private async session(request: Request, url: URL): Promise<Response> {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const project = url.searchParams.get('project') ?? '', session = url.searchParams.get('session') ?? ''
    if (!project || !/^[\w-]{1,80}$/.test(session)) return json({ error: 'a session is named by its project and id' }, 400)
    const store = sessionStore(this.ctx.storage, this.env)
    const what = url.pathname.slice('/session/'.length)
    if (request.method === 'POST' && what === 'append') {
      const b = await request.json() as { from: number; entries: any[] }
      if (!Number.isInteger(b?.from) || b.from < 0 || !Array.isArray(b.entries)) return json({ error: 'an append says where it starts, and its entries' }, 400)
      const r = await store.append(project, session, b.from, b.entries)
      return json(r, r.conflict !== undefined ? 409 : 200)
    }
    if (request.method === 'GET' && what === 'view') { const v = store.view(project, session, url.searchParams.get('asOf') ?? undefined); return v ? json(v) : json({ error: 'there is no such session' }, 404) }
    if (request.method === 'GET' && what === 'upto') return json({ upto: store.count(project, session) })
    if (request.method === 'POST' && what === 'artifact') {
      const b = await request.json() as any
      if (!b?.by || !b?.kind || !b?.title || !b?.status || !b?.body || typeof b.body !== 'object') return json({ error: 'an artifact names its kind, title, status, body and who' }, 400)
      try { return json({ artifact: store.recordArtifact(project, session, b) }) } catch (e: any) { return json({ error: e.message }, 404) }
    }
    if (request.method === 'GET' && what === 'artifacts') return json({ artifacts: store.artifacts(project, session) })
    if (request.method === 'GET' && what.startsWith('artifact/')) {
      const versions = store.artifactVersions(project, session, decodeURIComponent(what.slice('artifact/'.length)))
      return versions.length ? json({ versions }) : json({ error: 'there is no such artifact' }, 404)
    }
    return json({ error: 'not found' }, 404)
  }

  private async warehouseQueries(request: Request, url: URL): Promise<Response> {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const sql = this.ctx.storage.sql
    const now = new Date().toISOString()
    const shape = (r: any) => ({ id: Number(r.id), name: String(r.name ?? ''), sql: String(r.sql), columns: r.columns ? JSON.parse(String(r.columns)) : null, runs: Number(r.runs ?? 0), lastRun: r.last_run ?? null, lastRows: r.last_rows ?? null, sample: r.last_sample ? JSON.parse(String(r.last_sample)) : null, updated: r.updated })
    const columnsOf = (v: unknown) => (Array.isArray(v) ? JSON.stringify(v.slice(0, 500).map((c: any) => ({ name: String(c?.name ?? ''), type: String(c?.type ?? 'string') }))) : null)
    const b: any = request.method === 'POST' ? await request.json().catch(() => ({})) : {}
    const org = String(b.org ?? url.searchParams.get('org') ?? ''), project = String(b.project ?? url.searchParams.get('project') ?? '')
    if (!org) return json({ error: 'which warehouse? (org)' }, 400)
    if (request.method === 'GET' && url.pathname === '/warehouse/queries') {
      const named = [...sql.exec("SELECT * FROM warehouse_queries WHERE org = ? AND project = ? AND name != '' ORDER BY updated DESC", org, project)]
      const recent = [...sql.exec("SELECT * FROM warehouse_queries WHERE org = ? AND project = ? AND name = '' ORDER BY last_run DESC LIMIT 50", org, project)]
      return json({ queries: [...named, ...recent].map(shape) })
    }
    if (request.method === 'POST' && url.pathname === '/warehouse/runs') {
      const text = String(b.sql ?? '').trim()
      if (!text || text.length > 20_000) return json({ error: 'a run names its SQL (at most 20,000 characters)' }, 400)
      const sample = Array.isArray(b.sample) ? JSON.stringify(b.sample.slice(0, 5)).slice(0, 4000) : null
      const [row] = [...sql.exec(`INSERT INTO warehouse_queries (org, project, sql, columns, runs, last_run, last_rows, last_sample, created, updated) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT (org, project, sql) DO UPDATE SET runs = runs + 1, last_run = excluded.last_run, last_rows = excluded.last_rows, last_sample = excluded.last_sample, columns = COALESCE(excluded.columns, columns)
        RETURNING id`, org, project, text, columnsOf(b.columns), now, Number.isFinite(Number(b.rows)) ? Number(b.rows) : null, sample, now, now)] as any[]
      return json({ id: Number(row.id) })
    }
    if (request.method === 'POST' && url.pathname === '/warehouse/queries') {
      const name = String(b.name ?? '').trim().slice(0, 120), text = String(b.sql ?? '').trim()
      if (!name) return json({ error: 'name the query to save it' }, 400)
      if (!text || text.length > 20_000) return json({ error: 'a query has its SQL (at most 20,000 characters)' }, 400)
      if (b.id) {
        const clash = [...sql.exec('SELECT id FROM warehouse_queries WHERE org = ? AND project = ? AND sql = ? AND id != ?', org, project, text, Number(b.id))][0] as any
        if (clash) sql.exec('DELETE FROM warehouse_queries WHERE id = ?', Number(clash.id))   // the same SQL kept twice becomes one
        sql.exec('UPDATE warehouse_queries SET name = ?, sql = ?, columns = COALESCE(?, columns), updated = ? WHERE id = ? AND org = ? AND project = ?', name, text, columnsOf(b.columns), now, Number(b.id), org, project)
        const [row] = [...sql.exec('SELECT * FROM warehouse_queries WHERE id = ?', Number(b.id))]
        return row ? json(shape(row)) : json({ error: 'there is no such query' }, 404)
      }
      const [row] = [...sql.exec(`INSERT INTO warehouse_queries (org, project, name, sql, columns, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (org, project, sql) DO UPDATE SET name = excluded.name, columns = COALESCE(excluded.columns, columns), updated = excluded.updated RETURNING *`, org, project, name, text, columnsOf(b.columns), now, now)]
      return json(shape(row), 201)
    }
    const m = url.pathname.match(/^\/warehouse\/queries\/(\d+)$/)
    if (m && request.method === 'DELETE') {
      sql.exec('DELETE FROM warehouse_queries WHERE id = ? AND org = ? AND project = ?', Number(m[1]), org, project)
      return json({ ok: true })
    }
    return json({ error: 'not found' }, 404)
  }
}
