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
import { suspendMachine, stopMachine as flyStopMachine, startMachine as flyStartMachine, getMachineStatus, safeName, FLY_APP } from './fly.js'
import { AnswerBuffer } from './answer-buffer.js'


// How long a question queued for a sleeping machine is still worth waking up for. Past this the person has
// gone, and delivering it produces an answer nobody is waiting for — which arrives looking like the system
// answering a question at random. Dropped, and said so in the log rather than silently.
const QUEUE_MAX_AGE_MS = 60 * 60 * 1000        // 60 min

const SUSPEND_AFTER_MS = 60 * 60 * 1000        // 60 min idle (no real activity) → suspend (RAM snapshot kept → ~1-2s WARM wake, no agent re-warm)
const STOP_AFTER_MS    = 24 * 60 * 60 * 1000   // 24 h idle → stop (release the RAM snapshot; next wake is a COLD boot + agent warm-up)

// ── Types ──────────────────────────────────────────────────────────────────────

interface ConnInfo {
  wsId: string
  type: string       // "code-engine" | "runtime" | "fast-router" | "admin"
  userId?: string    // only for user connections
  orgRole?: string   // "admin" | "member" — from JWT, used for persona enforcement
  instanceId?: string // singleton identity: which process this connection belongs to (stable per boot)
  epoch?: number     // singleton generation: the process boot time — a NEWER process has a higher epoch
  channels?: Set<string>   // agent-LOG channels this connection has attached to (analyst-log / composer-log / concept-log)
}

interface Envelope {
  to?: { id?: string; type: string; channel?: string }   // channel: agent-log fan-out (the engine LABELS, the DO fans to the owner's attached devices)
  from: { id: string; type: string }
  payload: unknown
}

interface JwtClaims {
  userId: string
  email?: string     // what access is granted by — people are added to a project by address
  orgId?: string
  role: string       // PLATFORM role: "superadmin" | "user" | "service"
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
      base64urlDecode(sigB64) as BufferSource,   // see above: Uint8Array is generic over its buffer since TS 5.7
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

  // WHICH ORG owns this project. Written once at creation, then read locally — it is how the admin console
  // knows where to send an assignment (only the org may hand out access), without the project reading the org.
  private async orgId(): Promise<string | null> {
    return (await this.ctx.storage.get<string>('orgId')) ?? null
  }

  // Grace for a briefly-absent EXTERNAL engine before a routed message errors "offline": only if it
  // heartbeated within ENGINE_RECENT_MS (so we don't stall a genuinely-off box), wait up to ENGINE_GRACE_MS.
  private static ENGINE_RECENT_MS = 30_000
  private static ENGINE_GRACE_MS = 5_000

