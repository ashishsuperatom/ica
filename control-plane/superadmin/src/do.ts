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
    if (request.method === 'POST' && path === '/credits/backfill') {
      const record = createRecorder((this.env as any).RECORDS, () => 'platform')
      let n = 0
      for (const r of [...sql.exec('SELECT * FROM credit_ledger ORDER BY seq')] as any[]) { record('credit', `${r.kind}:${r.seq}`, { ...r, org: this.ctx.id.toString() }, r.at); n++ }
      return Response.json({ credits: n })
    }
    if (request.method === 'POST' && path === '/credits/usage') {
      const micro = Math.round(Number(b?.credits_micro))
      if (!(micro >= 0) || !b?.project) return Response.json({ error: 'usage names its project and its cost in micro-credits' }, { status: 400 })
      if (micro > 0) {
        sql.exec("INSERT INTO credit_ledger (at, kind, amount_micro, project, by) VALUES (?, 'usage', ?, ?, ?)", b.at ?? new Date().toISOString(), -micro, String(b.project), `project:${b.project}`)
        createRecorder((this.env as any).RECORDS, () => String(b.project))('credit', `usage:${b.at ?? Date.now()}`, { kind: 'usage', amount_micro: -micro, org: this.ctx.id.toString() }, b.at)
      }
      return Response.json({ ok: true })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  }
}