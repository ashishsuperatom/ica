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
import { meetsNeed, orgRouteNeeds, projectRouteNeeds, type Standing } from '../../shared/permissions.js'

/** How long the guard trusts its copy of a standing: past it, it lets the request through for the DO to decide. */
const COPY_FRESH_MS = 10 * 60_000

export class UserDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => { runMigrations(durableObjectDb(this.ctx.storage), USER_MIGRATIONS, { name: 'user' }) })
  }

  // One hub per instance: it holds the parts of large messages being joined and keeps each link's frames in order.
  private _hub?: ReturnType<typeof personHub>
  private hub() { return (this._hub ??= personHub(this.ctx, this.env)) }
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
    if (new URL(request.url).pathname.startsWith('/door/')) return this.door(request)
    if (request.method === 'PUT' && new URL(request.url).pathname === '/door-standing') {   // a DO telling where the person stands now
      const b = await request.json().catch(() => null) as { kind?: string; id?: string; standing?: Standing } | null
      if (!b || (b.kind !== 'project' && b.kind !== 'org') || !b.id || !b.standing) return new Response(JSON.stringify({ error: 'a kind, an id and a standing' }), { status: 400 })
      this.keepStanding(b.kind, b.id, b.standing)
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
    }
    if (request.method === 'POST' && new URL(request.url).pathname === '/attach') return this.hub().attach(request)
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
    // The person's own keys to connections that read with each person's own (docs/connectors-plan.md R2), by project and
    // connection: kept sealed (the project seals them with the platform's key; this object never holds one in the clear),
    // given back to that project alone. Reached only from a project — the worker forwards no path here.
    if (url.pathname === '/connection-keys') {
      const project = String(url.searchParams.get('project') ?? ''), connection = String(url.searchParams.get('connection') ?? '')
      if (!project || !connection) return json({ error: 'a project and a connection' }, 400)
      if (request.method === 'GET') { const [r] = [...sql.exec('SELECT sealed FROM connection_keys WHERE project = ? AND connection = ?', project, connection)] as any[]; return json({ sealed: r?.sealed ?? null }) }
      if (request.method === 'DELETE') { sql.exec('DELETE FROM connection_keys WHERE project = ? AND connection = ?', project, connection); return json({ ok: true }) }
      if (request.method === 'PUT') {
        const b = await request.json().catch(() => ({})) as { sealed?: string }
        if (!b.sealed || typeof b.sealed !== 'string' || b.sealed.length > 64_000) return json({ error: 'a sealed key' }, 400)
        sql.exec('INSERT INTO connection_keys (project, connection, sealed, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (project, connection) DO UPDATE SET sealed = excluded.sealed, added_at = excluded.added_at', project, connection, b.sealed, new Date().toISOString())
        return json({ ok: true })
      }
    }
    // The person's development environments, in every project of this organisation: each project replaces its own
    // (PUT /dev-envs { project, projectName, envs }) whenever one of theirs changes; GET /dev-envs[?project] reads them.
    if (url.pathname === '/dev-envs') {
      if (request.method === 'PUT') {
        const b = await request.json() as { project?: string; projectName?: string; envs?: { id: string; name: string; status: string; names: string[]; last_used: string }[] }
        if (!b?.project || !Array.isArray(b.envs)) return json({ error: 'a project and its environments' }, 400)
        sql.exec('DELETE FROM dev_envs WHERE project = ?', b.project)
        for (const e of b.envs) sql.exec('INSERT INTO dev_envs (project, project_name, id, name, status, names, last_used) VALUES (?, ?, ?, ?, ?, ?, ?)',
          b.project, String(b.projectName ?? ''), String(e.id), String(e.name), String(e.status), JSON.stringify(Array.isArray(e.names) ? e.names : []), String(e.last_used))
        return json({ ok: true })
      }
      if (request.method === 'GET') {
        const project = url.searchParams.get('project')
        const rows = [...(project ? sql.exec('SELECT * FROM dev_envs WHERE project = ? ORDER BY last_used DESC', project) : sql.exec('SELECT * FROM dev_envs ORDER BY last_used DESC'))]
        return json({ envs: rows.map((r: any) => ({ ...r, names: JSON.parse(String(r.names ?? '[]')) })) })
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

  // ── THE DOOR (docs/one-door-plan.md, step 2) ──────────────────────────────────────────────────────────────────────
  // Everything this person does with their sign-in comes through here — /door/<project|org|global>/<id>/<path> — and goes
  // on to that Durable Object, with who is asking (set by the Worker, which checked the sign-in). The DO it goes to
  // decides; this is the guard's place (step 3: what is already refused stops here; later the person's limits and costs).
  // Bodies pass through as they came: big ones never come this way (uploads and files go to storage with a ticket).
  private async door(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const m = url.pathname.match(/^\/door\/(project|org|global)\/([\w-]{1,80})(\/.*)$/)
    if (!m) return new Response(JSON.stringify({ error: 'not a door' }), { status: 404, headers: { 'content-type': 'application/json' } })
    const [, kind, id, rest] = m
    // THE GUARD: what a fresh copy of where they stand already refuses stops here — the same answer the DO would give.
    const no = this.guard(kind, id, request.method, rest)
    if (no) { const r = Response.json({ error: no.error }, { status: no.status }); r.headers.set('x-sa-door', 'person'); r.headers.set('x-sa-guard', 'refused'); return r }
    const ns: any = kind === 'project' ? this.env.PROJECT : kind === 'org' ? (this.env as any).ORG : (this.env as any).GLOBAL
    const target = ns.get(ns.idFromName(kind === 'project' ? `proj:${id}` : id))
    const fwd = new Request(`http://do${rest}${url.search}`, request)
    if (kind === 'project') fwd.headers.set('x-sa-project', id)
    if (kind === 'org') fwd.headers.set('x-sa-org', id)
    const r: Response = await target.fetch(fwd)
    const out = new Response(r.body, r)
    const decided = r.headers.get('x-sa-standing')   // where the DO decided they stand, for this request: the copy
    if (decided && (kind === 'project' || kind === 'org')) { try { this.keepStanding(kind, id, JSON.parse(decided)) } catch { /* not one */ } }
    out.headers.delete('x-sa-standing')
    out.headers.set('x-sa-door', 'person')   // came through the person's door (the Worker knows a UserDO before it by its absence)
    return out
  }

  private keepStanding(kind: 'project' | 'org', id: string, s: Standing) {
    this.ctx.storage.sql.exec('INSERT INTO standing_copy (kind, id, standing, at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET standing = excluded.standing, at = excluded.at',
      kind, id, JSON.stringify({ ok: !!s.ok, level: s.level, caps: Array.isArray(s.caps) ? s.caps : [], reason: s.reason ?? null }), Date.now())
  }

  /** Why the copy refuses this request (the DO's own words), or null to let it through: no copy, an old one, the standing
   *  question itself, or a request the copy allows. Giving a project role (/assignments) hangs on more than the copy. */
  private guard(kind: string, id: string, method: string, rest: string): { status: number; error: string } | null {
    if ((kind !== 'project' && kind !== 'org') || rest === '/standing' || (kind === 'org' && rest === '/assignments')) return null
    const [row] = [...this.ctx.storage.sql.exec('SELECT standing, at FROM standing_copy WHERE kind = ? AND id = ?', kind, id)] as any[]
    if (!row || Date.now() - Number(row.at) > COPY_FRESH_MS) return null
    let s: { ok: boolean; level: any; caps: string[]; reason: string | null }
    try { s = JSON.parse(String(row.standing)) } catch { return null }
    const need = kind === 'project' ? projectRouteNeeds(method, rest.slice(1)) : orgRouteNeeds(method, rest)
    if (need === 'internal') return null   // the DO answers that itself
    if (!s.ok) return { status: 401, error: s.reason ?? (kind === 'project' ? 'no access to this project' : 'not in this organisation') }
    if (meetsNeed(need, s.level, s.caps)) return null
    return { status: 403, error: kind === 'project' ? `this needs ${need}, which your role here does not hold` : `this needs ${need === 'platform' ? 'the platform' : need}, which your role in this organisation does not hold` }
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
