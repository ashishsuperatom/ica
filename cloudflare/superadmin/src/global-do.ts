// GlobalDO — singleton Durable Object for the Superatom platform
//
// Responsibilities:
//   - SQLite: superatom_users (platform admins), organizations list
//   - Auth: validate platform admin credentials
//   - Org lifecycle: create, disable, delete organizations
//
// Identified by name "global" — only one instance per Worker.

import { DurableObject } from 'cloudflare:workers'

export class GlobalDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(() => this.migrate())
  }

  private async migrate() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS superatom_users (
        id         TEXT PRIMARY KEY,
        email      TEXT UNIQUE NOT NULL,
        clerk_id   TEXT UNIQUE,
        role       TEXT NOT NULL DEFAULT 'superadmin',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS organizations (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        do_name    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'active',
        deleted    INTEGER NOT NULL DEFAULT 0,       -- 0=active, 1=soft-deleted
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      -- Reverse index for *.superatom.site: subdomain → projectId. Authoritative
      -- source of truth; KV is a hot-read cache in front of this (see worker.ts).
      -- Claims are rare writes, so this single DO is never on the hot path.
      CREATE TABLE IF NOT EXISTS domains (
        subdomain  TEXT PRIMARY KEY,                 -- lowercase, validated
        project_id TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_domains_project ON domains(project_id);
    `)
    // Migration: add column if missing (existing DOs from before this change)
    try { this.ctx.storage.sql.exec('ALTER TABLE organizations ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0') } catch {}
  }

  async fetch(request: Request): Promise<Response> {
    const url  = new URL(request.url)
    const path = url.pathname

    // Auth: lookup superatom admin by Clerk user ID
    if (request.method === 'POST' && path === '/admin-by-clerk-id') {
      return this.adminByClerkId(request)
    }

    // CRUD: organizations (soft-delete — never hard-delete)
    if (request.method === 'GET'  && path === '/organizations') return this.listOrgs(url)
    if (request.method === 'POST' && path === '/organizations') return this.createOrg(request)
    if (request.method === 'DELETE' && path === '/organizations') return this.deleteOrg(request)
    if (request.method === 'PUT'  && path === '/organizations') return this.restoreOrg(request)

    // CRUD: superatom users
    if (request.method === 'GET'  && path === '/users') return this.listUsers()
    if (request.method === 'POST' && path === '/users') return this.createUser(request)

    // Domains (*.superatom.site subdomain → projectId)
    if (request.method === 'GET'    && path === '/domains/check')   return this.checkDomain(url)
    if (request.method === 'GET'    && path === '/domains/resolve') return this.resolveDomain(url)
    if (request.method === 'GET'    && path === '/domains/by-project') return this.domainByProject(url)
    if (request.method === 'POST'   && path === '/domains/claim')   return this.claimDomain(request)
    if (request.method === 'DELETE' && path === '/domains')         return this.releaseDomain(request)

    return new Response('not found', { status: 404 })
  }

  // ── Domains ─────────────────────────────────────────────────────────────────

  // Single source of truth for what a valid subdomain is. Returns null if OK,
  // else a human reason. UUID-shaped names are reserved so they can never collide
  // with <projectid>.superatom.site direct addressing.
  static validateSubdomain(raw: string): string | null {
    const s = (raw ?? '').toLowerCase().trim()
    if (!s) return 'empty'
    if (s.length < 3 || s.length > 63) return 'must be 3–63 characters'
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(s)) return 'letters, digits and hyphens only (no leading/trailing hyphen)'
    if (s.includes('--')) return 'no double hyphens'
    if (s.includes('superatom')) return '"superatom" is not allowed in a subdomain'
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return 'reserved (looks like a project id)'
    const RESERVED = new Set(['admin','www','api','app','code','hub','ws','assets','static','cdn','mail','smtp','ftp','dashboard','console','status','docs','help','support','blog','dev','staging','prod','test','root','superadmin'])
    if (RESERVED.has(s)) return 'reserved name'
    return null
  }

  private checkDomain(url: URL): Response {
    const sub = (url.searchParams.get('subdomain') ?? '').toLowerCase().trim()
    const reason = GlobalDO.validateSubdomain(sub)
    if (reason) return Response.json({ available: false, reason })
    const taken = [...this.ctx.storage.sql.exec('SELECT project_id FROM domains WHERE subdomain = ?', sub)]
    if (taken.length) return Response.json({ available: false, reason: 'already taken' })
    return Response.json({ available: true })
  }

  private resolveDomain(url: URL): Response {
    const sub = (url.searchParams.get('subdomain') ?? '').toLowerCase().trim()
    const rows = [...this.ctx.storage.sql.exec('SELECT project_id FROM domains WHERE subdomain = ?', sub)]
    if (!rows.length) return new Response('not found', { status: 404 })
    return Response.json({ projectId: (rows[0] as any).project_id })
  }

  private domainByProject(url: URL): Response {
    const pid = url.searchParams.get('projectId') ?? ''
    const rows = [...this.ctx.storage.sql.exec('SELECT subdomain FROM domains WHERE project_id = ? ORDER BY created_at ASC', pid)]
    return Response.json({ subdomains: rows.map((r: any) => r.subdomain) })
  }

  // Atomic claim: validate, then INSERT. DO single-threaded execution gives us the
  // compare-and-set for free (no race between check and insert).
  private async claimDomain(req: Request): Promise<Response> {
    const { subdomain, projectId } = await req.json() as any
    const sub = (subdomain ?? '').toLowerCase().trim()
    if (!projectId) return Response.json({ error: 'missing projectId' }, { status: 400 })
    const reason = GlobalDO.validateSubdomain(sub)
    if (reason) return Response.json({ error: reason }, { status: 400 })
    const taken = [...this.ctx.storage.sql.exec('SELECT project_id FROM domains WHERE subdomain = ?', sub)]
    if (taken.length) {
      if ((taken[0] as any).project_id === projectId) return Response.json({ ok: true, subdomain: sub })
      return Response.json({ error: 'already taken' }, { status: 409 })
    }
    this.ctx.storage.sql.exec('INSERT INTO domains (subdomain, project_id) VALUES (?, ?)', sub, projectId)
    return Response.json({ ok: true, subdomain: sub }, { status: 201 })
  }

  private async releaseDomain(req: Request): Promise<Response> {
    const { subdomain } = await req.json() as any
    const sub = (subdomain ?? '').toLowerCase().trim()
    this.ctx.storage.sql.exec('DELETE FROM domains WHERE subdomain = ?', sub)
    return Response.json({ ok: true })
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  private async adminByClerkId(req: Request): Promise<Response> {
    const { clerkUserId } = await req.json() as any
    const rows = [...this.ctx.storage.sql.exec(
      'SELECT id FROM superatom_users WHERE clerk_id = ?', clerkUserId
    )]
    if (!rows.length) return new Response('Not found', { status: 404 })
    return Response.json({ userId: (rows[0] as any).id })
  }

  // ── Organizations ──────────────────────────────────────────────────────────

  private listOrgs(url: URL): Response {
    const showDeleted = url.searchParams.get('deleted') === '1'
    const rows = [...this.ctx.storage.sql.exec(
      `SELECT * FROM organizations WHERE deleted = ? ORDER BY created_at DESC`,
      showDeleted ? 1 : 0
    )]
    return Response.json(rows)
  }

  private async createOrg(req: Request): Promise<Response> {
    const { name } = await req.json() as any
    const id = crypto.randomUUID()
    const doName = `org:${id}`
    this.ctx.storage.sql.exec(
      'INSERT INTO organizations (id, name, do_name, deleted) VALUES (?, ?, ?, 0)',
      id, name, doName
    )
    return Response.json({ id, name, doName }, { status: 201 })
  }

  private async deleteOrg(req: Request): Promise<Response> {
    try {
      const body = await req.json() as any
      const id = body?.id
      if (!id) return Response.json({ error: 'missing id' }, { status: 400 })
      this.ctx.storage.sql.exec(
        'UPDATE organizations SET deleted = 1, status = ? WHERE id = ?', 'disabled', id
      )
      return Response.json({ ok: true })
    } catch (err: any) {
      return Response.json({ error: `delete failed: ${err.message}` }, { status: 500 })
    }
  }

  private async restoreOrg(req: Request): Promise<Response> {
    try {
      const body = await req.json() as any
      const id = body?.id
      if (!id) return Response.json({ error: 'missing id' }, { status: 400 })
      this.ctx.storage.sql.exec(
        'UPDATE organizations SET deleted = 0, status = ? WHERE id = ?', 'active', id
      )
      return Response.json({ ok: true })
    } catch (err: any) {
      return Response.json({ error: `restore failed: ${err.message}` }, { status: 500 })
    }
  }

  // ── Superatom users ───────────────────────────────────────────────────────

  private listUsers(): Response {
    const rows = [...this.ctx.storage.sql.exec(
      'SELECT id, email, role, created_at FROM superatom_users ORDER BY created_at DESC'
    )]
    return Response.json(rows)
  }

  private async createUser(req: Request): Promise<Response> {
    const { email, clerkId, role } = await req.json() as any
    const id = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      'INSERT INTO superatom_users (id, email, clerk_id, role) VALUES (?, ?, ?, ?)',
      id, email, clerkId ?? null, role ?? 'superadmin'
    )
    return Response.json({ id }, { status: 201 })
  }
}
