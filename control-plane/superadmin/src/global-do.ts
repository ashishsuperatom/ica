// GlobalDO — singleton Durable Object for the Superatom platform
//
// Responsibilities:
//   - SQLite: superatom_users (platform admins), organizations list
//   - Auth: validate platform admin credentials
//   - Org lifecycle: create, disable, delete organizations
//
// Identified by name "global" — only one instance per Worker.

import { DurableObject } from 'cloudflare:workers'
import { LoginCodeStore } from './auth/login-code-store.js'

// ── THE CATALOGUE WE SHIP WITH ─────────────────────────────────────────────────────────────────────────────
// A platform whose catalogue starts empty is a platform where nothing can be assigned until someone types a
// list from memory — so this is what is offered until a real one is saved, and saving replaces it wholesale.
//
// These are OBSERVED, not invented: read from pi's live model catalogue on a running box (which needs no
// credential to enumerate) and from the codex CLI's own models cache. Dateless ids, so an entry keeps meaning
// "the current one" rather than aging into a pinned build.
const DEFAULT_CATALOGUE: Record<string, string[]> = {
  'opencode-go': [
    'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash',
    'gpt-5.6-luna', 'grok-4.6', 'hy3', 'hy4-preview', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3',
    'longcat-2.0', 'mimo-v2.5', 'mimo-v2.5-pro', 'minimax-m2.7', 'minimax-m3', 'omen-alpha',
    'qwen3.6-plus', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen3.8-max',
  ],
  'openai-codex': [
    'gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5',
    'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra',
  ],
  'claude-code': ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  // The RELAY to Anthropic's API, which is a different account from the claude-code subscription above even
  // though the model names coincide — one is billed per token against a key in the vault, the other against a
  // seat. Same names, and deliberately so: the choice being made is which account pays.
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  // Turned off at the proxy AND not in use, so it is catalogued empty rather than guessed at: OpenRouter ids
  // are `vendor/model`, and an unverified one would put a model that may not exist in front of an operator.
  // (Transcription reaches openrouter.ai directly from the Worker — a different path from an agent's provider,
  // and not a reason to list a model here.) The entry stays so switching it on needs no new provider.
  openrouter: [],
}

export class GlobalDO extends DurableObject<Env> {
  // One-time mobile login codes — strongly-consistent store lives here (see auth/login-code-store.ts).
  private loginCodes: LoginCodeStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.loginCodes = new LoginCodeStore(this.ctx.storage.sql)
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

      -- WHICH MODELS EACH PROVIDER MAY BE ASKED FOR. Platform-wide and held ONCE: "opencode-go carries
      -- kimi-k3" is true for every project, so storing it per project would mean editing it N times and
      -- letting the copies drift. Merged into each project's profile when that profile is delivered, so an
      -- engine still receives one document over one path.
      --
      -- Here rather than in the engine image because adding or removing a model must not require a rebuild
      -- and a roll of every box — the whole point of configuration living in the control plane.
      CREATE TABLE IF NOT EXISTS model_catalogue (
        json       TEXT NOT NULL,
        updated_by TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
    // Migration: add column if missing (existing DOs from before this change)
    try { this.ctx.storage.sql.exec('ALTER TABLE organizations ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0') } catch {}
    LoginCodeStore.migrate(this.ctx.storage.sql)
  }

  /** The live catalogue, or null when none has been set — in which case every engine uses the fallback copy
   *  baked into its own default.json, and nothing has to be seeded here for a fresh platform to work. */
  private catalogueRow(): { models: Record<string, string[]>; updatedBy: string | null; updatedAt: number } | null {
    const [row] = this.ctx.storage.sql.exec('SELECT json, updated_by, updated_at FROM model_catalogue LIMIT 1')
    if (!row) return null
    try {
      return { models: JSON.parse((row as any).json), updatedBy: (row as any).updated_by ?? null, updatedAt: (row as any).updated_at }
    } catch { return null }
  }

  /** Read by ProjectDO on its own hot path, so it stays a plain lookup with no validation or work. */
  catalogue(): Record<string, string[]> | null { return this.catalogueRow()?.models ?? DEFAULT_CATALOGUE }

  private async getCatalogue(): Promise<Response> {
    const row = this.catalogueRow()
    // `source` so a screen can say whether it is showing a saved decision or the list we ship with — the two
    // look identical and mean different things.
    return row
      ? Response.json({ ...row, source: 'stored' })
      : Response.json({ models: DEFAULT_CATALOGUE, updatedBy: null, updatedAt: 0, source: 'default' })
  }

  private async putCatalogue(req: Request): Promise<Response> {
    const body = await req.json() as any
    const models = body?.models
    // SHAPE CHECKED HERE, because this reaches every project: a catalogue that is not
    // provider → list-of-names would make each engine refuse every profile it validates against it.
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
      return Response.json({ error: 'body must be { models: { provider: [model, …] } }' }, { status: 400 })
    }
    for (const [provider, list] of Object.entries(models)) {
      if (!Array.isArray(list) || list.some(m => typeof m !== 'string' || !m)) {
        return Response.json({ error: `models.${provider} must be a list of model names` }, { status: 400 })
      }
    }
    this.ctx.storage.sql.exec('DELETE FROM model_catalogue')
    this.ctx.storage.sql.exec('INSERT INTO model_catalogue (json, updated_by, updated_at) VALUES (?, ?, ?)',
      JSON.stringify(models), body?.by ?? null, Date.now())
    return Response.json({ ok: true, providers: Object.keys(models).length })
  }

  async fetch(request: Request): Promise<Response> {
    const url  = new URL(request.url)
    const path = url.pathname

    // Auth: lookup superatom admin by Clerk user ID
    if (request.method === 'POST' && path === '/admin-by-clerk-id') {
      return this.adminByClerkId(request)
    }

    // Mobile login one-time codes (device flow — strongly-consistent store; see auth/login-code-store.ts)
    if (request.method === 'POST' && path === '/mobile-code') {
      this.loginCodes.put(await request.json() as any)
      return Response.json({ ok: true })
    }
    if (request.method === 'POST' && path === '/mobile-code/claim') {
      const { code, codeVerifier } = await request.json() as any
      const r = await this.loginCodes.claim(String(code || ''), String(codeVerifier || ''))
      return r ? Response.json(r) : new Response('not found', { status: 404 })   // caller maps to a uniform 401
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
    // The model catalogue: read by ProjectDO when it composes a profile, written from superadmin.
    if (request.method === 'GET' && path === '/catalogue') return this.getCatalogue()
    if (request.method === 'PUT' && path === '/catalogue') return this.putCatalogue(request)

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
    const { name, adminEmail } = await req.json() as any
    const id = crypto.randomUUID()
    const doName = `org:${id}`
    this.ctx.storage.sql.exec(
      'INSERT INTO organizations (id, name, do_name, deleted) VALUES (?, ?, ?, 0)',
      id, name, doName
    )
    // A new organisation with nobody in it cannot be entered — only superadmin could reach it, which is not
    // the point of creating one. So the first admin is named here and created with it.
    let admin: string | null = null
    const addr = String(adminEmail ?? '').trim().toLowerCase()
    if (addr) {
      try {
        await this.env.ORG.get(this.env.ORG.idFromName(id)).fetch(new Request('https://do/users', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: addr, role: 'admin' }),
        }))
        admin = addr
      } catch { /* the org exists; its admin can still be added from the org page */ }
    }
    return Response.json({ id, name, doName, admin }, { status: 201 })
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