  // Durable per-user answer buffer + session snapshot — all storage logic lives in answer-buffer.ts; the DO
  // only wires it to transport (relay) and its migration ladder.
  private buffer: AnswerBuffer

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.buffer = new AnswerBuffer(this.ctx.storage.sql, (e, d) => this.log(e, d))
    // KEEPALIVE, ANSWERED AT THE EDGE. A client that sits idle — the engine between questions — has its socket
    // closed by the edge, seen as a clean register followed by a 1006 every half-minute or so. The cure is a
    // periodic frame, and Cloudflare provides exactly this pair for it: a literal `ping` is answered `pong`
    // WITHOUT waking the Durable Object, so staying connected costs no compute.
    //
    // Without the pair, a `ping` reaches handleMessage, fails JSON.parse, and earns an `Invalid JSON` error
    // reply — one every twelve seconds per client, forever. That is what a flood of 1,420 error frames turned
    // out to be, and it is why this line is not optional once anything is sending a keepalive.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    this.ctx.blockConcurrencyWhile(() => this.migrate())
  }

  // ── Schema (versioned — each migration runs once per DO, new DOs skip all) ──
  // Schema version is stored in _schema_version table. New DOs create all tables
  // at the latest version in one shot (CREATE IF NOT EXISTS) then jump to the
  // current version number. Existing DOs only run migrations they haven't seen.

  private static CURRENT_SCHEMA = 11

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

    // V6 — durable, per-user ANSWER BUFFER + recent-session snapshot. Always-on delivery: a client that was
    // offline when the answer landed (internet blip, machine asleep, app closed, a different device) PULLS it
    // from this DO without waking the engine. Every row is tagged with user_id (from the runtime JWT) so it's
    // already user-scoped for the eventual per-user-DO split. Bounded: pruned to newest 20 per user / 7 days.
    if (v < 6) AnswerBuffer.migrate(this.ctx.storage.sql)

    // V7 — ACCESS lives with the PROJECT. Users are created once in the ORG (the master list); assigning one to
    // a project copies them in here, so every check the project makes is local — no cross-DO call on the hot
    // path, and a project keeps working on its own. Removing access deletes the row here as well as in the org.
    // Keyed by EMAIL because that is what an admin adds (people sign in through Clerk themselves and are matched
    // on it) — a Clerk user id does not exist until they first log in.
    // ROLES are per-project too: the same person can be an editor on one project and a viewer on another, so a
    // project owns its own catalogue rather than inheriting one.
    if (v < 7) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS roles (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          permissions TEXT NOT NULL DEFAULT '[]',      -- JSON array of permission strings
          builtin     INTEGER NOT NULL DEFAULT 0,      -- 1 = seeded default, kept undeletable
          created_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS access (
          email       TEXT PRIMARY KEY,                -- lower-cased; the allowlist identity
          role_id     TEXT,
          source      TEXT NOT NULL DEFAULT 'direct',  -- 'direct' = assigned here | 'org-admin' = replicated from the org
          added_by    TEXT,
          created_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `)
      // Seeded defaults so a new project is usable immediately; an admin can add their own alongside these.
      const seed: Array<[string, string, string[]]> = [
        ['admin',  'Admin',  ['project.manage', 'access.manage', 'data.manage', 'ask']],
        ['member', 'Member', ['ask']],
        ['viewer', 'Viewer', ['read']],
      ]
      for (const [id, name, perms] of seed)
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO roles (id, name, permissions, builtin) VALUES (?, ?, ?, 1)', id, name, JSON.stringify(perms))
    }

    // V8 — dashboards: a built React bundle per project, uploaded through the admin console and served from
    // /dashboard/<id>/. The BYTES live in R2; this table holds only what the worker needs to find them and to
    // know which build is current — so a rollback is one UPDATE, not a re-upload.
    if (v < 8) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS dashboards (
          id          TEXT PRIMARY KEY,                -- appears in the URL: /dashboard/<id>/
          name        TEXT NOT NULL,
          build_id    TEXT,                            -- CURRENT build; R2 prefix dashboard/<proj>/<id>/<build>/
          files       INTEGER NOT NULL DEFAULT 0,
          bytes       INTEGER NOT NULL DEFAULT 0,
          uploaded_by TEXT,
          uploaded_at INTEGER,
          created_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `)
    }

    // V9 — the ENGINE PROFILE. Which harness/provider/model each agent runs on, written from superadmin and
    // read by this project's engine at boot. ONE ROW: a profile is the project's current answer, not a history,
    // and `version` is what the engine reports back so a UI can show what is genuinely RUNNING rather than what
    // was last saved. NO CREDENTIALS EVER LIVE HERE — a profile is logged, cached to disk and rendered in a UI;
    // keys come from the vault, per provider, already audited.
    if (v < 9) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS profile (
          json       TEXT NOT NULL,
          version    INTEGER NOT NULL DEFAULT 1,
          updated_by TEXT,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `)
    }

    // V10 — REMOVE the seeded profiles. A previous version wrote the engine's own default into this table the
    // first time a box reported in, so that the editor had something to show. That was backwards: an empty
    // table already means "this project uses the engine's default", and a stored copy of it is a second source
    // that goes stale the moment the default changes — which it did, one commit later, leaving projects
    // holding a profile the engine then refused. Only rows the seeder wrote are dropped; a real choice made by
    // a person is never touched.
    if (v < 10) {
      try { this.ctx.storage.sql.exec("DELETE FROM profile WHERE updated_by = 'engine (baked default)'") } catch {}
    }

    // V11 — WHAT THE ENGINE REPORTED, on disk. This was an in-memory field, which a Durable Object loses every
    // time it hibernates. The engine reports only when it connects, and a hibernating DO does not drop its
    // sockets — so after the first idle period the answer to "what is this project running" became null
    // forever, and the admin screen that depends on it rendered nothing at all.
    if (v < 11) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS engine_running (
          json       TEXT NOT NULL,
          version    INTEGER NOT NULL DEFAULT 0,
          at         INTEGER NOT NULL DEFAULT 0
        );
      `)
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
    this.hydrate()   // rebuild conn Maps from hibernated sockets before any path reads them (state/connections)
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
    if (request.method === 'POST' && path === '/keys/add')     return this.addKey(request)
    if (request.method === 'POST' && path === '/keys/prune')   return this.pruneKeys(request)
    if (request.method === 'POST' && path === '/info')         return this.setInfo(request)
    // ── Dashboards ──────────────────────────────────────────────────────────
    // Metadata only. The bytes are in R2 under dashboard/<project>/<id>/<build>/ — this says which build is
    // current, so publishing a new one or rolling back is a single UPDATE and never a re-upload.
    if (request.method === 'GET'    && path === '/dashboards')  return this.listDashboards()
    if (request.method === 'POST'   && path === '/dashboards')  return this.createDashboard(request)
    if (path.startsWith('/dashboards/')) {
      const id = decodeURIComponent(path.slice('/dashboards/'.length).split('/')[0])
      if (request.method === 'GET')    return this.getDashboard(id)
      if (request.method === 'PUT')    return this.setDashboardBuild(id, request)
      if (request.method === 'DELETE') return this.deleteDashboard(id)
    }

    if (request.method === 'GET'  && path === '/debug')        return this.debugInfo()
    if (request.method === 'POST' && path === '/members')      return this.addMember(request)
    // ACCESS + ROLES — project-local (see V7). The worker authorises the CALLER before routing here.
    if (request.method === 'GET'    && path === '/access')     return this.listAccess()
    if (request.method === 'POST'   && path === '/access')     return this.grantAccess(request)
    if (request.method === 'DELETE' && path === '/access')     return this.revokeAccess(request)
    if (request.method === 'POST'   && path === '/org-admins')  return this.syncOrgAdmins(request)
    if (request.method === 'GET'    && path === '/roles')      return this.listRoles()
    if (request.method === 'POST'   && path === '/roles')      return this.upsertRole(request)
    if (request.method === 'DELETE' && path === '/roles')      return this.deleteRole(request)
    if (request.method === 'POST' && path === '/datasources')  return this.addDatasource(request)
    if (request.method === 'GET'  && path === '/conversations') return this.getConversations(url)
    if (request.method === 'GET'  && path === '/logs')         return this.getLogs(url)
    if (request.method === 'POST' && path === '/log')          return this.addLog(request)
    if (request.method === 'PUT'  && path === '/machine')      return this.updateMachine(request)
    if (request.method === 'GET'  && path === '/profile')      return this.getProfile()
    if (request.method === 'PUT'  && path === '/profile')      return this.putProfile(request)
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
      // ANY stored key, not just the first. A project can hold more than one during a rotation, which is what
      // makes rotating possible without downtime: issue the new key, move the boxes over one at a time, then
      // drop the old one. With a single accepted key the only way to rotate is a hard cutover, and a rotation
      // that costs an outage is a rotation nobody performs — which is how an exposed key stays live.
      const ok = this.keyMatches(key)
      return Response.json({ ok }, { status: ok ? 200 : 401 })
    }

    // Browser users: our JWT (signature + expiry) AND project membership.
    if (token) {
      const secret = this.env.JWT_SECRET
      if (!secret) return Response.json({ ok: false, reason: 'no JWT secret' }, { status: 500 })
      const claims = await verifyJwt(token, secret)
      if (!claims) return Response.json({ ok: false, reason: 'invalid token' }, { status: 401 })
      if (claims.role === 'superadmin') return Response.json({ ok: true, role: 'superadmin' }, { status: 200 })
      const email = String((claims as any).email || '').toLowerCase()
      const byEmail = email ? [...this.ctx.storage.sql.exec('SELECT role_id AS role FROM access WHERE email = ?', email)] : []
      const rows = byEmail.length ? byEmail : [...this.ctx.storage.sql.exec('SELECT role FROM members WHERE user_id = ?', claims.userId)]
      if (!rows.length) return Response.json({ ok: false, reason: 'no access' }, { status: 403 })
      return Response.json({ ok: true, role: (rows[0] as any).role }, { status: 200 })
    }

    return Response.json({ ok: false, reason: 'no credential' }, { status: 401 })
  }

  // ── WebSocket hub ───────────────────────────────────────────────────────────

  private handleWS(request: Request): Response {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

    // HIBERNATION accept: the runtime keeps this socket alive across DO isolate eviction AND worker deploys,
    // then delivers messages/close/error to the webSocketMessage()/webSocketClose()/webSocketError() class
    // methods below. This is what stops the engine socket dying (1006) on every deploy. In-memory Maps don't
    // survive a hibernation wake, so they're rebuilt on demand from each socket's serialized attachment
    // (set in register(), read in hydrate()). No per-socket setTimeout auth timer survives hibernation; an
    // unauthenticated socket is instead closed the moment it sends any non-hello frame (see handleMessage).
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  // ── Hibernation handlers (replace addEventListener) ───────────────────────────
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.hydrate()
    let msg: any
    try { msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) }
    catch { ws.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: { t: 'error', reason: 'Invalid JSON' } })); return }
    try { await this.handleMessage(ws, msg) }
    catch { ws.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: { t: 'error', reason: 'Invalid JSON' } })) }
  }
  async webSocketClose(ws: WebSocket) { this.hydrate(); this.handleDisconnect(ws) }
  async webSocketError(ws: WebSocket) { this.hydrate(); this.handleDisconnect(ws) }

  // Rebuild the connection Maps from the sockets the runtime kept across a hibernation wake / new deploy.
  // Each AUTHENTICATED socket carries its ConnInfo as a serialized attachment (set in register()); sockets
  // that never authenticated have no attachment and are skipped. Runs at most once per isolate lifetime.
  private hydrated = false
  private hydrate() {
    if (this.hydrated) return
    this.hydrated = true
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as ConnInfo | null
      if (!att) continue
      this.wsById.set(att.wsId, ws)
      this.connByWs.set(ws, att)
      if (att.type === 'code-engine' || att.type === 'fast-router') this.roleRegistry.set(att.type, att.wsId)
    }
  }

  private async handleMessage(ws: WebSocket, msg: any) {
    // ── Handshake ───────────────────────────────────────────────────────────
    if (msg.type === 'hello') {
      try {
        await this.handleHello(ws, msg)
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

    // ── What the engine is ACTUALLY running ───────────────────────────────────────────────────────
    // Sent by the engine after it resolves its profile — at boot, and again after adopting a pushed change.
    // This, not the last write, is what a UI should show: saving a profile and a box running it are two
    // different facts, and they differ whenever a machine is asleep, unreachable, or mid-question.
    if (msg.type === 'config:applied') {
      if (sender.type === 'code-engine') {
        const version = Number(msg.version) || 0
        this.setRunningProfile({ version, agents: msg.agents ?? null, profile: msg.profile ?? null, at: Date.now() })
        this.log('config:applied', { version })
        this.broadcastToAll(ws, { from: { id: sender.wsId, type: 'code-engine' },
                                  payload: { t: 'config:applied', version, agents: msg.agents ?? null } })
      }
      return
    }

    await this.relay(ws, sender, msg)
  }

  private async handleHello(ws: WebSocket, msg: any) {
    const { role, key, token, instanceId, epoch } = msg   // instanceId/epoch: singleton identity + generation (code-engine)

    // ── Server-side (code-engine): validate the per-project API key from the hello
    // message (NOT at upgrade time — see fetch()). Close 4001 if missing/invalid.
    if (role === 'code-engine') {
      if (!key || !this.keyMatches(key)) {
        this.log('ws:auth_failed', { role: 'code-engine', reason: key ? 'invalid key' : 'missing key' })
        ws.close(4001, 'Invalid API key')
        return
      }
      this.log('ws:ce_auth_ok', {})
      if (msg.machineId) await this.reconcileMachineId(msg.machineId)   // self-heal (Fly-verified) the tracked machine id (survives recreate/resize)
      this.recordHeartbeat()
      if (await this.register(ws, role, undefined, undefined, instanceId, epoch)) this.flushQueued(ws)
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
      if (await this.register(ws, role, undefined, undefined, instanceId, epoch)) this.flushQueued(ws)
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
      this.register(ws, 'runtime', undefined, undefined)
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

      // SURFACE and AUTHORIZATION are SEPARATE. The connection TYPE follows the surface the client DECLARES in its
      // hello `role` ('admin' = the superadmin console app; 'runtime' = a human's client: web/voice/mobile). The JWT
      // claims.role ('superadmin' | …) is the user's AUTHORIZATION — it only gates WHICH surface is allowed and is
      // carried on the connection (orgRole) for downstream role checks. A user's privilege must NEVER silently change
      // what KIND of connection this is: a superadmin using the user app is a 'runtime' like anyone else (this is why
      // superadmins previously got no logs — they were mistyped 'admin' and skipped the runtime-only log:attach).
      if (role === 'admin') {
        // Admin-console surface — allowed ONLY for a superadmin. Accesses any project without membership, relays the
        // Inspector's inspect:req to the engine, and is NOT counted as user activity (watching ≠ using), so it never
        // bumps last_active / extends the idle countdown. It can still wake a suspended machine (see relay()).
        if (claims.role !== 'superadmin') { ws.close(4003, 'Admin surface requires superadmin'); return }
        this.register(ws, 'admin', claims.userId, claims.role)
        return
      }

      // Runtime surface — a human's client app. A superadmin may open ANY project here without membership; every
      // other user must be a member of this project. Either way it registers as 'runtime' (real user activity).
      // ACCESS is granted by EMAIL (the org assigns a person to this project, and that lands in `access`).
      // `members` remains for SERVICE identities — a bot has a userId and no address — so both are consulted,
      // in that order. Checking only `members`, as this did, meant assigning someone in the console did not
      // actually let them in: two lists, one of which nothing wrote to any more.
      if (claims.role !== 'superadmin') {
        const email = String(claims.email || '').toLowerCase()
        const byEmail = email ? [...this.ctx.storage.sql.exec('SELECT role_id FROM access WHERE email = ?', email)] : []
        const byUserId = byEmail.length ? [] : [...this.ctx.storage.sql.exec('SELECT role FROM members WHERE user_id = ?', claims.userId)]
        if (!byEmail.length && !byUserId.length) { ws.close(4003, 'No access to this project'); return }
      }
      this.markUserActivity()
      this.wakeMachine()
      this.register(ws, 'runtime', claims.userId, claims.role)
      return
    }

    ws.close(4001, 'Missing auth: provide key or token')
  }

  // Returns true if the connection was registered, false if it was FENCED (rejected — an older/stale
  // singleton connection that a newer instance already superseded). Callers skip post-register work on false.
  private async register(ws: WebSocket, type: string, userId: string | undefined, orgRole: string | undefined, instanceId?: string, epoch?: number): Promise<boolean> {

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
    const conn: ConnInfo = { wsId, type, userId, orgRole, instanceId, epoch }
    this.connByWs.set(ws, conn)
    ws.serializeAttachment(conn)   // survives hibernation → hydrate() rebuilds the Maps after a wake/deploy
    if (singleton) this.roleRegistry.set(type, wsId)
    // Wake anything waiting for the engine to come back (grace window in routeToCodeEngine).
    if (type === 'code-engine' && this.engineWaiters.size) {
      for (const w of this.engineWaiters) { try { w() } catch { /* one bad waiter can't block the rest */ } }
      this.engineWaiters.clear()
    }

    // Welcome. The engine's copy carries this project's profile; every other connection gets the same message
    // without it.
    const engineProfile = type === 'code-engine' ? this.profileForEngine() : null
    ws.send(JSON.stringify({
      from: { id: 'hub', type: 'hub' },
      to: { id: wsId, type },
      payload: { t: 'welcome', wsId, type, project: { id: this._pid, name: await this.projectName() },
                 // THE PROFILE, at the moment the engine registers — so a box adopts its project's configuration
                 // before it builds a single agent, and a restarted box needs no second round trip. Absent means
                 // "nothing configured for this project"; the engine then keeps its baked default.
                 ...(type === 'code-engine' ? { profile: engineProfile } : {}) },
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
    // The engine that told us what it was running is gone, so the claim goes with it. Reporting a profile as
    // "running" on a box that is no longer connected is the kind of confident-but-wrong answer this whole
    // reporting path exists to avoid.
    if (conn.type === 'code-engine') this.setRunningProfile(null)

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
    // ── Chat-channel answer delivery ──────────────────────────────────────────
    // The engine finished a channel-originated turn (Teams/…) and addresses the answer to type:'channel'.
    // The channel consumer holds no live socket, so we WAKE its ChannelDO (DO→DO) and hand it the answer to
    // post. Generic across channels — the adapter inside the ChannelDO does the channel-specific rendering.
    if ((msg.to as any)?.type === 'channel') {
      const p = msg.payload as any
      const chan = this.env.CHANNEL.get(this.env.CHANNEL.idFromName(`chan:${this._pid}`))
      // Live narration streams as tiny messages (→ /narration); the final answer is the rich card (→ /answer).
      const narration = p?.t === 'channel:narration'
      const path = narration ? 'https://do/narration' : 'https://do/answer'
      const body = narration
        ? { qid: p?.qid, channel: p?.channel, text: p?.text }
        : { qid: p?.qid, channel: p?.channel, answer: p?.answer, category: p?.category, projectId: this._pid }
      await chan.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
      return
    }
    // A runtime (human client) sending a message is real activity → reset the idle clock.
    if (sender.type === 'runtime') this.markUserActivity()

    // ── Durable answer buffer (V6) ──────────────────────────────────────────
    // Serve history/answers straight from the always-on DO (no engine wake), and capture questions/answers as
    // they pass through so an offline client can recover them. All user-scoped by the runtime's JWT userId.
    const pl = msg.payload || {}
    const hubReply = (payload: any) => senderWs.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload }))
    const envelope: Envelope = { from: { id: sender.wsId, type: sender.type }, payload: msg.payload }   // built once — reused by the base routing below AND the fan-out
    if (sender.type === 'runtime') {
      if (pl.t === 'sync:req')   { hubReply(this.buffer.sync(sender.userId || '')); return }
      if (pl.t === 'answer:get') { hubReply(this.buffer.get(sender.userId || '', pl.qid)); return }
      if (pl.t === 'answer:ack') { this.buffer.ack(sender.userId || '', pl.qids); return }
      // Agent-LOG subscriptions live in the DO (not the engine): a client attaches when it opens a log view and
      // detaches when it leaves, so the DO alone decides who receives which channel. Ephemeral (re-attach on reconnect).
      // Runtime-only is correct: the browser is ALWAYS a runtime surface (see handleHello — type follows the declared
      // surface, not the user's role), so a superadmin's user app attaches here like any user; the admin console is a
      // different surface and deliberately gets no log feed. Re-serialize after mutating channels: a hibernation wake
      // is transparent to the browser (it never re-attaches), so the subscription MUST live in the socket's attachment
      // or hydrate() rebuilds it empty and the log dies.
      if (pl.t === 'log:attach' && typeof pl.channel === 'string') { (sender.channels ??= new Set()).add(pl.channel); senderWs.serializeAttachment(sender); return }
      if (pl.t === 'log:detach' && typeof pl.channel === 'string') { sender.channels?.delete(pl.channel); senderWs.serializeAttachment(sender); return }
      if (pl.t === 'analyse' && pl.questionId) this.buffer.recordPending(sender.userId || '', pl)   // capture, then route on
    } else if (sender.type === 'code-engine') {
      // The engine addresses an answer/followups to the ASKER's connection (base routing, below). Here we (a)
      // record it for durable per-user recovery, and (b) — LAYER 1, separate from the base reply — fan it out to
      // the same user's OTHER devices. Keyed by the qid's OWNER, so it can reach ONLY that user (authz by
      // construction). Agent LOGS are a different layer (analyst-log/composer-log) and are never fanned out here.
      if (pl.t === 'analyst:answer' && pl.qid && !pl.replay) this.buffer.recordAnswer(pl)
      else if (pl.t === 'followups' && pl.qid) this.buffer.recordFollowups(pl)
      if ((pl.t === 'analyst:answer' || pl.t === 'followups') && pl.qid && !pl.replay) {
        const owner = this.buffer.ownerOf(pl.qid)
        if (owner) this.deliverToUser(owner, envelope, (msg.to as any)?.id)   // Tier 2 — the user's other devices (skip the base-routed asker)
      }
    }

    // If target is code-engine and the engine is DOWN, queue + wake it from OUTSIDE (the DO — on Cloudflare —
    // calls the Fly API; the engine never wakes itself). "Down" is decided from the DO's OWN record + the role
    // registry, NEVER a frozen WebSocket: a Fly suspend rarely delivers a clean WS close, so trusting the
    // socket leaves a stale "connected" engine that silently swallows messages. `idle_phase` is the DO's own
    // truth — it set 'suspended'/'stopped' when it put the machine to sleep. A user message is the only wake
    // trigger; an idle browser tab never wakes the machine.
    const to = msg.to as { id?: string; type?: string; channel?: string } | undefined
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

    // ── Agent-LOG channel fan-out (Tier 2, attach-filtered, owner-scoped) ────
    // The engine LABELS a log message `to: {type:'log', channel}` (payload carries the qid). The DO looks up the
    // qid's OWNER and delivers only to that user's connections attached to the channel — never another user's.
    if (to.type === 'log' && to.channel) {
      const owner = (msg.payload as any)?.qid ? this.buffer.ownerOf((msg.payload as any).qid) : ''
      this.deliverToChannel(to.channel, owner, envelope)
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
      this.deliverToConn(targetWs, this.connByWs.get(targetWs)!, envelope)   // Tier 1 — one connection (by role)
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
      this.deliverToConn(targetWs, this.connByWs.get(targetWs)!, envelope)   // Tier 1 — one connection (by wsId)
      return
    }
  }

  // ── Delivery tiers — the ONLY ways a message leaves the DO to clients, narrowest → widest ─────────────────
  // Every outbound path goes through exactly ONE of these:
  //   1. deliverToConn  — one CONNECTION (a specific wsId).                    used by base routing (role / id)
  //   2. deliverToUser  — one USER: all their devices (web + iOS). The AUTHZ   used by Layer 1 (per-user answers)
  //                        boundary — a message can never reach another user.
  //   3. broadcastToAll — EVERY connection (project-wide). Rare / unused.
  private deliverToConn(ws: WebSocket, conn: ConnInfo, envelope: Envelope) {
    try { ws.send(JSON.stringify({ ...envelope, to: { id: conn.wsId, type: conn.type } })) } catch {}   // stamp per-recipient `to`
  }
  private deliverToUser(userId: string, envelope: Envelope, exceptWsId?: string) {
    if (!userId) return   // never fan out to '' (that would be every unauthenticated connection)
    for (const [ws, conn] of this.connByWs)
      if (conn.userId === userId && conn.wsId !== exceptWsId && conn.type !== 'code-engine') this.deliverToConn(ws, conn, envelope)
  }
  // Tier-2 variant for AGENT LOGS: deliver only to the OWNER's connections that have ATTACHED to `channel`.
  // Owner-scoped = the authz boundary (a user's logs reach only that user); attach-filtered = bandwidth (a
  // client that isn't watching gets nothing). owner '' (project-level, e.g. semantic consolidation — no user
  // data) → all attached connections of the channel.
  private deliverToChannel(channel: string, owner: string, envelope: Envelope) {
    for (const [ws, conn] of this.connByWs) {
      if (conn.type === 'code-engine' || !conn.channels?.has(channel)) continue
      if (owner && conn.userId !== owner) continue
      this.deliverToConn(ws, conn, envelope)
    }
  }
  private broadcastToAll(senderWs: WebSocket, envelope: Envelope) {
    for (const [ws, conn] of this.connByWs) if (ws !== senderWs) this.deliverToConn(ws, conn, envelope)
  }

  // ── REST handlers ──────────────────────────────────────────────────────────

  private async getStatus(): Promise<Response> {
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
    // name + orgId travel with status so the admin console can label the project and know where assignments go.
    return Response.json({ machine, connections, provider, name: await this.projectName(), orgId: await this.orgId() })
  }

  // Write-only project info from the admin/org side (create + rename). ProjectDO = source of truth for the
  // per-project record; the user-UI only READS it (via the welcome message). No key/machine side effects.
  private async setInfo(req: Request): Promise<Response> {
    const { name } = await req.json() as any
    await this.setName(name)
    return Response.json({ ok: true, name: this._name })
  }

  /** Does this key match ANY of the project's live keys? Constant work per key and there are at most two,
   *  so the cost of supporting rotation is nil. */
  private keyMatches(key: string): boolean {
    const rows = [...this.ctx.storage.sql.exec('SELECT key FROM api_key')]
    return rows.some((r: any) => r.key === key)
  }

  /** Issue an ADDITIONAL key. Both work until the old one is dropped, so boxes can be moved across one at a
   *  time and a rotation never takes the project offline. */
  private async addKey(req: Request): Promise<Response> {
    const apiKey = `sk-proj-${crypto.randomUUID()}`
    this.ctx.storage.sql.exec('INSERT INTO api_key (key) VALUES (?)', apiKey)
    const n = [...this.ctx.storage.sql.exec('SELECT key FROM api_key')].length
    this.log('key:issued', { live: n })
    return Response.json({ apiKey, live: n })
  }

  /** Drop every key except the one given — the second half of a rotation, run once the boxes are moved.
   *  Refuses to drop the key it was handed, so a typo cannot leave a project with no way in. */
  private async pruneKeys(req: Request): Promise<Response> {
    const { keep } = await req.json() as any
    if (!keep || !this.keyMatches(keep)) {
      return Response.json({ error: 'keep must be one of this project\'s live keys' }, { status: 400 })
    }
    this.ctx.storage.sql.exec('DELETE FROM api_key WHERE key != ?', keep)
    const n = [...this.ctx.storage.sql.exec('SELECT key FROM api_key')].length
    this.log('key:pruned', { live: n })
    return Response.json({ ok: true, live: n })
  }

  private async setup(req: Request): Promise<Response> {
    const { apiKey, provider, name, orgId } = await req.json() as any
    await this.setName(name)                                   // seed the name at creation (source of truth, no org guess)
    if (typeof orgId === 'string' && orgId) await this.ctx.storage.put('orgId', orgId)
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

  // ── ACCESS + ROLES (project-local) ─────────────────────────────────────────
  // Keyed by lower-cased EMAIL. This table answers the one question asked on every request — "may this person
  // touch this project, and as what?" — without leaving the DO. Rows with source='org-admin' are placed by the
  // organisation and are read-only here.
  private j(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  private listAccess(): Response {
    const rows = [...this.ctx.storage.sql.exec(
      `SELECT a.email, a.role_id, a.source, a.created_at, r.name AS role_name, r.permissions
         FROM access a LEFT JOIN roles r ON r.id = a.role_id ORDER BY a.email`)] as any[]
    return this.j({ access: rows.map(r => ({ ...r, permissions: JSON.parse(r.permissions ?? '[]') })) })
  }

  private async grantAccess(request: Request): Promise<Response> {
    const b = await request.json().catch(() => ({})) as any
    const email = String(b.email ?? '').trim().toLowerCase()
    if (!email) return this.j({ error: 'email required' }, 400)
    const roleId = b.roleId ? String(b.roleId) : 'member'
    // 'org-admin' is set ONLY by the org's own sync (POST /org-admins), never by a grant arriving here.
    const exists = [...this.ctx.storage.sql.exec('SELECT 1 FROM roles WHERE id = ?', roleId)].length
    if (!exists) return this.j({ error: `unknown role "${roleId}"` }, 400)
    this.ctx.storage.sql.exec(
      "INSERT INTO access (email, role_id, source, added_by) VALUES (?, ?, 'direct', ?) " +
      "ON CONFLICT(email) DO UPDATE SET role_id = excluded.role_id",
      email, roleId, String(b.addedBy ?? ''))
    return this.j({ ok: true, email, roleId })
  }

  private async revokeAccess(request: Request): Promise<Response> {
    const b = await request.json().catch(() => ({})) as any
    const email = String(b.email ?? '').trim().toLowerCase()
    if (!email) return this.j({ error: 'email required' }, 400)
    // The people who administer the ORGANISATION are its to manage — a project cannot lock its owner out.
    const [row] = [...this.ctx.storage.sql.exec('SELECT source FROM access WHERE email = ?', email)]
    if (row?.source === 'org-admin') return this.j({ error: 'this person administers the organisation — change it there' }, 403)
    this.ctx.storage.sql.exec('DELETE FROM access WHERE email = ?', email)
    return this.j({ ok: true, email })
  }

  /** Replace the mirrored set of ORG ADMINS. Called by the org when its admin list changes, so this project can
   *  authorise alone rather than reading the organisation on every request. */
  private async syncOrgAdmins(request: Request): Promise<Response> {
    const b = await request.json().catch(() => ({})) as any
    const emails: string[] = Array.isArray(b.emails) ? b.emails.map((e: any) => String(e).trim().toLowerCase()).filter(Boolean) : []
    this.ctx.storage.sql.exec("DELETE FROM access WHERE source = 'org-admin'")
    for (const e of emails)
      this.ctx.storage.sql.exec(
        "INSERT INTO access (email, role_id, source, added_by) VALUES (?, 'admin', 'org-admin', 'org') " +
        "ON CONFLICT(email) DO UPDATE SET role_id = 'admin', source = 'org-admin'", e)
    return this.j({ ok: true, orgAdmins: emails.length })
  }

  private listRoles(): Response {
    const rows = [...this.ctx.storage.sql.exec('SELECT id, name, permissions, builtin FROM roles ORDER BY builtin DESC, name')] as any[]
    return this.j({ roles: rows.map(r => ({ ...r, permissions: JSON.parse(r.permissions ?? '[]'), builtin: !!r.builtin })) })
  }

  private async upsertRole(request: Request): Promise<Response> {
    const b = await request.json().catch(() => ({})) as any
    const id = String(b.id ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    const name = String(b.name ?? '').trim()
    if (!id || !name) return this.j({ error: 'id and name required' }, 400)
    const perms = Array.isArray(b.permissions) ? b.permissions.map(String) : []
    this.ctx.storage.sql.exec(
      'INSERT INTO roles (id, name, permissions) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, permissions = excluded.permissions',
      id, name, JSON.stringify(perms))
    return this.j({ ok: true, id, name, permissions: perms })
  }

  private async deleteRole(request: Request): Promise<Response> {
    const b = await request.json().catch(() => ({})) as any
    const id = String(b.id ?? '')
    const [row] = [...this.ctx.storage.sql.exec('SELECT builtin FROM roles WHERE id = ?', id)]
    if (!row) return this.j({ error: 'no such role' }, 404)
    if (row.builtin) return this.j({ error: 'built-in roles cannot be deleted' }, 400)
    // Holders fall back to the default rather than losing access mid-session.
    this.ctx.storage.sql.exec("UPDATE access SET role_id = 'member' WHERE role_id = ?", id)
    this.ctx.storage.sql.exec('DELETE FROM roles WHERE id = ?', id)
    return this.j({ ok: true, id })
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

  // The engine reports the Fly machine it's running on (FLY_MACHINE_ID). If our tracked id drifted — the
  // machine was recreated or resized — reconcile so suspend/stop/start always target the LIVE machine.
  //
  // SECURITY: the claimed id is NOT trusted. Holding the project key is enough to send this hello, so a
  // key-holder could otherwise point the DO at an arbitrary machine and have us drive Fly stop/suspend against
  // it with the org token. So on a claimed CHANGE we verify against Fly (the source of truth): the id must name
  // a machine that EXISTS IN OUR APP and whose name is this project's deterministic `proj_<projectId>` — which
  // can only be created with our Fly token. Same-id reconnects and external engines make no Fly call.
  private async reconcileMachineId(claimedId: string) {
    const [m] = this.ctx.storage.sql.exec('SELECT machine_id, provider FROM fly_machine LIMIT 1')
    if (!m) return
    if ((m as any).provider === 'external') return              // user-managed; no Fly machine to track
    if ((m as any).machine_id === claimedId) return             // already correct — no Fly call
    const token = this.env.FLY_API_TOKEN as string
    if (!token || !this._pid) return
    const expected = safeName('proj', this._pid)
    try {
      const info = await getMachineStatus(token, claimedId, FLY_APP)   // 404s if not in our app
      if (info?.name !== expected) {
        this.log('machine:reconcile_rejected', { claimedId, name: info?.name ?? null, expected })
        return
      }
      this.ctx.storage.sql.exec('UPDATE fly_machine SET machine_id = ?', claimedId)
      this.log('machine:reconciled', { from: (m as any).machine_id ?? null, to: claimedId })
    } catch (err: any) {
      this.log('machine:reconcile_failed', { claimedId, error: err?.message ?? String(err) })
    }
  }

  // ── THE ENGINE PROFILE ───────────────────────────────────────────────────
  // Read by this project's engine (it arrives in the welcome, and again on every change); written only from
  // superadmin. Stored as the JSON the engine consumes, so nothing translates between what is edited and what
  // is applied — a translation layer is one more place the two can disagree.
  private readProfile(): { profile: any; version: number; updatedBy: string | null; updatedAt: number } | null {
    const [row] = this.ctx.storage.sql.exec('SELECT json, version, updated_by, updated_at FROM profile LIMIT 1')
    if (!row) return null
    try {
      return { profile: JSON.parse((row as any).json), version: (row as any).version,
               updatedBy: (row as any).updated_by ?? null, updatedAt: (row as any).updated_at }
    } catch { return null }   // unparseable is the same as absent: the engine falls back to its baked default
  }

  /** WHAT AN ENGINE RECEIVES: this project's picks, and nothing else. Composed in ONE place so the welcome
   *  and a pushed change can never disagree — two call sites building the same document separately is how
   *  they drift.
   *
   *  NO CATALOGUE TRAVELS. Which models are permitted is a platform question answered in superadmin, where
   *  the choice is made; by the time a profile reaches a box the choosing is over, and shipping the options
   *  alongside the decision would only invite a second opinion about it further down.
   */
  private profileForEngine(): any | null {
    try { return this.readProfile()?.profile ?? null }
    catch { return null }   // a box that cannot be told its profile still runs its default; a dead hub does not
  }

  private async getProfile(): Promise<Response> {
    const p = this.readProfile()
    // `running` is what the ENGINE last reported it had adopted — NOT what was last saved. A UI must be able to
    // show that a change has actually taken effect, and those are different facts whenever a box is asleep,
    // unreachable, or still finishing the question it was on.
    return Response.json({ ...(p ?? { profile: null, version: 0, updatedBy: null, updatedAt: 0 }), running: this.runningProfile })
  }

  private async putProfile(req: Request): Promise<Response> {
    const body = await req.json() as any
    const profile = body?.profile
    if (!profile || typeof profile !== 'object') return Response.json({ error: 'body must be { profile, by? }' }, { status: 400 })
    const prev = this.readProfile()
    const version = (prev?.version ?? 0) + 1
    const stored = { ...profile, version }
    this.ctx.storage.sql.exec('DELETE FROM profile')
    this.ctx.storage.sql.exec('INSERT INTO profile (json, version, updated_by, updated_at) VALUES (?, ?, ?, ?)',
      JSON.stringify(stored), version, body?.by ?? null, Date.now())
    this.log('profile:saved', { version, by: body?.by ?? null })
    // PUSHED, not polled. The engine adopts it for the next session each agent builds; a running turn is never
    // interrupted. Delivered best-effort — a box that is asleep picks it up in its welcome when it wakes.
    const delivered = this.sendToRole('code-engine', { t: 'config:update', profile: this.profileForEngine(), version })
    return Response.json({ ok: true, version, delivered })
  }

  /** What the engine says it is RUNNING. Written from its `config:applied` message and cleared when it
   *  disconnects, so a stale claim never outlives the process that made it — and held on DISK, because this
   *  object hibernates while the engine stays connected, and an in-memory copy simply vanished. */
  //
  // BOOKKEEPING MUST NOT KILL A SOCKET. Both of these run inside the engine's WebSocket handlers — one when it
  // reports what it is running, one when it disconnects. An exception there (a table that a migration has not
  // reached yet, say) does not fail politely: it resets the Durable Object and takes every connection with it,
  // including the browser's. Knowing which profile is running is worth strictly less than the hub staying up,
  // so a failure here is reported and swallowed.
  private get runningProfile(): { version: number; agents?: any; profile?: any; at: number } | null {
    try {
      const [row] = this.ctx.storage.sql.exec('SELECT json, version, at FROM engine_running LIMIT 1')
      if (!row) return null
      return { ...JSON.parse((row as any).json), version: (row as any).version, at: (row as any).at }
    } catch { return null }
  }
  private setRunningProfile(v: { version: number; agents?: any; profile?: any; at: number } | null) {
    try {
      this.ctx.storage.sql.exec('DELETE FROM engine_running')
      if (v) this.ctx.storage.sql.exec('INSERT INTO engine_running (json, version, at) VALUES (?, ?, ?)',
        JSON.stringify({ agents: v.agents ?? null, profile: v.profile ?? null }), v.version, v.at)
    } catch (err: any) {
      this.log('config:running_write_failed', { error: String(err?.message ?? err).slice(0, 160) })
    }
  }

  /** Send one payload to the single connection holding a role. Returns whether anything received it — the
   *  caller reports that honestly rather than implying delivery to a box that is asleep. */
  private sendToRole(role: string, payload: any): boolean {
    const wsId = this.roleRegistry.get(role)
    const ws = wsId ? this.wsById.get(wsId) : undefined
    if (!ws || !wsId) return false
    try {
      ws.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, to: { id: wsId, type: role }, payload }))
      return true
    } catch { return false }
  }

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
  //
  // EVERY ROW LEAVES THE QUEUE, delivered or not. This used to parse and send the whole batch and only then
  // DELETE, with no error handling anywhere: one unparseable row — or one send onto a socket that closed while
  // we were iterating — threw, the delete never ran, and the identical failure replayed on EVERY subsequent
  // engine registration. A single bad message could therefore keep a project's hub in a permanent crash loop,
  // taking the browser's socket down with it, with nothing in the queue ever being delivered again.
  //
  // So each row is removed BEFORE it is attempted, and each attempt is isolated. A message we cannot deliver
  // is lost — which is the right trade against one poisoning the project forever — and it is logged with its
  // id rather than disappearing.
  private flushQueued(ws: WebSocket) {
    const queued = [...this.ctx.storage.sql.exec('SELECT id, msg_json, created_at FROM message_queue ORDER BY id')]
    if (queued.length === 0) return
    const nowSec = Math.floor(Date.now() / 1000)
    let sent = 0, stale = 0, failed = 0
    for (const q of queued) {
      const id = (q as any).id
      // First, so nothing can be replayed. A row that fails here is one we would otherwise retry forever.
      try { this.ctx.storage.sql.exec('DELETE FROM message_queue WHERE id = ?', id) } catch { /* gone already */ }
      if (nowSec - (Number((q as any).created_at) || 0) > QUEUE_MAX_AGE_MS / 1000) { stale++; continue }
      try {
        const msg = JSON.parse((q as any).msg_json)
        ws.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: msg.payload }))
        sent++
      } catch (err: any) {
        failed++
        this.log('machine:queue_undeliverable', { id, error: String(err?.message ?? err).slice(0, 160) })
      }
    }
    this.log('machine:delivered', { sent, stale, failed })
  }

  // The idle state machine. Runs whenever the alarm fires. Anchored to last_active
  // (real activity), so it's robust to reconnects and to the code-engine crashing.
  //   running   + idle >= 60min            → SUSPEND (compute billing → 0, ~1-2s WARM wake)
  //   suspended + idle >= 24h + NO user     → STOP    (release snapshot; cold wake)
  //   idle is measured from last_active, which is reset on: a user message, a busy heartbeat, AND a WAKE
  //   (recordHeartbeat) — so a freshly-started machine always gets a full idle window before it can suspend.
  // A connected user never triggers a cold STOP — they keep getting fast suspend-wakes.
  // Any failure re-arms in 1 min so an idle machine can never be left running (cost).
  async alarm() {
    this.hydrate()   // may fire after a hibernation wake — rebuild conn Maps before reading them
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
      // Running → suspend once idle 60 min.
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
      // Suspended → fully stop once idle 24 h, but only if no user is around (so an
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
  // ── Dashboards ────────────────────────────────────────────────────────────
  private listDashboards(): Response {
    const rows = [...this.ctx.storage.sql.exec(
      'SELECT id, name, build_id, files, bytes, uploaded_by, uploaded_at, created_at FROM dashboards ORDER BY created_at DESC')]
    return Response.json({ dashboards: rows })
  }

  private async createDashboard(request: Request): Promise<Response> {
    const b: any = await request.json().catch(() => ({}))
    const name = String(b?.name ?? '').trim()
    if (!name) return new Response('a dashboard needs a name', { status: 400 })
    // A readable id, because it is what people see in the URL. Suffixed so two dashboards named alike do not
    // collide, and so a deleted one's URL cannot be silently reused by the next.
    const slug = (String(b?.id ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dashboard').slice(0, 40)
    const id = `${slug}-${crypto.randomUUID().slice(0, 6)}`
    this.ctx.storage.sql.exec('INSERT INTO dashboards (id, name) VALUES (?, ?)', id, name)
    return Response.json({ id, name })
  }

  private getDashboard(id: string): Response {
    const rows = [...this.ctx.storage.sql.exec('SELECT * FROM dashboards WHERE id = ?', id)]
    return rows.length ? Response.json(rows[0]) : new Response('no such dashboard', { status: 404 })
  }

  /** Point a dashboard at a build that has finished uploading. Written LAST, so a half-uploaded build is never
   *  the one being served: until this runs, the old build stays current and the new objects are just sitting
   *  in R2 unreferenced. */
  private async setDashboardBuild(id: string, request: Request): Promise<Response> {
    const b: any = await request.json().catch(() => ({}))
    const rows = [...this.ctx.storage.sql.exec('SELECT id FROM dashboards WHERE id = ?', id)]
    if (!rows.length) return new Response('no such dashboard', { status: 404 })
    this.ctx.storage.sql.exec(
      'UPDATE dashboards SET build_id = ?, files = ?, bytes = ?, uploaded_by = ?, uploaded_at = ? WHERE id = ?',
      String(b?.buildId ?? ''), Number(b?.files ?? 0), Number(b?.bytes ?? 0), String(b?.by ?? ''), Date.now(), id)
    return Response.json({ ok: true })
  }

  private deleteDashboard(id: string): Response {
    this.ctx.storage.sql.exec('DELETE FROM dashboards WHERE id = ?', id)
    return Response.json({ ok: true })   // the R2 objects are removed by the worker, which owns the bucket
  }

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
