// GlobalDO — singleton Durable Object for the Superatom platform
//
// Responsibilities:
//   - SQLite: the organizations list
//   - Auth: validate platform admin credentials
//   - Org lifecycle: create, disable, delete organizations
//
// Identified by name "global" — only one instance per Worker.

import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { GLOBAL_MIGRATIONS } from './migrations.js'
import { ORG_ROLES } from '../../shared/permissions.js'
import { DurableObject } from 'cloudflare:workers'
import { checkPrices } from './metering.js'
import { LoginCodeStore } from './auth/login-code-store.js'

export class GlobalDO extends DurableObject<Env> {
  // One-time mobile login codes — strongly-consistent store lives here (see auth/login-code-store.ts).
  private loginCodes: LoginCodeStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.loginCodes = new LoginCodeStore(this.ctx.storage.sql)
    this.ctx.blockConcurrencyWhile(() => this.migrate())
  }

  // ── ChatGPT logins (proxy/chatgpt-login.ts) ──────────────────────────────────────────────────────────────────────
  // Every renewal invalidates the refresh token before it, so a login is renewed by one caller at a time: callers that
  // arrive while it is being renewed wait for that renewal and take its result. This object is the platform's only one
  // of its kind, so "one at a time" holds across every engine and every Worker.
  private renewing = new Map<string, Promise<{ access: string; accountId: string | null; expiresAt: number | null; renewed: boolean }>>()
  private chatgptLogin(id: string) {
    const running = this.renewing.get(id)
    if (running) return running
    const p = (async () => {
      const kv: any = (this.env as any).CREDENTIALS, master = (this.env as any).CREDENTIALS_MASTER_KEY
      if (!kv) throw new Error('no vault bound (CREDENTIALS)')
      const { readVault, writeVault, expiryOf } = await import('./proxy/vault.js')
      const { parseLogin, renewLogin, RENEW_BEFORE_MS } = await import('./proxy/chatgpt-login.js')
      const v = await readVault(kv, master)
      const e = v.entries.find((x) => x.id === id)
      const login = e ? parseLogin(e.value) : null
      if (!e || !login) throw new Error(`there is no ChatGPT login ${id} in the vault`)
      const exp = expiryOf(e.value)
      if (exp && exp - Date.now() > RENEW_BEFORE_MS) return { access: login.access, accountId: login.accountId ?? null, expiresAt: exp, renewed: false }
      let next
      try { next = await renewLogin(login) }
      catch (err: any) { throw new Error(`the ChatGPT login ${id} could not be renewed — ${err?.message ?? err}. Sign in again (codex login) and replace it: platform console → Credentials`) }
      const value = JSON.stringify(next), at = expiryOf(value)
      // Read again just before writing: anything else changed in the vault meanwhile is kept; only this login moves on.
      const now = await readVault(kv, master)
      await writeVault(kv, { ...now, entries: now.entries.map((x) => (x.id === id ? { ...x, value, expiresAt: at } : x)) }, master)
      console.log(`[vault] ChatGPT login ${id} renewed${at ? `, good until ${new Date(at).toISOString().slice(0, 16)}` : ''}`)
      return { access: next.access, accountId: next.accountId ?? null, expiresAt: at ?? null, renewed: true }
    })()
    this.renewing.set(id, p)
    return p.finally(() => this.renewing.delete(id))
  }

  private async migrate() {
    runMigrations(durableObjectDb(this.ctx.storage), GLOBAL_MIGRATIONS, { name: 'GlobalDO' })
  }

  async fetch(request: Request): Promise<Response> {
    const url  = new URL(request.url)
    const path = url.pathname

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

    // A ChatGPT login from the vault, renewed first when it is due — here, so there is one renewal at a time per login.
    if (request.method === 'POST' && path === '/vault/chatgpt') {
      const { id } = await request.json() as any
      try { return Response.json(await this.chatgptLogin(String(id ?? ''))) }
      catch (e: any) { return Response.json({ error: String(e?.message ?? e) }, { status: 502 }) }
    }

    // CRUD: organizations (soft-delete — never hard-delete)
    if (request.method === 'GET'  && path === '/organizations') return this.listOrgs(url)
    if (request.method === 'POST' && path === '/organizations') return this.createOrg(request)
    if (request.method === 'DELETE' && path === '/organizations') return this.deleteOrg(request)
    if (request.method === 'PUT'  && path === '/organizations') return this.restoreOrg(request)

    // CRUD: superatom users

    // Domains (*.superatom.site subdomain → projectId)
    if (request.method === 'GET' && path === '/prices') {
      const [row] = [...this.ctx.storage.sql.exec('SELECT json, by, at, seq FROM price_list ORDER BY seq DESC LIMIT 1')] as any[]
      return Response.json(row ? { prices: JSON.parse(row.json), by: row.by, at: row.at, version: row.seq } : { prices: [], version: 0 })
    }
    if (request.method === 'PUT' && path === '/prices') {
      const b = await request.json().catch(() => ({})) as any
      const bad = checkPrices(b?.prices)
      if (bad.length) return Response.json({ error: bad.join('; ') }, { status: 400 })
      if (!b?.by) return Response.json({ error: 'who is setting the prices?' }, { status: 400 })
      this.ctx.storage.sql.exec('INSERT INTO price_list (json, by, at) VALUES (?, ?, ?)', JSON.stringify(b.prices), String(b.by), new Date().toISOString())
      return Response.json({ ok: true, prices: b.prices.length })
    }

    if (request.method === 'GET'    && path === '/domains/check')   return this.checkDomain(url)
    if (request.method === 'GET'    && path === '/domains/resolve') return this.resolveDomain(url)
    if (request.method === 'GET'    && path === '/domains/by-project') return this.domainByProject(url)
    if (request.method === 'POST'   && path === '/domains/claim')   return this.claimDomain(request)
    if (request.method === 'DELETE' && path === '/domains')         return this.releaseDomain(request)
    // The platform's own hand on every address (the worker lets only a platform admin here): all of them, a move, a removal.
    if (request.method === 'GET'    && path === '/domains/all')     return this.allDomains()
    if (request.method === 'PUT'    && path === '/domains/assign')  return this.assignDomain(request)
    if (request.method === 'DELETE' && path === '/domains/any')     return this.removeDomain(request)

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
    const { subdomain, projectId } = await req.json() as any
    const sub = (subdomain ?? '').toLowerCase().trim()
    // Only the project that holds an address releases it (the worker checked the caller may act on that project).
    const [held] = [...this.ctx.storage.sql.exec('SELECT project_id FROM domains WHERE subdomain = ?', sub)] as any[]
    if (held && held.project_id !== projectId) return Response.json({ error: `${sub} is another project's address` }, { status: 403 })
    this.ctx.storage.sql.exec('DELETE FROM domains WHERE subdomain = ? AND project_id = ?', sub, projectId)
    return Response.json({ ok: true })
  }

  private allDomains(): Response {
    const rows = [...this.ctx.storage.sql.exec('SELECT subdomain, project_id, created_at FROM domains ORDER BY subdomain')] as any[]
    return Response.json({ domains: rows.map((r) => ({ subdomain: r.subdomain, projectId: r.project_id, createdAt: r.created_at ?? null })) })
  }

  /** An address given to a project, whoever held it (a platform admin's move). */
  private async assignDomain(req: Request): Promise<Response> {
    const { subdomain, projectId } = await req.json() as any
    const sub = (subdomain ?? '').toLowerCase().trim()
    if (!projectId) return Response.json({ error: 'missing projectId' }, { status: 400 })
    const reason = GlobalDO.validateSubdomain(sub)
    if (reason) return Response.json({ error: reason }, { status: 400 })
    this.ctx.storage.sql.exec('DELETE FROM domains WHERE subdomain = ?', sub)
    this.ctx.storage.sql.exec('INSERT INTO domains (subdomain, project_id) VALUES (?, ?)', sub, String(projectId))
    return Response.json({ ok: true, subdomain: sub, projectId })
  }

  /** An address taken from whichever project holds it (a platform admin's removal). */
  private async removeDomain(req: Request): Promise<Response> {
    const { subdomain } = await req.json() as any
    const sub = (subdomain ?? '').toLowerCase().trim()
    this.ctx.storage.sql.exec('DELETE FROM domains WHERE subdomain = ?', sub)
    return Response.json({ ok: true })
  }

  // ── Auth ───────────────────────────────────────────────────────────────────



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
      // Made by the platform (only superadmin creates organisations), so it gives as an owner would: the OrgDO checks that
      // no one gives more than they hold, and a call with no holder was refused — silently, the admin never added.
      const r = await this.env.ORG.get(this.env.ORG.idFromName(id)).fetch(new Request('https://do/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sa-org': id, 'x-sa-actor': JSON.stringify({ kind: 'user', id: 'platform', email: 'platform' }), 'x-sa-caps': JSON.stringify(ORG_ROLES.owner.capabilities) },
        body: JSON.stringify({ email: addr, role: 'admin' }),
      })).catch(() => null)
      if (r?.ok) admin = addr
      else console.error(`[org] ${id}: its first admin ${addr} was not added (${r ? `${r.status} ${await r.text().catch(() => '')}` : 'unreachable'}) — add them from the organisation's page`)
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
}
