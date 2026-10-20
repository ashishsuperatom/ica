// OrgDO — Durable Object per org
//
// Responsibilities:
//   - SQLite: users, projects, datasource configs, conversation logs, the organisation's keys (reference rows)
//   - deciding every request about the organisation (standing; docs/one-door-plan.md)
//
// The DO holds no AI, no tools, no agent logic, and no sockets: every live socket goes through /_ws/<project>.

import { orgConnectors } from './org-connectors.js'
import { seal, unseal } from './proxy/seal.js'
import { OAUTH_PROVIDERS, OAUTH_CALLBACK } from '../../shared/oauth.js'
import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { ORG_MIGRATIONS } from './migrations.js'
import { DurableObject } from 'cloudflare:workers'
import { createRecorder } from './records.js'
import { warehouse, WarehouseRefusal, explore, querySource, tableSource, ExploreRefusal, type Grant } from './warehouse/index.js'
import { AgentKeys, KeyRefusal, ORG_KEYS, type AgentKey } from './agent-keys.js'
import { beyond, builtinRole, capabilitiesOf, checkRole, compare, isCapability, meetsNeed, orgMessageAllowed, orgRouteNeeds, parseCaller, whyNot, ORG_ADMINISTERS_PROJECTS, ORG_ROLES, type Caller, type Capability, type Standing } from '../../shared/permissions.js'
import { SUPERADMIN_EMAILS } from './auth/tokens.js'
import { personHome, personId } from '../../shared/identity.js'
import { ensureSignInAccount } from './auth/clerk-users.js'

