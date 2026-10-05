// OrgDO — Durable Object per org
//
// Responsibilities:
//   - SQLite: users, projects, datasource configs, conversation logs
//   - WebSocket server: clients connect here, DO broadcasts events to all sessions
//
// The DO holds no AI, no tools, no agent logic.
// All analysis runs on the VM. The DO is the persistence and WS hub.

import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { ORG_MIGRATIONS } from './migrations.js'
import { DurableObject } from 'cloudflare:workers'
import { createRecorder } from './records.js'
import { warehouse, WarehouseRefusal, type Grant } from './warehouse/index.js'

interface Session {
  ws:     WebSocket
  userId: string
  role:   'admin' | 'user'
}

export class OrgDO extends DurableObject<Env> {
  private sessions = new Set<Session>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(() => this.migrate())
  }

  // ── Schema migrations ───────────────────────────────────────────────────────

  private async migrate() {
    runMigrations(durableObjectDb(this.ctx.storage), ORG_MIGRATIONS, { name: `OrgDO ${this.ctx.id.toString().slice(0, 8)}` })
  }

  // ── HTTP + WS entrypoint ────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url  = new URL(request.url)
    const path = url.pathname

    // WS upgrade — clients connect here for real-time events
    if (request.headers.get('upgrade') === 'websocket') {
      return this.handleWS(request)
    }

    // REST API
    if (path === '/warehouse' || path.startsWith('/warehouse/')) return this.warehouse(request, path)
    if (path === '/credits' || path.startsWith('/credits/')) return this.credits(request, path)
    if (request.method === 'GET'  && path === '/projects')     return this.getProjects(url)
    if (request.method === 'POST' && path === '/projects')     return this.createProject(request)
    if (request.method === 'DELETE' && path === '/projects')   return this.deleteProject(request)
    if (request.method === 'PUT'  && path === '/projects')     return this.restoreProject(request)
    if (request.method === 'GET'  && path === '/users')        return this.getUsers()
    if (request.method === 'POST' && path === '/users')        return this.createUser(request)
    if (request.method === 'POST' && path === '/user-by-clerk-id') return this.userByClerkId(request)
    if (request.method === 'DELETE' && path === '/users')      return this.deleteUser(request)
    // MEMBERSHIP — who in this org may reach which project. The org owns the master list; the project holds its
    // own copy (ProjectDO /access), so the two are written together and never drift.
    if (request.method === 'GET'  && path === '/assignments')  return this.listAssignments(url)
    if (request.method === 'POST' && path === '/assignments')  return this.assign(request)
    if (request.method === 'DELETE' && path === '/assignments') return this.unassign(request)
    if (request.method === 'GET'  && path.startsWith('/conversations')) return this.getConversations(url)
    if (request.method === 'POST' && path === '/messages')     return this.addMessage(request)

    return new Response('not found', { status: 404 })
  }

  // ── The organisation's warehouse (warehouse/): this DO coordinates it — names it, records what is done to it, routes
  //    each operation through the module. The data is in object storage, never here. A query arrives with what may be
  //    read: 'all' (an organisation administrator) or a project's grant (its ProjectDO sends it).
  private async warehouse(request: Request, path: string): Promise<Response> {
    const { bridge, ingest } = warehouse(this.env)
    const org = request.headers.get('x-sa-org') ?? this.ctx.id.name ?? 'default'
    const json = (v: unknown, status = 200) => Response.json(v, { status })
    const log = (op: string, o: { tbl?: string | null; project?: string | null; rows?: number | null; snapshot?: string | null; ok: boolean; detail?: unknown; by: string }) =>
      this.ctx.storage.sql.exec('INSERT INTO warehouse_ops (at, op, tbl, project, rows, snapshot, ok, detail, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        new Date().toISOString(), op, o.tbl ?? null, o.project ?? null, o.rows ?? null, o.snapshot ?? null, o.ok ? 1 : 0, o.detail === undefined ? null : JSON.stringify(o.detail), o.by)
    const body: any = request.method === 'POST' ? await request.json().catch(() => ({})) : {}
    const by = String(body.by ?? 'platform')
    try {
      if (request.method === 'GET' && path === '/warehouse') {
        const ops = [...this.ctx.storage.sql.exec('SELECT * FROM warehouse_ops ORDER BY seq DESC LIMIT 50')]
        return json({ configured: bridge.configured, org, tables: bridge.configured ? await bridge.tables(org) : [], ops })
      }
      if (request.method === 'POST' && path === '/warehouse/tables') {
        await ingest.createTable(org, { name: String(body.name ?? ''), columns: Array.isArray(body.columns) ? body.columns : [] })
        log('create', { tbl: body.name, ok: true, detail: { columns: body.columns }, by })
        return json({ ok: true, table: body.name }, 201)
      }
      if (request.method === 'POST' && path === '/warehouse/append') {
        const rows = Array.isArray(body.rows) ? body.rows : []
        if (rows.length > 50_000) throw new WarehouseRefusal('at most 50,000 rows in one append — send the rest in another')
        const r = await ingest.append(org, String(body.table ?? ''), rows)
        log('append', { tbl: body.table, project: body.project ?? null, rows: r.rows, snapshot: r.snapshot, ok: true, by })
        return json({ ok: true, ...r })
      }
      if (request.method === 'POST' && path === '/warehouse/query') {
        const grant: Grant | 'all' = body.grant === 'all' ? 'all' : (body.grant && typeof body.grant === 'object' ? body.grant : {})
        const r = await bridge.queryAs(org, String(body.sql ?? ''), grant, { limit: Number(body.limit) || 100 })
        log('query', { tbl: r.tables.join(','), project: body.project ?? null, rows: r.rows.length, ok: true, detail: { sql: String(body.sql).slice(0, 2000) }, by })
        return json({ columns: r.columns, rows: r.rows, truncated: r.truncated })
      }
      return json({ error: 'not found' }, 404)
    } catch (e: any) {
      const refused = e instanceof WarehouseRefusal
      log(path.split('/').pop() ?? 'op', { tbl: body.table ?? body.name ?? null, project: body.project ?? null, ok: false, detail: { error: String(e?.message ?? e).slice(0, 500), ...(body.sql ? { sql: String(body.sql).slice(0, 2000) } : {}) }, by })
      return json({ error: e?.message ?? String(e) }, refused ? 400 : 502)
    }
  }

  // ── WebSocket ───────────────────────────────────────────────────────────────

  private handleWS(request: Request): Response {
    const url    = new URL(request.url)
    const userId = url.searchParams.get('userId') ?? 'anon'
    const role   = (url.searchParams.get('role') ?? 'user') as 'admin' | 'user'
    const pair   = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

    this.ctx.acceptWebSocket(server)
    const session: Session = { ws: server, userId, role }
    this.sessions.add(session)

    server.addEventListener('message', (evt) => {
      // Clients can send { t: "ping" } — just echo back
      // All real work is initiated server-side by the VM calling broadcast()
      try {
        const msg = JSON.parse(evt.data as string)
        if (msg.t === 'ping') server.send(JSON.stringify({ t: 'pong' }))
      } catch {}
    })

    server.addEventListener('close', () => {
      this.sessions.delete(session)
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  // Called by the VM to push events to all connected clients for this org
  broadcast(event: object) {
    const payload = JSON.stringify(event)
    for (const s of this.sessions) {
      try { s.ws.send(payload) } catch {}
    }
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  private async getProjects(url: URL): Promise<Response> {
    const showDeleted = url.searchParams.get('deleted') === '1'
    const rows = [...this.ctx.storage.sql.exec(
      `SELECT * FROM projects WHERE deleted = ? ORDER BY created_at DESC`,
      showDeleted ? 1 : 0
    )]
    // Self-heal the write-path: make sure each project's DO knows its name (ProjectDO = source of truth for
    // the user-UI). Idempotent; this backfills projects created before the name write-path existed. Awaited —
    // admin-only, few projects, and never on the user hot path.
    await Promise.allSettled(rows.map((r: any) =>
      this.env.PROJECT.get(this.env.PROJECT.idFromName(`proj:${r.id}`)).fetch(new Request('http://do/info', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: r.name }),
      }))))
    return Response.json(rows)
  }

  private async createProject(req: Request): Promise<Response> {
    const { name, description, createdBy } = await req.json() as any
    const id = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      'INSERT INTO projects (id, name, description, created_by, deleted) VALUES (?, ?, ?, ?, 0)',
      id, name, description ?? '', createdBy ?? 'system'
    )
    // A new project inherits this org's admins immediately, so whoever created it can administer it without a
    // second step — and without the project ever reading the org.
    await this.syncOrgAdminsToProjects([id])
    this.broadcast({ t: 'project:created', id, name })
    return Response.json({ id }, { status: 201 })
  }

  private async deleteProject(req: Request): Promise<Response> {
    try {
      const body = await req.json() as any
      const id = body?.id
      if (!id) return Response.json({ error: 'missing id' }, { status: 400 })
      // Soft-delete — infrastructure stop is handled by the Worker
      this.ctx.storage.sql.exec('UPDATE projects SET deleted = 1 WHERE id = ?', id)
      this.broadcast({ t: 'project:deleted', id })
      return Response.json({ ok: true })
    } catch (err: any) {
      return Response.json({ error: `delete failed: ${err.message}` }, { status: 500 })
    }
  }

  private async restoreProject(req: Request): Promise<Response> {
    try {
      const body = await req.json() as any
      const id = body?.id
      if (!id) return Response.json({ error: 'missing id' }, { status: 400 })
      this.ctx.storage.sql.exec('UPDATE projects SET deleted = 0 WHERE id = ?', id)
      this.broadcast({ t: 'project:restored', id })
      return Response.json({ ok: true })
    } catch (err: any) {
      return Response.json({ error: `restore failed: ${err.message}` }, { status: 500 })
    }
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  private async userByClerkId(req: Request): Promise<Response> {
    const { clerkUserId } = await req.json() as any
    const rows = [...this.ctx.storage.sql.exec(
      'SELECT id, role FROM users WHERE clerk_id = ?', clerkUserId
    )]
    if (!rows.length) return new Response('Not found', { status: 404 })
    return Response.json({ userId: (rows[0] as any).id, role: (rows[0] as any).role })
  }

  // ── Users ───────────────────────────────────────────────────────────────────

  private getUsers(): Response {
    const rows = [...this.ctx.storage.sql.exec('SELECT id, email, name, role, created_at FROM users')]
    return Response.json(rows)
  }

  private async createUser(req: Request): Promise<Response> {
    const { email, name, role } = await req.json() as any
    const addr = String(email ?? '').trim().toLowerCase()
    if (!addr) return Response.json({ error: 'email required' }, { status: 400 })
    // Lower-cased on the way in: this address IS the identity every later check matches on.
    const [existing] = [...this.ctx.storage.sql.exec('SELECT id FROM users WHERE email = ?', addr)]
    if (existing) {
      if (role) {
        this.ctx.storage.sql.exec('UPDATE users SET role = ? WHERE id = ?', role, existing.id)
        await this.syncOrgAdminsToProjects()   // promoted or demoted → every project's mirror follows
      }
      return Response.json({ id: existing.id, existed: true })
    }
    const id = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      'INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)',
      id, addr, name ?? '', role ?? 'user'
    )
    if ((role ?? 'user') === 'admin') await this.syncOrgAdminsToProjects()
    return Response.json({ id }, { status: 201 })
  }

  // Removing someone from the ORG removes them from every project in it — otherwise a revoked person keeps
  // project access through the copy the project holds.
  private async deleteUser(req: Request): Promise<Response> {
    const { email } = await req.json() as any
    const addr = String(email ?? '').trim().toLowerCase()
    if (!addr) return Response.json({ error: 'email required' }, { status: 400 })
    const projects = [...this.ctx.storage.sql.exec('SELECT id FROM projects WHERE deleted = 0')] as any[]
    for (const p of projects) await this.projectAccess(p.id, 'DELETE', { email: addr })
    this.ctx.storage.sql.exec('DELETE FROM users WHERE email = ?', addr)
    await this.syncOrgAdminsToProjects()   // if they were an admin, drop the mirrored rows too
    return Response.json({ ok: true, email: addr, removedFromProjects: projects.length })
  }

  // ── Assignment: org user → project ─────────────────────────────────────────
  // The write goes to the PROJECT (its own access table). The org list stays the source of who exists; the
  // project decides what they can do there, with its own roles.
  private async projectAccess(projectId: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<any> {
    const id = this.env.PROJECT.idFromName(`proj:${projectId}`)   // same naming everywhere — a bare id addresses a DIFFERENT DO
    const stub = this.env.PROJECT.get(id)
    const res = await stub.fetch(new Request('https://do/access', {
      method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    }))
    return res.json().catch(() => ({}))
  }

  /** Push this org's ADMIN list into every one of its projects. Called whenever that list changes, and when a
   *  project is created, so each project can authorise on its own. Duplicated on purpose: the copy is what keeps
   *  a project's traffic off this object. */
  private async syncOrgAdminsToProjects(projectIds?: string[]): Promise<number> {
    const admins = [...this.ctx.storage.sql.exec("SELECT email FROM users WHERE role = 'admin'")] as any[]
    const emails = admins.map(a => String(a.email || '').toLowerCase()).filter(Boolean)
    const ids = projectIds ?? ([...this.ctx.storage.sql.exec('SELECT id FROM projects WHERE deleted = 0')] as any[]).map(p => p.id)
    for (const pid of ids) {
      const stub = this.env.PROJECT.get(this.env.PROJECT.idFromName(`proj:${pid}`))
      await stub.fetch(new Request('https://do/org-admins', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emails }),
      })).catch(() => {})
    }
    return ids.length
  }

  private async listAssignments(url: URL): Promise<Response> {
    const projectId = url.searchParams.get('projectId')
    if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
    return Response.json(await this.projectAccess(projectId, 'GET'))
  }

  private async assign(req: Request): Promise<Response> {
    const { projectId, email, roleId } = await req.json() as any
    const addr = String(email ?? '').trim().toLowerCase()
    if (!projectId || !addr) return Response.json({ error: 'projectId and email required' }, { status: 400 })
    // Only someone already in the org can be assigned — a project cannot invent its own users.
    const [u] = [...this.ctx.storage.sql.exec('SELECT id FROM users WHERE email = ?', addr)]
    if (!u) return Response.json({ error: 'no such user in this organisation — add them to the org first' }, { status: 400 })
    return Response.json(await this.projectAccess(projectId, 'POST', { email: addr, roleId: roleId ?? 'member' }))
  }

  private async unassign(req: Request): Promise<Response> {
    const { projectId, email } = await req.json() as any
    const addr = String(email ?? '').trim().toLowerCase()
    if (!projectId || !addr) return Response.json({ error: 'projectId and email required' }, { status: 400 })
    return Response.json(await this.projectAccess(projectId, 'DELETE', { email: addr }))
  }

  // ── Conversations + messages ─────────────────────────────────────────────────

  private getConversations(url: URL): Response {
    const projectId = url.searchParams.get('projectId')
    const userId    = url.searchParams.get('userId')
    let sql = 'SELECT * FROM conversations WHERE 1=1'
    const params: any[] = []
    if (projectId) { sql += ' AND project_id = ?'; params.push(projectId) }
    if (userId)    { sql += ' AND user_id = ?';    params.push(userId) }
    sql += ' ORDER BY created_at DESC'
    const rows = [...this.ctx.storage.sql.exec(sql, ...params)]
    return Response.json(rows)
  }

  private async addMessage(req: Request): Promise<Response> {
    const { conversationId, role, content } = await req.json() as any
    const id = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
      id, conversationId, role, content
    )
    return Response.json({ id }, { status: 201 })
  }

  // ── Credits (metering.ts): grants by the platform, debits by this organisation's projects' usage ──
  private async credits(request: Request, path: string): Promise<Response> {
    const sql = this.ctx.storage.sql
    const sum = (q: string) => Number(([...sql.exec(q)][0] as any)?.v ?? 0)
    if (request.method === 'GET' && path === '/credits') {
      const granted = sum("SELECT COALESCE(SUM(amount_micro), 0) AS v FROM credit_ledger WHERE kind = 'grant'")
      const used = -sum("SELECT COALESCE(SUM(amount_micro), 0) AS v FROM credit_ledger WHERE kind = 'usage'")
      const plan = sum("SELECT COUNT(*) AS v FROM credit_ledger WHERE kind = 'grant'") > 0
      const recent = [...sql.exec("SELECT at, kind, amount_micro, project, note, by FROM credit_ledger WHERE kind = 'grant' ORDER BY seq DESC LIMIT 20")]
      return Response.json({ plan, granted_micro: granted, used_micro: used, balance_micro: granted - used, grants: recent })
    }
    const b = await request.json().catch(() => ({})) as any
    if (request.method === 'POST' && path === '/credits/grant') {
      const amount = Number(b?.credits)
      if (!(amount > 0) || !Number.isFinite(amount)) return Response.json({ error: 'a grant is a number of credits, more than 0' }, { status: 400 })
      if (!b?.by) return Response.json({ error: 'who is granting?' }, { status: 400 })
      const at = new Date().toISOString()
      sql.exec("INSERT INTO credit_ledger (at, kind, amount_micro, note, by) VALUES (?, 'grant', ?, ?, ?)", at, Math.round(amount * 1_000_000), b.note ?? null, String(b.by))
      createRecorder((this.env as any).RECORDS, () => 'platform')('credit', `grant:${at}`, { kind: 'grant', amount_micro: Math.round(amount * 1_000_000), note: b.note ?? null, by: b.by, org: this.ctx.id.toString() }, at)
      return Response.json({ ok: true }, { status: 201 })
    }
    // Budgets: credits a person (email:<address>) or group (group:<name>) may spend in a period (month or total).
    if (path === '/credits/budgets' && request.method === 'GET') {
      const rows = [...sql.exec('SELECT b.* FROM budgets b WHERE b.seq = (SELECT MAX(seq) FROM budgets WHERE subject = b.subject) ORDER BY subject')] as any[]
      return Response.json({ budgets: rows.filter((r) => r.credits_micro >= 0) })
    }
    if (path === '/credits/budgets' && request.method === 'POST') {
      const subject = String(b?.subject ?? '').toLowerCase()
      if (!/^(email:[^\s@]+@[^\s@]+|group:[a-z][a-z0-9-]*)$/.test(subject)) return Response.json({ error: 'a budget is for email:<address> or group:<name>' }, { status: 400 })
      const credits = Number(b?.credits)
      if (!Number.isFinite(credits) || (credits < 0 && credits !== -1)) return Response.json({ error: 'a budget is a number of credits, 0 or more (remove it with -1)' }, { status: 400 })
      const period = b?.period === 'total' ? 'total' : 'month'
      if (!b?.by) return Response.json({ error: 'who is setting the budget?' }, { status: 400 })
      sql.exec('INSERT INTO budgets (subject, credits_micro, period, by, at) VALUES (?, ?, ?, ?, ?)', subject, credits === -1 ? -1 : Math.round(credits * 1_000_000), period, String(b.by), new Date().toISOString())
      return Response.json({ ok: true }, { status: 201 })
    }
    // What a person may still spend: their own budget and each of their groups', against what is attributed to them.
    if (path === '/credits/allowance' && request.method === 'POST') {
      const subjects: string[] = [String(b?.email ? `email:${String(b.email).toLowerCase()}` : ''), ...((b?.groups ?? []) as string[]).map((g) => `group:${g}`)].filter(Boolean)
      const month = new Date().toISOString().slice(0, 7)
      const refusals: string[] = []
      for (const subject of subjects) {
        const [bud] = [...sql.exec('SELECT credits_micro, period FROM budgets WHERE subject = ? ORDER BY seq DESC LIMIT 1', subject)] as any[]
        if (!bud || bud.credits_micro < 0) continue
        const who = subject.startsWith('email:') ? [subject] : ((b?.members ?? {})[subject] ?? [])
        if (!who.length) continue
        const marks = who.map(() => '?').join(', ')
        const spent = -Number(([...sql.exec(`SELECT COALESCE(SUM(amount_micro), 0) AS v FROM credit_ledger WHERE kind = 'usage' AND principal IN (${marks})${bud.period === 'month' ? ' AND substr(at, 1, 7) = ?' : ''}`, ...who, ...(bud.period === 'month' ? [month] : []))][0] as any)?.v ?? 0)
        if (spent >= bud.credits_micro) refusals.push(`${subject.replace(/^email:/, '')} has used its ${bud.period === 'month' ? 'monthly ' : ''}budget of ${bud.credits_micro / 1_000_000} credits`)
      }
      return Response.json(refusals.length ? { ok: false, reason: refusals.join('; ') } : { ok: true })
    }
    if (request.method === 'POST' && path === '/credits/usage') {
      const micro = Math.round(Number(b?.credits_micro))
      if (!(micro >= 0) || !b?.project) return Response.json({ error: 'usage names its project and its cost in micro-credits' }, { status: 400 })
      if (micro > 0) {
        sql.exec("INSERT INTO credit_ledger (at, kind, amount_micro, project, by, principal) VALUES (?, 'usage', ?, ?, ?, ?)", b.at ?? new Date().toISOString(), -micro, String(b.project), `project:${b.project}`, b.principal ?? null)
        createRecorder((this.env as any).RECORDS, () => String(b.project))('credit', `usage:${b.at ?? Date.now()}`, { kind: 'usage', amount_micro: -micro, org: this.ctx.id.toString() }, b.at)
      }
      return Response.json({ ok: true })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  }
}