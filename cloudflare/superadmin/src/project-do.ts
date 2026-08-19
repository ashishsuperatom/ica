// ProjectDO — Durable Object per project
//
// Responsibilities:
//   - SQLite: fly_machine reference, api key, members, datasources, conversations
//   - WebSocket hub: role registry, message relay with stamped `from`, per-role routing
//
// Every connection authenticates via `hello`:
//   - server-side (code-engine, adapters): { type: "hello", key: "sk-proj-...", role: "..." }
//   - browser (runtime):                 { type: "hello", token: "<our-jwt>", role: "runtime" }
//
// Auth flow:
//   1. User logs in via Clerk (SSO, email, MFA, etc.) in the React SPA
//   2. React SPA sends Clerk session → Worker POST /api/auth/token → validates with Clerk
//   3. Worker returns our own JWT (signed with HMAC-SHA256, carries userId, orgId, role)
//   4. All subsequent WS and API calls use our JWT — Clerk is out of the picture
//
// The DO ALWAYS stamps `from` on every relayed message — clients never set it.
// Clients send `to` (optional; absent = broadcast); the DO resolves `to.type` via role registry.

import { DurableObject } from 'cloudflare:workers'
import { suspendMachine, stopMachine as flyStopMachine, startMachine as flyStartMachine, getMachineStatus } from './fly.js'

const FLY_APP = 'superatom-code-engine-vm'
const SUSPEND_AFTER_MS = 30 * 60 * 1000   // 30 min idle (no real activity) → suspend
const STOP_AFTER_MS    = 60 * 60 * 1000   // 60 min idle → stop (release the RAM snapshot)

// ── Types ──────────────────────────────────────────────────────────────────────

interface ConnInfo {
  wsId: string
  type: string       // "code-engine" | "runtime" | "fast-router" | "admin"
  userId?: string    // only for user connections
  orgRole?: string   // "admin" | "member" — from JWT, used for persona enforcement
  instanceId?: string // singleton identity: which process this connection belongs to (stable per boot)
  epoch?: number     // singleton generation: the process boot time — a NEWER process has a higher epoch
}

interface Envelope {
  to?: { id: string; type: string }
  from: { id: string; type: string }
  payload: unknown
}

interface JwtClaims {
  userId: string
  orgId: string
  role: string       // "admin" | "member"
  exp: number
}

// ── JWT verification (our own token, HMAC-SHA256) ─────────────────────────────

function base64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
  return Uint8Array.from(atob(b64 + pad), c => c.charCodeAt(0))
}

async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.')
    const data = `${headerB64}.${payloadB64}`

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlDecode(sigB64),
      new TextEncoder().encode(data)
    )

    if (!valid) return null

    const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64))) as JwtClaims

    // Check expiration
    if (claims.exp && claims.exp * 1000 < Date.now()) return null

    return claims
  } catch {
    return null
  }
}

// ── ProjectDO ─────────────────────────────────────────────────────────────────

export class ProjectDO extends DurableObject<Env> {
  // wsId → WebSocket
  private wsById = new Map<string, WebSocket>()
  // WebSocket → metadata
  private connByWs = new Map<WebSocket, ConnInfo>()
  // role → wsId  (at most one connection per role)
  private roleRegistry = new Map<string, string>()
  // Resolvers waiting for the code-engine to (re)register — used to give a briefly-reconnecting engine a
  // short grace before a routed message is declared "offline" (see routeToCodeEngine).
  private engineWaiters = new Set<() => void>()

  // This project's id (learned from the /_ws/<id> URL) + its read-only project name. The ProjectDO is the
  // SOURCE OF TRUTH for the name: it is WRITTEN here (setName) on create + rename, so the user-UI reads it
  // from THIS per-project DO on connect and we NEVER reverse-fetch / guess the org on the user hot path.
  private _pid = ''
  private _name: string | null = null

  // Read-only project name for the user-UI. Purely local — whatever setName last stored (null until written).
  private async projectName(): Promise<string | null> {
    if (this._name) return this._name
    const stored = await this.ctx.storage.get<string>('projectName')
    return (this._name = stored ?? null)
  }

  // The WRITE path: create/rename pushes the name in here (via POST /info, or /setup at creation). This is
  // the only place the name is set — no org guessing. Extensible: more per-project fields land the same way.
  private async setName(name: unknown): Promise<void> {
    if (typeof name !== 'string' || !name.trim()) return
    this._name = name
    await this.ctx.storage.put('projectName', name)
  }