export class OrgDO extends DurableObject<Env> {

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
    const res = await this.handle(request)
    // THE GUARD'S COPY (docs/one-door-plan.md, step 3): every answer to a person's request carries the standing decided
    // for it, which their UserDO keeps; and when who may do what here changes, everyone here is told.
    if (res.ok && request.method !== 'GET' && /^\/(users|roles)(\/|$)/.test(new URL(request.url).pathname))
      this.pushStandings(request, [...this.ctx.storage.sql.exec('SELECT email FROM users')].map((r: any) => String(r.email)))
    const decided = this.reqStanding.get(request)
    if (!decided || request.headers.get('upgrade') === 'websocket') return res
    const out = new Response(res.body, res)
    out.headers.set('x-sa-standing', encodeURIComponent(JSON.stringify(decided)))   // any address, as header-safe text
    return out
  }

  /** A key's secret is kept by the person it acts for: its hash, to their UserDO (docs/one-door-plan.md, step 4). */
  private async keepWithPerson(req: Request, email: string, r: { hash: string; record: AgentKey }): Promise<boolean> {
    const user = (this.env as any).USER, org = this.orgName(req)
    const res: Response | null = await user.get(user.idFromName(personHome(org, await personId(email)))).fetch(new Request('http://door/keys', { method: 'PUT',
      body: JSON.stringify({ id: r.record.id, hash: r.hash, email: email.toLowerCase(), scope: { kind: 'org', id: org }, expiresAt: r.record.expires_at }) })).catch(() => null)
    return !!res?.ok
  }
  private tellPersonRevoked(req: Request, k: AgentKey) {
    const user = (this.env as any).USER, org = this.orgName(req)
    this.ctx.waitUntil((async () => {
      await user.get(user.idFromName(personHome(org, await personId(k.created_by)))).fetch(new Request('http://door/keys/revoke', { method: 'POST', body: JSON.stringify({ id: k.id }) }))
    })().catch((e: any) => console.error(`[guard] revoke of ${k.id} not told: ${e?.message ?? e}`)))
  }

  /** Tell each of these people's UserDO where they stand in this organisation now — the guard's copy. Best effort: the
   *  copy also refreshes from every answer, is trusted only while fresh, and only ever refuses early. */
  private pushStandings(req: Request, emails: Iterable<string>) {
    const org = this.orgName(req), user = (this.env as any).USER
    if (!user) return
    for (const email of new Set([...emails].map((e) => e.toLowerCase()).filter((e) => e.includes('@')))) {
      this.ctx.waitUntil((async () => {
        await null   // after the change being made now
        const standing = await this.standing(req, { kind: 'person', email })
        await user.get(user.idFromName(personHome(org, await personId(email)))).fetch(new Request('http://door/door-standing', { method: 'PUT', body: JSON.stringify({ kind: 'org', id: org, standing }) }))
      })().catch((e: any) => console.error(`[guard] ${email}: ${e?.message ?? e}`)))
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url  = new URL(request.url)
    const path = url.pathname

    // A PERSON'S OR A KEY'S REQUEST, passed on with who is asking — never with what they hold: decided HERE, from this
    // organisation's own rows (docs/one-door-plan.md, step 1). Requests without a caller are the platform's own. Giving a
    // project role (/assignments) also hangs on the person's standing in that project, which the Worker asks of it.
    const caller = parseCaller(request.headers.get('x-sa-caller'))
    if (caller) {
      const s = await this.standing(request, caller)
      this.reqStanding.set(request, s)
      if (path === '/standing') return Response.json(s)
      if (!s.ok) return Response.json({ error: s.reason ?? 'not in this organisation' }, { status: 401 })
      const need = orgRouteNeeds(request.method, path)
      if (need === 'internal') return new Response('not found', { status: 404 })
      if (path !== '/assignments' && !meetsNeed(need, s.level, s.caps)) return Response.json({ error: `this needs ${need === 'platform' ? 'the platform' : need}, which your role in this organisation does not hold` }, { status: 403 })
      this.reqStanding.set(request, s)
    }

    // REST API
    if (path === '/warehouse' || path.startsWith('/warehouse/')) return this.warehouse(request, path)
    if (path === '/connectors' || path.startsWith('/connectors/')) return this.connectors(request, path)
    if (path === '/oauth-apps' || path.startsWith('/oauth-apps/')) return this.oauthApps(request, path)
    if (path === '/credits' || path.startsWith('/credits/')) return this.credits(request, path)
    if (path === '/fly' || path.startsWith('/fly/')) return this.fly(request, path)
    if (request.method === 'GET'  && path === '/projects')     return this.getProjects(url)
    if (request.method === 'POST' && path === '/projects')     return this.createProject(request)
    if (request.method === 'DELETE' && path === '/projects')   return this.deleteProject(request)
    if (request.method === 'PUT'  && path === '/projects')     return this.restoreProject(request)
    if (request.method === 'PATCH' && path === '/projects')    return this.renameProject(request)
    if (request.method === 'GET'  && path === '/me')           return this.me(url)
    if (request.method === 'GET'  && path === '/audit')        return Response.json({ events: [...this.ctx.storage.sql.exec('SELECT * FROM org_audit ORDER BY seq DESC LIMIT 200')] })
    if (path === '/roles')                                     return this.roles(request)
    if (path === '/billing')                                   return this.billing(request)
    if (path === '/keys' || path.startsWith('/keys/'))         return this.keys(request, path)
    if (request.method === 'POST' && path === '/agent')        return this.agent(request)
    if (request.method === 'GET'  && path === '/key-alive')    return this.keyAlive(url)
    if (request.method === 'GET'  && path === '/users')        return this.getUsers()
    if (request.method === 'POST' && path === '/users')        return this.createUser(request)
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
    // Each operation is recorded with how long it took (ms), so a slow warehouse shows in its record.
    const started = Date.now()
    const log = (op: string, o: { tbl?: string | null; project?: string | null; rows?: number | null; snapshot?: string | null; ok: boolean; detail?: Record<string, unknown>; by: string }) =>
      this.ctx.storage.sql.exec('INSERT INTO warehouse_ops (at, op, tbl, project, rows, snapshot, ok, detail, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        new Date().toISOString(), op, o.tbl ?? null, o.project ?? null, o.rows ?? null, o.snapshot ?? null, o.ok ? 1 : 0, JSON.stringify({ ...(o.detail ?? {}), ms: Date.now() - started }), o.by)
    const body: any = request.method === 'POST' ? await request.json().catch(() => ({})) : {}
    const by = String(body.by ?? 'platform')
    // Who owns each table and what it is (warehouse_tables, the latest per table); a table made before owners were kept
    // has none until one is set.
    const owners = () => new Map(([...this.ctx.storage.sql.exec('SELECT w.tbl, w.owner, w.description, w.by, w.at FROM warehouse_tables w JOIN (SELECT tbl, MAX(seq) AS m FROM warehouse_tables GROUP BY tbl) x ON x.m = w.seq')] as any[]).map((r) => [String(r.tbl), r]))
    const own = (tbl: string, owner: string, description: string) => this.ctx.storage.sql.exec('INSERT INTO warehouse_tables (tbl, owner, description, by, at) VALUES (?, ?, ?, ?, ?)', tbl, owner, description, by, new Date().toISOString())
    try {
      if (request.method === 'GET' && path === '/warehouse') {
        // The record of what was done; the explorer's reads are kept too, but not listed among the doings.
        const ops = [...this.ctx.storage.sql.exec("SELECT * FROM warehouse_ops WHERE op != 'explore' ORDER BY seq DESC LIMIT 50")]
        const o = owners()
        const tables = bridge.configured ? (await bridge.tables(org)).map((t) => { const w = o.get(t.name); return { ...t, owner: w?.owner ?? null, description: w?.description ?? '' } }) : []
        return json({ configured: bridge.configured, org, tables, ops })
      }
      if (request.method === 'POST' && path === '/warehouse/tables') {
        await ingest.createTable(org, { name: String(body.name ?? ''), columns: Array.isArray(body.columns) ? body.columns : [] })
        own(String(body.name), String(body.owner || by), String(body.description ?? '').slice(0, 2000))
        log('create', { tbl: body.name, ok: true, detail: { columns: body.columns }, by })
        return json({ ok: true, table: body.name }, 201)
      }
      // A table gone with its data — a file loaded again replaces its tables this way (drop, make, append). Its owner record
      // and the projects' grants stay, so the table made again under the same name is theirs as before.
      if (request.method === 'POST' && path === '/warehouse/drop') {
        const tbl = String(body.table ?? '')
        await ingest.dropTable(org, tbl)
        log('drop', { tbl, ok: true, by })
        return json({ ok: true, table: tbl })
      }
      if (request.method === 'POST' && path === '/warehouse/owner') {
        const tbl = String(body.table ?? ''), owner = String(body.owner ?? '').trim()
        if (!(await bridge.describe(org, tbl))) throw new WarehouseRefusal(`there is no table "${tbl}"`)
        if (!owner) throw new WarehouseRefusal('a table has an owner: a person (their email) or a project')
        own(tbl, owner.slice(0, 200), String(body.description ?? '').slice(0, 2000))
        log('owner', { tbl, ok: true, detail: { owner }, by })
        return json({ ok: true, table: tbl, owner, description: String(body.description ?? '') })
      }
      if (request.method === 'POST' && path === '/warehouse/explore') {
        // What may be read: 'all', or a project's grant — the explorer is given only those columns, and every query it
        // makes is checked against the same grant again.
        const grant: Grant | 'all' = body.grant === 'all' ? 'all' : (body.grant && typeof body.grant === 'object' ? body.grant : {})
        const run = (sql: string, limit: number) => bridge.queryAs(org, sql, grant, { limit })
        if (body.query && typeof body.query === 'object') {
          // A query's result, explored like a table: every query the explorer makes over it is checked as a whole.
          const src = await querySource(run, String(body.query.sql ?? ''), Array.isArray(body.query.columns) ? body.query.columns : undefined)
          const out: any = await explore(run, src, body)
          log('explore', { tbl: 'query', project: body.project ?? null, ok: true, detail: { op: body.op }, by })
          return json({ ...out, ...(body.op === 'rows' ? { columns: src.columns, skipped: src.skipped } : {}) })
        }
        const tbl = String(body.table ?? '')
        const info = await bridge.describe(org, tbl)
        if (!info || (grant !== 'all' && !(tbl in grant))) throw new WarehouseRefusal(`there is no table "${tbl}" you may read`)
        const allowed = grant === 'all' || grant[tbl] === null ? info.columns : info.columns.filter((c) => (grant[tbl] as string[]).includes(c.name))
        const out = await explore(run, tableSource({ ...info, columns: allowed }), body)
        log('explore', { tbl, project: body.project ?? null, ok: true, detail: { op: body.op }, by })
        return json(out)
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
      const refused = e instanceof WarehouseRefusal || e instanceof ExploreRefusal
      log(path.split('/').pop() ?? 'op', { tbl: body.table ?? body.name ?? null, project: body.project ?? null, ok: false, detail: { error: String(e?.message ?? e).slice(0, 500), ...(body.sql ? { sql: String(body.sql).slice(0, 2000) } : {}) }, by })
      return json({ error: e?.message ?? String(e) }, refused ? 400 : 502)
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
    return Response.json({ id }, { status: 201 })
  }

  private async deleteProject(req: Request): Promise<Response> {
    try {
      const body = await req.json() as any
      const id = body?.id
      if (!id) return Response.json({ error: 'missing id' }, { status: 400 })
      // Soft-delete — infrastructure stop is handled by the Worker
      this.ctx.storage.sql.exec('UPDATE projects SET deleted = 1 WHERE id = ?', id)
      return Response.json({ ok: true })
    } catch (err: any) {
      return Response.json({ error: `delete failed: ${err.message}` }, { status: 500 })
    }
  }

  /** A project renamed: the organisation's list and the project's own record (what its app shows) both change. */
  private async renameProject(req: Request): Promise<Response> {
    const body = await req.json().catch(() => ({})) as any
    const id = String(body?.id ?? ''), name = String(body?.name ?? '').trim()
    if (!id) return Response.json({ error: 'missing id' }, { status: 400 })
    if (!name || name.length > 80) return Response.json({ error: 'a project name is 1–80 characters' }, { status: 400 })
    const [row] = [...this.ctx.storage.sql.exec('SELECT id FROM projects WHERE id = ? AND deleted = 0', id)]
    if (!row) return Response.json({ error: 'there is no such project in this organisation' }, { status: 404 })
    this.ctx.storage.sql.exec('UPDATE projects SET name = ? WHERE id = ?', name, id)
    await this.env.PROJECT.get(this.env.PROJECT.idFromName(`proj:${id}`)).fetch(new Request('http://do/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }))
    return Response.json({ ok: true, id, name })
  }

  private async restoreProject(req: Request): Promise<Response> {
    try {
      const body = await req.json() as any
      const id = body?.id
      if (!id) return Response.json({ error: 'missing id' }, { status: 400 })
      this.ctx.storage.sql.exec('UPDATE projects SET deleted = 0 WHERE id = ?', id)
      return Response.json({ ok: true })
    } catch (err: any) {
      return Response.json({ error: `restore failed: ${err.message}` }, { status: 500 })
    }
  }

  // ── Auth ───────────────────────────────────────────────────────────────────



  // ── Users ───────────────────────────────────────────────────────────────────

  private getUsers(): Response {
    const rows = [...this.ctx.storage.sql.exec('SELECT id, email, name, role, created_at FROM users ORDER BY email')] as any[]
    return Response.json(rows.map((r) => ({ ...r, capabilities: this.roleCaps(r.role) })))
  }

  // ── Who may do what in this organisation (shared/permissions.ts) ─────────────────────────────────────────────────
  /** What an organisation role holds: a built-in one the code's, a custom one as the owners defined it. */
  private roleCaps(roleId: string | null | undefined): Capability[] {
    if (!roleId) return []
    const b = builtinRole('org', roleId)
    if (b) return b.capabilities
    const [r] = [...this.ctx.storage.sql.exec('SELECT capabilities FROM org_roles WHERE id = ?', roleId)] as any[]
    try { return r ? (JSON.parse(String(r.capabilities)) as unknown[]).filter((c): c is Capability => isCapability('org', c) && c !== 'org.roles') : [] } catch { return [] }
  }
  private roleExists(id: string) { return !!builtinRole('org', id) || [...this.ctx.storage.sql.exec('SELECT 1 FROM org_roles WHERE id = ?', id)].length > 0 }
  /** What a person holds here now (the platform's superadmin everything). */
  private capsOfEmail(email: string | null | undefined): { role: string | null; capabilities: Capability[] } {
    const e = String(email ?? '').toLowerCase()
    if (e && SUPERADMIN_EMAILS.includes(e)) return { role: 'superadmin', capabilities: [...ORG_ROLES.owner.capabilities] }
    const [u] = e ? [...this.ctx.storage.sql.exec('SELECT role FROM users WHERE email = ?', e)] as any[] : []
    return u ? { role: String(u.role), capabilities: this.roleCaps(u.role) } : { role: null, capabilities: [] }
  }
  private me(url: URL): Response {
    const r = this.capsOfEmail(url.searchParams.get('email'))
    return Response.json({ member: r.role !== null, ...r })
  }
  /** The caller of a request, as decided at its gate (fetch): their address and what they hold here; nobody for the
   *  platform's own calls — those name who they act for in their body (by), where they do. */
  private reqStanding = new WeakMap<Request, Standing>()
  private callerOf(req: Request): { email: string; caps: Capability[] } {
    const s = this.reqStanding.get(req)
    return { email: String(s?.email ?? '').toLowerCase(), caps: s?.caps ?? [] }
  }

  /** WHERE A CALLER STANDS HERE — the one decision for the organisation: the platform's admin every organisation
   *  capability; a person on the list their role's; a key of this organisation what it was given, cut to its maker now. */
  async standing(req: Request, c: Caller): Promise<Standing> {
    const none = (reason: string): Standing => ({ ok: false, level: 'none', email: '', caps: [], reason })
    if (c.kind === 'person') {
      const email = c.email.toLowerCase()
      if (SUPERADMIN_EMAILS.includes(email)) return { ok: true, level: 'superadmin', email, roleId: 'superadmin', caps: [...capabilitiesOf('org')] }
      const r = this.capsOfEmail(email)
      if (r.role === null) return none('not in this organisation')
      return { ok: true, level: r.role === 'owner' || r.role === 'admin' ? 'org-admin' : 'member', email, roleId: r.role, caps: r.capabilities }
    }
    if (c.kind === 'agent') {
      // A key its person's UserDO checked: this organisation's row for it decides.
      const k = this.orgKeys(req).get(c.keyId)
      if (!k) return none('not a key of this organisation')
      if (k.created_by.toLowerCase() !== c.email) return none('the key acts for someone else')
      if (k.revoked_at || (k.expires_at && Date.parse(k.expires_at) <= Date.now())) return none(k.revoked_at ? 'the key was revoked' : 'the key has expired')
      const held = this.keyHolds(req, k)
      if (!held.length) return none(k.made_by_key ? 'the key that made it is no longer in force' : 'its person holds nothing here now')
      this.orgKeys(req).used(k)
      return { ok: true, level: 'key', email: k.created_by, caps: held, key: k.id }
    }
    // A key's secret is never seen here: it is checked at its person's door, which says which key and whose (above).
    return none('a key is checked at the door of the person it acts for')
  }
  /** May the caller act on someone holding `theirs` (null), or why not — the hierarchy (shared/permissions.ts): only on
   *  those they are above; equals and those apart leave each other alone. The platform's superadmin is above everyone. */
  private whyNotOn(caller: { email: string; caps: Capability[] }, theirs: readonly string[], what: string): string | null {
    if (SUPERADMIN_EMAILS.includes(caller.email)) return null
    return whyNot(caller.caps, theirs, what)
  }
  /** May the caller give this role: one below their own — or, holding org.roles ("make owners"), the owner's. */
  private whyNotGive(caller: { email: string; caps: Capability[] }, roleId: string): string | null {
    if (SUPERADMIN_EMAILS.includes(caller.email)) return null
    if (roleId === 'owner' && caller.caps.includes('org.roles')) return null
    return compare(caller.caps, this.roleCaps(roleId)) === 'above' ? null : `you give only a role below your own — someone above ${roleId === 'admin' ? 'an admin (an owner)' : 'you'} gives "${roleId}"`
  }
  private owners(): number { return Number(([...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'")][0] as any)?.n ?? 0) }

  /** Give a person a role here (adding them if new). No one gives more than they hold — nor changes someone who holds
   *  more than they do; only owners make owners; the organisation keeps an owner. */
  private async createUser(req: Request): Promise<Response> {
    const { email, name, role } = await req.json() as any
    const addr = String(email ?? '').trim().toLowerCase()
    if (!addr || !/^[^\s@]+@[^\s@]+$/.test(addr)) return Response.json({ error: 'an email address is required' }, { status: 400 })
    const caller = this.callerOf(req)
    const roleId = role ? String(role) : null
    if (roleId && !this.roleExists(roleId)) return Response.json({ error: `there is no role "${roleId}"` }, { status: 400 })
    const [existing] = [...this.ctx.storage.sql.exec('SELECT id, role FROM users WHERE email = ?', addr)] as any[]
    const target = roleId ?? (existing ? String(existing.role) : 'member')
    const over = beyond(this.roleCaps(target), caller.caps)
    if (over.length && !SUPERADMIN_EMAILS.includes(caller.email)) return Response.json({ error: `you cannot give what you do not hold: ${over.join(', ')}` }, { status: 403 })
    if (existing) {
      if (!roleId || roleId === existing.role) return Response.json({ id: existing.id, existed: true })
      // one's own role, stepped down (never up); anyone else's only when above them, and only to a role below one's own
      const self = caller.email === addr
      const no = self ? (compare(caller.caps, this.roleCaps(roleId)) === 'above' ? null : 'you step down, never up') : this.whyNotOn(caller, this.roleCaps(existing.role), `${addr}'s role`) ?? this.whyNotGive(caller, roleId)
      if (no) return Response.json({ error: no }, { status: 403 })
      if (existing.role === 'owner' && this.owners() <= 1) return Response.json({ error: 'the organisation must keep an owner — make another owner first' }, { status: 400 })
      this.ctx.storage.sql.exec('UPDATE users SET role = ? WHERE id = ?', roleId, existing.id)
      this.record('person.role', addr, caller.email, { from: existing.role, to: roleId })
      await this.syncOrgAdminsToProjects()   // promoted or demoted → every project's mirror follows
      return Response.json({ id: existing.id, existed: true, role: roleId })
    }
    const giveNo = this.whyNotGive(caller, target)
    if (giveNo) return Response.json({ error: giveNo }, { status: 403 })
    const id = crypto.randomUUID()
    this.ctx.storage.sql.exec('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)', id, addr, name ?? '', target)
    this.record('person.add', addr, caller.email, { role: target })
    if ((ORG_ADMINISTERS_PROJECTS as readonly string[]).includes(target)) await this.syncOrgAdminsToProjects()
    // Their sign-in account, made now: no one signs up on their own (auth/clerk-users.ts).
    const account = await ensureSignInAccount(addr, (this.env as any).CLERK_SECRET_KEY)
    if (typeof account === 'object') console.error(`[people] ${addr}: added, but no sign-in account — ${account.problem}`)
    return Response.json({ id, role: target, signIn: typeof account === 'object' ? 'not ready' : 'ready' }, { status: 201 })
  }

  // Removing someone from the ORG removes them from every project in it — otherwise a revoked person keeps
  // project access through the copy the project holds.
  private async deleteUser(req: Request): Promise<Response> {
    const { email } = await req.json() as any
    const addr = String(email ?? '').trim().toLowerCase()
    if (!addr) return Response.json({ error: 'email required' }, { status: 400 })
    const caller = this.callerOf(req)
    const [u] = [...this.ctx.storage.sql.exec('SELECT role FROM users WHERE email = ?', addr)] as any[]
    if (!u) return Response.json({ error: `${addr} is not in this organisation` }, { status: 404 })
    // leaving is one's own; removing anyone else needs being above them
    const no = caller.email === addr ? null : this.whyNotOn(caller, this.roleCaps(u.role), `removing ${addr}`)
    if (no) return Response.json({ error: no }, { status: 403 })
    if (u.role === 'owner' && this.owners() <= 1) return Response.json({ error: 'the organisation must keep an owner — make another owner first' }, { status: 400 })
    const projects = [...this.ctx.storage.sql.exec('SELECT id FROM projects WHERE deleted = 0')] as any[]
    for (const p of projects) await this.projectAccess(p.id, 'DELETE', { email: addr })
    this.ctx.storage.sql.exec('DELETE FROM users WHERE email = ?', addr)
    this.pushStandings(req, [addr])   // no longer here: their guard learns it now
    this.record('person.remove', addr, caller.email, { role: u.role })
    await this.syncOrgAdminsToProjects()   // if they were an admin, drop the mirrored rows too
    return Response.json({ ok: true, email: addr, removedFromProjects: projects.length })
  }

  /** The organisation's roles: built-in and the owners' own. Defining one is an owner's (org.roles). */
  private async roles(req: Request): Promise<Response> {
    const sql = this.ctx.storage.sql
    if (req.method === 'GET') {
      const custom = ([...sql.exec('SELECT id, name FROM org_roles ORDER BY name')] as any[]).map((r) => ({ id: r.id, name: r.name, capabilities: this.roleCaps(r.id), builtin: false }))
      return Response.json({ roles: [...Object.values(ORG_ROLES), ...custom] })
    }
    const b = await req.json().catch(() => ({})) as any
    const caller = this.callerOf(req)
    if (req.method === 'POST') {
      const { role, problems } = checkRole('org', b)
      if (!role) return Response.json({ error: problems.join('; ') }, { status: 400 })
      sql.exec('INSERT INTO org_roles (id, name, capabilities, by, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, capabilities = excluded.capabilities, by = excluded.by, at = excluded.at',
        role.id, role.name, JSON.stringify(role.capabilities), caller.email, new Date().toISOString())
      this.record('role.set', role.id, caller.email, { name: role.name, capabilities: role.capabilities })
      return Response.json({ role }, { status: 201 })
    }
    if (req.method === 'DELETE') {
      const id = String(b.id ?? '')
      if (builtinRole('org', id)) return Response.json({ error: 'built-in roles cannot be removed' }, { status: 400 })
      const n = Number(([...sql.exec('SELECT COUNT(*) AS n FROM users WHERE role = ?', id)][0] as any)?.n ?? 0)
      if (n) return Response.json({ error: `${n} ${n === 1 ? 'person holds' : 'people hold'} this role — give them another first` }, { status: 400 })
      sql.exec('DELETE FROM org_roles WHERE id = ?', id)
      this.record('role.remove', id, caller.email, {})
      return Response.json({ ok: true })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  }

  /** Who the organisation is billed as. Card details are never kept here (the payment provider holds them). */
  private async billing(req: Request): Promise<Response> {
    const sql = this.ctx.storage.sql
    const latest = () => { const [r] = [...sql.exec('SELECT details, by, at FROM billing_details ORDER BY seq DESC LIMIT 1')] as any[]; return r ? { details: JSON.parse(String(r.details)), by: r.by, at: r.at } : { details: null } }
    if (req.method === 'GET') return Response.json(latest())
    if (req.method !== 'PUT') return Response.json({ error: 'use GET or PUT' }, { status: 405 })
    const b = await req.json().catch(() => ({})) as any
    const FIELDS = ['name', 'email', 'line1', 'line2', 'city', 'region', 'postcode', 'country', 'taxId'] as const
    const details: Record<string, string> = {}
    for (const f of FIELDS) { const v = String(b?.[f] ?? '').trim(); if (v.length > 200) return Response.json({ error: `${f} is at most 200 characters` }, { status: 400 }); if (v) details[f] = v }
    if (!details.name) return Response.json({ error: 'the name the organisation is billed as is required' }, { status: 400 })
    if (!details.email || !/^[^\s@]+@[^\s@]+$/.test(details.email)) return Response.json({ error: 'a billing email address is required' }, { status: 400 })
    if (!details.line1 || !details.city || !details.country) return Response.json({ error: 'an address needs its first line, a city and a country' }, { status: 400 })
    const caller = this.callerOf(req)
    sql.exec('INSERT INTO billing_details (details, by, at) VALUES (?, ?, ?)', JSON.stringify(details), caller.email || 'platform', new Date().toISOString())
    this.record('billing.details', 'billing', caller.email, { fields: Object.keys(details) })
    return Response.json(latest())
  }

  // ── Engines on Fly: the platform's decision for this organisation (docs/deploying-the-engine.md, "On Fly") ──────────
  // A machine on Fly costs money, so whether this organisation's engines may run there, how many at most, and whether a
  // new project gets one when it is made are set by the platform's administrators only (the Worker lets nobody else PUT).
  // A project placing its engine there claims one of the organisation's machines first; taking it off gives it back.
  private async fly(request: Request, path: string): Promise<Response> {
    type Allowance = { allowed: boolean; machines: number; onCreate: boolean; setBy: string | null; setAt: string | null }
    const allowance = async (): Promise<Allowance> => (await this.ctx.storage.get<Allowance>('flyAllowance')) ?? { allowed: false, machines: 0, onCreate: false, setBy: null, setAt: null }
    const claims = async (): Promise<string[]> => (await this.ctx.storage.get<string[]>('flyClaims')) ?? []
    const b = request.method === 'GET' ? null : await request.json().catch(() => ({})) as any
    if (request.method === 'GET' && path === '/fly') { const c = await claims(); return Response.json({ ...(await allowance()), used: c.length, projects: c }) }
    if (request.method === 'PUT' && path === '/fly') {
      const machines = Number(b?.machines ?? 0)
      if (!Number.isInteger(machines) || machines < 0 || machines > 100) return Response.json({ error: 'machines is a whole number from 0 to 100' }, { status: 400 })
      let by = 'platform'; try { by = JSON.parse(request.headers.get('x-sa-actor') ?? 'null')?.email ?? by } catch { /* the platform */ }
      const next: Allowance = { allowed: b?.allowed === true, machines, onCreate: b?.allowed === true && b?.onCreate === true, setBy: by, setAt: new Date().toISOString() }
      await this.ctx.storage.put('flyAllowance', next)
      this.record('fly.allowance', 'fly', by, { allowed: next.allowed, machines, onCreate: next.onCreate })
      const c = await claims()
      return Response.json({ ...next, used: c.length, projects: c })
    }
    const project = typeof b?.project === 'string' ? b.project : ''
    if (!project) return Response.json({ error: 'which project?' }, { status: 400 })
    if (request.method === 'POST' && path === '/fly/claim') {
      const a = await allowance(), c = await claims()
      if (c.includes(project)) return Response.json({ ok: true })
      if (!a.allowed) return Response.json({ error: 'this organisation\'s engines may not run on Fly — the platform\'s administrators decide that' }, { status: 403 })
      if (c.length >= a.machines) return Response.json({ error: `this organisation may run ${a.machines} engine${a.machines === 1 ? '' : 's'} on Fly, and all are in use — the platform's administrators can allow more` }, { status: 409 })
      await this.ctx.storage.put('flyClaims', [...c, project])
      this.record('fly.claim', project, 'platform', {})
      return Response.json({ ok: true })
    }
    if (request.method === 'POST' && path === '/fly/release') {
      await this.ctx.storage.put('flyClaims', (await claims()).filter((x) => x !== project))
      this.record('fly.release', project, 'platform', {})
      return Response.json({ ok: true })
    }
    return new Response('not found', { status: 404 })
  }

  /** The organisation's connectors (org-connectors.ts): listed for its projects; published from a project (internal — the
   *  worker never forwards /connectors/publish); blocked, approved and the approval setting by an organisation admin
   *  (org.connectors, checked by the worker). */
  private _connectors?: ReturnType<typeof orgConnectors>
  private async connectors(request: Request, path: string): Promise<Response> {
    const reg = (this._connectors ??= orgConnectors(this.ctx.storage.sql, (op, target, by, detail) => this.record(op, target, by, detail)))
    // A change reaches every project at once: each reads the registry again and tells its engine (a block stops its
    // connections now, not at the next read).
    const told = async () => {
      const ids = ([...this.ctx.storage.sql.exec('SELECT id FROM projects WHERE deleted = 0')] as any[]).map((p) => String(p.id))
      await Promise.all(ids.map((p) => this.env.PROJECT.get(this.env.PROJECT.idFromName(`proj:${p}`)).fetch(new Request('http://do/org-connectors/changed', { method: 'POST', headers: { 'x-sa-project': p } })).catch(() => null)))
    }
    const answer = async (r: { ok: boolean; error?: string } & Record<string, unknown>) => { if (r.ok && !(r as any).already) await told(); return Response.json(r, { status: r.ok ? 200 : 400 }) }
    if (request.method === 'GET' && path === '/connectors') return Response.json({ connectors: reg.list(), approval: reg.approvalRequired() })
    // Where each runs: every project's connections on a connector, and the version each is pinned to — asked of each
    // project now (its own record), so a block is decided knowing what it stops.
    if (request.method === 'GET' && path === '/connectors/usage') {
      const projects = ([...this.ctx.storage.sql.exec('SELECT id, name FROM projects WHERE deleted = 0 ORDER BY name')] as any[])
      const usage = await Promise.all(projects.map(async (p) => {
        const r: any = await this.env.PROJECT.get(this.env.PROJECT.idFromName(`proj:${p.id}`)).fetch(new Request('http://do/org-connectors/usage', { headers: { 'x-sa-project': String(p.id) } })).then((x) => x.json()).catch(() => null)
        return { project: String(p.id), name: String(p.name ?? p.id), ...(r ? { connections: r.connections ?? [] } : { connections: [], unreachable: true }) }
      }))
      return Response.json({ usage })
    }
    const b: any = await request.json().catch(() => ({}))
    const by = String(b.by ?? 'platform')
    if (request.method === 'POST' && path === '/connectors/publish') return answer(reg.publish({ manifest: b.manifest ?? {}, hash: String(b.hash ?? ''), bytes: Number(b.bytes) || 0, by, project: String(b.project ?? '') }))
    if (request.method === 'POST' && path === '/connectors/block') return answer(reg.block({ id: String(b.id ?? ''), hash: b.hash ? String(b.hash) : undefined, by, unblock: b.unblock === true }))
    if (request.method === 'POST' && path === '/connectors/approve') return answer(reg.approve({ id: String(b.id ?? ''), hash: String(b.hash ?? ''), by }))
    if (request.method === 'PUT' && path === '/connectors/settings') { reg.setApproval(b.approval === true, by); return answer({ ok: true, approval: reg.approvalRequired() }) }
    return Response.json({ error: 'not found' }, { status: 404 })
  }

  /** The organisation's apps with OAuth providers (docs/connectors-plan.md R6): listed for anyone in it (never a secret);
   *  set and removed by an organisation admin (org.connectors, checked by the worker — who did it is the caller); the
   *  client with its secret only for the platform itself (internal: the project that runs a sign-in). */
  private async oauthApps(request: Request, path: string): Promise<Response> {
    const sql = this.ctx.storage.sql
    const master = (this.env as any).CREDENTIALS_MASTER_KEY as string | undefined
    if (request.method === 'GET' && path === '/oauth-apps')
      return Response.json({ apps: [...sql.exec('SELECT provider, client_id, added_by, added_at FROM org_oauth_apps ORDER BY provider')], providers: Object.values(OAUTH_PROVIDERS).map((p) => ({ id: p.id, title: p.title, console: p.console })), callback: OAUTH_CALLBACK })
    const m = path.match(/^\/oauth-apps\/([a-z0-9-]+)(\/client)?$/)
    if (!m) return Response.json({ error: 'not found' }, { status: 404 })
    const provider = m[1]
    if (!OAUTH_PROVIDERS[provider]) return Response.json({ error: `there is no provider ${provider} (${Object.keys(OAUTH_PROVIDERS).join(', ')})` }, { status: 404 })
    if (m[2]) {   // internal: the client, its secret unsealed
      const [r] = [...sql.exec('SELECT client_id, secret_sealed FROM org_oauth_apps WHERE provider = ?', provider)] as any[]
      if (!r) return Response.json({ error: `this organisation has no ${OAUTH_PROVIDERS[provider].title} app — an organisation admin adds it (Organisation → Connectors → Sign-in apps)` }, { status: 404 })
      if (!master) return Response.json({ error: 'the platform has no master key' }, { status: 503 })
      return Response.json({ clientId: r.client_id, clientSecret: await unseal(r.secret_sealed, master) })
    }
    const b: any = await request.json().catch(() => ({}))
    const by = String(b.by ?? 'platform')
    if (request.method === 'DELETE') {
      sql.exec('DELETE FROM org_oauth_apps WHERE provider = ?', provider)
      this.record('oauth-app.remove', provider, by, {})
      return Response.json({ ok: true })
    }
    if (request.method !== 'PUT') return Response.json({ error: 'PUT { clientId, clientSecret }, or DELETE' }, { status: 405 })
    const clientId = String(b.clientId ?? '').trim(), clientSecret = String(b.clientSecret ?? '').trim()
    if (!clientId || clientId.length > 300) return Response.json({ error: 'its client id' }, { status: 400 })
    const [had] = [...sql.exec('SELECT secret_sealed FROM org_oauth_apps WHERE provider = ?', provider)] as any[]
    if (!clientSecret && !had) return Response.json({ error: 'its client secret' }, { status: 400 })
    if (clientSecret.length > 500) return Response.json({ error: 'a client secret is at most 500 characters' }, { status: 400 })
    if (!master) return Response.json({ error: 'secrets cannot be kept: the platform has no master key' }, { status: 503 })
    const sealed = clientSecret ? await seal(clientSecret, master) : had.secret_sealed   // a secret left out keeps the one kept
    sql.exec('INSERT INTO org_oauth_apps (provider, client_id, secret_sealed, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider) DO UPDATE SET client_id = excluded.client_id, secret_sealed = excluded.secret_sealed, added_by = excluded.added_by, added_at = excluded.added_at',
      provider, clientId, sealed, by, new Date().toISOString())
    this.record('oauth-app.set', provider, by, { clientId, secretChanged: !!clientSecret })   // never the secret
    return Response.json({ ok: true })
  }

  /** May the caller revoke this key (null), or why not: their own; one whose maker now holds nothing here; one made by
   *  someone they are above. Equals leave each other's keys alone. */
  private whyNotRevoke(caller: { email: string; caps: Capability[] }, k: { name: string; created_by: string } | null): string | null {
    if (!k || caller.email === k.created_by.toLowerCase()) return null
    const maker = this.capsOfEmail(k.created_by).capabilities
    return maker.length ? this.whyNotOn(caller, maker, `"${k.name}" was made by ${k.created_by}`) : null
  }

  /** Who changed who may do what here (org_audit, append-only). */
  private record(op: string, target: string, by: string, detail: unknown) {
    this.ctx.storage.sql.exec('INSERT INTO org_audit (at, op, target, by, detail) VALUES (?, ?, ?, ?, ?)', new Date().toISOString(), op, target, by || 'platform', JSON.stringify(detail))
  }

  // ── Organisation keys (sak_org_<org>_…): an agent working for the organisation, as its maker, cut to what they hold ──
  private orgName(req: Request) { return req.headers.get('x-sa-org') ?? this.ctx.id.name ?? 'default' }
  private orgKeys(req: Request) { const org = this.orgName(req); return new AgentKeys(this.ctx.storage.sql as any, () => org, ORG_KEYS) }
  private async keys(req: Request, path: string): Promise<Response> {
    const caller = this.callerOf(req)
    const keys = this.orgKeys(req)
    try {
      // Whether the caller may revoke a key, or why not — one answer for the list and the revoke: a key reaches only the
      // keys below it; and a person (or the person a key acts for) only those made by someone they are above.
      const whyNotKey = (id: string) => !keys.reaches(req.headers.get('x-sa-key'), id) ? 'a key revokes only the keys below it' : this.whyNotRevoke(caller, keys.get(id))
      if (req.method === 'GET' && path === '/keys') return Response.json({ keys: keys.list().map((k) => { const no = whyNotKey(k.id); return { ...k, mayRevoke: !no, ...(no ? { whyNot: no } : {}) } }) })
      const b = await req.json().catch(() => ({})) as any
      if (req.method === 'POST' && path === '/keys') {
        if (!caller.email) return Response.json({ error: 'who is creating the key?' }, { status: 400 })
        // A key holds at most what its maker holds here now (a person, or a key — what the caller holds, decided at the gate).
        const over = beyond(Array.isArray(b.capabilities) ? b.capabilities.map(String) : [], caller.caps)
        if (over.length) return Response.json({ error: `a key cannot be given what its maker does not hold: ${over.join(', ')}` }, { status: 403 })
        const r = await keys.create({ name: b.name, capabilities: b.capabilities, by: caller.email, person: await personId(caller.email).catch(() => { throw new KeyRefusal('a key acts for a person, named by their address') }), madeByKey: req.headers.get('x-sa-key'), expiresAt: b.expiresAt ?? null })
        if (!(await this.keepWithPerson(req, caller.email, r))) { keys.revoke(r.record.id, 'platform'); return Response.json({ error: 'the key could not be kept with its person — try again' }, { status: 502 }) }
        this.record('key.create', r.record.id, caller.email, { name: r.record.name, capabilities: r.record.capabilities, made_by_key: r.record.made_by_key })
        return Response.json({ key: r.key, record: r.record }, { status: 201 })
      }
      const m = path.match(/^\/keys\/([\w-]+)$/)
      if (m && req.method === 'DELETE') {
        const no = whyNotKey(m[1])
        if (no) return Response.json({ error: no }, { status: 403 })
        const k = keys.revoke(m[1], caller.email || 'admin')
        this.tellPersonRevoked(req, k)
        this.record('key.revoke', k.id, caller.email, { name: k.name })
        return Response.json({ key: k })
      }
      return Response.json({ error: 'not found' }, { status: 404 })
    } catch (e: any) {
      if (e instanceof KeyRefusal) return Response.json({ error: e.message }, { status: 400 })
      throw e
    }
  }

  /** What an organisation key holds now: what it was given, cut to its maker (a person here, or the key that made it). */
  private keyHolds(req: Request, k: AgentKey): Capability[] { return this.orgKeys(req).holds(k, (who) => this.capsOfEmail(who).capabilities) }

  /** For a project: is the organisation key that made one of its keys still in force (it, and the keys that made it)? */
  private keyAlive(url: URL): Response {
    const keys = new AgentKeys(this.ctx.storage.sql as any, () => this.ctx.id.name ?? 'default', ORG_KEYS)
    const k = keys.get(String(url.searchParams.get('id') ?? ''))
    const alive = !!k && keys.live(k) && (!k.made_by_key || keys.holds(k, (who) => this.capsOfEmail(who).capabilities).length > 0)
    return Response.json({ alive })
  }

  /** One call from an organisation key: verified, cut to what its maker holds now, then done as any. */
  private async agent(req: Request): Promise<Response> {
    // A key its person's UserDO checked, decided at the gate.
    const decided = this.reqStanding.get(req)
    const k = decided?.ok && decided.level === 'key' && decided.key ? this.orgKeys(req).get(decided.key) : null
    if (!decided || !k) return Response.json({ error: `the key was refused: ${decided?.reason ?? 'a key comes through the door of the person it acts for'}` }, { status: 401 })
    const v = { key: k }
    const held = decided.caps
    const b = await req.json().catch(() => ({})) as any
    const t = String(b.t ?? '')
    if (!orgMessageAllowed(held, t)) return Response.json({ error: `this key may not ${t || 'do that'} (it holds ${held.join(', ') || 'nothing'}; cut to what its maker holds now)` }, { status: 403 })
    const by = `key:${v.key.name} (${v.key.created_by})`
    const org = this.orgName(req)
    const headers = { 'content-type': 'application/json', 'x-sa-org': org }
    const call = (path: string, body?: unknown) => this.warehouse(new Request(`http://do${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify({ ...(body as object), by }) }), path)
    if (t === 'warehouse:tables') return call('/warehouse')
    if (t === 'warehouse:query') return call('/warehouse/query', { sql: b.sql, limit: b.limit, grant: 'all' })
    if (t === 'warehouse:explore') { const { t: _t, reqId: _r, ...req } = b; return call('/warehouse/explore', { ...req, grant: 'all' }) }
    if (t === 'warehouse:append') return call('/warehouse/append', { table: b.table, rows: b.rows })
    if (t === 'warehouse:create') return call('/warehouse/tables', { name: b.name, columns: b.columns, ...(b.description ? { description: b.description } : {}) })
    if (t === 'warehouse:drop') return call('/warehouse/drop', { table: b.table })
    // A project's grant: the project must be this organisation's.
    const project = String(b.project ?? '')
    if (![...this.ctx.storage.sql.exec('SELECT 1 FROM projects WHERE id = ? AND deleted = 0', project)].length) return Response.json({ error: 'that project is not in this organisation' }, { status: 404 })
    const stub = this.env.PROJECT.get(this.env.PROJECT.idFromName(`proj:${project}`))
    const ph = { 'content-type': 'application/json', 'x-sa-project': project }
    if (t === 'warehouse:grants') return stub.fetch(new Request('http://do/warehouse/grants', { headers: ph }))
    return stub.fetch(new Request('http://do/warehouse/grants', { method: t === 'warehouse:revoke' ? 'DELETE' : 'POST', headers: ph, body: JSON.stringify({ table: b.table, columns: b.columns ?? null, write: b.write === true, by }) }))
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
    const admins = [...this.ctx.storage.sql.exec(`SELECT email FROM users WHERE role IN (${ORG_ADMINISTERS_PROJECTS.map((r) => `'${r}'`).join(', ')})`)] as any[]
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
    if (!this.ownProject(projectId)) return Response.json({ error: 'that project is not in this organisation' }, { status: 404 })
    return Response.json(await this.projectAccess(projectId, 'GET'))
  }

  /** Is this one of this organisation's projects (not removed)? Nothing here ever reaches into another's. */
  private ownProject(id: string): boolean { return [...this.ctx.storage.sql.exec('SELECT 1 FROM projects WHERE id = ? AND deleted = 0', String(id))].length > 0 }

  private async assign(req: Request): Promise<Response> {
    const { projectId, email, roleId } = await req.json() as any
    const addr = String(email ?? '').trim().toLowerCase()
    if (!projectId || !addr) return Response.json({ error: 'projectId and email required' }, { status: 400 })
    if (!this.ownProject(projectId)) return Response.json({ error: 'that project is not in this organisation' }, { status: 404 })
    // Only someone already in the org can be assigned — a project cannot invent its own users.
    const [u] = [...this.ctx.storage.sql.exec('SELECT id FROM users WHERE email = ?', addr)]
    if (!u) return Response.json({ error: 'no such user in this organisation — add them to the org first' }, { status: 400 })
    return Response.json(await this.projectAccess(projectId, 'POST', { email: addr, roleId: roleId ?? 'member' }))
  }

  private async unassign(req: Request): Promise<Response> {
    const { projectId, email } = await req.json() as any
    const addr = String(email ?? '').trim().toLowerCase()
    if (!projectId || !addr) return Response.json({ error: 'projectId and email required' }, { status: 400 })
    if (!this.ownProject(projectId)) return Response.json({ error: 'that project is not in this organisation' }, { status: 404 })
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