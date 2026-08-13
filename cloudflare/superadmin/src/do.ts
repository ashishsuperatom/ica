// OrgDO — Durable Object per org
//
// Responsibilities:
//   - SQLite: users, projects, datasource configs, conversation logs
//   - WebSocket server: clients connect here, DO broadcasts events to all sessions
//
// The DO holds no AI, no tools, no agent logic.
// All analysis runs on the VM. The DO is the persistence and WS hub.

import { DurableObject } from 'cloudflare:workers'

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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id         TEXT PRIMARY KEY,
        email      TEXT UNIQUE NOT NULL,
        clerk_id   TEXT UNIQUE,
        name       TEXT,
        role       TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        created_by  TEXT NOT NULL,
        deleted     INTEGER NOT NULL DEFAULT 0,       -- 0=active, 1=soft-deleted
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS datasources (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL,
        config     TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );
    `)
    // Migration: add deleted column to existing DOs
    try { this.ctx.storage.sql.exec('ALTER TABLE projects ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0') } catch {}
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
    if (request.method === 'GET'  && path === '/projects')     return this.getProjects(url)
    if (request.method === 'POST' && path === '/projects')     return this.createProject(request)
    if (request.method === 'DELETE' && path === '/projects')   return this.deleteProject(request)
    if (request.method === 'PUT'  && path === '/projects')     return this.restoreProject(request)
    if (request.method === 'GET'  && path === '/users')        return this.getUsers()
    if (request.method === 'POST' && path === '/users')        return this.createUser(request)
    if (request.method === 'POST' && path === '/user-by-clerk-id') return this.userByClerkId(request)
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
    const id = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      'INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)',
      id, email, name ?? '', role ?? 'user'
    )
    return Response.json({ id }, { status: 201 })
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
}