  // Timeout for unauthenticated connections (ms)
  private static AUTH_TIMEOUT = 10_000
  // Grace for a briefly-absent EXTERNAL engine before a routed message errors "offline": only if it
  // heartbeated within ENGINE_RECENT_MS (so we don't stall a genuinely-off box), wait up to ENGINE_GRACE_MS.
  private static ENGINE_RECENT_MS = 30_000
  private static ENGINE_GRACE_MS = 5_000

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(() => this.migrate())
  }

  // ── Schema (versioned — each migration runs once per DO, new DOs skip all) ──
  // Schema version is stored in _schema_version table. New DOs create all tables
  // at the latest version in one shot (CREATE IF NOT EXISTS) then jump to the
  // current version number. Existing DOs only run migrations they haven't seen.

  private static CURRENT_SCHEMA = 5

  private async migrate() {
    // Ensure version tracking table exists
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL DEFAULT 0)')
    const [rv] = this.ctx.storage.sql.exec('SELECT MAX(version) as v FROM _schema_version')
    const v = (rv as any)?.v ?? 0

    // V1 — initial tables (original schema)
    if (v < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS fly_machine (
          machine_id TEXT,
          status     TEXT NOT NULL DEFAULT 'creating'
        );
        CREATE TABLE IF NOT EXISTS api_key ( key TEXT NOT NULL );
        CREATE TABLE IF NOT EXISTS members (
          user_id TEXT NOT NULL,
          role    TEXT NOT NULL DEFAULT 'member',
          PRIMARY KEY (user_id)
        );
        CREATE TABLE IF NOT EXISTS datasources (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, tables TEXT,
          uploaded_by TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, question TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL,
          detail TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `)
    }

    // V2 — idle detection columns (heartbeat + suspend)
    if (v < 2) {
      try { this.ctx.storage.sql.exec('ALTER TABLE fly_machine ADD COLUMN last_heartbeat INTEGER NOT NULL DEFAULT 0') } catch {}
      try { this.ctx.storage.sql.exec('ALTER TABLE fly_machine ADD COLUMN idle_phase TEXT NOT NULL DEFAULT \'active\'') } catch {}
    }

    // V3 — message queue for wake-on-message delivery
    if (v < 3) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS message_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT, msg_json TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
    }

    // V4 — last_active: drives idle suspend/stop based on REAL activity (user
    // messages / busy work), NOT connection events. Reconnects no longer reset it.
    if (v < 4) {
      try { this.ctx.storage.sql.exec('ALTER TABLE fly_machine ADD COLUMN last_active INTEGER NOT NULL DEFAULT 0') } catch {}
      // seed from last_heartbeat so existing machines have a sane baseline
      try { this.ctx.storage.sql.exec('UPDATE fly_machine SET last_active = last_heartbeat WHERE last_active = 0') } catch {}
    }

    // V5 — provider: 'fly' (managed: create/suspend/stop) vs 'external' (local/EC2,
    // user-managed always-on box that connects out to the hub — no lifecycle).
    if (v < 5) {
      try { this.ctx.storage.sql.exec("ALTER TABLE fly_machine ADD COLUMN provider TEXT NOT NULL DEFAULT 'fly'") } catch {}
    }

    // Advance to current version
    this.ctx.storage.sql.exec('DELETE FROM _schema_version')
    this.ctx.storage.sql.exec('INSERT INTO _schema_version (version) VALUES (?)', ProjectDO.CURRENT_SCHEMA)

    // If this DO has a machine with a stale heartbeat, set an alarm so it
    // gets suspended within 10 min of this DO loading (handles existing DOs
    // that were created before the suspend feature was added).
    const [m] = this.ctx.storage.sql.exec(
      'SELECT last_heartbeat FROM fly_machine WHERE idle_phase = \'active\' LIMIT 1'
    )
    if (m) {
      const lastHb = (m as any).last_heartbeat as number
      if (lastHb > 0) {
        this.ctx.storage.setAlarm(lastHb + SUSPEND_AFTER_MS)
      }
    }
  }

  // ── Log helper ────────────────────────────────────────────────────────────────

  log(event: string, detail?: Record<string, unknown>) {
    try {
      this.ctx.storage.sql.exec(
        'INSERT INTO logs (event, detail) VALUES (?, ?)',
        event, detail ? JSON.stringify(detail) : null
      )
    } catch {} // never fail because of logging
  }

  // ── HTTP + WS entry point ───────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url  = new URL(request.url)
    const path = url.pathname
    const wsm = path.match(/^\/_ws\/([^/?]+)/); if (wsm) this._pid = decodeURIComponent(wsm[1])   // learn our project id

    // WebSocket upgrade — ALWAYS accept (return 101). A Durable Object cannot return a
    // non-101 status from a WS upgrade (Cloudflare fails the upgrade entirely and the
    // client sees "Unexpected server response: 401"). Auth is therefore deferred to the
    // first `hello` message: handleHello validates the key/JWT and closes the socket
    // with 4001 if invalid. Standard WS pattern (authenticate-after-accept).
    if (request.headers.get('upgrade') === 'websocket') {
      return this.handleWS(request)
    }

    // REST API
    if (request.method === 'GET'  && path === '/status')       return this.getStatus()
    if (request.method === 'POST' && path === '/setup')        return this.setup(request)
    if (request.method === 'POST' && path === '/info')         return this.setInfo(request)
    if (request.method === 'GET'  && path === '/debug')        return this.debugInfo()
    if (request.method === 'POST' && path === '/members')      return this.addMember(request)
    if (request.method === 'POST' && path === '/datasources')  return this.addDatasource(request)
    if (request.method === 'GET'  && path === '/conversations') return this.getConversations(url)
    if (request.method === 'GET'  && path === '/logs')         return this.getLogs(url)
    if (request.method === 'POST' && path === '/log')          return this.addLog(request)
    if (request.method === 'PUT'  && path === '/machine')      return this.updateMachine(request)
    if (request.method === 'POST' && path === '/verify-conn')  return this.verifyConn(request)

    return new Response('not found', { status: 404 })
  }

  // Connection-time auth, called by the Worker BEFORE it upgrades a WS (the Worker can
  // return 401 to the client; a DO's WS-upgrade handler cannot). Handles BOTH credential
  // types — server clients send `key`, browser users send a `token` (our JWT) — and the
  // credential lives only here. 200 = allowed; 401 = bad credential; 403 = not a member.
  private async verifyConn(req: Request): Promise<Response> {
    const { key, token } = await req.json() as any

    // Server-side clients (code-engine, adapters): per-project API key.
    if (key) {
      const rows = [...this.ctx.storage.sql.exec('SELECT key FROM api_key LIMIT 1')]
      const ok = rows.length > 0 && (rows[0] as any).key === key
      return Response.json({ ok }, { status: ok ? 200 : 401 })
    }

    // Browser users: our JWT (signature + expiry) AND project membership.
    if (token) {
      const secret = this.env.JWT_SECRET
      if (!secret) return Response.json({ ok: false, reason: 'no JWT secret' }, { status: 500 })
      const claims = await verifyJwt(token, secret)
      if (!claims) return Response.json({ ok: false, reason: 'invalid token' }, { status: 401 })
      const memberRows = [...this.ctx.storage.sql.exec('SELECT role FROM members WHERE user_id = ?', claims.userId)]
      if (!memberRows.length) return Response.json({ ok: false, reason: 'not a member' }, { status: 403 })
      return Response.json({ ok: true, role: (memberRows[0] as any).role }, { status: 200 })
    }

    return Response.json({ ok: false, reason: 'no credential' }, { status: 401 })
  }

  // ── WebSocket hub ───────────────────────────────────────────────────────────

  private handleWS(request: Request): Response {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

    // Standard (non-hibernation) accept — REQUIRED because this hub uses
    // addEventListener('message'|'close'|'error') below + in-memory Maps + a setTimeout
    // auth timer. ctx.acceptWebSocket() (hibernation) would route messages to
    // webSocketMessage()/webSocketClose() class methods instead, so the listeners would
    // never fire (the bug: 101 ok, but hello never received → 10s 4001 timeout).
    server.accept()

    // Auth timeout — close if handshake not received within the window
    const authTimer = setTimeout(() => {
      if (!this.connByWs.has(server)) {
        server.close(4001, 'Authentication timeout')
      }
    }, ProjectDO.AUTH_TIMEOUT)

    server.addEventListener('message', async (evt) => {
      try {
        await this.handleMessage(server, JSON.parse(evt.data as string), authTimer)
      } catch {
        server.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: { t: 'error', reason: 'Invalid JSON' } }))
      }
    })

    server.addEventListener('close', () => {
      clearTimeout(authTimer)
      this.handleDisconnect(server)
    })

    server.addEventListener('error', () => {
      clearTimeout(authTimer)
      this.handleDisconnect(server)
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  private async handleMessage(ws: WebSocket, msg: any, authTimer: ReturnType<typeof setTimeout>) {
    // ── Handshake ───────────────────────────────────────────────────────────
    if (msg.type === 'hello') {
      try {
        await this.handleHello(ws, msg, authTimer)
      } catch (err: any) {
        this.log('ws:hello_error', { error: err?.message ?? String(err) })
        ws.close(4001, 'Internal error')
      }
      return
    }

    // ── Graceful goodbye ────────────────────────────────────────────────────
    // A singleton (code-engine) shutting down closes cleanly so its slot frees NOW — the replacement
    // process then connects into an EMPTY slot, avoiding the restart-window eviction war entirely.
    if (msg.type === 'bye') { try { ws.close(1000, 'bye') } catch { /* already closing */ } ; return }

    // ── Authenticated relay ─────────────────────────────────────────────────
    const sender = this.connByWs.get(ws)
    if (!sender) {
      ws.close(4001, 'Not authenticated — send { type: "hello", ... } first')
      return
    }

    // ── Heartbeat: code-engine reports liveness + activity ──────────────────
    // busy=true  → REAL activity → bump last_active, reset the idle countdown
    // busy=false → idle → do NOT touch last_active; just keep the alarm armed
    //   (anchored to last_active, so reconnects/idle pings never extend idle time)
    // A heartbeat from ANY role is an incoming message that keeps this (non-hibernating)
    // DO warm in memory, so connections don't get evicted/dropped. Only code-engine's
    // heartbeat drives the machine-idle bookkeeping.
    if (msg.type === 'heartbeat') {
      if (sender.type === 'code-engine') {
        const now = Date.now()
        this.ctx.storage.sql.exec('UPDATE fly_machine SET last_heartbeat = ?', now)
        if (msg.busy) {
          this.ctx.storage.sql.exec('UPDATE fly_machine SET last_active = ?, idle_phase = ?, status = ?', now, 'active', 'running')
          this.ctx.storage.setAlarm(now + SUSPEND_AFTER_MS)
        } else {
          await this.ensureAlarm()
        }
        this.flushQueued(ws)
      }
      return
    }

    // ── Engine readiness: code-engine finished bootstrap + passed its self-check ──────────────────
    // A socket being open ≠ the engine being able to answer. code-engine sends this ONCE after it has
    // created its dirs, opened its stores, and verified the data seam. We record it (so the DO/UI can
    // trust "engine ready", not just "connected") and tell the clients.
    if (msg.type === 'ready' || msg.type === 'not_ready') {
      if (sender.type === 'code-engine') {
        const ready = msg.type === 'ready'
        try { this.ctx.storage.sql.exec('UPDATE fly_machine SET status = ?', ready ? 'ready' : 'not_ready') } catch {}
        this.log('engine:ready', { ready, detail: msg.detail })
        this.broadcastToAll(ws, { from: { id: sender.wsId, type: 'code-engine' }, payload: { t: ready ? 'engine:ready' : 'engine:not_ready', detail: msg.detail } })
      }
      return
    }

    await this.relay(ws, sender, msg)
  }

  private async handleHello(ws: WebSocket, msg: any, authTimer: ReturnType<typeof setTimeout>) {
    const { role, key, token, instanceId, epoch } = msg   // instanceId/epoch: singleton identity + generation (code-engine)

    // ── Server-side (code-engine): validate the per-project API key from the hello
    // message (NOT at upgrade time — see fetch()). Close 4001 if missing/invalid.
    if (role === 'code-engine') {
      const rows = [...this.ctx.storage.sql.exec('SELECT key FROM api_key LIMIT 1')]
      const storedKey = rows.length ? (rows[0] as any).key : null
      if (!key || !storedKey || storedKey !== key) {
        this.log('ws:auth_failed', { role: 'code-engine', reason: key ? 'invalid key' : 'missing key' })
        ws.close(4001, 'Invalid API key')
        return
      }
      this.log('ws:ce_auth_ok', {})
      this.recordHeartbeat()
      if (await this.register(ws, role, undefined, undefined, authTimer, instanceId, epoch)) this.flushQueued(ws)
      return
    }

    // ── Server-side (fast-router): the fast-router worker. Authenticates with the SHARED fast-router
    // secret (a single worker env var FR_SHARED_KEY), NOT a per-project key — so the fast-router DO
    // needs no provisioning. Passive: never records engine liveness / wakes the machine.
    if (role === 'fast-router') {
      const shared = (this.env as any).FR_SHARED_KEY
      if (!key || !shared || key !== shared) {
        this.log('ws:auth_failed', { role: 'fast-router', reason: key ? 'invalid key' : 'missing key' })
        ws.close(4001, 'Invalid fast-router key')
        return
      }
      this.log('ws:fr_auth_ok', {})
      if (await this.register(ws, role, undefined, undefined, authTimer, instanceId, epoch)) this.flushQueued(ws)
      return
    }

    // ── Server-side runtime: a code-engine dialing INTO a fast-router DO as a client, using the
    // shared key. A 'runtime' is any CONSUMER of a hub: a browser is a runtime of its project DO
    // (authed by JWT, in the token branch below); a code-engine is a runtime of the fast-router DO
    // (authed by this shared key). MULTI — many code-engines share one fast-router DO, addressed by
    // wsId; they reach the worker via to:{type:'fast-router'} and it replies by wsId. Passive — no
    // heartbeat, no machine wake. Guarded on `key` so a BROWSER runtime (role:'runtime' + token, no
    // key) falls through to JWT auth instead of being rejected here.
    if (role === 'runtime' && key) {
      const shared = (this.env as any).FR_SHARED_KEY   // the same shared fast-router secret every code-engine joins with
      if (!shared || key !== shared) {
        this.log('ws:auth_failed', { role: 'runtime', reason: 'invalid key' })
        ws.close(4001, 'Invalid fast-router key')
        return
      }
      this.log('ws:rt_key_auth_ok', {})
      this.register(ws, 'runtime', undefined, undefined, authTimer)
      return
    }

    // ── Auth: Our JWT (browser users, issued by Worker after Clerk login) ───
    if (token) {
      const secret = this.env.JWT_SECRET
      if (!secret) { ws.close(4001, 'Server misconfigured: JWT_SECRET not set'); return }
      let claims
      try { claims = await verifyJwt(token, secret) }
      catch { ws.close(4001, 'JWT verify error'); return }
      if (!claims) { ws.close(4001, 'Invalid JWT'); return }

      // Superadmin (admin UI): accesses ANY project — no membership required. Registers as
      // the 'admin' role (distinct from 'runtime'/'code-engine') so it can req/res with the
      // code-engine over the relay (the Inspector's inspect:req) without evicting either of them.
      // An admin frame is NOT user activity — it never bumps last_active, so watching the Inspector
      // does not extend the idle countdown. It CAN still wake a suspended machine (see relay()):
      // an inspect request needs the engine up to answer, and the Inspector only fetches on
      // open/refresh, never on a poll.
      if (claims.role === 'superadmin') {
        this.register(ws, 'admin', claims.userId, claims.role, authTimer)
        return
      }

      // Verify user is a member of this project
      const memberRows = [...this.ctx.storage.sql.exec(
        'SELECT role FROM members WHERE user_id = ?', claims.userId
      )]
      if (!memberRows.length) { ws.close(4003, 'Not a member of this project'); return }

      // Runtime (a human's client surface: web/voice/mobile) connected — real activity; wake machine.
      this.markUserActivity()
      this.wakeMachine()
      this.register(ws, 'runtime', claims.userId, claims.role, authTimer)
      return
    }

    ws.close(4001, 'Missing auth: provide key or token')
  }

  // Returns true if the connection was registered, false if it was FENCED (rejected — an older/stale
  // singleton connection that a newer instance already superseded). Callers skip post-register work on false.
  private async register(ws: WebSocket, type: string, userId: string | undefined, orgRole: string | undefined, authTimer: ReturnType<typeof setTimeout>, instanceId?: string, epoch?: number): Promise<boolean> {
    clearTimeout(authTimer)

    // Generate wsId
    const wsId = crypto.randomUUID().slice(0, 8)

    // Singletons (code-engine, fast-router) own the role slot so {to:{type}} routes to them. Non-singletons
    // (runtime, admin) are MULTI and never evict each other. For singletons we use IDENTITY + FENCING so a
    // reconnect never wars with itself and a zombie can never steal the slot back from a newer instance:
    //   • same instanceId  → the same process reconnecting → quietly supersede its own stale socket (4005)
    //   • newer epoch      → a genuinely newer process     → deliberate takeover of the old holder (4002)
    //   • older/equal epoch→ a zombie/stale reconnect       → FENCE the newcomer (4006), keep the holder
    // The fence is what breaks the register→evict→reconnect ping-pong. (epoch = the engine's boot time.)
    const singleton = type === 'code-engine' || type === 'fast-router'
    if (singleton && this.roleRegistry.has(type)) {
      const oldWs = this.wsById.get(this.roleRegistry.get(type)!)
      const old = oldWs ? this.connByWs.get(oldWs) : undefined
      if (oldWs && old) {
        const sameInstance = !!instanceId && old.instanceId === instanceId
        if (sameInstance) {
          oldWs.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: { t: 'superseded', reason: 'your own reconnection' } }))
          try { oldWs.close(4005, 'Superseded by your own reconnection') } catch { /* already closing */ }
        } else if (!instanceId || (epoch ?? 0) > (old.epoch ?? -1)) {
          oldWs.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: { t: 'evicted', reason: 'A newer connection took your role' } }))
          try { oldWs.close(4002, 'Role taken by a newer connection') } catch { /* already closing */ }
        } else {
          this.log('ws:fenced', { role: type, incomingEpoch: epoch ?? null, holderEpoch: old.epoch ?? null })
          ws.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: { t: 'fenced', reason: 'A newer engine already holds this role' } }))
          try { ws.close(4006, 'A newer engine holds this role') } catch { /* already closing */ }
          return false
        }
      }
    }

    // Register
    this.wsById.set(wsId, ws)
    this.connByWs.set(ws, { wsId, type, userId, orgRole, instanceId, epoch })
    if (singleton) this.roleRegistry.set(type, wsId)
    // Wake anything waiting for the engine to come back (grace window in routeToCodeEngine).
    if (type === 'code-engine' && this.engineWaiters.size) {
      for (const w of this.engineWaiters) { try { w() } catch { /* one bad waiter can't block the rest */ } }
      this.engineWaiters.clear()
    }

    // Welcome
    ws.send(JSON.stringify({
      from: { id: 'hub', type: 'hub' },
      to: { id: wsId, type },
      payload: { t: 'welcome', wsId, type, project: { id: this._pid, name: await this.projectName() } },
    }))

    // Log
    this.log('ws:connected', { wsId, type, userId: userId ?? null, orgRole: orgRole ?? null })

    // Notify others of join (only to user connections)
    this.broadcastToAll(ws, {
      from: { id: 'hub', type: 'hub' },
      payload: { t: 'connection:join', wsId, type },
    })
    return true
  }

  // Resolve when the code-engine (re)registers, or after `ms` — whichever first. Lets a routed message ride
  // out a brief engine reconnect (e.g. after a worker deploy drops the non-hibernating socket) instead of
  // immediately erroring "offline". Bounded, so a genuinely-down engine still errors promptly.
  private waitForEngine(ms: number): Promise<boolean> {
    if (this.roleRegistry.has('code-engine')) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (ok: boolean) => { if (done) return; done = true; this.engineWaiters.delete(w); resolve(ok) }
      const w = () => finish(true)
      this.engineWaiters.add(w)
      setTimeout(() => finish(this.roleRegistry.has('code-engine')), ms)
    })
  }

  private handleDisconnect(ws: WebSocket) {
    const conn = this.connByWs.get(ws)
    if (!conn) return

    this.wsById.delete(conn.wsId)
    this.connByWs.delete(ws)

    // Clear role if this was the active holder
    if (this.roleRegistry.get(conn.type) === conn.wsId) {
      this.roleRegistry.delete(conn.type)
    }

    // Log
    this.log('ws:disconnected', { wsId: conn.wsId, type: conn.type, userId: conn.userId ?? null })

    // Notify others
    this.broadcastToAll(ws, {
      from: { id: 'hub', type: 'hub' },
      payload: { t: 'connection:leave', wsId: conn.wsId, type: conn.type },
    })
  }

  // ── Message relay ──────────────────────────────────────────────────────────

  private async relay(senderWs: WebSocket, sender: ConnInfo, msg: any) {
    // A runtime (human client) sending a message is real activity → reset the idle clock.
    if (sender.type === 'runtime') this.markUserActivity()

    const envelope: Envelope = {
      from: { id: sender.wsId, type: sender.type },
      payload: msg.payload,
    }

    // If target is code-engine and the engine is DOWN, queue + wake it from OUTSIDE (the DO — on Cloudflare —
    // calls the Fly API; the engine never wakes itself). "Down" is decided from the DO's OWN record + the role
    // registry, NEVER a frozen WebSocket: a Fly suspend rarely delivers a clean WS close, so trusting the
    // socket leaves a stale "connected" engine that silently swallows messages. `idle_phase` is the DO's own
    // truth — it set 'suspended'/'stopped' when it put the machine to sleep. A user message is the only wake
    // trigger; an idle browser tab never wakes the machine.
    const to = msg.to as { id?: string; type?: string } | undefined
    if (to?.type === 'code-engine') {
      const [pm] = this.ctx.storage.sql.exec('SELECT provider, idle_phase, last_heartbeat FROM fly_machine LIMIT 1')
      const phase = (pm as any)?.idle_phase as string | undefined
      let engineDown = !this.roleRegistry.has('code-engine') || phase === 'suspended' || phase === 'stopped'
      // GRACE (external only): an external engine that isn't suspended/stopped but is momentarily absent is
      // almost always mid-reconnect — a non-hibernating hub socket dies (1006) on every worker deploy and the
      // engine is back in ~1s. If it heartbeated recently, wait a few seconds for it to re-register before
      // declaring it offline, so a blip doesn't surface as a scary error. A genuinely-down box errors promptly.
      if (engineDown && (pm as any)?.provider === 'external' && phase !== 'suspended' && phase !== 'stopped') {
        const lastHb = Number((pm as any)?.last_heartbeat ?? 0)
        if (lastHb && Date.now() - lastHb < ProjectDO.ENGINE_RECENT_MS) {
          await this.waitForEngine(ProjectDO.ENGINE_GRACE_MS)
          engineDown = !this.roleRegistry.has('code-engine')
        }
      }
      if (engineDown) {
        if ((pm as any)?.provider === 'external') {
          // Local/EC2 box we can't start — just tell the user it's offline.
          senderWs.send(JSON.stringify({ from: { id: 'hub', type: 'hub' },
            payload: { t: 'error', source: 'compute', message: 'Compute is offline — start your local/EC2 code-engine for this project.' } }))
          return
        }
        // Fly: queue the message + wake the managed machine. Record the wake COMMAND we're issuing (beside the
        // engine's own lifecycle events) so the log shows both what the engine reported and what we told it.
        this.ctx.storage.sql.exec('INSERT INTO message_queue (msg_json) VALUES (?)', JSON.stringify(msg))
        this.log('machine:wake_requested', { trigger: 'user-message', payloadType: (msg.payload as any)?.t ?? null, fromPhase: phase ?? null })
        this.wakeMachine()
        senderWs.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: { t: 'machine:waking' } }))
        return
      }
    }

    // ── Broadcast (no `to` field) ───────────────────────────────────────────
    if (!to) {
      this.broadcastToAll(senderWs, envelope)
      return
    }

    // ── Role-based routing ──────────────────────────────────────────────────
    if (to.type && !to.id) {
      const targetWsId = this.roleRegistry.get(to.type)
      if (!targetWsId) {
        senderWs.send(JSON.stringify({
          from: { id: 'hub', type: 'hub' },
          payload: { t: 'error', reason: `No connection for role: ${to.type}` },
        }))
        return
      }
      const targetWs = this.wsById.get(targetWsId)
      if (!targetWs) {
        // Stale registry entry
        this.roleRegistry.delete(to.type)
        senderWs.send(JSON.stringify({
          from: { id: 'hub', type: 'hub' },
          payload: { t: 'error', reason: `Role ${to.type} connection lost` },
        }))
        return
      }
      const target = this.connByWs.get(targetWs)!
      envelope.to = { id: target.wsId, type: target.type }
      targetWs.send(JSON.stringify(envelope))
      return
    }

    // ── Direct wsId routing ─────────────────────────────────────────────────
    if (to.id) {
      const targetWs = this.wsById.get(to.id)
      if (!targetWs) {
        senderWs.send(JSON.stringify({
          from: { id: 'hub', type: 'hub' },
          payload: { t: 'error', reason: `Connection not found: ${to.id}` },
        }))
        return
      }
      const target = this.connByWs.get(targetWs)!
      envelope.to = { id: target.wsId, type: target.type }
      targetWs.send(JSON.stringify(envelope))
      return
    }
  }

  private broadcastToAll(senderWs: WebSocket, envelope: Envelope) {
    const payload = JSON.stringify(envelope)
    for (const [ws, conn] of this.connByWs) {
      if (ws === senderWs) continue
      try {
        // Stamp individual `to` per recipient for broadcast
        const withTo = { ...envelope, to: { id: conn.wsId, type: conn.type } }
        ws.send(JSON.stringify(withTo))
      } catch {}
    }
  }

  // ── REST handlers ──────────────────────────────────────────────────────────

  private getStatus(): Response {
    const machineRows = [...this.ctx.storage.sql.exec(
      'SELECT machine_id, status, last_heartbeat, idle_phase, provider FROM fly_machine'
    )]
    const m = machineRows.length ? machineRows[0] as any : null
    const provider = m?.provider ?? 'fly'
    const machine = m ? {
      id: m.machine_id,
      status: m.status,
      provider,
      lastHeartbeat: m.last_heartbeat,
      idlePhase: m.idle_phase,
      idleMin: Math.round((Date.now() - m.last_heartbeat) / 60000),
    } : null
    const connections = [...this.connByWs.values()].map(c => ({ wsId: c.wsId, type: c.type }))
    return Response.json({ machine, connections, provider })
  }

  // Write-only project info from the admin/org side (create + rename). ProjectDO = source of truth for the
  // per-project record; the user-UI only READS it (via the welcome message). No key/machine side effects.
  private async setInfo(req: Request): Promise<Response> {
    const { name } = await req.json() as any
    await this.setName(name)
    return Response.json({ ok: true, name: this._name })
  }

  private async setup(req: Request): Promise<Response> {
    const { apiKey, provider, name } = await req.json() as any
    await this.setName(name)                                   // seed the name at creation (source of truth, no org guess)
    const prov = (provider === 'external' || provider === 'local') ? 'external' : 'fly'
    // Replace any existing key
    this.ctx.storage.sql.exec('DELETE FROM api_key')
    this.ctx.storage.sql.exec('INSERT INTO api_key (key) VALUES (?)', apiKey)
    // Record the compute provider. External boxes (local/EC2) have no Fly machine and
    // skip the whole lifecycle; ensure one fly_machine row holds the provider.
    const [row] = this.ctx.storage.sql.exec('SELECT 1 AS x FROM fly_machine LIMIT 1')
    if (row) this.ctx.storage.sql.exec('UPDATE fly_machine SET provider = ?', prov)
    else this.ctx.storage.sql.exec(
      'INSERT INTO fly_machine (machine_id, status, provider, last_active) VALUES (NULL, ?, ?, ?)',
      prov === 'external' ? 'external' : 'creating', prov, Date.now()
    )
    return Response.json({ ok: true, provider: prov })
  }

  private async addMember(req: Request): Promise<Response> {
    const { userId, role } = await req.json() as any
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO members (user_id, role) VALUES (?, ?)',
      userId, role ?? 'member'
    )
    return Response.json({ ok: true }, { status: 201 })
  }

  private async addDatasource(req: Request): Promise<Response> {
    const { name, tables, uploadedBy } = await req.json() as any
    const id = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      'INSERT INTO datasources (id, name, tables, uploaded_by) VALUES (?, ?, ?, ?)',
      id, name, JSON.stringify(tables ?? []), uploadedBy ?? ''
    )
    return Response.json({ id }, { status: 201 })
  }

  private getConversations(url: URL): Response {
    const userId = url.searchParams.get('userId')
    let sql = 'SELECT * FROM conversations'
    const params: any[] = []
    if (userId) { sql += ' WHERE user_id = ?'; params.push(userId) }
    sql += ' ORDER BY created_at DESC'
    const rows = [...this.ctx.storage.sql.exec(sql, ...params)]
    return Response.json(rows)
  }

  private getLogs(url: URL): Response {
    const limit = parseInt(url.searchParams.get('limit') ?? '50')
    const rows = [...this.ctx.storage.sql.exec(
      'SELECT * FROM logs ORDER BY id DESC LIMIT ?', limit
    )]
    return Response.json(rows)
  }

  private async addLog(req: Request): Promise<Response> {
    const { event, detail } = await req.json() as any
    this.log(event, detail)
    return Response.json({ ok: true }, { status: 201 })
  }

  // ── Machine lifecycle ──────────────────────────────────────────────────────

  private async updateMachine(req: Request): Promise<Response> {
    const { machineId, status } = await req.json() as any
    if (machineId) {
      this.ctx.storage.sql.exec('DELETE FROM fly_machine')
      this.ctx.storage.sql.exec(
        'INSERT INTO fly_machine (machine_id, status, last_heartbeat) VALUES (?, ?, ?)',
        machineId, status ?? 'running', Date.now()
      )
    } else if (status) {
      this.ctx.storage.sql.exec('UPDATE fly_machine SET status = ?', status)
    }
    this.log('machine:status', { machineId, status })
    return Response.json({ ok: true })
  }

  // ── Idle detection: heartbeat → alarm → suspend → stop ────────────────────

  // Called on code-engine connect. A (re)connect is NOT user activity — so we
  // PRESERVE last_active (only seeding it on the very first connect) and anchor the
  // suspend alarm to last_active, NOT to now. This is the fix for the reconnect bug:
  // the code-engine dropping/reconnecting every few minutes no longer extends idle time.
  private recordHeartbeat() {
    const now = Date.now()
    const [m] = this.ctx.storage.sql.exec('SELECT last_active, idle_phase FROM fly_machine LIMIT 1')
    const la    = Number((m as any)?.last_active) || 0
    const phase = (m as any)?.idle_phase as string | undefined
    // Distinguish a WAKE from a mere RECONNECT — this is the fix for "suspends 20s after starting":
    //  • WAKE (machine was suspended/stopped, or never seen before): it just came up to do work, so give it
    //    a FRESH idle window by resetting last_active = now. Without this it inherits a stale last_active
    //    (hours old) and the alarm below is already in the past → it suspends within seconds.
    //  • RECONNECT while already 'active'/running (an engine flap): PRESERVE last_active so repeated flaps
    //    can't keep extending idle time and running up cost.
    const wokeUp = la === 0 || phase === 'suspended' || phase === 'stopped' || phase === undefined
    const lastActive = wokeUp ? now : la
    this.ctx.storage.sql.exec(
      'UPDATE fly_machine SET last_heartbeat = ?, last_active = ?, status = ?, idle_phase = ?',
      now, lastActive, 'running', 'active'
    )
    this.ctx.storage.setAlarm(lastActive + SUSPEND_AFTER_MS)
  }

  // A user did something (connected or sent a message) → real activity. Resets the idle
  // clock. Does NOT touch `status` — that field tracks the machine's real Fly state
  // (running/suspended/stopped), set by wakeMachine/alarm/code-engine connect. Setting it
  // to 'running' here would make wakeMachine think the machine is up and skip starting it.
  private markUserActivity() {
    const now = Date.now()
    this.ctx.storage.sql.exec('UPDATE fly_machine SET last_active = ?, idle_phase = ?', now, 'active')
    this.ctx.storage.setAlarm(now + SUSPEND_AFTER_MS)
  }

  // Make sure SOME alarm is pending, anchored to last_active — so suspend/stop always
  // eventually fires even if heartbeats stop (crash) or the alarm was lost. Cost failsafe.
  private async ensureAlarm() {
    if (await this.ctx.storage.getAlarm() != null) return
    const [m] = this.ctx.storage.sql.exec('SELECT last_active, idle_phase FROM fly_machine LIMIT 1')
    if (!m) return
    const la = Number((m as any).last_active) || Date.now()
    const next = (m as any).idle_phase === 'suspended' ? la + STOP_AFTER_MS : la + SUSPEND_AFTER_MS
    this.ctx.storage.setAlarm(next)
  }

  // Deliver messages queued while machine was asleep. Called on code-engine
  // connect AND on every heartbeat (belt-and-suspenders for wake scenarios).
  private flushQueued(ws: WebSocket) {
    const queued = [...this.ctx.storage.sql.exec('SELECT id, msg_json FROM message_queue ORDER BY id')]
    if (queued.length === 0) return
    for (const q of queued) {
      const msg = JSON.parse((q as any).msg_json)
      ws.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: msg.payload }))
    }
    this.ctx.storage.sql.exec('DELETE FROM message_queue')
    this.log('machine:delivered', { count: queued.length })
  }

  // The idle state machine. Runs whenever the alarm fires. Anchored to last_active
  // (real activity), so it's robust to reconnects and to the code-engine crashing.
  //   running   + idle >= 30min            → SUSPEND (compute billing → 0, ~1-2s wake)
  //   suspended + idle >= 60min + NO user   → STOP    (release snapshot; cold wake)
  //   idle is measured from last_active, which is reset on: a user message, a busy heartbeat, AND a WAKE
  //   (recordHeartbeat) — so a freshly-started machine always gets a full idle window before it can suspend.
  // A connected user never triggers a cold STOP — they keep getting fast suspend-wakes.
  // Any failure re-arms in 1 min so an idle machine can never be left running (cost).
  async alarm() {
    const [m] = this.ctx.storage.sql.exec(
      'SELECT machine_id, last_active, idle_phase, status, provider FROM fly_machine LIMIT 1'
    )
    if (!m) return
    if ((m as any).provider === 'external') return   // local/EC2: user-managed, no lifecycle
    const token = this.env.FLY_API_TOKEN as string
    const mid   = (m as any).machine_id as string | null
    if (!token || !mid) return

    const now        = Date.now()
    const lastActive = Number((m as any).last_active) || 0
    const idleMs     = now - lastActive
    const phase      = (m as any).idle_phase as string
    const idleMin    = Math.round(idleMs / 60000)
    const hasUser    = [...this.connByWs.values()].some(c => c.type === 'runtime')

    if (phase !== 'suspended' && phase !== 'stopped') {
      // Running → suspend once idle 10 min.
      if (idleMs >= SUSPEND_AFTER_MS) {
        try {
          await suspendMachine(token, mid, FLY_APP)
          this.ctx.storage.sql.exec('UPDATE fly_machine SET status = ?, idle_phase = ?', 'suspended', 'suspended')
          this.dropEngine('machine suspended')   // clear the (now-frozen) engine WS so the next message wakes it
          this.log('machine:suspended', { machineId: mid, idleMin })
          this.ctx.storage.setAlarm(lastActive + STOP_AFTER_MS)   // schedule the stop
        } catch (err: any) {
          this.log('machine:suspend_failed', { error: err?.message ?? String(err) })
          this.ctx.storage.setAlarm(now + 60_000)                 // retry — never leave it running
        }
      } else {
        this.ctx.storage.setAlarm(lastActive + SUSPEND_AFTER_MS)  // not idle long enough yet
      }
    } else if (phase === 'suspended') {
      // Suspended → fully stop once idle 30 min, but only if no user is around (so an
      // active session always gets fast suspend-wakes, never a cold stop).
      if (idleMs >= STOP_AFTER_MS && !hasUser) {
        try {
          await flyStopMachine(token, mid, FLY_APP)
          this.ctx.storage.sql.exec('UPDATE fly_machine SET status = ?, idle_phase = ?', 'stopped', 'stopped')
          this.dropEngine('machine stopped')   // clear the engine WS so the next message wakes it
          this.log('machine:stopped', { machineId: mid, idleMin })
        } catch (err: any) {
          this.log('machine:stop_failed', { error: err?.message ?? String(err) })
          this.ctx.storage.setAlarm(now + 60_000)                 // retry
        }
      } else {
        this.ctx.storage.setAlarm(Math.max(lastActive + STOP_AFTER_MS, now + 60_000))
      }
    }
    // stopped → terminal; nothing to do (wakeMachine restarts on user connect)
  }

  // Forget the code-engine connection when WE put the machine to sleep. Fly suspend rarely delivers a clean
  // WS close, so the DO would otherwise keep a stale "connected" engine and never wake on the next message.
  // We close the (about-to-be-frozen) socket and clear the registry ourselves — so the next user message sees
  // the engine as down, wakes the machine, and the resumed engine reconnects + re-registers, which flushes
  // the queued message.
  private dropEngine(reason: string) {
    let closed = 0
    for (const [ws, conn] of [...this.connByWs]) {
      if (conn.type === 'code-engine') { try { ws.close(1000, reason) } catch { /* already gone */ } this.handleDisconnect(ws); closed++ }
    }
    this.roleRegistry.delete('code-engine')
    this.log('machine:engine_dropped', { reason, closed })   // WE closed the engine link (part of the sleep command)
  }

  // Wake the machine if it's not running. Checks the REAL Fly state (not the DO's
  // possibly-stale record) and logs success/failure to the DO log (never silent).
  private async wakeMachine() {
    const [m] = this.ctx.storage.sql.exec('SELECT machine_id, provider FROM fly_machine LIMIT 1')
    if ((m as any)?.provider === 'external') return   // can't start a user's local/EC2 box
    const mid = (m as any)?.machine_id as string | null
    const token = this.env.FLY_API_TOKEN as string
    if (!token || !mid) return
    try {
      const { state } = await getMachineStatus(token, mid, FLY_APP)
      const now = Date.now()
      if (state === 'started') {
        // already up — just sync the DO record
        this.ctx.storage.sql.exec('UPDATE fly_machine SET status = ?, idle_phase = ? WHERE 1', 'running', 'active')
        return
      }
      this.log('machine:waking', { machineId: mid, fromState: state })
      await flyStartMachine(token, mid, FLY_APP)
      this.ctx.storage.sql.exec(
        'UPDATE fly_machine SET status = ?, idle_phase = ?, last_heartbeat = ?, last_active = ?',
        'running', 'active', now, now
      )
      this.ctx.storage.setAlarm(now + SUSPEND_AFTER_MS)
      this.log('machine:woke', { machineId: mid, fromState: state })
    } catch (err: any) {
      this.log('machine:wake_failed', { machineId: mid, error: err?.message ?? String(err) })
    }
  }

  /** Returns the current machine ID if one exists, null otherwise */
  /** Debug: returns the stored API key so we can verify it matches the machine */
  private debugInfo(): Response {
    const keyRows = [...this.ctx.storage.sql.exec('SELECT key FROM api_key LIMIT 1')]
    const machineRows = [...this.ctx.storage.sql.exec('SELECT * FROM fly_machine LIMIT 1')]
    return Response.json({
      apiKey: keyRows.length ? (keyRows[0] as any).key : null,
      machine: machineRows.length ? machineRows[0] : null,
      connections: [...this.connByWs.values()].map(c => ({ wsId: c.wsId, type: c.type })),
    })
  }
}
