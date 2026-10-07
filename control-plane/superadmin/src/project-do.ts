// ProjectDO — one per project: the project's own record and its hub.
//
// It keeps what is the project's: who may do what (members, access, roles, groups, keys, grants — copied in from the
// organisation, so nothing here crosses to the OrgDO on the way), the composition graph (graph.ts), programs,
// the engine connection and its machine, connections to data, decisions, the audit, activities and usage.
//
// Who is in its hub:
//   - the engine:           { type: "hello", role: "code-engine", key: "sk-proj-..." }
//   - agents (agent keys):  { type: "hello", role: "agent", key: "sak_..." }
//   - service identities:   { type: "hello", role: "runtime", token: "<service jwt>" } (the ChannelDO, Teams)
//   - PEOPLE, never directly: every tab and device of a person connects to that person's UserDO (user-hub.ts), which
//     holds one link here per surface (personLink / personMessage / personUnlink, by RPC). The link is a connection like
//     any other; its `send` is an RPC back to the UserDO, which decides which of the person's tabs gets what.
//
// The hub ALWAYS stamps `from` on every relayed message — clients never set it. Clients send `to` (absent = to everyone
// in the hub); `to.type` resolves through the role registry.

import { DurableObject } from 'cloudflare:workers'
import { suspendMachine, stopMachine as flyStopMachine, startMachine as flyStartMachine, getMachineStatus, safeName, FLY_APP } from './fly.js'
import { AnswerBuffer } from './answer-buffer.js'
import { receiver, sender as wireSender, FRAME_LIMIT, isParcelled } from '../../../clients/transport.js'
import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { PROJECT_MIGRATIONS, adoptProjectSchemaVersion } from './migrations.js'
import { bucketStore } from './parcels.js'
import { AuditLog, auditScope } from './audit.js'
import { AgentKeys, KeyRefusal, type AgentKey } from './agent-keys.js'
import { HUB_MESSAGES } from '../../shared/hub-messages.js'
import { can, beyond, builtinRole, capabilitiesOf, checkRole, isCapability, messageNeeds, PROJECT_ROLES, type Capability } from '../../shared/permissions.js'
import { SUPERADMIN_EMAILS } from './auth/tokens.js'
import { ProgramCatalogue, CatalogueRefusal } from './program-catalogue.js'
import { TAG } from '../../../vm/packages/agent-contract/contract.mjs'
import { stepOf } from '../../../vm/packages/decision/src/index.js'
import { checkPolicy, resolve as resolvePolicies, type AccessPolicy } from './access-policies.js'
import { costOf, priceFor, type Price } from './metering.js'
import { createRecorder, type Recorder } from './records.js'
import { connectorById, checkConnection, CONNECTORS } from '../../shared/connectors.js'
import { seal, unseal } from './proxy/seal.js'
import { runConnector, runCode, manifestOf } from './connectors/runtime.js'
import { projectGraph, migrateGraph, GRAPH_MESSAGES, GRAPH_VIEWS, type Who } from './graph.js'
import { changesFingerprint } from '../../../vm/packages/composition-graph/src/fingerprint.js'
import { projectDsi, DsiRefusal } from './dsi.js'
/** THE ONLY PAYLOADS THAT CARRY SECRETS: a project's connections, unsealed for its engine (and one connection, for one
 *  person). They are sent inline on the engine's authenticated socket — never as a parcel, never into the bucket, the
 *  audit, the record stream or a log. A secret enters the platform only through the connections routes (sealed at once,
 *  proxy/seal.ts) and leaves only in these. */
export const SECRET_PAYLOADS = new Set(['connections:list', 'connection:got'])
import { projectJobs, JobRefusal, type Job } from './jobs.js'
import { putObject, removeObjects, kindOfKey, projectOfKey as projectOfObject, prefixesOf, KINDS, type Ledger, type LedgerRow } from './storage.js'
import { keyOf as fileKeys } from './files.js'


// How long a question queued for a sleeping machine is still worth waking up for. Past this the person has
// gone, and delivering it produces an answer nobody is waiting for — which arrives looking like the system
// answering a question at random. Dropped, and said so in the log rather than silently.
const QUEUE_MAX_AGE_MS = 60 * 60 * 1000        // 60 min

const SUSPEND_AFTER_MS = 60 * 60 * 1000        // 60 min idle (no real activity) → suspend (RAM snapshot kept → ~1-2s WARM wake, no agent re-warm)
const STOP_AFTER_MS    = 24 * 60 * 60 * 1000   // 24 h idle → stop (release the RAM snapshot; next wake is a COLD boot + agent warm-up)

// ── Types ──────────────────────────────────────────────────────────────────────

interface ConnInfo {
  wsId: string
  type: string       // "code-engine" | "runtime" | "admin" | "agent"
  userId?: string    // only for user connections; an agent key's is `agent:<keyId>`
  email?: string     // the person's address, from their token (for the audit history)
  maker?: string     // who made an agent key: the key acts for them, cut to what they hold now
  admin?: boolean    // a person who administers this project (superadmin, org admin, or the project's admin role)
  orgRole?: string   // "admin" | "member" — from JWT, used for persona enforcement
  instanceId?: string // singleton identity: which process this connection belongs to (stable per boot)
  epoch?: number     // singleton generation: the process boot time — a NEWER process has a higher epoch
  channels?: Set<string>   // agent-LOG channels this connection has attached to (composer-log / analyst-log / narration)
}

interface Envelope {
  to?: { id?: string; type: string; channel?: string }   // channel: agent-log fan-out (the engine LABELS, the DO fans to the owner's attached devices)
  // userId: who sent it, stamped by the hub from the connection's credentials — never taken from the payload.
  from: { id: string; type: string; userId?: string; email?: string; admin?: boolean; scopes?: string[] }
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
  /** Connector calls made so far by each code-mode program (by its run id). */
  private codeRuns = new Map<string, number>()
  private static CODE_RUN_CALLS = 200
  // The channel consumer holds no socket, so what the engine addresses to it lands here — through the transport,
  // like every other end: parts are joined and a parcel's body is read from the bucket, and the ChannelDO is
  // handed a whole answer. One receiver, made on first use, since the engine is the only sender to a channel.
  private _channelIn: ReturnType<typeof receiver> | null = null
  private channelIn() {
    if (!this._channelIn) this._channelIn = receiver({ deliver: (whole) => { void this.handToChatChannel(whole) }, parcels: bucketStore(this.env.PACKAGES, this._pid) })
    return this._channelIn
  }
  private async handToChatChannel(p: any) {
    const chan = this.env.CHANNEL.get(this.env.CHANNEL.idFromName(`chan:${this._pid}`))
    // Live narration streams as tiny messages (→ /narration); the final answer is the rich card (→ /answer).
    const narration = p?.t === 'channel:narration'
    const path = narration ? 'https://do/narration' : 'https://do/answer'
    const body = narration
      ? { qid: p?.qid, channel: p?.channel, text: p?.text }
      : { qid: p?.qid, channel: p?.channel, answer: p?.answer, category: p?.category, projectId: this._pid }
    await chan.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
  }
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

  // ── Keys: in force, and what they hold (the worker asks on every call made with a key) ──
  /** A key is in force when it is, and so is the key that made it — one of this project's, or an organisation's (asked
   *  of the OrgDO). A key whose maker key went holds nothing: it goes with it. */
  private async keyInForce(k: AgentKey, seen = new Set<string>()): Promise<boolean> {
    if (!seen.size && !(await this.inItsOrganisation())) return false   // a removed project's keys hold nothing
    if (!this.agentKeys.live(k) || seen.has(k.id)) return false
    seen.add(k.id)
    if (!k.made_by_key) return true
    if (k.made_by_key.startsWith('org:')) {
      const org = await this.orgId()
      if (!org) return false
      const r: any = await this.env.ORG.get(this.env.ORG.idFromName(org)).fetch(new Request(`http://do/key-alive?id=${encodeURIComponent(k.made_by_key.slice(4))}`)).then((x) => x.json()).catch(() => null)
      return r?.alive === true
    }
    const parent = this.agentKeys.get(k.made_by_key)
    return !!parent && this.keyInForce(parent, seen)
  }
  /** Is this project still in force — not removed by its organisation? A project with no organisation has nothing to ask. */
  private async inItsOrganisation(): Promise<boolean> {
    const org = await this.orgId()
    if (!org) return true
    const removed: any = await this.env.ORG.get(this.env.ORG.idFromName(org)).fetch(new Request('http://do/projects?deleted=1')).then((x) => x.json()).catch(() => null)
    if (!Array.isArray(removed)) return false   // cannot tell: refuse, never assume
    return !removed.some((p: any) => p.id === this._pid)
  }
  /** For the worker: a project key's standing — in force, what it holds now, and the person it acts for. */
  private async keyAccess(request: Request): Promise<Response> {
    const { key } = await request.json().catch(() => ({})) as { key?: string }
    const v = key ? await this.agentKeys.verify(String(key)) : { ok: false as const, reason: 'no key' }
    if (!v.ok || !(await this.keyInForce(v.key))) return Response.json({ ok: false, reason: v.ok ? 'the key that made it is no longer in force' : v.reason })
    return Response.json({ ok: true, keyId: v.key.id, name: v.key.name, maker: v.key.created_by, caps: this.agentKeys.holds(v.key, (who) => this.capabilitiesOfEmail(who)) })
  }

  // Grace for a briefly-absent EXTERNAL engine before a routed message errors "offline": only if it
  // heartbeated within ENGINE_RECENT_MS (so we don't stall a genuinely-off box), wait up to ENGINE_GRACE_MS.
  private static ENGINE_RECENT_MS = 30_000
  private static ENGINE_GRACE_MS = 5_000

  // Durable per-user answer buffer + session snapshot — all storage logic lives in answer-buffer.ts; the DO
  // only wires it to transport (relay) and its migration ladder.
  private buffer: AnswerBuffer
  private audit: AuditLog
  private agentKeys: AgentKeys
  private catalogue: ProgramCatalogue
  private record: Recorder

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.buffer = new AnswerBuffer(this.ctx.storage.sql, (e, d) => this.log(e, d))
    this.audit = new AuditLog(this.ctx.storage.sql as any, () => this._pid ?? '', { stream: (env as any).AUDIT, records: createRecorder((env as any).RECORDS, () => this._pid ?? ''), warn: (m) => { this.log('audit:send_failed', { message: m }); console.warn(`[audit] ${m}`) } })
    this.agentKeys = new AgentKeys(this.ctx.storage.sql as any, () => this._pid ?? '')
    this.catalogue = new ProgramCatalogue(this.ctx.storage.sql as any, env.PACKAGES, () => this._pid ?? '', () => this.ledger())
    this.record = createRecorder((env as any).RECORDS, () => this._pid ?? '')
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

  // ── Schema: migrations (migrations.ts), once per wake; a single-row read when nothing is pending ──
  private async migrate() {
    runMigrations(durableObjectDb(this.ctx.storage), PROJECT_MIGRATIONS, { name: `ProjectDO ${this.ctx.id.toString().slice(0, 8)}`, adopt: adoptProjectSchemaVersion })
    // The composition graph's own tables, by its own migrations (graph.ts).
    migrateGraph(this.ctx.storage)

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

  /** Every HTTP call, through one gate for the audit history: a call that changes something is recorded once — by its
   *  handler, with what it means (agent-key.create, …), or else here, as the call itself. Whatever way it came. */
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET' || request.method === 'HEAD' || request.headers.get('upgrade') === 'websocket') return this.handleFetch(request)
    const mark = { recorded: false }
    const res = await auditScope.run(mark, () => this.handleFetch(request))
    if (!mark.recorded) {
      const path = new URL(request.url).pathname
      let actor: any = null
      try { actor = JSON.parse(request.headers.get('x-sa-actor') ?? 'null') } catch { /* malformed: not a person's */ }
      // The audit history is who did what: the platform's own parts talking successfully is not kept; anything refused
      // or failed is, whoever made it.
      const known = !!(actor?.kind && actor?.id)
      if (known || !res.ok) try {
        this.audit.record({ actor: known ? actor : { kind: 'system', id: 'platform' }, via: known ? 'api' : 'system', action: `api.${request.method.toLowerCase()}`,
          target: path.slice(1, 200), outcome: res.ok ? 'ok' : res.status >= 500 ? 'error' : 'refused', detail: { status: res.status } })
      } catch (e: any) { this.log('audit:refused', { message: e?.message ?? String(e) }) }
    }
    return res
  }

  private async handleFetch(request: Request): Promise<Response> {
    this.hydrate()   // rebuild conn Maps from hibernated sockets before any path reads them (state/connections)
    const url  = new URL(request.url)
    const path = url.pathname
    const wsm = path.match(/^\/_ws\/([^/?]+)/); if (wsm) this._pid = decodeURIComponent(wsm[1])   // learn our project id
    const hp = request.headers.get('x-sa-project'); if (hp && /^[0-9a-f-]{36}$/.test(hp)) this._pid = hp   // …or from the worker's forward

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
    if (request.method === 'GET'  && path === '/attention')    return this.attention()
    if (path === '/warehouse/grants') return this.warehouseGrants(request)
    // The connector gateway's record of the requests a connection's code made; code mode's proxy running an operation.
    // Both internal (the worker never forwards connector-* paths).
    if (request.method === 'POST' && path === '/connector-calls') return this.connectorCalls(request)
    if (request.method === 'POST' && path === '/connector-op') {
      const b: any = await request.json().catch(() => ({}))
      // One code-mode program may make so many connector calls, and no more.
      const run = String(b.run ?? '')
      const n = (this.codeRuns.get(run) ?? 0) + 1; this.codeRuns.set(run, n)
      if (this.codeRuns.size > 500) this.codeRuns.delete(this.codeRuns.keys().next().value!)
      if (n > ProjectDO.CODE_RUN_CALLS) return this.j({ error: `a program may make at most ${ProjectDO.CODE_RUN_CALLS} connector calls` }, 429)
      try { return this.j(await this.connectorOp(b.sender as ConnInfo, String(b.op), b.payload ?? {})) } catch (e: any) { return this.j({ error: e?.message ?? String(e) }, 400) }
    }
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
      const rest = path.slice('/dashboards/'.length).split('/').slice(1)
      if (rest[0] === 'builds' && request.method === 'GET')    return this.listDashboardBuilds(id, new URL(request.url).searchParams.get('hash'))
      if (rest[0] === 'builds' && request.method === 'PUT' && rest[1] && rest[2] === 'pruned') return this.markDashboardBuildPruned(id, decodeURIComponent(rest[1]))
      if (rest[0] === 'current' && request.method === 'PUT')   return this.rollDashboardTo(id, request)
      if (request.method === 'GET')    return this.getDashboard(id)
      if (request.method === 'PUT')    return this.setDashboardBuild(id, request)
      if (request.method === 'DELETE') return this.deleteDashboard(id)
    }

    // ── Agent API keys and the audit history (the worker authorises the caller as the project's admin) ──
    if (path === '/agent-keys' || path.startsWith('/agent-keys/') || path === '/audit') return this.agentKeysAndAudit(request, path)
    if (request.method === 'POST' && path === '/agent-call') return this.agentCall(request)
    if (request.method === 'POST' && path === '/key-access') return this.keyAccess(request)
    if (path === '/engine/programs' || path.startsWith('/engine/programs/')) return this.enginePrograms(request, path)
    if (path.startsWith('/engine/connections/')) return this.engineConnections(request, path)
    if (path === '/engine/app' || path.startsWith('/engine/app/')) return this.engineApp(request, path)
    // A program's React side, file by file, for screens (the worker has checked the caller is in the project).
    { const m = request.method === 'GET' ? path.match(/^\/programs\/([0-9a-f]{64})\/(web\/[\w./-]+\.js)$/) : null
      if (m && !m[2].includes('..')) {
        try {
          const b = await this.catalogue.bundle(m[1])
          const text = b.files[m[2]]
          if (text === undefined) return this.j({ error: `program ${m[1].slice(0, 12)} has no ${m[2]}` }, 404)
          return new Response(text, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable' } })
        } catch (e: any) { return this.j({ error: e?.message ?? String(e) }, 404) }
      } }
    if (path === '/access-policies' || path.startsWith('/access-policies/') || path === '/access-attributes') return this.accessAdmin(request, path)
    if (path === '/access-domains' || path.startsWith('/access-domains/')) return this.accessDomains(request, path)
    if (path === '/groups' || path.startsWith('/groups/')) return this.groupsAdmin(request, path)
    if (path === '/connections' || path.startsWith('/connections/') || path === '/connectors') return this.connectionsApi(request, path)
    if (path === '/storage' || path.startsWith('/storage/')) return this.storageApi(request, path)
    if (request.method === 'POST' && path === '/access/arrive') return this.arrive(request)
    if (path === '/usage' && request.method === 'GET') return this.usageSummary(new URL(request.url))

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
      if (att.type === 'code-engine') this.roleRegistry.set(att.type, att.wsId)
    }
    // People's links, kept beside the sockets (see personLink).
    try {
      for (const r of [...this.ctx.storage.sql.exec('SELECT conn FROM person_links')] as any[]) {
        const c = JSON.parse(String(r.conn)) as ConnInfo & { channels?: string[] }
        const conn: ConnInfo = { ...c, channels: c.channels ? new Set(c.channels) : undefined }
        const ws = this.linkSocket(conn)
        this.wsById.set(conn.wsId, ws); this.connByWs.set(ws, conn)
      }
    } catch { /* before its migration ran: no links yet */ }
  }

  private async handleMessage(ws: WebSocket, msg: any) {
    // ── Handshake ───────────────────────────────────────────────────────────
    if (msg.type === 'hello') {
      try {
        await this.handleHello(ws, msg)
      } catch (err: any) {
        this.log('ws:hello_error', { error: err?.message ?? String(err) })
        console.log(`[hello] ${this._pid} failed: ${err?.stack ?? err}`)
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
    // The engine's own message, too big for a frame, came beside the wire: opened here (the one place), then handled.
    if (sender.type === 'code-engine' && typeof msg.type === 'string' && isParcelled(msg)) {
      const body = await this.openParcel(msg as any, 'type')
      if (!body) { console.warn(`[hub] the engine's ${msg.type} came as a parcel that could not be opened`); return }
      msg = body
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
    // ── A session's log, pushed up by the engine: the platform keeps the truth (in its owner's UserDO), the person's index
    //    of their sessions follows (UserDO), and the engine hears how far the platform has it. ──
    // ── What the engine did, for the platform's warehouse (an agent's turn, its steps and queries): recorded here, the
    //    one path, never by the engine itself. Only the engine's own kinds. ──
    if (msg.type === 'record' && sender.type === 'code-engine') {
      if (typeof msg.kind === 'string' && /^agent\.[a-z][\w.-]*$/.test(msg.kind) && typeof msg.key === 'string' && msg.key) this.record(msg.kind, msg.key, msg.data ?? null)
      return
    }
    // ── Usage per person: what each harness reported for each model call, stamped by the engine with the turn's
    //    session and person — the one path usage is recorded by, for every harness and account. ──
    if (msg.type === 'usage:report' && sender.type === 'code-engine') {
      if (typeof msg.provider === 'string') await this.addUsage({ ...msg, tag: TAG.test(String(msg.tag ?? '')) ? msg.tag : null }, 'engine')
      return
    }
    // ── Long work in the engine (an activity): its latest state kept, and sent to its owner and the admins ──
    if (msg.type === 'activity' && sender.type === 'code-engine') {
      const a = msg.activity ?? {}
      if (typeof a.id === 'string' && /^(user|agent):\S+$/.test(String(a.owner ?? '')) && ['running', 'done', 'failed'].includes(a.state)) {
        this.ctx.storage.sql.exec(`INSERT INTO activities (id, owner, kind, title, state, progress, detail, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET state = excluded.state, progress = excluded.progress, detail = excluded.detail, updated_at = excluded.updated_at`,
          a.id, a.owner, String(a.kind ?? ''), String(a.title ?? '').slice(0, 300), a.state, a.progress ?? null, a.detail ? String(a.detail).slice(0, 1000) : null, String(a.startedAt ?? new Date().toISOString()), String(a.updatedAt ?? new Date().toISOString()))
        this.record('activity', `${a.id}:${a.state}:${a.updatedAt}`, a)
        const envelope = { from: { id: 'hub', type: 'hub' }, payload: { t: 'activity', activity: a } }
        for (const [cws, conn] of this.connByWs) {
          if (conn.type === 'code-engine' || conn.wsId.startsWith('http-')) continue
          if (this.principalOf(conn) === a.owner || conn.admin) this.deliverToConn(cws, conn, envelope as any)
        }
      }
      return
    }
    // ── The data access policies a reader is under, resolved for the engine to send with each of their queries ──
    // The code connectors the engine runs, as it reports them (on each connect): the whole set, replacing the last.
    if (msg.type === 'sources:report' && sender.type === 'code-engine') {
      const list = Array.isArray(msg.sources) ? msg.sources.filter((x: any) => typeof x?.id === 'string') : []
      const at = new Date().toISOString()
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM engine_sources')
        // What the source is, as its connector says (engine-made information goes up): kept on the connection where nobody said otherwise.
        for (const x of list) this.ctx.storage.sql.exec("UPDATE connections SET kind = COALESCE(kind, ?), dialect = COALESCE(dialect, ?), description = COALESCE(description, ?) WHERE name = ? AND removed_at IS NULL AND level = 'project'",
          x.kind ?? null, x.dialect ?? null, x.description ? String(x.description).slice(0, 4000) : null, x.id)
        for (const x of list) this.ctx.storage.sql.exec('INSERT INTO engine_sources (id, kind, dialect, description, ready, reported_at) VALUES (?, ?, ?, ?, ?, ?)', x.id, x.kind ?? null, x.dialect ?? null, String(x.description ?? '').slice(0, 500), x.ready ? 1 : 0, at)
      })
      return
    }
    // The code connections the engine runs: pulled on every welcome and whenever they change (connections:changed).
    if (msg.type === 'connections:pull' && sender.type === 'code-engine') {
      const reply = (payload: Record<string, unknown>) => { this.emit(ws, { from: { id: 'hub', type: 'hub' } }, { t: 'connections:list', reqId: msg.reqId, ...payload }) }
      try { reply({ connections: await this.codeConnectionsForEngine() }); this.audit.record({ actor: { kind: 'engine', id: 'engine' }, via: 'engine', action: 'connection.open', target: 'code connections', outcome: 'ok' }) }
      catch (e: any) { reply({ error: e?.message ?? String(e) }) }
      return
    }
    if (msg.type === 'connection:get' && sender.type === 'code-engine') {
      const reply = (payload: Record<string, unknown>) => { this.emit(ws, { from: { id: 'hub', type: 'hub' } }, { t: 'connection:got', reqId: msg.reqId, ...payload }) }
      try { reply({ connection: await this.connectionForEngine(String(msg.id ?? ''), msg.principal ? String(msg.principal) : null, msg.email ? String(msg.email) : null) }) }
      catch (e: any) { reply({ error: e?.message ?? String(e) }) }
      return
    }
    if (msg.type === 'access:resolve' && sender.type === 'code-engine') {
      const reply = (payload: Record<string, unknown>) => { this.emit(ws, { from: { id: 'hub', type: 'hub' } }, { t: 'access:resolved', principal: msg.principal, source: msg.source, reqId: msg.reqId, ...payload }) }
      try { reply({ policies: this.policiesFor(String(msg.principal ?? ''), msg.email ? String(msg.email) : null, String(msg.source ?? '')), version: this.accessVersion() }) }
      catch (e: any) { reply({ error: e?.message ?? String(e) }) }
      return
    }
    // The engine's replica of the graph: what it lacks after its cursor; and the questions it routes, recorded here.
    if (msg.type === 'graph:write' && sender.type === 'code-engine') {
      // Nodes written for a person (who, as the hub stamped them when they asked the engine) — through governance, as them.
      const w = msg.who ?? {}
      const who: Who = { id: String(w.id ?? ''), admin: w.admin === true, ...(typeof w.email === 'string' ? { email: w.email } : {}), scopes: Array.isArray(w.scopes) ? w.scopes.map(String) : [] }
      const r = /^(user|agent):\S+$/.test(who.id) ? this.graph().writeFor(who, msg.writes) : { error: 'who the write is for is not known', changed: false }
      this.emit(ws, { from: { id: 'hub', type: 'hub' } }, { t: 'graph:written', reqId: msg.reqId, ...(r.error ? { error: r.error } : { results: r.results }) })
      if (r.changed) this.sendToRole('code-engine', { t: 'graph:changed', cursor: this.graph().cursor() })
      return
    }
    // The graph replica's check: the platform's change log, summed up (fingerprint.ts) — a replica that differs is rebuilt.
    if (msg.type === 'graph:fingerprint' && sender.type === 'code-engine') {
      const rows = [...this.ctx.storage.sql.exec('SELECT id, name, to_hash FROM change')] as any[]
      this.emit(ws, { from: { id: 'hub', type: 'hub' } }, { t: 'graph:fingerprint', reqId: msg.reqId, ...(await changesFingerprint(rows)) })
      return
    }
    if ((msg.type === 'graph:pull' || msg.type === 'graph:asked') && sender.type === 'code-engine') {
      const reply = (payload: Record<string, unknown>) => { this.emit(ws, { from: { id: 'hub', type: 'hub' } }, payload) }
      try {
        if (msg.type === 'graph:pull') reply({ t: 'graph:batch', batch: this.graph().pull(msg.cursor ?? {}), cursor: this.graph().cursor() })
        else this.graph().asked(msg.question)
      } catch (e: any) { if (msg.type === 'graph:pull') reply({ t: 'graph:batch', error: e?.message ?? String(e) }); else console.warn(`[graph] a question was not recorded: ${e?.message ?? e}`) }
      return
    }
    // ── Each source's index (dsi.ts): built by the engine, kept here; and long work (jobs.ts), any kind ──
    if (typeof msg.type === 'string' && /^(dsi|job):/.test(msg.type) && sender.type === 'code-engine') {
      const reply = (payload: Record<string, unknown>) => { this.emit(ws, { from: { id: 'hub', type: 'hub' } }, { reqId: msg.reqId, ...payload }) }
      const by = 'engine'
      try {
        switch (msg.type) {
          case 'dsi:pull': reply({ t: 'dsi:batch', source: msg.source ?? null, ...this.dsi().pull(msg.cursor, msg.source || undefined) }); break
          case 'dsi:fingerprints': reply({ t: 'dsi:fingerprints', sources: await this.dsi().fingerprints(), latest: this.dsi().cursor() }); break
          case 'dsi:plan': { const r = this.dsi().plan(msg, by); reply({ t: 'dsi:planned', source: msg.source, phase: msg.phase, ...r }); if (r.gone) this.dsiChanged(); break }
          case 'dsi:put': if (this.dsi().put(msg, by).changed) this.dsiChanged(); break
          case 'dsi:failed': this.dsi().failed(msg); break
          case 'dsi:rows': if (this.dsi().rows(msg, by).changed) this.dsiChanged(); break
          case 'dsi:finish': this.dsi().finish(msg); break
          case 'dsi:resume': {
            // The engine is back (or its sources changed): a build left unfinished, or never run, carries on by itself.
            const todo = this.dsi().unfinished(this.codeSourceNames())
            if (todo.length) this.askIndexBuild({ sources: todo }, 'platform')
            break
          }
          case 'job:start': { const r = this.jobs().start({ kind: String(msg.kind ?? ''), lease: String(msg.lease ?? ''), holder: sender.instanceId ?? null, by: msg.by ? String(msg.by) : null })
            if ('job' in r) { reply({ t: 'job:started', job: r.job }); this.jobUpdate(r.job) } else reply({ t: 'job:busy', job: r.busy }); break }
          case 'job:beat': this.jobUpdate(this.jobs().beat(String(msg.id ?? ''), msg)); break
          case 'job:end': this.jobUpdate(this.jobs().end(String(msg.id ?? ''), msg.state, msg.detail)); break
          default: reply({ t: 'dsi:refused', reason: `there is no ${msg.type}` })
        }
      } catch (e: any) {
        if (e instanceof DsiRefusal || e instanceof JobRefusal) reply({ t: msg.type.startsWith('job:') ? 'job:refused' : 'dsi:refused', reason: e.message })
        else throw e
      }
      return
    }
    if (msg.type === 'session:sync' && sender.type === 'code-engine') {
      const reply = (payload: Record<string, unknown>) => { this.emit(ws, { from: { id: 'hub', type: 'hub' } }, { t: 'session:synced', session: msg.session, ...payload }) }
      try { reply(await this.syncSession(String(msg.session ?? ''), Number(msg.from), Array.isArray(msg.entries) ? msg.entries : [])) }
      catch (e: any) { reply({ error: e?.message ?? String(e) }) }
      return
    }
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

    // ── An agent (any system acting with an agent key the project's admin made) ──
    if (role === 'agent') {
      const v = key ? await this.agentKeys.verify(String(key)) : { ok: false as const, reason: 'no key' }
      if (!v.ok) {
        this.audit.record({ actor: { kind: 'agent', id: `key:${String(key ?? '').slice(0, 47) || 'none'}` }, via: 'agent', action: 'agent.connect', outcome: 'refused', detail: { reason: v.reason } })
        ws.close(4001, `Invalid agent key: ${v.reason}`)
        return
      }
      if (!(await this.keyInForce(v.key))) { ws.close(4001, 'Invalid agent key: the key that made it is no longer in force'); return }
      this.audit.record({ actor: { kind: 'agent', id: `agent:${v.key.id}` }, via: 'agent', action: 'agent.connect', outcome: 'ok', detail: { name: v.key.name, capabilities: v.key.capabilities } })
      await this.register(ws, 'agent', `agent:${v.key.id}`, undefined, undefined, undefined, { maker: v.key.created_by })
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
      // People never connect here: every tab and device of theirs goes to their own UserDO, which links them (personLink).
      // Only service identities (the ChannelDO, Teams) hold a token socket of their own.
      if (claims.role !== 'service' && !String(claims.userId ?? '').startsWith('svc:')) { ws.close(4001, 'People connect through their own UserDO'); return }

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
        this.register(ws, 'admin', claims.userId, claims.role, undefined, undefined, { email: claims.email, admin: true })
        return
      }

      // Runtime surface — a human's client app. A superadmin may open ANY project here without membership; every
      // other user must be a member of this project. Either way it registers as 'runtime' (real user activity).
      // ACCESS is granted by EMAIL (the org assigns a person to this project, and that lands in `access`).
      // `members` remains for SERVICE identities — a bot has a userId and no address — so both are consulted,
      // in that order. Checking only `members`, as this did, meant assigning someone in the console did not
      // actually let them in: two lists, one of which nothing wrote to any more.
      const verdict = this.admitPerson(claims, 'runtime')
      if (!verdict.ok) { ws.close(verdict.code, verdict.reason); return }
      const admin = verdict.admin
      this.markUserActivity()
      this.wakeMachine()
      this.register(ws, 'runtime', claims.userId, claims.role, undefined, undefined, { email: claims.email, admin })
      return
    }

    ws.close(4001, 'Missing auth: provide key or token')
  }

  /** A person, by their verified sign-in, on a surface ('admin' = the superadmin console, 'runtime' = their own apps):
   *  whether they may in, and whether they administer the project. Access is by email (the organisation assigns people
   *  to the project, landing in `access`); `members` keeps service identities that have no address. */
  private admitPerson(claims: { userId: string; email?: string; role?: string }, surface: 'admin' | 'runtime'): { ok: true; admin: boolean } | { ok: false; code: number; reason: string } {
    if (surface === 'admin') return claims.role === 'superadmin' ? { ok: true, admin: true } : { ok: false, code: 4003, reason: 'Admin surface requires superadmin' }
    if (claims.role === 'superadmin') return { ok: true, admin: true }
    const email = String(claims.email || '').toLowerCase()
    const arrived = email ? this.accessOnArrival(email) : null
    const byUserId = arrived ? [] : [...this.ctx.storage.sql.exec('SELECT role FROM members WHERE user_id = ?', claims.userId)]
    if (!arrived && !byUserId.length) return { ok: false, code: 4003, reason: 'No access to this project' }
    return { ok: true, admin: !!email && can(this.capabilitiesOfEmail(email), 'project.audit') }
  }

  // ── People, through their UserDO ──────────────────────────────────────────────────────────────────────────────────
  // A person never holds a socket here: every tab and device of theirs connects to their own UserDO, which keeps ONE
  // link per project and surface. The link is a connection like any other in this hub — its `send` is an RPC call to
  // the person's UserDO (which fans it out to their tabs), its close a call to drop them. Links are kept in
  // person_links so a hibernation wake or a deploy finds them again; a delivery to a UserDO with no tab left on the
  // project ends the link.
  private linkStubs = new Map<string, any>()
  private linkSocket(conn: ConnInfo): WebSocket {
    const user = (this.linkStubs.get(conn.wsId) ?? this.userStub(`user:${conn.userId}`))
    this.linkStubs.set(conn.wsId, user)   // one stub per link: calls on it arrive in the order they were made
    return {
      send: (data: string) => { void Promise.resolve(user.deliver(this._pid, conn.wsId, data)).then((r: any) => { if (r?.gone) this.dropLink(conn.wsId) }).catch(() => {}) },
      close: (code?: number, reason?: string) => { void Promise.resolve(user.closeLink(this._pid, conn.wsId, code ?? 1000, reason ?? '')).catch(() => {}); this.dropLink(conn.wsId) },
      serializeAttachment: (c: ConnInfo) => this.saveLink(c),
      deserializeAttachment: () => this.connByWs.get(this.wsById.get(conn.wsId)!) ?? conn,
    } as unknown as WebSocket
  }
  private saveLink(c: ConnInfo) {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO person_links (ws_id, conn, at) VALUES (?, ?, ?)', c.wsId, JSON.stringify({ ...c, channels: c.channels ? [...c.channels] : undefined }), Date.now())
  }
  private dropLink(wsId: string) {
    const ws = this.wsById.get(wsId)
    const conn = ws ? this.connByWs.get(ws) : undefined
    this.ctx.storage.sql.exec('DELETE FROM person_links WHERE ws_id = ?', wsId)
    this.linkStubs.delete(wsId)
    if (!ws || !conn) return
    this.wsById.delete(wsId); this.connByWs.delete(ws)
    this.log('ws:disconnected', { wsId, type: conn.type, userId: conn.userId ?? null })
    this.broadcastToAll(ws, { from: { id: 'hub', type: 'hub' }, payload: { t: 'connection:leave', wsId, type: conn.type } })
  }
  /** A person's UserDO links them to this project (a first tab opened it): admitted as on any socket, then welcomed. */
  async personLink(a: { project: string; userId: string; email?: string; role?: string; surface: string }) {
    if (!this._pid) this._pid = a.project
    this.hydrate()
    const surface = a.surface === 'admin' ? 'admin' : 'runtime'
    const verdict = this.admitPerson({ userId: a.userId, email: a.email, role: a.role }, surface)
    if (!verdict.ok) return verdict
    const wsId = `${surface === 'admin' ? 'pa' : 'pr'}-${a.userId}`
    const had = this.wsById.get(wsId)
    const before = had ? this.connByWs.get(had) : undefined
    const conn: ConnInfo = { wsId, type: surface, userId: a.userId, orgRole: a.role, ...(a.email ? { email: a.email } : {}), ...(verdict.admin ? { admin: true } : {}), ...(before?.channels ? { channels: before.channels } : {}) }
    if (surface === 'runtime') { this.markUserActivity(); this.wakeMachine() }
    const ws = had ?? this.linkSocket(conn)
    this.wsById.set(wsId, ws); this.connByWs.set(ws, conn); this.saveLink(conn)
    if (!had) {
      this.log('ws:connected', { wsId, type: surface, userId: a.userId, orgRole: a.role ?? null, via: 'user' })
      this.broadcastToAll(ws, { from: { id: 'hub', type: 'hub' }, payload: { t: 'connection:join', wsId, type: surface } })
    }
    return { ok: true as const, wsId, type: surface, welcome: { t: 'welcome', wsId, type: surface, project: { id: this._pid, name: await this.projectName() }, scopes: this.scopesOf(conn), caps: this.capsOf(conn) } }
  }
  /** A message from one of a person's tabs, through their link — handled exactly as one from a socket. */
  async personMessage(project: string, wsId: string, msg: any): Promise<{ ok: true } | { relink: true }> {
    if (!this._pid) this._pid = project
    this.hydrate()
    const ws = this.wsById.get(wsId)
    if (!ws || !this.connByWs.get(ws)) return { relink: true }
    if (msg?.type === 'hello' || msg?.type === 'bye') return { ok: true }
    try { await this.handleMessage(ws, msg) }
    catch (e: any) { ws.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: { t: 'error', reason: e?.message ?? 'not handled' } })) }
    return { ok: true }
  }
  /** The person's last tab on this project closed. */
  async personUnlink(project: string, wsId: string) { if (!this._pid) this._pid = project; this.hydrate(); this.dropLink(wsId) }

  // Returns true if the connection was registered, false if it was FENCED (rejected — an older/stale
  // singleton connection that a newer instance already superseded). Callers skip post-register work on false.
  private async register(ws: WebSocket, type: string, userId: string | undefined, orgRole: string | undefined, instanceId?: string, epoch?: number, extra: { email?: string; scopes?: string[]; admin?: boolean; maker?: string } = {}): Promise<boolean> {

    // Generate wsId
    const wsId = crypto.randomUUID().slice(0, 8)

    // The singleton (code-engine) owns its role slot so {to:{type}} routes to them. Non-singletons
    // (runtime, admin) are MULTI and never evict each other. For singletons we use IDENTITY + FENCING so a
    // reconnect never wars with itself and a zombie can never steal the slot back from a newer instance:
    //   • same instanceId  → the same process reconnecting → quietly supersede its own stale socket (4005)
    //   • newer epoch      → a genuinely newer process     → deliberate takeover of the old holder (4002)
    //   • older/equal epoch→ a zombie/stale reconnect       → FENCE the newcomer (4006), keep the holder
    // The fence is what breaks the register→evict→reconnect ping-pong. (epoch = the engine's boot time.)
    const singleton = type === 'code-engine'
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
    const conn: ConnInfo = { wsId, type, userId, orgRole, instanceId, epoch, ...(extra.email ? { email: extra.email } : {}), ...(extra.scopes ? { scopes: extra.scopes } : {}), ...(extra.maker ? { maker: extra.maker } : {}), ...(extra.admin ? { admin: true } : {}) }
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
                 ...(type === 'code-engine' ? { profile: engineProfile } : {}),
                 // what this person or agent sees with (their own scope and their groups'), for screens to offer
                 ...(type === 'runtime' || type === 'agent' || type === 'admin' ? { scopes: this.scopesOf(conn) } : {}) },
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

  // ── An agent over HTTP ─────────────────────────────────────────────────────
  // The same message an agent sends over its WebSocket, sent as one HTTP request instead. It is not a second
  // implementation: the call becomes a short-lived agent connection and goes through relay() — the same scope check,
  // the same audit, the same routing to the engine — and the reply addressed to it (made whole by the platform's
  // transport, if it came in parts or as a parcel) is the response.
  private async agentCall(request: Request): Promise<Response> {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const key = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const v = key ? await this.agentKeys.verify(key) : { ok: false as const, reason: 'no key' }
    if (!v.ok) {
      this.audit.record({ actor: { kind: 'agent', id: `key:${key.slice(0, 47) || 'none'}` }, via: 'agent', action: 'agent.call', outcome: 'refused', detail: { reason: v.reason } })
      return json({ error: `Invalid agent key: ${v.reason}` }, 401)
    }
    const payload: any = await request.json().catch(() => null)
    if (!payload || typeof payload.t !== 'string') return json({ error: 'the body is a message: { "t": "<type>", … }' }, 400)
    payload.reqId ??= `http-${crypto.randomUUID()}`
    const wsId = `http-${crypto.randomUUID().slice(0, 8)}`
    if (!(await this.keyInForce(v.key))) return json({ error: 'Invalid agent key: the key that made it is no longer in force' }, 401)
    const conn: ConnInfo = { wsId, type: 'agent', userId: `agent:${v.key.id}`, maker: v.key.created_by }
    const timeoutMs = Math.min(Math.max(Number(new URL(request.url).searchParams.get('timeout')) || 120, 1), 300) * 1000
    return await new Promise<Response>((resolve) => {
      let done = false
      const finish = (r: Response) => { if (done) return; done = true; clearTimeout(timer); this.wsById.delete(wsId); this.connByWs.delete(fake); resolve(r) }
      const inbound = receiver({ deliver: (m: any) => {
        if (m?.reqId === payload.reqId) finish(json(m, m.t === 'error' ? 403 : 200))
        else if (m?.t === 'error' && m.source === 'compute') finish(json(m, 503))
      }, parcels: bucketStore(this.env.PACKAGES, this._pid) })
      const fake = { send: (data: string) => { try { const env = JSON.parse(data); if (env?.payload) void inbound.receive(env.payload) } catch { /* not ours */ } }, close: () => {} } as unknown as WebSocket
      const timer = setTimeout(() => finish(json({ error: `no reply to ${payload.t} in ${timeoutMs / 1000}s` }, 504)), timeoutMs)
      this.wsById.set(wsId, fake)
      this.connByWs.set(fake, conn)
      this.relay(fake, conn, { to: { type: 'code-engine' }, payload }).catch((e) => finish(json({ error: e?.message ?? String(e) }, 500)))
    })
  }

  // ── Programs the engine builds (authenticated with the project's key); it downloads them, its bridges and session files by the object route (parcels.ts) ──
  private async enginePrograms(request: Request, path: string): Promise<Response> {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const key = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!key || !this.keyMatches(key)) return json({ error: 'only this project\'s engine' }, 401)
    try {
      if (path === '/engine/programs' && request.method === 'GET') {
        const q = new URL(request.url).searchParams
        return json({ programs: this.catalogue.list({ name: q.get('name') ?? undefined, published: q.has('published') ? q.get('published') === 'true' : undefined }) })
      }
      const hash = path.slice('/engine/programs/'.length)
      if (!/^[0-9a-f]{64}$/.test(hash)) return json({ error: 'not a program hash' }, 400)
      if (request.method === 'PUT') {
        const by = request.headers.get('x-sa-by') ?? ''
        if (!/^(user|agent):[^\s]+$/.test(by)) return json({ error: 'an upload says who asked for the build (x-sa-by)' }, 400)
        const bundle: any = await request.json().catch(() => null)
        if (bundle?.hash !== hash) return json({ error: 'the bundle is not the program this path names' }, 400)
        const r = await this.catalogue.upload(bundle, by)
        if (r.added) this.record('program', hash, { ...r.entry, event: 'uploaded' })
        this.audit.record({ actor: { kind: by.startsWith('agent:') ? 'agent' : 'user', id: by }, via: 'engine', action: 'program.upload', target: hash, outcome: 'ok', detail: { name: r.entry.name, version: r.entry.version, added: r.added } })
        return json(r, r.added ? 201 : 200)
      }
      return json({ error: 'not found' }, 404)
    } catch (e: any) {
      if (e instanceof CatalogueRefusal) return json({ error: e.message }, 400)
      throw e
    }
  }

  // ── Connections, for the engine: the bridges it runs come from here (one path) ──────────────────────────────────
  /** The project's code connections, as the engine runs them: each one's name (the source id queries use), connector,
   *  settings, secrets (unsealed — over the engine's authenticated socket, never kept on its disk) and bridge (hash). */
  private async codeConnectionsForEngine() {
    const master = (this.env as any).CREDENTIALS_MASTER_KEY
    const rows = [...this.ctx.storage.sql.exec("SELECT * FROM connections WHERE removed_at IS NULL AND level = 'project' ORDER BY created_at")] as any[]
    const out = []
    for (const r of rows.filter((x) => connectorById(x.connector)?.runs === 'code')) {
      out.push({ id: r.id, name: r.name, connector: r.connector, settings: JSON.parse(r.settings), secrets: r.secrets_sealed && master ? JSON.parse(await unseal(r.secrets_sealed, master)) : {}, bridge: r.bridge ?? null })
    }
    return out
  }
  /** The engine's own calls about connections: download a bridge by its hash; upload a bridge written on the engine (by
   *  the connector agent) — the engine generates it, so it comes up here first and goes back down like any other. */
  private async engineConnections(request: Request, path: string): Promise<Response> {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const key = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!key || !this.keyMatches(key)) return json({ error: 'only this project\'s engine' }, 401)
    const bucket = (this.env as any).PACKAGES as R2Bucket | undefined
    if (!bucket) return json({ error: 'no bucket' }, 503)
    const c = path.match(/^\/engine\/connections\/([\w.-]{1,80})$/)
    if (c && request.method === 'PUT') {
      const body: any = await request.json().catch(() => null)
      const name = c[1]
      const code = typeof body?.bridge === 'string' ? body.bridge : null
      if (!code || code.length > 2_000_000) return json({ error: 'an upload carries the bridge\'s code' }, 400)
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((x) => x.toString(16).padStart(2, '0')).join('')
      await putObject(bucket, this.ledger(), { key: `bridge/${this._pid}/${hash}`, kind: 'bridge', bytes: new TextEncoder().encode(code).byteLength, by: 'engine', body: code, contentType: 'text/javascript', once: true })
      const [have] = [...this.ctx.storage.sql.exec("SELECT id, bridge FROM connections WHERE name = ? AND level = 'project' AND removed_at IS NULL", name)] as any[]
      if (have) this.ctx.storage.sql.exec('UPDATE connections SET bridge = ? WHERE id = ?', hash, have.id)
      else this.ctx.storage.sql.exec("INSERT INTO connections (id, connector, name, level, owner, settings, secrets_sealed, created_by, created_at, bridge) VALUES (?, 'code', ?, 'project', 'project', '{}', NULL, 'engine', ?, ?)",
        `con_${crypto.randomUUID().slice(0, 12)}`, name, new Date().toISOString(), hash)
      this.audit.record({ actor: { kind: 'engine', id: 'engine' }, via: 'engine', action: 'connection.bridge', target: name, outcome: 'ok', detail: { bridge: hash, made: !have } })
      if (!have || have.bridge !== hash) this.sendToRole('code-engine', { t: 'connections:changed' })
      return json({ name, bridge: hash, changed: !have || have.bridge !== hash })
    }
    return json({ error: 'not found' }, 404)
  }

  // ── The project's app: published here, downloaded by the engine (one path) ──────────────────────────────────────
  /** A version of the project's app, published by a person (sacli app publish): its files kept by hash, the engine told. */
  private async publishApp(files: Record<string, string>, by: string): Promise<{ hash: string; changed: boolean }> {
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('an app is its files: { "<path>": "<text>" }')
    const paths = Object.keys(files).sort()
    if (!paths.length || !paths.some((p) => p === 'server/index.mjs')) throw new Error('an app has server/index.mjs')
    let bytes = 0
    for (const p of paths) {
      if (!/^(server|web)\/[\w@.+-]+(\/[\w@.+-]+)*$/.test(p) || /(^|\/)(node_modules|dist)(\/|$)/.test(p)) throw new Error(`"${p}" is not a file of an app (server/…, web/… — no node_modules, no builds)`)
      if (typeof files[p] !== 'string') throw new Error(`${p} is not text`)
      bytes += files[p].length
    }
    if (bytes > 16 * 1024 * 1024) throw new Error('an app is at most 16 MB of source')
    const body = JSON.stringify(Object.fromEntries(paths.map((p) => [p, files[p]])))
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map((x) => x.toString(16).padStart(2, '0')).join('')
    const [cur] = [...this.ctx.storage.sql.exec('SELECT hash FROM app_versions ORDER BY rowid DESC LIMIT 1')] as any[]
    if (cur?.hash === hash) return { hash, changed: false }
    await putObject((this.env as any).PACKAGES as R2Bucket, this.ledger(), { key: `app/${this._pid}/${hash}`, kind: 'app', bytes: new TextEncoder().encode(body).byteLength, by, body, contentType: 'application/json', once: true })
    this.ctx.storage.sql.exec('INSERT INTO app_versions (hash, at, by, files, bytes) VALUES (?, ?, ?, ?, ?)', hash, new Date().toISOString(), by, paths.length, bytes)
    this.sendToRole('code-engine', { t: 'app:changed', hash })
    return { hash, changed: true }
  }
  /** The engine's own calls: which app version is current, and its files by hash. */
  private async engineApp(request: Request, path: string): Promise<Response> {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const key = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!key || !this.keyMatches(key)) return json({ error: 'only this project\'s engine' }, 401)
    if (path === '/engine/app') { const [cur] = [...this.ctx.storage.sql.exec('SELECT hash, at, by FROM app_versions ORDER BY rowid DESC LIMIT 1')] as any[]; return json({ app: cur ?? null }) }
    const hash = path.slice('/engine/app/'.length)
    const o = await ((this.env as any).PACKAGES as R2Bucket).get(`app/${this._pid}/${hash}`)
    return o ? new Response(await o.text(), { headers: { 'content-type': 'application/json' } }) : json({ error: 'there is no such app version' }, 404)
  }

  // ── Usage and credits (metering.ts) ───────────────────────────────────────
  private prices: { at: number; list: Price[] } | null = null
  private async priceList(): Promise<Price[]> {
    if (this.prices && Date.now() - this.prices.at < 5 * 60_000) return this.prices.list
    const g = this.env.GLOBAL.get(this.env.GLOBAL.idFromName('global'))
    const list = ((await (await g.fetch('http://do/prices')).json()) as any).prices ?? []
    this.prices = { at: Date.now(), list }
    return list
  }
  /** One model call's usage as its harness reported it: kept, priced now, and debited from the organisation's credits. */
  private async addUsage(b: any, source: 'engine'): Promise<{ ok: true; credits_micro: number; priced: boolean; session: string | null }> {
    const tin = Math.max(0, Math.round(Number(b.in) || 0)), tout = Math.max(0, Math.round(Number(b.out) || 0))
    const price = priceFor(await this.priceList(), String(b.provider ?? ''), b.model ? String(b.model) : undefined)
    const micro = costOf(price, tin, tout)
    const at = new Date().toISOString()
    // Who it was for, when the call said which session it served (the proxy path's session tag).
    const owner = b.session ? ([...this.ctx.storage.sql.exec('SELECT principal, email FROM session_owners WHERE session = ?', String(b.session))][0] as any) : null
    // The person the turn named (the engine knows who asked), else the session's owner as the hub saw them.
    const principal = (typeof b.person === 'string' && /^(email|user|agent):\S+$/.test(b.person) ? b.person : null) ?? (owner ? (owner.email ? `email:${String(owner.email).toLowerCase()}` : owner.principal) : null)
    const cacheR = Math.max(0, Math.round(Number(b.cacheRead) || 0)), cacheW = Math.max(0, Math.round(Number(b.cacheWrite) || 0))
    this.ctx.storage.sql.exec('INSERT INTO usage_events (at, kind, provider, model, key_id, tokens_in, tokens_out, ms, credits_micro, priced, principal, session, tag, source, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      at, 'model.tokens', b.provider ?? null, b.model ?? null, b.keyId ?? null, tin, tout, Number(b.ms) || null, micro, price ? 1 : 0, principal, b.session ?? null, b.tag ?? null, source, cacheR, cacheW)
    const seq = Number(([...this.ctx.storage.sql.exec('SELECT last_insert_rowid() AS id')][0] as any)?.id ?? 0)
    this.record('usage', String(seq), { at, provider: b.provider ?? null, model: b.model ?? null, key_id: b.keyId ?? null, tokens_in: tin, tokens_out: tout, ms: Number(b.ms) || null, credits_micro: micro, priced: !!price, principal, session: b.session ?? null, tag: b.tag ?? null, source, tokens_cache_read: cacheR, tokens_cache_write: cacheW }, at)
    const org = await this.orgId()
    if (org && micro > 0) {
      await this.env.ORG.get(this.env.ORG.idFromName(org)).fetch('http://do/credits/usage', { method: 'POST', body: JSON.stringify({ project: this._pid, credits_micro: micro, at, principal }) }).catch(() => {})
      if (this.creditCache) this.creditCache.balance -= micro
    }
    return { ok: true, credits_micro: micro, priced: !!price, session: b.session ?? null }
  }
  // ── Cloud connectors (connectors/): a connection's connector run in its sandbox, governed here ──
  /** A connection as someone may run it: a shared one for anyone in the project, a personal one for its owner alone
   *  (no one runs with another person's credentials); its secrets unsealed for the gateway alone. */
  private async connectionToRun(id: string, sender: ConnInfo) {
    const [r] = [...this.ctx.storage.sql.exec('SELECT * FROM connections WHERE id = ? AND removed_at IS NULL', id)] as any[]
    if (!r) throw new Error(`there is no connection ${id}`)
    const me = sender.email ? `email:${sender.email.toLowerCase()}` : this.principalOf(sender)
    if (r.level === 'user' && r.owner !== me) throw new Error(`connection ${id} is someone else's`)
    if (!manifestOf(r.connector)) throw new Error(`${r.name} is not a cloud connector; the engine runs it`)
    const master = (this.env as any).CREDENTIALS_MASTER_KEY
    const secrets = r.secrets_sealed ? JSON.parse(await unseal(r.secrets_sealed, master)) : {}
    const version = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${r.settings}|${r.secrets_sealed ?? ''}`)))].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('')
    return { id: r.id as string, name: r.name as string, connector: r.connector as string, settings: JSON.parse(r.settings), secrets, version }
  }
  private recordCall(c: { connection?: string | null; op: string; target?: string | null; by?: string | null; ok: boolean; rows?: number | null; status?: number | null; ms?: number | null; error?: string | null }) {
    this.ctx.storage.sql.exec('INSERT INTO connector_calls (at, connection, op, target, by, ok, rows, status, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      new Date().toISOString(), c.connection ?? null, c.op, c.target ?? null, c.by ?? null, c.ok ? 1 : 0, c.rows ?? null, c.status ?? null, c.ms ?? null, c.error ? String(c.error).slice(0, 500) : null)
  }
  private async connectorCalls(request: Request): Promise<Response> {
    const b: any = await request.json().catch(() => ({}))
    for (const c of Array.isArray(b.calls) ? b.calls.slice(0, 200) : []) this.recordCall({ connection: String(b.connection ?? ''), op: 'http', target: `${c.method} ${c.host}${c.path}`, ok: !c.refused && c.status < 400, status: c.status, ms: c.ms, error: c.refused ?? null })
    return this.j({ ok: true })
  }
  /** One connector operation for someone: catalog, test, introspect, read, act (a change needs a person's confirmation),
   *  run (code mode), calls (the record). Every operation is recorded. */
  private async connectorOp(sender: ConnInfo, op: string, pl: any): Promise<Record<string, unknown>> {
    const who = sender.email ? `email:${sender.email.toLowerCase()}` : this.principalOf(sender)
    if (!who) throw new Error('who is asking is not known')
    const exportsObj = (this.ctx as any).exports
    if (op === 'catalog') return { connectors: CONNECTORS.filter((c) => c.runs === 'cloud') }
    if (op === 'calls') {
      const id = String(pl.connection ?? ''); await this.connectionToRun(id, sender)
      return { calls: [...this.ctx.storage.sql.exec('SELECT * FROM connector_calls WHERE connection = ? ORDER BY seq DESC LIMIT 100', id)] }
    }
    if (op === 'run') {
      const code = String(pl.code ?? '')
      if (!code.trim() || code.length > 100_000) throw new Error('code mode runs a program of at most 100,000 characters')
      const t0 = Date.now()
      let r: Awaited<ReturnType<typeof runCode>> = { ok: false, error: 'the program did not run', logs: [] }
      try { r = await runCode(this.env, exportsObj, this._pid, { type: sender.type, userId: sender.userId, email: sender.email, admin: can(this.capsOf(sender), 'project.data'), scopes: this.scopesOf(sender) }, code) }
      catch (e: any) { r = { ok: false, error: e?.message ?? String(e), logs: [] } }
      finally { this.recordCall({ op: 'run', target: `${code.length} characters`, by: who, ok: r.ok, ms: Date.now() - t0, error: r.error ?? null }) }
      return r as unknown as Record<string, unknown>
    }
    const c = await this.connectionToRun(String(pl.connection ?? ''), sender)
    const t0 = Date.now()
    if (op === 'act') {
      const latest = [...this.ctx.storage.sql.exec('SELECT actions FROM connector_schemas WHERE connection = ? ORDER BY seq DESC LIMIT 1', c.id)][0] as any
      const actions: any[] = latest ? JSON.parse(String(latest.actions)) : (((await runConnector(this.env, exportsObj, this._pid, c, 'introspect', null)).result as any)?.actions ?? [])
      const spec = actions.find((a) => a.name === pl.action)
      if (!spec) throw new Error(`${c.name} has no action "${pl.action}"`)
      if ((spec.effect !== 'read' || spec.confirm) && !(pl.confirmed === true && sender.type !== 'agent')) {
        this.recordCall({ connection: c.id, op: 'act', target: spec.name, by: who, ok: false, error: 'needs a person\'s confirmation' })
        throw new Error(`${spec.label ?? spec.name} ${spec.effect === 'irreversible' ? 'cannot be undone' : 'changes'} ${c.name}: a person confirms it before it runs`)
      }
    }
    const req = op === 'read' ? { entity: pl.entity, filters: pl.filters ?? {}, cursor: pl.cursor ?? null, since: pl.since ?? null, limit: Math.min(Number(pl.limit) || 100, 1000) } : op === 'act' ? { action: pl.action, input: pl.input ?? {} } : null
    if (!['test', 'introspect', 'read', 'act'].includes(op)) throw new Error(`there is no connector operation "${op}"`)
    const r = await runConnector(this.env, exportsObj, this._pid, c, op as any, req)
    const rows = op === 'read' && r.ok ? ((r.result as any)?.rows?.length ?? 0) : null
    this.recordCall({ connection: c.id, op, target: op === 'read' ? String(pl.entity) : op === 'act' ? String(pl.action) : null, by: who, ok: r.ok, rows, ms: Date.now() - t0, error: r.error ?? null })
    if (op === 'introspect' && r.ok) this.ctx.storage.sql.exec('INSERT INTO connector_schemas (connection, entities, actions, at) VALUES (?, ?, ?, ?)', c.id, JSON.stringify((r.result as any)?.entities ?? []), JSON.stringify((r.result as any)?.actions ?? []), new Date().toISOString())
    if (op === 'act') this.audit.record({ actor: { kind: sender.type === 'agent' ? 'agent' : 'user', id: who, ...(sender.email ? { email: sender.email } : {}) }, via: sender.type === 'agent' ? 'agent' : 'ui', action: 'connector.act', target: `${c.id}/${pl.action}`, outcome: r.ok ? 'ok' : 'error', detail: { input: Object.keys(pl.input ?? {}) } })
    if (!r.ok) throw new Error(r.error ?? 'the connector failed')
    return { connection: c.id, op, result: r.result, logs: r.logs }
  }

  /** Each table's latest grant, unless revoked. */
  private grantRows(): { tbl: string; columns: string[] | null; write: boolean }[] {
    return ([...this.ctx.storage.sql.exec('SELECT g.tbl, g.columns, g.revoked, g.write FROM warehouse_grants g JOIN (SELECT tbl, MAX(seq) AS m FROM warehouse_grants GROUP BY tbl) x ON x.m = g.seq')] as any[])
      .filter((r) => !r.revoked).map((r) => ({ tbl: String(r.tbl), columns: r.columns === null ? null : JSON.parse(String(r.columns)), write: !!r.write }))
  }
  /** What this project may read of its organisation's warehouse: a table, and its columns or all of them. */
  private grantInForce(): Record<string, string[] | null> { return Object.fromEntries(this.grantRows().map((r) => [r.tbl, r.columns])) }
  /** The tables this project may append to. */
  private writableInForce(): string[] { return this.grantRows().filter((r) => r.write).map((r) => r.tbl) }
  /** The grants, set by the organisation's administrator through the worker (never from a hub message). */
  private async warehouseGrants(request: Request): Promise<Response> {
    if (request.method === 'GET') return Response.json({ grant: this.grantInForce(), writable: this.writableInForce(), history: [...this.ctx.storage.sql.exec('SELECT * FROM warehouse_grants ORDER BY seq DESC LIMIT 100')] })
    const b: any = await request.json().catch(() => ({}))
    const tbl = String(b.table ?? '')
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(tbl)) return Response.json({ error: 'name the table' }, { status: 400 })
    const by = String(b.by ?? 'admin'), at = new Date().toISOString()
    if (request.method === 'DELETE') this.ctx.storage.sql.exec('INSERT INTO warehouse_grants (tbl, columns, revoked, by, at) VALUES (?, NULL, 1, ?, ?)', tbl, by, at)
    else {
      const cols = b.columns === null || b.columns === undefined ? null : Array.isArray(b.columns) && b.columns.every((c: unknown) => typeof c === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(c)) ? b.columns : undefined
      if (cols === undefined) return Response.json({ error: 'columns are a list of column names, or null for all of them' }, { status: 400 })
      // Writing is the whole table or nothing: an append carries every column, so a write grant is all columns too.
      if (b.write === true && cols !== null) return Response.json({ error: 'a project that may write a table reads all of it — leave columns empty' }, { status: 400 })
      this.ctx.storage.sql.exec('INSERT INTO warehouse_grants (tbl, columns, revoked, by, at, write) VALUES (?, ?, 0, ?, ?, ?)', tbl, cols === null ? null : JSON.stringify(cols), by, at, b.write === true ? 1 : 0)
    }
    this.audit.record({ actor: { kind: 'user', id: by }, via: 'ui', action: request.method === 'DELETE' ? 'warehouse.revoke' : 'warehouse.grant', target: tbl, outcome: 'ok', detail: { columns: b.columns ?? null, write: b.write === true } })
    return Response.json({ grant: this.grantInForce(), writable: this.writableInForce() })
  }
  private usageSummary(url: URL): Response {
    const since = url.searchParams.get('since') ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
    // PER PERSON: who used what — every call counted, those no turn named kept as the project's own ('unattributed').
    if (url.searchParams.get('by') === 'person') {
      const until = url.searchParams.get('until') ?? '9999'
      const people = [...this.ctx.storage.sql.exec(`SELECT COALESCE(principal, 'unattributed') AS person, COUNT(*) AS calls, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
        SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write, SUM(credits_micro) AS credits_micro, SUM(1 - priced) AS unpriced,
        MIN(at) AS first_at, MAX(at) AS last_at FROM usage_events WHERE at >= ? AND at < ? GROUP BY person ORDER BY credits_micro DESC, tokens_in DESC`, since, until)]
      return this.j({ since, until, people })
    }
    const rows = [...this.ctx.storage.sql.exec(`SELECT substr(at, 1, 10) AS day, provider, model, COUNT(*) AS calls, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
      SUM(credits_micro) AS credits_micro, SUM(1 - priced) AS unpriced FROM usage_events WHERE at >= ? GROUP BY day, provider, model ORDER BY day DESC`, since)]
    return this.j({ since, usage: rows })
  }
  /** May this person still spend? Their own budget and their groups', against the usage attributed to them. */
  private async budgetLeft(c: ConnInfo): Promise<{ ok: true } | { ok: false; reason: string }> {
    const org = await this.orgId()
    if (!org || !c.email) return { ok: true }
    const groups = [...this.ctx.storage.sql.exec('SELECT grp FROM group_members WHERE member = ?', `email:${c.email.toLowerCase()}`)].map((r: any) => String(r.grp))
    const members: Record<string, string[]> = {}
    for (const g of groups) members[`group:${g}`] = [...this.ctx.storage.sql.exec("SELECT member FROM group_members WHERE grp = ? AND member LIKE 'email:%'", g)].map((r: any) => String(r.member))
    try { return await (await this.env.ORG.get(this.env.ORG.idFromName(org)).fetch('http://do/credits/allowance', { method: 'POST', body: JSON.stringify({ email: c.email, groups, members }) })).json() as any }
    catch { return { ok: true } }   // the ledger unreachable: do not stop work over a check that could not be made
  }

  /** May this organisation still spend? Only an organisation on a credit plan (given credits) is ever limited. The
   *  balance is cached only while there are credits left (and decremented by each use recorded here); "no plan" and
   *  "used up" are always asked again, so a grant counts from the next piece of work. */
  private creditCache: { at: number; balance: number } | null = null
  private async creditsLeft(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const org = await this.orgId()
    if (!org) return { ok: true }
    if (this.creditCache && this.creditCache.balance > 0 && Date.now() - this.creditCache.at < 60_000) return { ok: true }
    let c: any
    try { c = await (await this.env.ORG.get(this.env.ORG.idFromName(org)).fetch('http://do/credits')).json() }
    catch { return { ok: true } }   // the ledger unreachable: do not stop work over a check that could not be made
    if (!c.plan) { this.creditCache = null; return { ok: true } }
    const balance = Number(c.balance_micro) || 0
    this.creditCache = balance > 0 ? { at: Date.now(), balance } : null
    return balance > 0 ? { ok: true } : { ok: false, reason: 'this organisation has used all its credits — an administrator can add more' }
  }

  // ── Connections to other systems (shared/connectors.ts) ────────────────────
  /** Connections a person may see: the project's shared ones and their own; never a secret. An admin sees all. */
  private connectionRows(who: string | null, admin: boolean) {
    const ready = new Map(([...this.ctx.storage.sql.exec('SELECT * FROM engine_sources')] as any[]).map((e) => [String(e.id), e]))
    return ([...this.ctx.storage.sql.exec('SELECT id, connector, name, level, owner, settings, kind, dialect, description, auth, created_by, created_at FROM connections WHERE removed_at IS NULL ORDER BY created_at')] as any[])
      .filter((r) => admin || r.level === 'project' || r.owner === who).map((r) => {
        const runs = connectorById(r.connector)?.runs ?? 'api'
        // a code connection runs on the engine: runnable when the engine says its source is ready
        const ran = runs === 'code' ? ready.get(r.name) : undefined
        return { ...r, settings: JSON.parse(r.settings), runs, runnable: runs === 'code' ? !!ran?.ready : ['api', 'cloud'].includes(runs), ...(ran ? { source: { kind: ran.kind, dialect: ran.dialect, description: ran.description } } : {}), origin: 'platform' }
      })
  }
  // ── What this project keeps in the bucket (storage.ts): its ledger ──
  /** This project's ledger, for writers inside this object. */
  ledger(): Ledger {
    const sql = this.ctx.storage.sql
    return {
      add: async (rows: LedgerRow[]) => { for (const r of rows) this.ledgerAdd(r) },
      forget: async (keys: string[]) => { for (const k of keys) sql.exec('DELETE FROM stored_objects WHERE key = ?', k) },
    }
  }
  private ledgerAdd(r: LedgerRow) {
    if (projectOfObject(r.key) !== this._pid || kindOfKey(r.key) !== r.kind || !(Number(r.bytes) >= 0)) throw new Error(`${r.key} is not one of this project's ${r.kind} objects`)
    this.ctx.storage.sql.exec('INSERT INTO stored_objects (key, kind, bytes, by, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING', r.key, r.kind, Number(r.bytes), r.by ?? null, new Date().toISOString())
  }
  /** Objects still in use are not deleted: a source's bridge, a program in the catalogue, the app version engines run. */
  private inUse(key: string): string | null {
    const kind = kindOfKey(key), hash = key.split('/').pop()?.replace(/\.json$/, '') ?? ''
    if (kind === 'bridge' && this.ctx.storage.sql.exec('SELECT name FROM connections WHERE bridge = ? AND removed_at IS NULL', hash).toArray().length) return 'a data source runs this bridge'
    if (kind === 'program' && this.ctx.storage.sql.exec('SELECT 1 FROM programs WHERE hash = ?', hash).toArray().length) return 'it is a program in the catalogue'
    if (kind === 'app') { const [v] = this.ctx.storage.sql.exec('SELECT hash FROM app_versions ORDER BY at DESC LIMIT 1').toArray() as any[]; if (v?.hash === hash) return 'it is the app version engines run' }
    return null
  }
  /** GET /storage — totals by kind and by person (anyone in the project), and the objects themselves (a person's own;
   *  every one's for someone who runs the project): ?list=1&by=<who>&kind=<kind>&page=<n>.
   *  DELETE /storage { keys } | { everything: true, by? } — a person removes their own, someone who runs the project
   *  anyone's (never what is in use).
   *  POST /storage/add { rows } · /storage/forget { keys } — the platform's own writers outside this object. */
  private async storageApi(request: Request, path: string): Promise<Response> {
    const sql = this.ctx.storage.sql
    const body: any = request.method === 'GET' ? {} : await request.json().catch(() => ({}))
    if (path === '/storage/add' && request.method === 'POST') { try { for (const r of body.rows ?? []) this.ledgerAdd(r) } catch (e: any) { return this.j({ error: e.message }, 400) } return this.j({ ok: true }) }
    // ONE-OFF (removed once run): objects stored before this ledger existed, recorded from the bucket's own listing.
    if (path === '/storage/backfill' && request.method === 'POST') {
      if (!can(this.capsOfRequest(request), 'project.manage')) return this.j({ error: 'needs project.manage' }, 403)
      const bucket = (this.env as any).PACKAGES as R2Bucket
      let seen = 0
      for (const prefix of prefixesOf(this._pid)) {
        let cursor: string | undefined
        do {
          const page = await bucket.list({ prefix, cursor })
          for (const o of page.objects) { const kind = kindOfKey(o.key); if (kind) { this.ledgerAdd({ key: o.key, kind, bytes: o.size, by: null }); seen++ } }
          cursor = page.truncated ? page.cursor : undefined
        } while (cursor)
      }
      return this.j({ seen, recorded: Number((sql.exec('SELECT COUNT(*) AS n FROM stored_objects').toArray()[0] as any).n) })
    }
    if (path === '/storage/forget' && request.method === 'POST') { for (const k of body.keys ?? []) sql.exec('DELETE FROM stored_objects WHERE key = ?', String(k)); return this.j({ ok: true }) }
    let actorH: any = null
    try { actorH = JSON.parse(request.headers.get('x-sa-actor') ?? 'null') } catch { /* none */ }
    const me = String(actorH?.email ?? actorH?.id ?? '')
    const all = can(this.capsOfRequest(request), 'project.manage')
    if (path === '/storage' && request.method === 'GET') {
      const q = new URL(request.url).searchParams
      const totals = sql.exec('SELECT COUNT(*) AS objects, COALESCE(SUM(bytes), 0) AS bytes FROM stored_objects').toArray()[0] as any
      const byKind = sql.exec('SELECT kind, COUNT(*) AS objects, SUM(bytes) AS bytes FROM stored_objects GROUP BY kind ORDER BY bytes DESC').toArray()
      const byPerson = sql.exec("SELECT COALESCE(by, 'before the ledger') AS by, COUNT(*) AS objects, SUM(bytes) AS bytes FROM stored_objects GROUP BY by ORDER BY bytes DESC").toArray()
      const out: Record<string, unknown> = { project: this._pid, objects: Number(totals.objects), bytes: Number(totals.bytes), byKind, byPerson: all ? byPerson : byPerson.filter((r: any) => r.by === me) }
      if (q.get('list')) {
        const who = all ? q.get('by') : me, kind = q.get('kind'), page = Math.max(1, Number(q.get('page')) || 1)
        if (kind && !(kind in KINDS)) return this.j({ error: `a kind is one of ${Object.keys(KINDS).join(', ')}` }, 400)
        const where = [who ? 'by = ?' : '', kind ? 'kind = ?' : ''].filter(Boolean)
        const bind = [...(who ? [who] : []), ...(kind ? [kind] : [])]
        out.list = sql.exec(`SELECT key, kind, bytes, by, at FROM stored_objects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT 100 OFFSET ?`, ...bind, (page - 1) * 100).toArray()
          .map((r: any) => ({ ...r, inUse: this.inUse(r.key) }))
        out.listed = Number((sql.exec(`SELECT COUNT(*) AS n FROM stored_objects ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...bind).toArray()[0] as any).n)
      }
      return this.j(out)
    }
    if (path === '/storage' && request.method === 'DELETE') {
      // Everything of one person's ({ everything: true } — one's own; someone who runs the project names whose with by), or
      // the objects named.
      const whose = body.everything === true ? (all && typeof body.by === 'string' ? body.by : me) : null
      if (whose !== null && !whose) return this.j({ error: 'whose objects?' }, 400)
      const keys: string[] = whose !== null ? (sql.exec('SELECT key FROM stored_objects WHERE by = ?', whose).toArray() as any[]).map((r) => String(r.key)) : Array.isArray(body.keys) ? body.keys.map(String) : []
      if (!keys.length) return this.j(whose !== null ? { removed: 0, refused: [] } : { error: 'which objects? { keys: [...] } or { everything: true }' }, whose !== null ? 200 : 400)
      const refused: { key: string; why: string }[] = [], doomed: string[] = []
      for (const k of keys) {
        const [r] = sql.exec('SELECT key, by FROM stored_objects WHERE key = ?', k).toArray() as any[]
        if (!r) { refused.push({ key: k, why: 'not one of this project\'s objects' }); continue }
        if (!all && r.by !== me) { refused.push({ key: k, why: 'not yours' }); continue }
        const why = this.inUse(k)
        if (why) { refused.push({ key: k, why: `in use: ${why}` }); continue }
        doomed.push(k)
      }
      const bucket = (this.env as any).PACKAGES as R2Bucket
      const removed = doomed.length ? await removeObjects(bucket, this.ledger(), doomed) : 0
      this.audit.record({ actor: { kind: actorH?.kind === 'agent' ? 'agent' : 'user', id: me || 'unknown', ...(actorH?.email ? { email: actorH.email } : {}) }, via: 'api', action: 'storage.delete', target: `${removed} objects`, outcome: 'ok', detail: { removed: doomed, refused } })
      return this.j({ removed, refused })
    }
    return this.j({ error: 'not found' }, 404)
  }

  /** What a source is and how people reach it, as given — or why not. */
  private aboutSource(body: any): { kind?: string; dialect?: string; description?: string; auth?: 'shared' | 'per-user' } | string {
    const out: { kind?: string; dialect?: string; description?: string; auth?: 'shared' | 'per-user' } = {}
    for (const k of ['kind', 'dialect'] as const) if (body[k] !== undefined) { if (typeof body[k] !== 'string' || !/^[a-z][\w-]{0,40}$/.test(body[k])) return `${k} is a short lower-case word`; out[k] = body[k] }
    if (body.description !== undefined) { if (typeof body.description !== 'string' || body.description.length > 4000) return 'a description is text of at most 4000 characters'; out.description = body.description }
    if (body.auth !== undefined) { if (body.auth !== 'shared' && body.auth !== 'per-user') return 'auth is "shared" (one key) or "per-user" (each person\'s own key)'; out.auth = body.auth }
    return out
  }
  private async connectionsApi(request: Request, path: string): Promise<Response> {
    const url = new URL(request.url)
    const body: any = request.method === 'GET' ? {} : await request.json().catch(() => ({}))
    let actorH: any = null
    try { actorH = JSON.parse(request.headers.get('x-sa-actor') ?? 'null') } catch { /* none */ }
    const email = String(actorH?.email ?? body.by ?? '').toLowerCase()
    const who = email ? `email:${email}` : null
    const admin = can(this.capsOfRequest(request), 'project.data')
    const actor = { kind: 'user' as const, id: email || 'unknown', ...(email ? { email } : {}) }
    if (path === '/connectors' && request.method === 'GET') return this.j({ connectors: CONNECTORS })
    if (path === '/connections' && request.method === 'GET') return this.j({ connections: this.connectionRows(who, admin) })
    if (!who) return this.j({ error: 'who is making the change?' }, 400)
    if (path === '/connections' && request.method === 'POST') {
      const c = connectorById(String(body.connector ?? ''))
      if (!c) return this.j({ error: `there is no connector ${body.connector}` }, 400)
      const level = body.level === 'user' ? 'user' : 'project'
      if (!c.levels.includes(level)) return this.j({ error: `${c.title} is connected ${c.levels.map((l) => l === 'project' ? 'for the whole project' : 'per person').join(' or ')}` }, 400)
      if (level === 'project' && !admin) return this.j({ error: 'a connection shared by the project needs project.data; connect your own instead' }, 403)
      const name = String(body.name ?? '').trim()
      if (!name || name.length > 80) return this.j({ error: 'a connection has a name of at most 80 characters' }, 400)
      const { problems, settings, secrets } = checkConnection(c, body.values ?? {})
      if (problems.length) return this.j({ error: problems.join('; ') }, 400)
      const master = (this.env as any).CREDENTIALS_MASTER_KEY
      if (Object.keys(secrets).length && !master) return this.j({ error: 'secrets cannot be kept: the platform has no master key' }, 503)
      const id = `con_${crypto.randomUUID().slice(0, 12)}`
      const about = this.aboutSource(body)
      if (typeof about === 'string') return this.j({ error: about }, 400)
      if (this.ctx.storage.sql.exec("SELECT 1 FROM connections WHERE name = ? AND removed_at IS NULL", name).toArray().length) return this.j({ error: `there is a connection named ${name} already` }, 409)
      this.ctx.storage.sql.exec('INSERT INTO connections (id, connector, name, level, owner, settings, secrets_sealed, kind, dialect, description, auth, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, c.id, name, level, level === 'user' ? who : 'project', JSON.stringify(settings), Object.keys(secrets).length ? await seal(JSON.stringify(secrets), master) : null,
        about.kind ?? c.kind ?? null, about.dialect ?? null, about.description ?? null, about.auth ?? 'shared', email, new Date().toISOString())
      this.audit.record({ actor, via: 'ui', action: 'connection.create', target: id, outcome: 'ok', detail: { connector: c.id, name, level, settings } })   // never the secrets
      if (c.runs === 'code') this.sendToRole('code-engine', { t: 'connections:changed' })
      return this.j({ connection: { id, connector: c.id, name, level, settings, runnable: !!c.bridge || c.runs === 'cloud' } }, 201)
    }
    const m = path.match(/^\/connections\/(con_[\w-]+)$/)
    // A source's settings, secrets (a secret left out is kept), what it is, and how people reach it — its admins change them.
    if (m && request.method === 'PATCH') {
      const [r] = [...this.ctx.storage.sql.exec('SELECT * FROM connections WHERE id = ? AND removed_at IS NULL', m[1])] as any[]
      if (!r) return this.j({ error: `there is no connection ${m[1]}` }, 404)
      if (!admin && r.owner !== who) return this.j({ error: 'only its owner, or someone with project.data, changes a connection' }, 403)
      const c = connectorById(r.connector)!
      const about = this.aboutSource(body)
      if (typeof about === 'string') return this.j({ error: about }, 400)
      const master = (this.env as any).CREDENTIALS_MASTER_KEY
      const before = r.secrets_sealed && master ? JSON.parse(await unseal(r.secrets_sealed, master)) : {}
      const given = body.values && typeof body.values === 'object' ? body.values : {}
      const merged = c.id === 'code'   // free-form: its settings and its secrets, each map kept and added to
        ? { settings: { ...JSON.parse(r.settings), ...(given.settings ?? {}) }, secrets: { ...before, ...(given.secrets ?? {}) } }
        : { ...JSON.parse(r.settings), ...before, ...given }
      const { problems, settings, secrets } = checkConnection(c, merged)
      if (problems.length) return this.j({ error: problems.join('; ') }, 400)
      if (Object.keys(secrets).length && !master) return this.j({ error: 'secrets cannot be kept: the platform has no master key' }, 503)
      this.ctx.storage.sql.exec('UPDATE connections SET settings = ?, secrets_sealed = ?, kind = COALESCE(?, kind), dialect = COALESCE(?, dialect), description = COALESCE(?, description), auth = COALESCE(?, auth) WHERE id = ?',
        JSON.stringify(settings), Object.keys(secrets).length ? await seal(JSON.stringify(secrets), master) : null, about.kind ?? null, about.dialect ?? null, about.description ?? null, about.auth ?? null, m[1])
      this.audit.record({ actor, via: 'ui', action: 'connection.change', target: m[1], outcome: 'ok', detail: { settings, secretsChanged: Object.keys(c.id === 'code' ? given.secrets ?? {} : given).filter((k) => k in secrets), ...about } })   // never the secrets
      if (c.runs === 'code') this.sendToRole('code-engine', { t: 'connections:changed' })
      return this.j({ connection: this.connectionRows(who, admin).find((x: any) => x.id === m[1]) })
    }
    // A source's bridge — the code its connector runs (a template's copy, written by a person or an agent, sent with sacli):
    // kept by its hash in the bucket, the connection pointing at it; the engine downloads it and loads it.
    const br = path.match(/^\/connections\/(con_[\w-]+)\/bridge$/)
    if (br && request.method === 'PUT') {
      const [r] = [...this.ctx.storage.sql.exec('SELECT * FROM connections WHERE id = ? AND removed_at IS NULL', br[1])] as any[]
      if (!r) return this.j({ error: `there is no connection ${br[1]}` }, 404)
      if (!admin) return this.j({ error: "a source's code is set by someone with project.data" }, 403)
      if (connectorById(r.connector)?.runs !== 'code') return this.j({ error: `${r.name} runs no code of its own` }, 400)
      const code = typeof body.code === 'string' ? body.code : ''
      if (!code.trim() || code.length > 2_000_000) return this.j({ error: 'a bridge is the code of a module (at most 2 MB) exporting createBridge' }, 400)
      if (!/export\s+(async\s+)?function\s+createBridge|export\s+(const|let)\s+createBridge/.test(code)) return this.j({ error: 'a bridge exports createBridge({ settings, secrets })' }, 400)
      const bucket = (this.env as any).PACKAGES as R2Bucket | undefined
      if (!bucket) return this.j({ error: 'no bucket to keep it in' }, 503)
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((x) => x.toString(16).padStart(2, '0')).join('')
      await putObject(bucket, this.ledger(), { key: `bridge/${this._pid}/${hash}`, kind: 'bridge', bytes: new TextEncoder().encode(code).byteLength, by: email || 'unknown', body: code, contentType: 'text/javascript', once: true })
      this.ctx.storage.sql.exec('UPDATE connections SET bridge = ? WHERE id = ?', hash, br[1])
      this.audit.record({ actor, via: 'ui', action: 'connection.bridge', target: br[1], outcome: 'ok', detail: { bridge: hash, bytes: code.length } })
      if (r.bridge !== hash) this.sendToRole('code-engine', { t: 'connections:changed' })
      return this.j({ bridge: hash, changed: r.bridge !== hash })
    }
    // A person's own key for a source that reaches each person with their own (auth "per-user"): kept sealed, theirs only.
    const mine = path.match(/^\/connections\/(con_[\w-]+)\/my-key$/)
    if (mine) {
      const [r] = [...this.ctx.storage.sql.exec('SELECT * FROM connections WHERE id = ? AND removed_at IS NULL', mine[1])] as any[]
      if (!r) return this.j({ error: `there is no connection ${mine[1]}` }, 404)
      if (request.method === 'DELETE') { this.ctx.storage.sql.exec('DELETE FROM connection_user_keys WHERE connection = ? AND principal = ?', mine[1], who); this.audit.record({ actor, via: 'ui', action: 'connection.my-key.remove', target: mine[1], outcome: 'ok' }); return this.j({ removed: true }) }
      if (request.method !== 'PUT') return this.j({ error: 'PUT your key, or DELETE it' }, 405)
      if (r.auth !== 'per-user') return this.j({ error: `${r.name} is reached with one shared key, not each person's own` }, 400)
      const master = (this.env as any).CREDENTIALS_MASTER_KEY
      if (!master) return this.j({ error: 'secrets cannot be kept: the platform has no master key' }, 503)
      const values = body.values && typeof body.values === 'object' ? body.values : {}
      if (!Object.keys(values).length) return this.j({ error: 'your key is the values the source asks of each person' }, 400)
      this.ctx.storage.sql.exec('INSERT INTO connection_user_keys (connection, principal, secrets_sealed, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (connection, principal) DO UPDATE SET secrets_sealed = excluded.secrets_sealed, added_at = excluded.added_at',
        mine[1], who, await seal(JSON.stringify(values), master), new Date().toISOString())
      this.audit.record({ actor, via: 'ui', action: 'connection.my-key.set', target: mine[1], outcome: 'ok' })
      return this.j({ saved: true })
    }
    if (m && request.method === 'DELETE') {
      const [r] = [...this.ctx.storage.sql.exec('SELECT level, owner, removed_at FROM connections WHERE id = ?', m[1])] as any[]
      if (!r || r.removed_at) return this.j({ error: `there is no connection ${m[1]}` }, 404)
      if (!admin && r.owner !== who) return this.j({ error: 'only its owner, or someone with project.data, removes a connection' }, 403)
      this.ctx.storage.sql.exec('UPDATE connections SET removed_at = ?, removed_by = ? WHERE id = ?', new Date().toISOString(), email, m[1])
      this.audit.record({ actor, via: 'ui', action: 'connection.remove', target: m[1], outcome: 'ok' })
      this.sendToRole('code-engine', { t: 'connections:changed' })
      return this.j({ removed: m[1] })
    }
    return this.j({ error: 'not found' }, 404)
  }
  /** For the engine, when it runs a connection: its settings and secrets — a shared one for anyone, a personal one only
   *  for its owner. Over the engine's authenticated socket; never kept on the engine's disk. */
  private async connectionForEngine(id: string, principal: string | null, email: string | null) {
    const [r] = [...this.ctx.storage.sql.exec('SELECT * FROM connections WHERE id = ? AND removed_at IS NULL', id)] as any[]
    if (!r) throw new Error(`there is no connection ${id}`)
    if (r.level === 'user' && r.owner !== (email ? `email:${email.toLowerCase()}` : principal)) throw new Error(`connection ${id} is someone else's`)
    const master = (this.env as any).CREDENTIALS_MASTER_KEY
    const secrets = r.secrets_sealed ? JSON.parse(await unseal(r.secrets_sealed, master)) : {}
    this.audit.record({ actor: { kind: 'engine', id: 'engine' }, via: 'engine', action: 'connection.open', target: id, outcome: 'ok', detail: { for: principal ?? 'the project' } })
    return { id, connector: r.connector, name: r.name, level: r.level, settings: JSON.parse(r.settings), secrets }
  }

  // ── Access by verified email domain (enterprise sign-in, provisioned on first arrival) ──
  /** The access row for an address — granting it from a verified domain the first time that person arrives. */
  private accessOnArrival(email: string): { role_id: string; source: string } | null {
    const e = email.toLowerCase()
    const [row] = [...this.ctx.storage.sql.exec('SELECT role_id, source FROM access WHERE email = ?', e)] as any[]
    if (row) return row
    const domain = e.split('@')[1]
    if (!domain) return null
    const [d] = [...this.ctx.storage.sql.exec('SELECT role_id FROM access_domains WHERE domain = ?', domain)] as any[]
    if (!d) return null
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO access (email, role_id, source, added_by) VALUES (?, ?, 'domain', ?)", e, d.role_id, `domain:${domain}`)
    this.audit.record({ actor: { kind: 'system', id: 'platform' }, via: 'system', action: 'access.grant', target: e, outcome: 'ok', detail: { reason: `first sign-in from ${domain}`, role: d.role_id } })
    return { role_id: d.role_id, source: 'domain' }
  }
  /** The worker asks, for someone not yet on the access list, whether their verified domain lets them in. */
  private async arrive(request: Request): Promise<Response> {
    const b = await request.json().catch(() => ({})) as any
    const row = b?.email ? this.accessOnArrival(String(b.email)) : null
    return this.j(row ? { access: row } : { access: null }, row ? 200 : 404)
  }
  private async accessDomains(request: Request, path: string): Promise<Response> {
    const url = new URL(request.url)
    const body: any = request.method === 'GET' ? {} : await request.json().catch(() => ({}))
    const by = String(body.by ?? url.searchParams.get('by') ?? '')
    const actor = { kind: 'user' as const, id: by || 'unknown', ...(by.includes('@') ? { email: by } : {}) }
    if (request.method === 'GET') return this.j({ domains: [...this.ctx.storage.sql.exec('SELECT domain, role_id, added_by, added_at FROM access_domains ORDER BY domain')] })
    if (!by) return this.j({ error: 'who is making the change?' }, 400)
    if (request.method === 'POST' && path === '/access-domains') {
      const domain = String(body.domain ?? '').trim().toLowerCase()
      if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) return this.j({ error: 'a domain like acme.com' }, 400)
      if (['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me'].includes(domain)) return this.j({ error: `${domain} is a public mail domain: anyone could sign in with it` }, 400)
      const role = String(body.roleId ?? 'viewer')
      if (!builtinRole('project', role) && ![...this.ctx.storage.sql.exec('SELECT 1 FROM roles WHERE id = ? AND builtin = 0', role)].length) return this.j({ error: `there is no role ${role}` }, 400)
      if (beyond(this.roleCapabilities(role), PROJECT_ROLES.member.capabilities).length) return this.j({ error: 'a whole domain is admitted as a member at most: give more one by one' }, 400)
      this.ctx.storage.sql.exec('INSERT INTO access_domains (domain, role_id, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (domain) DO UPDATE SET role_id = excluded.role_id, added_by = excluded.added_by, added_at = excluded.added_at', domain, role, by, new Date().toISOString())
      this.audit.record({ actor, via: 'admin', action: 'access-domain.add', target: domain, outcome: 'ok', detail: { role } })
      return this.j({ domain, role_id: role }, 201)
    }
    const m = path.match(/^\/access-domains\/([a-z0-9.-]+)$/)
    if (m && request.method === 'DELETE') {
      if (![...this.ctx.storage.sql.exec('SELECT 1 FROM access_domains WHERE domain = ?', m[1])].length) return this.j({ error: `there is no domain ${m[1]}` }, 404)
      this.ctx.storage.sql.exec('DELETE FROM access_domains WHERE domain = ?', m[1])
      this.audit.record({ actor, via: 'admin', action: 'access-domain.remove', target: m[1], outcome: 'ok', detail: { note: 'people already let in keep their access until it is revoked' } })
      return this.j({ removed: m[1] })
    }
    return this.j({ error: 'not found' }, 404)
  }

  // ── Data access policies ───────────────────────────────────────────────────
  private accessVersion(): number { return Number([...this.ctx.storage.sql.exec('SELECT version FROM access_version')][0]?.version ?? 0) }
  private policies(): AccessPolicy[] {
    return [...this.ctx.storage.sql.exec('SELECT id, applies_to, source, table_name, kind, predicate, column_name, note FROM access_policies WHERE removed_at IS NULL ORDER BY created_at')]
      .map((r: any) => ({ id: r.id, applies_to: r.applies_to, source: r.source, table: r.table_name, kind: r.kind, predicate: r.predicate, column: r.column_name, note: r.note }))
  }
  /** A reader's policies for one source: their role from the project's access list, their attributes, every policy that applies. */
  private policiesFor(principal: string, email: string | null, source: string) {
    if (!/^(user|agent):\S+$/.test(principal)) throw new Error('who is reading is not known')
    const role = email ? ([...this.ctx.storage.sql.exec('SELECT role_id FROM access WHERE email = ?', email.toLowerCase())][0] as any)?.role_id ?? null : null
    const subject = principal.startsWith('agent:') ? principal : email ? `email:${email.toLowerCase()}` : null
    const attributes = Object.fromEntries(subject ? [...this.ctx.storage.sql.exec('SELECT key, value FROM access_attributes WHERE subject = ?', subject)].map((r: any) => [r.key, JSON.parse(r.value)]) : [])
    const member = principal.startsWith('agent:') ? principal : email ? `email:${email.toLowerCase()}` : null
    const groups = member ? [...this.ctx.storage.sql.exec('SELECT grp FROM group_members WHERE member = ?', member)].map((r: any) => String(r.grp)) : []
    return resolvePolicies(this.policies(), source, { principal, email, role, groups, attributes })
  }
  /** Something changed: bump the version and tell the engine its resolved policies are stale. */
  private accessChanged() {
    this.ctx.storage.sql.exec('UPDATE access_version SET version = version + 1')
    const id = this.roleRegistry.get('code-engine'); const ws = id ? this.wsById.get(id) : undefined
    try { ws?.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: { t: 'access:changed', version: this.accessVersion() } })) } catch { /* the engine asks again on its next query */ }
  }
  private async accessAdmin(request: Request, path: string): Promise<Response> {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const url = new URL(request.url)
    const body: any = request.method === 'GET' ? {} : await request.json().catch(() => ({}))
    const by = String(body.by ?? url.searchParams.get('by') ?? '')
    const actor = { kind: 'user' as const, id: by || 'unknown', ...(by.includes('@') ? { email: by } : {}) }
    if (path === '/access-policies' && request.method === 'GET') return json({ policies: this.policies(), version: this.accessVersion() })
    if (request.method !== 'GET' && !by) return json({ error: 'who is making the change?' }, 400)
    if (path === '/access-policies' && request.method === 'POST') {
      const p = { applies_to: body.applies_to, source: body.source, table: body.table, kind: body.kind, predicate: body.predicate ?? null, column: body.column ?? null, note: body.note ?? null }
      const bad = checkPolicy(p)
      if (bad.length) return json({ error: bad.join('; ') }, 400)
      const id = `pol_${crypto.randomUUID().slice(0, 12)}`
      this.ctx.storage.sql.exec('INSERT INTO access_policies (id, applies_to, source, table_name, kind, predicate, column_name, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, p.applies_to, p.source, p.table, p.kind, p.predicate, p.column, p.note, by, new Date().toISOString())
      this.audit.record({ actor, via: 'admin', action: 'access-policy.create', target: id, outcome: 'ok', detail: p })
      this.accessChanged()
      return json({ policy: { id, ...p } }, 201)
    }
    const m = path.match(/^\/access-policies\/(pol_[\w-]+)$/)
    if (m && request.method === 'DELETE') {
      const [r] = [...this.ctx.storage.sql.exec('SELECT removed_at FROM access_policies WHERE id = ?', m[1])] as any[]
      if (!r) return json({ error: `there is no policy ${m[1]}` }, 404)
      if (r.removed_at) return json({ error: `policy ${m[1]} was already removed` }, 400)
      this.ctx.storage.sql.exec('UPDATE access_policies SET removed_at = ?, removed_by = ? WHERE id = ?', new Date().toISOString(), by, m[1])
      this.audit.record({ actor, via: 'admin', action: 'access-policy.remove', target: m[1], outcome: 'ok' })
      this.accessChanged()
      return json({ removed: m[1] })
    }
    if (path === '/access-attributes') {
      // An email is matched without case; an agent key's id is case-sensitive and kept as it is.
      const raw = String(body.subject ?? url.searchParams.get('subject') ?? '')
      const subject = raw.startsWith('email:') ? raw.toLowerCase() : raw
      if (!/^(email:[^\s@]+@[^\s@]+|agent:key_[\w-]+)$/.test(subject)) return json({ error: 'attributes belong to email:<address> or agent:<key id>' }, 400)
      if (request.method === 'GET') return json({ subject, attributes: Object.fromEntries([...this.ctx.storage.sql.exec('SELECT key, value FROM access_attributes WHERE subject = ?', subject)].map((r: any) => [r.key, JSON.parse(r.value)])) })
      if (request.method === 'PUT') {
        if (!/^[\w-]{1,60}$/.test(String(body.key ?? ''))) return json({ error: 'an attribute key is letters, digits, dashes or underscores' }, 400)
        if (body.value === null || body.value === undefined) {
          this.ctx.storage.sql.exec('DELETE FROM access_attributes WHERE subject = ? AND key = ?', subject, body.key)
        } else {
          this.ctx.storage.sql.exec('INSERT INTO access_attributes (subject, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (subject, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
            subject, body.key, JSON.stringify(body.value), by, new Date().toISOString())
        }
        this.audit.record({ actor, via: 'admin', action: 'access-attribute.set', target: subject, outcome: 'ok', detail: { key: body.key, value: body.value ?? null } })
        this.accessChanged()
        return json({ ok: true })
      }
    }
    return json({ error: 'not found' }, 404)
  }

  // ── Sessions kept by the platform ──────────────────────────────────────────
  /** What in this project awaits a decision, worst first: its engine away, work that failed, decisions to approve,
   *  suggestions to decide (knowledge, agents to publish). Each item says where it is, so a screen can open its step. */
  private async attention(): Promise<Response> {
    const items: Record<string, unknown>[] = []
    const engineHere = [...this.connByWs.values()].some((c) => c.type === 'code-engine')
    if (!engineHere) items.push({ id: 'engine', kind: 'engine', state: 'critical', title: 'The engine is not connected', detail: 'Questions, sessions and programs wait until it is back.' })
    const since = new Date(Date.now() - 86_400_000).toISOString()
    for (const a of [...this.ctx.storage.sql.exec("SELECT id, title, detail, updated_at FROM activities WHERE state = 'failed' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 20", since)] as any[])
      items.push({ id: `failed:${a.id}`, kind: 'failed', state: 'critical', title: `Failed: ${a.title}`, detail: a.detail ?? undefined, at: a.updated_at })
    for (const d of [...this.ctx.storage.sql.exec(`SELECT r.* FROM decision_register r JOIN (SELECT artifact, MAX(version) AS m FROM decision_register GROUP BY artifact) x ON x.artifact = r.artifact AND x.m = r.version WHERE r.status = 'pending' ORDER BY r.at`)] as any[])
      items.push({ id: `approval:${d.artifact}`, kind: 'approval', state: 'attention', title: `Approve: ${d.title}`, detail: `Recorded by ${String(d.by).replace(/^(email|user):/, '')}${d.agent ? ` with ${d.agent}` : ''}`, session: d.session, artifact: d.artifact, at: d.at })
    try {
      for (const s of this.graph().open()) items.push({ id: `suggestion:${s.id}`, kind: 'suggestion', state: 'attention', title: s.scope ? `Publish ${s.name} to ${s.scope === 'global' ? 'everyone' : s.scope}` : `Change suggested to ${s.name}`, detail: `${String(s.by).replace(/^(email|user|agent):/, '')}: ${s.reason}`, suggestion: s.id, name: s.name, at: s.at })
    } catch { /* the graph replica unreachable: its suggestions are not listed */ }
    return this.j({ items })
  }

  /** The project's composition graph, held here (graph.ts). */
  private _graph?: ReturnType<typeof projectGraph>
  private graph() { return (this._graph ??= projectGraph(this.ctx.storage, this.env, () => this._pid)) }
  private _dsi?: ReturnType<typeof projectDsi>
  private dsi() { return (this._dsi ??= projectDsi(this.ctx.storage)) }
  private _jobs?: ReturnType<typeof projectJobs>
  private jobs() { return (this._jobs ??= projectJobs(this.ctx.storage)) }
  /** A job's state, to everyone in the project who may run the project (and the engine's own listeners do not need it). */
  private jobUpdate(job: Job) {
    const envelope = { from: { id: 'hub', type: 'hub' }, payload: { t: 'job:update', job } }
    for (const [cws, conn] of this.connByWs) {
      if (conn.type === 'code-engine' || conn.wsId.startsWith('http-')) continue
      if (can(this.capsOf(conn), 'project.manage') || can(this.capsOf(conn), 'project.data')) this.deliverToConn(cws, conn, envelope as any)
    }
  }
  /** The engine's replica pulls what changed — told once per burst of changes, not once per table. */
  private dsiNotify?: ReturnType<typeof setTimeout>
  private dsiChanged() {
    if (this.dsiNotify) return
    this.dsiNotify = setTimeout(() => { this.dsiNotify = undefined; this.sendToRole('code-engine', { t: 'dsi:changed', cursor: this.dsi().cursor() }) }, 300)
  }
  /** The project's code sources by name (the connections the engine runs). */
  private codeSourceNames(): string[] {
    return ([...this.ctx.storage.sql.exec("SELECT name, connector FROM connections WHERE removed_at IS NULL AND level = 'project'")] as any[]).filter((r) => connectorById(r.connector)?.runs === 'code').map((r) => String(r.name))
  }
  /** A build asked for (by a person, an agent, or the platform itself on the engine's return): one at a time — if one is
   *  running it is the answer; otherwise the engine is asked to build. */
  private askIndexBuild(p: { sources?: string[]; tables?: Record<string, string[]>; fresh?: boolean }, by: string): { asked: boolean; running?: Job } {
    const running = this.jobs().running('dsi')
    if (running) return { asked: false, running }
    this.sendToRole('code-engine', { t: 'dsi:build', ...(p.sources?.length ? { sources: p.sources } : {}), ...(p.tables ? { tables: p.tables } : {}), ...(p.fresh ? { fresh: true } : {}), by })
    return { asked: true }
  }
  private decisionStub() { return (this.env as any).DECISION.get((this.env as any).DECISION.idFromName(`dec:${this._pid}`)) }
  /** Where a session lives: its owner's UserDO, asked with this project and the session's id (session-store.ts). */
  private sessionAt(session: string) {
    if (!/^[\w-]{1,80}$/.test(session)) throw new Error('not a session id')
    const owner = ([...this.ctx.storage.sql.exec('SELECT user FROM sessions_known WHERE session = ?', session)][0] as any)?.user as string | undefined
    const q = `project=${encodeURIComponent(this._pid)}&session=${encodeURIComponent(session)}`
    return {
      fetch: async (url: string, init?: RequestInit): Promise<Response> => {
        if (!owner) return new Response(JSON.stringify({ error: 'there is no such session' }), { status: 404, headers: { 'content-type': 'application/json' } })
        const u = new URL(url)
        return this.userStub(owner).fetch(`http://do/session${u.pathname}?${q}${u.search ? `&${u.search.slice(1)}` : ''}`, init)
      },
    }
  }
  private userStub(principal: string) { return (this.env as any).USER.get((this.env as any).USER.idFromName(principal)) }
  /** A session's entries from the engine, kept in its owner's UserDO. Whose it is comes from its opening entry, once. */
  private async syncSession(session: string, from: number, entries: unknown[]) {
    if (!/^[\w-]{1,80}$/.test(session)) throw new Error('not a session id')
    const known = ([...this.ctx.storage.sql.exec('SELECT user FROM sessions_known WHERE session = ?', session)][0] as any)?.user as string | undefined
    const open = from === 0 ? (entries as any[]).find((e) => e?.t === 'open' && typeof e.user === 'string') : undefined
    const owner = known ?? open?.user
    if (!owner) return { upto: 0, gap: true }   // whose it is is not known yet: send it from its opening entry
    this.ctx.storage.sql.exec('INSERT INTO sessions_known (session, first_seen, user) VALUES (?, ?, ?) ON CONFLICT (session) DO UPDATE SET user = COALESCE(sessions_known.user, excluded.user)', session, new Date().toISOString(), owner)
    const r = await this.sessionAt(session).fetch('http://do/append', { method: 'POST', body: JSON.stringify({ from, entries }) })
    const body: any = await r.json()
    if (r.status >= 400 && body.conflict === undefined) throw new Error(body.error ?? `the session could not be kept (${r.status})`)
    return { upto: body.upto, ...(body.gap ? { gap: true } : {}), ...(body.conflict !== undefined ? { conflict: body.conflict, error: body.error } : {}) }
  }
  // ── Who may do what (shared/permissions.ts) ──────────────────────────────────────────────────────────────────────
  /** What a project role holds: a built-in role's capabilities are the code's, always; a custom role's as stored. */
  private roleCapabilities(roleId: string | null | undefined): Capability[] {
    if (!roleId) return []
    const b = builtinRole('project', roleId)
    if (b) return b.capabilities
    const [r] = [...this.ctx.storage.sql.exec('SELECT permissions FROM roles WHERE id = ?', roleId)] as any[]
    if (!r) return []
    try { return (JSON.parse(String(r.permissions)) as unknown[]).filter((c): c is Capability => isCapability('project', c)) } catch { return [] }
  }
  /** What a person holds in this project now: the platform's superadmin everything; the organisation's owners and admins
   *  (mirrored here) the admin role; anyone else their role; someone not here nothing. */
  private capabilitiesOfEmail(email: string | null | undefined): Capability[] {
    const e = String(email ?? '').toLowerCase()
    if (!e) return []
    if (e === 'superadmin' || SUPERADMIN_EMAILS.includes(e)) return [...capabilitiesOf('project')]
    const [row] = [...this.ctx.storage.sql.exec('SELECT role_id, source FROM access WHERE email = ?', e)] as any[]
    if (!row) return []
    return row.source === 'org-admin' ? [...PROJECT_ROLES.admin.capabilities] : this.roleCapabilities(row.role_id)
  }
  /** What a connection holds now, read each time so a change of role applies at once: a person their role's; a service
   *  member (a chat channel) a member's; an agent key its maker's (its scopes cut it further); the console everything. */
  private capsOf(c: ConnInfo): Capability[] {
    if (c.type === 'admin' || c.orgRole === 'superadmin') return [...capabilitiesOf('project')]
    if (c.type === 'agent') { const k = this.agentKeys.get(String(c.userId ?? '').replace(/^agent:/, '')); return k ? this.agentKeys.holds(k, (who) => this.capabilitiesOfEmail(who)) : [] }
    if (c.type !== 'runtime' || !c.userId) return []
    if (c.email) return this.capabilitiesOfEmail(c.email)
    const [m] = [...this.ctx.storage.sql.exec('SELECT role FROM members WHERE user_id = ?', c.userId)] as any[]
    return m ? [...PROJECT_ROLES.member.capabilities] : []
  }
  /** The capabilities the worker checked for a REST call (it read them from the shared table; the DO only applies them). */
  private capsOfRequest(request: Request): Capability[] {
    try { const v = JSON.parse(request.headers.get('x-sa-caps') ?? '[]'); return Array.isArray(v) ? v.filter((c: unknown): c is Capability => isCapability('project', c)) : [] } catch { return [] }
  }
  /** Large messages arrive in parts; the hub holds them until whole, so what is inside is checked like any message. */
  private partsHeld = new Map<string, { frames: any[]; at: number }>()
  private partsChecked = new WeakSet<object>()
  private parcelsChecked = new WeakSet<object>()

  /** The scopes a connection sees with: its own (user:<id>, or the agent key's id) and its groups' — read each time, so
   *  a change to a group applies at once. Stamped by the hub on every message; never taken from a payload. */
  private scopesOf(c: ConnInfo): string[] {
    const member = c.type === 'agent' ? c.userId : c.email ? `email:${c.email.toLowerCase()}` : null
    const groups = member ? [...this.ctx.storage.sql.exec('SELECT grp FROM group_members WHERE member = ?', member)].map((r: any) => `group:${r.grp}`) : []
    const own = c.userId ? [`user:${c.userId.replace(/^agent:/, '')}`] : []   // an agent key's own scope is user:<key id>
    return [...own, ...groups]
  }
  private async groupsAdmin(request: Request, path: string): Promise<Response> {
    const url = new URL(request.url)
    const body: any = request.method === 'GET' ? {} : await request.json().catch(() => ({}))
    const by = String(body.by ?? url.searchParams.get('by') ?? '')
    const actor = { kind: 'user' as const, id: by || 'unknown', ...(by.includes('@') ? { email: by } : {}) }
    const sql = this.ctx.storage.sql
    if (request.method === 'GET' && path === '/groups') {
      const groups = [...sql.exec('SELECT name, description, created_by, created_at FROM groups ORDER BY name')] as any[]
      for (const g of groups) g.members = [...sql.exec('SELECT member FROM group_members WHERE grp = ? ORDER BY member', g.name)].map((r: any) => r.member)
      return this.j({ groups })
    }
    if (!by) return this.j({ error: 'who is making the change?' }, 400)
    const NAME = /^[a-z][a-z0-9-]{0,40}$/
    if (request.method === 'POST' && path === '/groups') {
      const name = String(body.name ?? '').trim().toLowerCase()
      if (!NAME.test(name)) return this.j({ error: 'a group name is lower-case letters, digits and dashes, starting with a letter' }, 400)
      if ([...sql.exec('SELECT 1 FROM groups WHERE name = ?', name)].length) return this.j({ error: `there is already a group ${name}` }, 400)
      sql.exec('INSERT INTO groups (name, description, created_by, created_at) VALUES (?, ?, ?, ?)', name, body.description ?? null, by, new Date().toISOString())
      this.audit.record({ actor, via: 'admin', action: 'group.create', target: name, outcome: 'ok' })
      return this.j({ group: name }, 201)
    }
    const m = path.match(/^\/groups\/([a-z][a-z0-9-]{0,40})\/members$/)
    if (m && (request.method === 'POST' || request.method === 'DELETE')) {
      if (![...sql.exec('SELECT 1 FROM groups WHERE name = ?', m[1])].length) return this.j({ error: `there is no group ${m[1]}` }, 404)
      const raw = String(body.member ?? url.searchParams.get('member') ?? '').trim()
      const member = raw.startsWith('email:') ? raw.toLowerCase() : raw
      if (!/^(email:[^\s@]+@[^\s@]+|agent:key_[\w-]+)$/.test(member)) return this.j({ error: 'a member is email:<address> or agent:<key id>' }, 400)
      if (request.method === 'POST') sql.exec('INSERT OR IGNORE INTO group_members (grp, member, added_by, added_at) VALUES (?, ?, ?, ?)', m[1], member, by, new Date().toISOString())
      else sql.exec('DELETE FROM group_members WHERE grp = ? AND member = ?', m[1], member)
      this.audit.record({ actor, via: 'admin', action: request.method === 'POST' ? 'group.add-member' : 'group.remove-member', target: m[1], outcome: 'ok', detail: { member } })
      this.accessChanged()   // a reader's groups can change what their policies resolve to
      return this.j({ ok: true })
    }
    return this.j({ error: 'not found' }, 404)
  }

  /** The principal a connection acts as, as sessions name it. */
  private principalOf(c: ConnInfo): string | null { return c.type === 'agent' ? c.userId ?? null : c.userId ? `user:${c.userId}` : null }

  // ── The audit history ──────────────────────────────────────────────────────
  // What a message means, for the record: its action and what it carried. Liveness and screen bookkeeping are not
  // actions (pings, resizes, keystrokes into a terminal, sync pulls); everything else is recorded.
  private static NOT_ACTIONS = new Set(['session:list', 'activity:list', 'tick', 'ping', 'ui:resize', 'term:input', 'term:detach', 'sync:req', 'answer:get', 'answer:ack', 'log:attach', 'log:detach', 'suggestions:req', 'sessions:list', 'analyst:sync', 'session:file', 'view:open', 'view:intent'])
  private auditMessage(sender: ConnInfo, pl: any, outcome: 'ok' | 'refused', reason?: string) {
    const t = String(pl?.t ?? '')
    if (outcome === 'ok' && ProjectDO.NOT_ACTIONS.has(t)) return
    const actor = sender.type === 'agent'
      ? { kind: 'agent' as const, id: sender.userId ?? 'agent:unknown' }
      : { kind: 'user' as const, id: sender.userId ?? 'unknown', ...(sender.email ? { email: sender.email } : {}) }
    const via = sender.type === 'agent' ? 'agent' as const : sender.type === 'admin' ? 'admin' as const : 'ui' as const
    const action = t === 'analyse' ? 'question.ask' : t ? `message.${t.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : 'message.untyped'
    const detail: Record<string, unknown> = {}
    if (t === 'analyse') { detail.question = String(pl.question ?? '').slice(0, 4000); if (pl.sessionId) detail.session = String(pl.sessionId); if (pl.questionId) detail.qid = String(pl.questionId) }
    else if (t.startsWith('session:')) { for (const k of ['session', 'agent', 'block', 'to', 'ops', 'action', 'call', 'asOf']) if (pl[k] !== undefined) detail[k] = pl[k] }
    else if (t.startsWith('graph:')) { for (const k of ['name', 'kind', 'domain', 'concept', 'at', 'id', 'verdict', 'reason', 'scope', 'status', 'asOf']) if (pl[k] !== undefined) detail[k] = pl[k] }
    if (reason) detail.reason = reason
    try { this.audit.record({ actor, via, action, ...(pl?.session || pl?.sessionId ? { target: String(pl.session ?? pl.sessionId) } : {}), outcome, ...(Object.keys(detail).length ? { detail } : {}) }) }
    catch (e: any) { this.log('audit:refused', { message: e?.message ?? String(e) }) }
  }

  /** Agent keys (list, create, revoke) and the audit history (read; record what the worker did). The worker has
   *  already checked the caller administers this project and says who they are (`by`). */
  private async agentKeysAndAudit(request: Request, path: string): Promise<Response> {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const body: any = request.method === 'GET' ? {} : await request.json().catch(() => ({}))
    let actorH: any = null
    try { actorH = JSON.parse(request.headers.get('x-sa-actor') ?? 'null') } catch { /* none */ }
    // Who acts: a person, or a key acting for its person (the worker says which — x-sa-actor, x-sa-key).
    const by = String(body.by ?? actorH?.email ?? new URL(request.url).searchParams.get('by') ?? '')
    const admin = request.headers.get('x-sa-key') ? { kind: 'agent' as const, id: String(actorH?.id ?? `agent:${request.headers.get('x-sa-key')}`) } : { kind: 'user' as const, id: by || 'unknown', ...(by.includes('@') ? { email: by } : {}) }
    const callerCaps = request.headers.get('x-sa-caps') ? this.capsOfRequest(request) : null
    try {
      if (path === '/audit' && request.method === 'GET') {
        const q = new URL(request.url).searchParams
        return json({ events: this.audit.list({ limit: Number(q.get('limit')) || undefined, before: q.get('before') ?? undefined, actor: q.get('actor') ?? undefined, action: q.get('action') ?? undefined }) })
      }
      if (path === '/audit' && request.method === 'POST') {
        // What the worker did for someone through the platform's API (a change to the project), or an engine's event.
        const e = this.audit.record({ actor: body.actor ?? admin, via: body.via ?? 'api', action: String(body.action ?? ''), ...(body.target ? { target: String(body.target) } : {}), outcome: body.outcome ?? 'ok', ...(body.detail ? { detail: body.detail } : {}), ...(body.id ? { id: String(body.id) } : {}), ...(body.at ? { at: String(body.at) } : {}) })
        return json({ event: e }, 201)
      }
      if (path === '/agent-keys' && request.method === 'GET') return json({ keys: this.agentKeys.list() })
      if (path === '/agent-keys' && request.method === 'POST') {
        if (!by) return json({ error: 'who is creating the key?' }, 400)
        // A key holds at most what its maker holds here now (a person, or a key — x-sa-caps is what the caller holds).
        const holds = callerCaps ?? this.capabilitiesOfEmail(by)
        const over = beyond(Array.isArray(body.capabilities) ? body.capabilities.map(String) : [], holds)
        if (over.length) return json({ error: `a key cannot be given what its maker does not hold: ${over.join(', ')}` }, 403)
        const r = await this.agentKeys.create({ name: body.name, capabilities: body.capabilities, by, madeByKey: request.headers.get('x-sa-key'), expiresAt: body.expiresAt ?? null })
        this.audit.record({ actor: admin, via: request.headers.get('x-sa-key') ? 'agent' : 'admin', action: 'agent-key.create', target: r.record.id, outcome: 'ok', detail: { name: r.record.name, capabilities: r.record.capabilities, made_by_key: r.record.made_by_key, expires_at: r.record.expires_at } })
        return json(r, 201)
      }
      const m = path.match(/^\/agent-keys\/([\w-]+)$/)
      if (m && request.method === 'DELETE') {
        if (!by) return json({ error: 'who is revoking the key?' }, 400)
        if (!this.agentKeys.reaches(request.headers.get('x-sa-key'), m[1])) return json({ error: 'a key revokes only the keys below it' }, 403)
        const k = this.agentKeys.revoke(m[1], by)
        this.audit.record({ actor: admin, via: 'admin', action: 'agent-key.revoke', target: k.id, outcome: 'ok', detail: { name: k.name } })
        // A revoked key's open connections end now — and those of every key it made, which go with it.
        for (const [ws, conn] of this.connByWs) if (conn.type === 'agent') { const ck = this.agentKeys.get(String(conn.userId ?? '').replace(/^agent:/, '')); if (ck && !this.agentKeys.holds(ck, (who) => this.capabilitiesOfEmail(who)).length) { try { ws.close(4001, 'The agent key was revoked') } catch { /* closing */ } } }
        return json({ key: k })
      }
      return json({ error: 'not found' }, 404)
    } catch (e: any) {
      if (e instanceof KeyRefusal) return json({ error: e.message }, 400)
      if (/audit event refused/.test(e?.message ?? '')) return json({ error: e.message }, 400)
      throw e
    }
  }

  // ── Message relay ──────────────────────────────────────────────────────────

  private async relay(senderWs: WebSocket, sender: ConnInfo, msg: any) {
    // ── Chat-channel answer delivery ──────────────────────────────────────────
    // The engine finished a channel-originated turn (Teams/…) and addresses the answer to type:'channel'.
    // The channel consumer holds no live socket, so we WAKE its ChannelDO (DO→DO) and hand it the answer to
    // post, once the transport has made it whole. Generic across channels — the adapter inside the ChannelDO does
    // the channel-specific rendering.
    if ((msg.to as any)?.type === 'channel') { await this.channelIn().receive(msg.payload); return }
    // A runtime (human client) sending a message is real activity → reset the idle clock.
    if (sender.type === 'runtime') this.markUserActivity()

    // ── Durable answer buffer (V6) ──────────────────────────────────────────
    // Serve history/answers straight from the always-on DO (no engine wake), and capture questions/answers as
    // they pass through so an offline client can recover them. All user-scoped by the runtime's JWT userId.
    const pl = msg.payload || {}
    const hubReply = (payload: any) => this.emit(senderWs, { from: { id: 'hub', type: 'hub' } }, payload)
    const scopes = sender.type === 'runtime' || sender.type === 'admin' || sender.type === 'agent' ? this.scopesOf(sender) : undefined
    const envelope: Envelope = { from: { id: sender.wsId, type: sender.type, ...(sender.userId ? { userId: sender.userId } : {}), ...(sender.email ? { email: sender.email } : {}), ...(sender.admin ? { admin: true } : {}), ...(scopes ? { scopes } : {}) }, payload: msg.payload }   // built once — reused by the base routing below AND the fan-out
    // ── Who may send this: everything a person or an agent sends is checked against what they hold now ──
    const caps = sender.type === 'runtime' || sender.type === 'admin' || sender.type === 'agent' ? this.capsOf(sender) : null
    if (caps) {
      const toType = (msg.to as any)?.type
      if (!sender.userId) { hubReply({ t: 'error', source: 'hub', reason: 'who is asking is not known', reqId: pl.reqId }); return }
      if (sender.userId && pl.t === 'part' && !this.partsChecked.has(msg)) {
        // Held until whole; then the whole is checked and the parts go on in order.
        const k = `${sender.wsId}:${String(pl.id)}`
        const held = this.partsHeld.get(k) ?? { frames: [], at: Date.now() }
        held.frames.push(msg); this.partsHeld.set(k, held)
        for (const [hk, h] of this.partsHeld) if (Date.now() - h.at > 10 * 60_000) this.partsHeld.delete(hk)
        if (held.frames.length < Number(pl.of)) return
        this.partsHeld.delete(k)
        let inner: any = null
        try { inner = JSON.parse(held.frames.map((f) => f.payload).sort((a: any, b: any) => a.part - b.part).map((p: any) => p.data).join('')) } catch { /* not a message */ }
        const t = String(inner?.t ?? '')
        const ok = can(caps, messageNeeds(t))
        if (!ok) { this.auditMessage(sender, inner ?? {}, 'refused', `${t || 'this message'} is not allowed for you here`); hubReply({ t: 'error', source: 'hub', reason: `${t || 'this message'} is not allowed for you here`, reqId: inner?.reqId }); return }
        // A message the platform answers itself (the graph, an app's publish, …) is handled here, whole; one for the engine
        // goes on in its parts, in order.
        if ((HUB_MESSAGES as readonly string[]).includes(t) || (t === 'inspect:req' && GRAPH_VIEWS.has(String(inner?.view)))) { await this.relay(senderWs, sender, { ...msg, payload: inner }); return }
        for (const f of held.frames.sort((a: any, b: any) => a.payload.part - b.payload.part)) { this.partsChecked.add(f); await this.relay(senderWs, sender, f) }
        return
      }
      // A message whose body came beside the wire (a parcel): its body must be the message its pointer names — what is
      // checked below is the pointer's type, and the engine acts on the body. One the platform answers itself is handled
      // here, whole; one for the engine goes on as its pointer.
      if (isParcelled(pl) && !this.parcelsChecked.has(msg)) {
        const body = await this.openParcel(pl, 't')
        if (!body) {
          const reason = 'the body beside the wire is not the message its pointer names'
          this.auditMessage(sender, pl, 'refused', reason); hubReply({ t: 'error', source: 'hub', reason, reqId: pl.reqId }); return
        }
        if ((HUB_MESSAGES as readonly string[]).includes(String(body.t)) || (body.t === 'inspect:req' && GRAPH_VIEWS.has(String(body.view)))) {
          await this.relay(senderWs, sender, { ...msg, payload: body }); return
        }
        this.parcelsChecked.add(msg)
      }
      if (sender.userId && !(pl.t === 'part' && this.partsChecked.has(msg))) {
        const t = String(pl.t ?? '')
        if (sender.type === 'agent') {
          const hubServed = (HUB_MESSAGES as readonly string[]).includes(t)
          if ((toType !== 'code-engine' && !hubServed) || !can(caps, messageNeeds(t))) {
            const reason = toType !== 'code-engine' && !hubServed ? 'an agent talks only to the engine and the platform'
              : `${t || 'this message'} needs ${messageNeeds(t)}, which this key does not hold (or its maker no longer holds)`
            this.auditMessage(sender, pl, 'refused', reason)
            hubReply({ t: 'error', source: 'hub', reason, reqId: pl.reqId })
            return
          }
        } else if (!can(caps, messageNeeds(t))) {
          const reason = `${t || 'this message'} needs ${messageNeeds(t)}, which your role here does not hold`
          this.auditMessage(sender, pl, 'refused', reason)
          hubReply({ t: 'error', source: 'hub', reason, reqId: pl.reqId })
          return
        }
      }
    }
    // What the engine is told about the sender's standing: `admin` = may publish (widen what others see) — a person by
    // their role, a key by what it holds (cut to its maker).
    if (caps) envelope.from.admin = can(caps, 'project.publish') || undefined
    if (!envelope.from.admin) delete envelope.from.admin
    // Each session's owner, as their messages pass — so usage tagged with a session is attributed to them.
    if ((pl.t === 'analyse' || pl.t?.startsWith?.('session:')) && (pl.sessionId || pl.session) && (sender.type === 'runtime' || sender.type === 'agent')) {
      const who = this.principalOf(sender)
      if (who) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO session_owners (session, principal, email, first_seen) VALUES (?, ?, ?, ?)', String(pl.sessionId ?? pl.session), who, sender.email ?? null, new Date().toISOString())
    }
    // Work that spends (a question, a session intent) needs credits left, for an organisation on a credit plan — and,
    // for a person with a budget (theirs or a group's), budget left.
    if ((pl.t === 'analyse' || pl.t === 'session:intent') && (sender.type === 'runtime' || sender.type === 'agent')) {
      const b = await this.budgetLeft(sender)
      if (!b.ok) { this.auditMessage(sender, pl, 'refused', b.reason); hubReply({ t: 'error', source: 'credits', reason: b.reason, reqId: pl.reqId }); return }
      const c = await this.creditsLeft()
      if (!c.ok) { this.auditMessage(sender, pl, 'refused', c.reason); hubReply({ t: 'error', source: 'credits', reason: c.reason, reqId: pl.reqId }); return }
    }
    if (sender.type === 'runtime' || sender.type === 'admin' || sender.type === 'agent') this.auditMessage(sender, pl, 'ok')
    // ── The project's app, published by a person: kept here, the engine told to download it ──
    if (pl.t === 'app:publish' && (sender.type === 'runtime' || sender.type === 'admin' || sender.type === 'agent')) {
      try { hubReply({ t: 'app:published', ...(await this.publishApp(pl.files, this.principalOf(sender) ?? 'unknown')), reqId: pl.reqId }) }
      catch (e: any) { hubReply({ t: 'app:refused', reason: e?.message ?? String(e), reqId: pl.reqId }) }
      return
    }
    // ── The composition graph: held here (graph.ts) — read and changed here, never by an engine ──
    if ((GRAPH_MESSAGES.has(String(pl.t)) || (pl.t === 'inspect:req' && GRAPH_VIEWS.has(String(pl.view)))) && (sender.type === 'runtime' || sender.type === 'admin' || sender.type === 'agent')) {
      if (!sender.userId) { hubReply({ t: 'graph:refused', reason: 'who is asking is not known', reqId: pl.reqId }); return }
      const graph = this.graph()
      if (pl.t === 'inspect:req') { hubReply({ t: 'inspect:res', reqId: pl.reqId, view: pl.view, ...graph.view(String(pl.view), pl) }); return }
      const who: Who = { id: sender.type === 'agent' ? sender.userId : `user:${sender.userId}`, admin: !!envelope.from.admin, ...(sender.email && sender.type !== 'agent' ? { email: sender.email } : {}), scopes: this.scopesOf(sender) }
      const { reply, changed } = graph.handle(pl, who)
      hubReply({ ...reply, reqId: pl.reqId })
      // The engines' replicas pull what changed.
      if (changed) this.sendToRole('code-engine', { t: 'graph:changed', cursor: graph.cursor() })
      return
    }
    // Browsing an agent's views: one small usage row each (never the STATE), then on to the engine as any message.
    if ((pl.t === 'view:open' || pl.t === 'view:intent') && (sender.type === 'runtime' || sender.type === 'agent')) {
      const control = pl.t === 'view:open' ? (pl.startAt ? `start ${String(pl.startAt)}` : pl.state ? 'reopened' : 'opened')
        : pl.call ? `${pl.call.package}.${pl.call.fn}${Array.isArray(pl.call.params?.ops) ? ` ${pl.call.params.ops.map((o: any) => o?.op).join(',')}` : ''}` : pl.action ? `${pl.action.package}·${pl.action.id}` : Array.isArray(pl.ops) ? pl.ops.map((o: any) => `${o?.op} ${o?.path ?? ''}`).join(',') : 'a change'
      this.ctx.storage.sql.exec('INSERT INTO view_events (at, who, agent, kind, detail) VALUES (?, ?, ?, ?, ?)', new Date().toISOString(), this.principalOf(sender), String(pl.agent ?? ''), pl.t === 'view:open' ? 'open' : 'step', control.slice(0, 200))
    }
    // ── Each source's index, and long work: read and changed here (the hub checked what each message needs) ──
    if (typeof pl.t === 'string' && /^(dsi:(show|stats|describe|enable|build|snapshot)|job:(list|get))$/.test(pl.t) && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      const who = this.principalOf(sender)
      if (!who) { hubReply({ t: 'dsi:refused', reason: 'who is asking is not known', reqId: pl.reqId }); return }
      const actor = sender.type === 'agent' ? { kind: 'agent' as const, id: who } : { kind: 'user' as const, id: who, ...(sender.email ? { email: sender.email } : {}) }
      const via = sender.type === 'agent' ? 'agent' : sender.type === 'admin' ? 'admin' : 'ui'
      try {
        switch (pl.t) {
          case 'dsi:show': hubReply({ t: 'dsi:items', items: this.dsi().show(pl), reqId: pl.reqId }); break
          case 'dsi:stats': hubReply({ t: 'dsi:stats', ...this.dsi().stats(), running: this.jobs().running('dsi'), reqId: pl.reqId }); break
          case 'dsi:snapshot': hubReply({ t: 'dsi:snapshot', cursor: this.dsi().cursor(), at: new Date().toISOString(), sources: this.dsi().document(), reqId: pl.reqId }); break
          case 'dsi:describe': case 'dsi:enable': {
            const item = pl.t === 'dsi:describe' ? this.dsi().describe(pl, sender.email ?? who) : this.dsi().enable(pl, sender.email ?? who)
            this.audit.record({ actor, via, action: pl.t === 'dsi:describe' ? 'dsi.describe' : item.enabled ? 'dsi.enable' : 'dsi.disable', target: [item.source, item.table, item.field].filter(Boolean).join('.'), outcome: 'ok', detail: pl.t === 'dsi:describe' ? { by: pl.by, text: String(pl.text ?? '').slice(0, 300) } : { enabled: item.enabled } })
            this.dsiChanged()
            hubReply({ t: 'dsi:item', item, reqId: pl.reqId }); break
          }
          case 'dsi:build': {
            const tables = pl.tables && typeof pl.tables === 'object' ? Object.fromEntries(Object.entries(pl.tables).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []])) : undefined
            const r = this.askIndexBuild({ sources: Array.isArray(pl.sources) ? pl.sources.map(String) : undefined, tables, fresh: !!pl.fresh }, sender.email ?? who)
            this.audit.record({ actor, via, action: 'dsi.build', target: (pl.sources ?? []).join(',') || 'every source', outcome: 'ok', detail: { asked: r.asked, running: r.running?.id ?? null } })
            hubReply({ t: 'dsi:building', ...r, reqId: pl.reqId }); break
          }
          case 'job:list': hubReply({ t: 'job:list', jobs: this.jobs().list({ kind: pl.kind ? String(pl.kind) : undefined, active: !!pl.active }), reqId: pl.reqId }); break
          case 'job:get': hubReply({ t: 'job:got', job: this.jobs().get(String(pl.id ?? '')), reqId: pl.reqId }); break
        }
      } catch (e: any) {
        if (e instanceof DsiRefusal || e instanceof JobRefusal) hubReply({ t: 'dsi:refused', reason: e.message, reqId: pl.reqId }); else throw e
      }
      return
    }
    // ── Activities: what is running, or ran lately — one's own (an admin sees everyone's) ──
    if (pl.t === 'activity:list' && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      const who = this.principalOf(sender)
      const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
      const rows = can(caps, 'project.audit')
        ? [...this.ctx.storage.sql.exec("SELECT * FROM activities WHERE state = 'running' OR updated_at >= ? ORDER BY updated_at DESC LIMIT 100", since)]
        : [...this.ctx.storage.sql.exec("SELECT * FROM activities WHERE owner = ? AND (state = 'running' OR updated_at >= ?) ORDER BY updated_at DESC LIMIT 100", who ?? '', since)]
      hubReply({ t: 'activity:list', activities: rows, reqId: pl.reqId })
      return
    }
    // ── The program catalogue (no engine needed) ──
    if ((pl.t === 'program:list' || pl.t === 'program:publish') && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      const who = this.principalOf(sender)
      if (!who) { hubReply({ t: 'program:refused', reason: 'who is asking is not known', reqId: pl.reqId }); return }
      const actor = sender.type === 'agent' ? { kind: 'agent' as const, id: who } : { kind: 'user' as const, id: who, ...(sender.email ? { email: sender.email } : {}) }
      try {
        if (pl.t === 'program:list') {
          // Only programs whose scope this asker sees (global, their own, their groups'); an admin sees all; one's own drafts always.
          const sees = can(caps, 'project.audit') ? null : new Set(['global', ...this.scopesOf(sender)])
          hubReply({ t: 'program:list', programs: this.catalogue.list({ name: pl.name, published: pl.published }).filter((p) => !sees || sees.has(p.scope) || p.owner === who), reqId: pl.reqId })
        }
        else {
          const e = this.catalogue.publish(String(pl.hash ?? ''), { id: who, admin: can(caps, 'project.publish') })
          this.record('program', e.hash, { ...e, event: 'published' })
          this.audit.record({ actor, via: sender.type === 'agent' ? 'agent' : sender.type === 'admin' ? 'admin' : 'ui', action: 'program.publish', target: e.hash, outcome: 'ok', detail: { name: e.name, version: e.version } })
          hubReply({ t: 'program:published', program: e, reqId: pl.reqId })
        }
      } catch (e: any) {
        if (pl.t === 'program:publish') this.audit.record({ actor, via: sender.type === 'agent' ? 'agent' : 'ui', action: 'program.publish', target: String(pl.hash ?? ''), outcome: 'refused', detail: { reason: e?.message ?? String(e) } })
        hubReply({ t: 'program:refused', reason: e?.message ?? String(e), reqId: pl.reqId })
      }
      return
    }
    // ── The decision memory (no engine needed): the paths from a step, how a step turned out, the decision states ──
    // ── Cloud connectors: run a connection's connector in its sandbox (no engine needed) ──
    if (typeof pl.t === 'string' && pl.t.startsWith('connector:') && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      try { hubReply({ t: pl.t === 'connector:catalog' ? 'connector:catalog' : 'connector:result', ...(await this.connectorOp(sender, pl.t.slice('connector:'.length), pl)), reqId: pl.reqId }) }
      catch (e: any) { hubReply({ t: 'connector:refused', reason: e?.message ?? String(e), reqId: pl.reqId }) }
      return
    }
    // ── The organisation's warehouse, as far as this project was granted (no engine needed) ──
    if ((pl.t === 'warehouse:tables' || pl.t === 'warehouse:query' || pl.t === 'warehouse:explore' || pl.t === 'warehouse:append' || pl.t === 'warehouse:queries' || pl.t === 'warehouse:queries:save' || pl.t === 'warehouse:queries:delete') && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      const who = this.principalOf(sender)
      try {
        if (!who) throw new Error('who is asking is not known')
        const org = await this.orgId()
        if (!org) throw new Error('this project belongs to no organisation')
        const grant = this.grantInForce()
        const orgDo = this.env.ORG.get(this.env.ORG.idFromName(org))
        if (pl.t === 'warehouse:tables') {
          const r: any = await (await orgDo.fetch(new Request('http://do/warehouse', { headers: { 'x-sa-org': org } }))).json()
          const writable = this.writableInForce()
          const tables = (r.tables ?? []).filter((t: any) => t.name in grant).map((t: any) => ({ ...t, columns: grant[t.name] === null ? t.columns : t.columns.filter((c: any) => grant[t.name]!.includes(c.name)), writable: writable.includes(t.name) }))
          hubReply({ t: 'warehouse:tables', configured: !!r.configured, tables, reqId: pl.reqId })
        } else if (pl.t === 'warehouse:append') {
          // Only a table this project's grant makes writable (the organisation's word), by someone who may append here.
          const table = String(pl.table ?? '')
          if (!this.writableInForce().includes(table)) throw new Error(`this project may not write ${table || 'that table'} — the organisation grants writing`)
          const res = await orgDo.fetch(new Request('http://do/warehouse/append', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-org': org }, body: JSON.stringify({ table, rows: pl.rows, project: this._pid, by: who }) }))
          const out: any = await res.json()
          if (!res.ok) throw new Error(out.error ?? `the warehouse answered ${res.status}`)
          this.audit.record({ actor: { kind: sender.type === 'agent' ? 'agent' : 'user', id: who, ...(sender.email ? { email: sender.email } : {}) }, via: sender.type === 'agent' ? 'agent' : 'ui', action: 'warehouse.append', target: table, outcome: 'ok', detail: { rows: out.rows ?? 0 } })
          hubReply({ t: 'warehouse:appended', ...out, reqId: pl.reqId })
        } else if (pl.t === 'warehouse:explore') {
          // The explorer over what this project was granted: the organisation makes the SQL and checks it against the grant.
          const { t: _t, reqId: _r, ...req } = pl
          const res = await orgDo.fetch(new Request('http://do/warehouse/explore', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-org': org }, body: JSON.stringify({ ...req, grant, project: this._pid, by: who }) }))
          const out: any = await res.json()
          if (!res.ok) throw new Error(out.error ?? `the warehouse answered ${res.status}`)
          // A query run (its first page, as written) is recorded in the person's own UserDO, for this project.
          let recorded: { id: number } | undefined
          if (req.query && req.op === 'rows' && Number(req.page ?? 1) === 1 && !req.q && !req.where?.length && !req.sort) {
            const r: any = await this.userStub(who).fetch('http://do/warehouse/runs', { method: 'POST', body: JSON.stringify({ org, project: this._pid, sql: req.query.sql, columns: out.columns, rows: out.total, sample: (out.rows ?? []).slice(0, 5) }) }).then((x: Response) => x.json()).catch(() => null)
            if (r?.id) recorded = { id: r.id }
          }
          hubReply({ t: 'warehouse:explored', ...out, ...(recorded ? { recorded } : {}), reqId: pl.reqId })
        } else if (pl.t === 'warehouse:queries' || pl.t === 'warehouse:queries:save' || pl.t === 'warehouse:queries:delete') {
          // One's own queries over the warehouse, from this project: kept in one's UserDO.
          const me = this.userStub(who), qs = `org=${encodeURIComponent(org)}&project=${encodeURIComponent(this._pid)}`
          const res = pl.t === 'warehouse:queries' ? await me.fetch(`http://do/warehouse/queries?${qs}`)
            : pl.t === 'warehouse:queries:save' ? await me.fetch('http://do/warehouse/queries', { method: 'POST', body: JSON.stringify({ id: pl.id, name: pl.name, sql: pl.sql, columns: pl.columns, org, project: this._pid }) })
            : await me.fetch(`http://do/warehouse/queries/${Number(pl.id)}?${qs}`, { method: 'DELETE' })
          const out: any = await res.json()
          if (!res.ok) throw new Error(out.error ?? `not done (${res.status})`)
          hubReply({ t: 'warehouse:queries', ...out, reqId: pl.reqId })
        } else {
          const res = await orgDo.fetch(new Request('http://do/warehouse/query', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-org': org }, body: JSON.stringify({ sql: pl.sql, limit: pl.limit, grant, project: this._pid, by: who }) }))
          const out: any = await res.json()
          if (!res.ok) throw new Error(out.error ?? `the warehouse answered ${res.status}`)
          this.audit.record({ actor: { kind: sender.type === 'agent' ? 'agent' : 'user', id: who, ...(sender.email ? { email: sender.email } : {}) }, via: sender.type === 'agent' ? 'agent' : 'ui', action: 'warehouse.query', target: org, outcome: 'ok', detail: { rows: out.rows?.length ?? 0 } })
          hubReply({ t: 'warehouse:result', ...out, reqId: pl.reqId })
        }
      } catch (e: any) { hubReply({ t: 'warehouse:refused', reason: e?.message ?? String(e), reqId: pl.reqId }) }
      return
    }
    if (typeof pl.t === 'string' && pl.t.startsWith('decision:') && pl.t !== 'decision:register' && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      const who = this.principalOf(sender)
      if (!who) { hubReply({ t: 'decision:refused', reason: 'who is asking is not known', reqId: pl.reqId }); return }
      const dec = this.decisionStub()
      const call = async (path: string, body?: unknown) => {
        const r = await dec.fetch(`http://do${path}`, body === undefined ? { headers: { 'x-sa-project': this._pid } } : { method: 'POST', headers: { 'x-sa-project': this._pid }, body: JSON.stringify(body) })
        const out: any = await r.json(); if (!r.ok) throw new Error(out.error ?? `the decision memory answered ${r.status}`); return out
      }
      try {
        if (pl.t === 'decision:paths' && !pl.session && pl.view && typeof pl.view === 'object') {
          // A view browsed without a session: its step, as the browser holds it (an agent, a STATE, what it showed).
          const v: any = pl.view
          const step = stepOf({ agent: String(v.agent ?? ''), states: { b: v.state ?? {} }, blocks: [{ id: 'b', answer: v.answer ? 'a' : null, stateHash: String(v.stateHash ?? '') }], answers: v.answer ? [{ ...v.answer, id: 'a' }] : [] } as any, 'b')
          if (!step) throw new Error('the view has no step to recognise')
          hubReply({ t: 'decision:paths', block: null, ...(await call('/recognise', { cues: step.cues, world: step.world, scopes: this.scopesOf(sender) })), reqId: pl.reqId })
        } else if (pl.t === 'decision:paths' || pl.t === 'decision:outcome') {
          const r = await this.sessionAt(String(pl.session ?? '')).fetch('http://do/view')
          const body: any = await r.json()
          if (!r.ok) throw new Error(body.error ?? 'there is no such session')
          if (body.view.user !== who && !can(caps, 'project.audit')) throw new Error(`session ${pl.session} is not yours`)
          const block = String(pl.block ?? body.view.leaf)
          if (pl.t === 'decision:paths') {
            const step = stepOf(body.view, block)
            if (!step) throw new Error(`session ${pl.session} has no block ${block}`)
            hubReply({ t: 'decision:paths', session: pl.session, block, ...(await call('/recognise', { cues: step.cues, world: step.world, scopes: this.scopesOf(sender) })), reqId: pl.reqId })
          } else {
            const out = await call('/outcome', { session: pl.session, block, outcome: pl.outcome, by: who, note: pl.note ?? null, artifact: pl.artifact ?? null })
            this.audit.record({ actor: { kind: sender.type === 'agent' ? 'agent' : 'user', id: who, ...(sender.email ? { email: sender.email } : {}) }, via: sender.type === 'agent' ? 'agent' : 'ui', action: 'decision.outcome', target: `${pl.session}/${block}`, outcome: 'ok', detail: { outcome: pl.outcome } })
            hubReply({ t: 'decision:outcome', ...out, reqId: pl.reqId })
          }
        } else if (pl.t === 'decision:states') {
          const out = await call(`/states${pl.asOf ? `?asOf=${encodeURIComponent(String(pl.asOf))}` : ''}`)
          const sees = can(caps, 'project.audit') ? null : new Set(['global', ...this.scopesOf(sender)])
          hubReply({ t: 'decision:states', asOf: out.asOf, states: out.states.filter((x: any) => !sees || sees.has(x.scope)), reqId: pl.reqId })
        } else if (pl.t === 'decision:state') {
          const one = await call(`/state/${encodeURIComponent(String(pl.id ?? ''))}`)
          const sees = can(caps, 'project.audit') ? null : new Set(['global', ...this.scopesOf(sender)])
          if (sees && one?.state && !sees.has(one.state.scope ?? 'global')) throw new Error(`there is no decision state ${pl.id}`)
          hubReply({ t: 'decision:state', ...one, reqId: pl.reqId })
        } else if (pl.t === 'decision:learn') {
          if (!can(caps, 'project.publish')) throw new Error('running the learner needs project.publish')
          hubReply({ t: 'decision:learned', ...(await call('/learn', {})), reqId: pl.reqId })
        } else if (pl.t === 'decision:change') {
          // The learning path: someone who may publish, or an agent key allowed to learn made by one.
          if (!can(caps, 'project.publish')) throw new Error('changing the decision memory needs project.publish')
          const out = await call('/change', { op: pl.op, by: who, why: String(pl.why ?? '') })
          this.audit.record({ actor: { kind: sender.type === 'agent' ? 'agent' : 'user', id: who }, via: sender.type === 'agent' ? 'agent' : 'ui', action: `decision.${pl.op?.op ?? 'change'}`, target: out.written.map((w: any) => w.id).join(','), outcome: 'ok', detail: { why: pl.why ?? '' } })
          hubReply({ t: 'decision:changed', ...out, reqId: pl.reqId })
        } else throw new Error(`there is no ${pl.t}`)
      } catch (e: any) { hubReply({ t: 'decision:refused', reason: e?.message ?? String(e), reqId: pl.reqId }) }
      return
    }
    // ── Artifacts of a session (a decision record, a file, a plan) and the project's decision register (no engine needed) ──
    if (typeof pl.t === 'string' && (pl.t.startsWith('artifact:') || pl.t === 'decision:register') && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      const who = this.principalOf(sender)
      if (!who) { hubReply({ t: 'artifact:refused', reason: 'who is asking is not known', reqId: pl.reqId }); return }
      const actor = { kind: (sender.type === 'agent' ? 'agent' : 'user') as 'agent' | 'user', id: who, ...(sender.email ? { email: sender.email } : {}) }
      try {
        if (pl.t === 'decision:register') {
          const rows = [...this.ctx.storage.sql.exec(`SELECT r.* FROM decision_register r JOIN (SELECT artifact, MAX(version) AS m FROM decision_register ${pl.asOf ? 'WHERE at <= ?' : ''} GROUP BY artifact) x ON x.artifact = r.artifact AND x.m = r.version ORDER BY r.at DESC LIMIT 200`, ...(pl.asOf ? [String(pl.asOf)] : []))]
          hubReply({ t: 'decision:register', decisions: rows, asOf: pl.asOf ?? null, reqId: pl.reqId }); return
        }
        const stub = this.sessionAt(String(pl.session ?? ''))
        const viewRes = await stub.fetch('http://do/view'); const vb: any = await viewRes.json()
        if (!viewRes.ok) throw new Error(vb.error ?? 'there is no such session')
        const view = vb.view
        const own = view.user === who
        if (!own && !can(caps, 'project.audit')) throw new Error(`session ${pl.session} is not yours`)
        if (pl.t === 'artifact:list') { hubReply({ t: 'artifact:list', session: pl.session, ...(await (await stub.fetch('http://do/artifacts')).json() as any), reqId: pl.reqId }); return }
        if (pl.t === 'artifact:get') { const r = await stub.fetch(`http://do/artifact/${encodeURIComponent(String(pl.id ?? ''))}`); const b: any = await r.json(); if (!r.ok) throw new Error(b.error); hubReply({ t: 'artifact:get', session: pl.session, ...b, reqId: pl.reqId }); return }
        // The experiences on the path that led to a step: how they turned out is what this decision says.
        const pathTo = (block: string) => { const out: string[] = []; for (let b: string | null = block; b; b = view.blocks.find((x: any) => x.id === b)?.parent ?? null) out.unshift(b); return out }
        const outcome = async (block: string, o: 'succeeded' | 'failed' | 'reversed', artifact: string) => {
          for (const b of pathTo(block)) await this.decisionStub().fetch('http://do/outcome', { method: 'POST', headers: { 'x-sa-project': this._pid }, body: JSON.stringify({ session: pl.session, block: b, outcome: o, by: who, artifact }) }).catch(() => {})
        }
        const register = (a: any) => this.ctx.storage.sql.exec('INSERT INTO decision_register (session, artifact, version, title, status, agent, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', String(pl.session), a.id, a.version, a.title, a.status, view.agent ?? null, who, a.at)
        if (pl.t === 'artifact:record') {
          // A command, not a STATE change: who → may they → recorded with what it rested on → the register → the audit.
          if (!own) throw new Error('only the session\'s owner records its decisions')
          const kind = String(pl.kind ?? 'decision')
          const block = String(pl.block ?? view.leaf)
          if (!view.blocks.some((b: any) => b.id === block)) throw new Error(`session ${pl.session} has no block ${block}`)
          const body = { ...(pl.body ?? {}) }
          if (kind === 'decision') {
            if (!String(body.decision ?? '').trim()) throw new Error('a decision record says what was decided')
            if (!String(body.reasoning ?? '').trim()) throw new Error('a decision record says why (reasoning)')
            const step = stepOf(view, block)
            const b = view.blocks.find((x: any) => x.id === block)
            body.restsOn = { block, answer: b?.answer ?? null, stateHash: b?.stateHash ?? null, world: step?.world ?? {} }
          }
          const status = kind === 'decision' ? (pl.approval ? 'pending' : 'decided') : 'made'
          const r = await stub.fetch('http://do/artifact', { method: 'POST', body: JSON.stringify({ kind, title: String(pl.title ?? body.decision ?? kind).slice(0, 200), status, block, body, by: who }) })
          const out: any = await r.json(); if (!r.ok) throw new Error(out.error)
          if (kind === 'decision') { register(out.artifact); await outcome(block, 'succeeded', out.artifact.id) }
          this.audit.record({ actor, via: sender.type === 'agent' ? 'agent' : 'ui', action: `artifact.${kind}`, target: `${pl.session}/${out.artifact.id}`, outcome: 'ok', detail: { title: out.artifact.title, status } })
          hubReply({ t: 'artifact:recorded', session: pl.session, artifact: out.artifact, reqId: pl.reqId }); return
        }
        if (pl.t === 'artifact:decide') {
          const status = String(pl.status ?? '')
          if (!['approved', 'rejected', 'reversed', 'superseded'].includes(status)) throw new Error('a decision is approved, rejected, reversed or superseded')
          const r0 = await stub.fetch(`http://do/artifact/${encodeURIComponent(String(pl.id ?? ''))}`); const b0: any = await r0.json(); if (!r0.ok) throw new Error(b0.error)
          const last = b0.versions[b0.versions.length - 1]
          if (status === 'approved' && last.status !== 'pending') throw new Error('only a decision awaiting approval is approved')
          if (status === 'approved' && own && !can(caps, 'project.manage')) throw new Error('a decision is approved by someone other than who made it')
          if ((status === 'approved' || status === 'rejected') && !own && !can(caps, 'project.approve')) throw new Error('approving a decision needs project.approve')
          const body = status === 'approved' || status === 'rejected' ? { ...last.body, approvals: [...(last.body.approvals ?? []), { by: who, at: new Date().toISOString(), status, note: pl.note ?? null }] } : last.body
          const r = await stub.fetch('http://do/artifact', { method: 'POST', body: JSON.stringify({ id: last.id, kind: last.kind, title: last.title, status, block: last.block, body, by: who, note: pl.note ?? null }) })
          const out: any = await r.json(); if (!r.ok) throw new Error(out.error)
          if (last.kind === 'decision') { register(out.artifact); if (status === 'reversed' || status === 'rejected') await outcome(last.block, status === 'reversed' ? 'reversed' : 'failed', last.id) }
          this.audit.record({ actor, via: sender.type === 'agent' ? 'agent' : 'ui', action: `artifact.${status}`, target: `${pl.session}/${last.id}`, outcome: 'ok', detail: { note: pl.note ?? null } })
          hubReply({ t: 'artifact:decided', session: pl.session, artifact: out.artifact, reqId: pl.reqId }); return
        }
        throw new Error(`there is no ${pl.t}`)
      } catch (e: any) { hubReply({ t: 'artifact:refused', reason: e?.message ?? String(e), reqId: pl.reqId }) }
      return
    }
    // ── Sessions read from the platform's copy (no engine needed): only the person's own ──
    if ((pl.t === 'session:list' || pl.t === 'session:read') && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      const who = this.principalOf(sender)
      if (!who) { hubReply({ t: 'session:refused', reason: 'who is asking is not known', reqId: pl.reqId }); return }
      try {
        if (pl.t === 'session:list') {
          const r: any = await (await this.userStub(who).fetch(`http://do/sessions?project=${encodeURIComponent(this._pid)}`)).json()
          hubReply({ t: 'session:list', sessions: r.sessions ?? [], reqId: pl.reqId })
        } else {
          const r = await this.sessionAt(String(pl.session ?? '')).fetch(`http://do/view${pl.asOf ? `?asOf=${encodeURIComponent(String(pl.asOf))}` : ''}`)
          const body: any = await r.json()
          if (!r.ok) hubReply({ t: 'session:refused', reason: body.error ?? 'there is no such session', reqId: pl.reqId })
          else if (body.view.user !== who) hubReply({ t: 'session:refused', reason: `session ${pl.session} is not yours`, reqId: pl.reqId })
          else hubReply({ t: 'session:read', view: body.view, upto: body.upto, reqId: pl.reqId })
        }
      } catch (e: any) { hubReply({ t: 'session:refused', reason: e?.message ?? String(e), reqId: pl.reqId }) }
      return
    }
    if (sender.type === 'runtime') {
      // A person's inbox (what they asked, the answers for a device that was away) is in their UserDO (user-hub.ts);
      // here only who asked each question is kept — it decides whose logs and answers reach whom.
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
      if (pl.t === 'analyst:answer' && pl.qid && !pl.replay) { this.record('chat.answer', String(pl.qid), { qid: pl.qid, sid: pl.sid ?? null, category: pl.category ?? null, answer: pl.answer ?? null, timing: pl.timing ?? null }) }
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
        this.ctx.storage.sql.exec('INSERT INTO message_queue (msg_json) VALUES (?)', JSON.stringify(envelope))   // with who sent it, so the reply finds them
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
      const pl0 = msg.payload as any
      // Whose log it is: the question's asker, else the session's owner; unknown — the project's admins only.
      let owner = pl0?.qid ? this.buffer.ownerOf(pl0.qid) : ''
      const sid = pl0?.sid ?? pl0?.sessionId ?? pl0?.session
      if (!owner && sid) owner = String(([...this.ctx.storage.sql.exec('SELECT principal FROM session_owners WHERE session = ?', String(sid))][0] as any)?.principal ?? '').replace(/^user:/, '')
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
    const { payload, ...head } = envelope as any
    this.emit(ws, { ...head, to: { id: conn.wsId, type: conn.type } }, payload)   // stamp per-recipient `to`
  }

  // ── EVERY PAYLOAD THE HUB SENDS GOES THROUGH emit ──
  // In order, per socket. A payload too big for one frame goes beside the wire as a parcel (the bucket, by its hash, read
  // with a ticket) and its pointer travels instead — the same transport every end uses, in every direction. A payload
  // that carries secrets (SECRET_PAYLOADS) is never a parcel, whatever its size: secrets never rest in the bucket.
  private outChain = new WeakMap<WebSocket, Promise<void>>()
  /** The one place the platform opens a parcel it was sent: the body, if it is the message its pointer names (by `t` or
   *  `type`) — else null. The pointer's reqId stays the message's. */
  private async openParcel(pointer: { parcel: any; reqId?: unknown; [k: string]: unknown }, by: 't' | 'type'): Promise<any | null> {
    let body: any = null
    try { body = JSON.parse(await bucketStore(this.env.PACKAGES, this._pid).get!(pointer.parcel)) } catch { return null }
    if (!body || typeof body !== 'object' || String(body[by] ?? '') !== String(pointer[by] ?? '')) return null
    return pointer.reqId !== undefined ? { ...body, reqId: pointer.reqId } : body
  }
  private emit(ws: WebSocket, head: Record<string, unknown>, payload: unknown) {
    const frame = (p: unknown) => JSON.stringify({ ...head, payload: p })
    const text = frame(payload)
    const small = SECRET_PAYLOADS.has(String((payload as any)?.t)) || text.length * 3 <= FRAME_LIMIT   // under the limit even if every character took three bytes
    const prev = this.outChain.get(ws)
    if (small && !prev) { try { ws.send(text) } catch { /* gone */ } return }
    const next = (prev ?? Promise.resolve()).then(async () => {
      if (small) { try { ws.send(text) } catch { /* gone */ } return }
      await wireSender({ send: (f) => { try { ws.send(frame(f)) } catch { /* gone */ } }, parcels: bucketStore(this.env.PACKAGES, this._pid, (this.env as any).JWT_SECRET, this.ledger()),
        onFallback: (why) => console.warn(`[hub] a payload went as parts: ${why}`) }).send(payload as Record<string, unknown>)
    }).catch((e) => console.warn(`[hub] a payload was not sent: ${e?.message ?? e}`))
    this.outChain.set(ws, next)
    void next.then(() => { if (this.outChain.get(ws) === next) this.outChain.delete(ws) })
  }
  private deliverToUser(userId: string, envelope: Envelope, exceptWsId?: string) {
    if (!userId) return   // never fan out to '' (that would be every unauthenticated connection)
    for (const [ws, conn] of this.connByWs)
      if (conn.userId === userId && conn.wsId !== exceptWsId && conn.type !== 'code-engine') this.deliverToConn(ws, conn, envelope)
  }
  // Tier-2 variant for AGENT LOGS: deliver only to the OWNER's connections that have ATTACHED to `channel`.
  // Owner-scoped = the authz boundary (a user's logs reach only that user); attach-filtered = bandwidth (a
  // client that isn't watching gets nothing). owner '' (a log nobody can be found to own) → the project's admins only.
  private deliverToChannel(channel: string, owner: string, envelope: Envelope) {
    for (const [ws, conn] of this.connByWs) {
      if (conn.type === 'code-engine' || !conn.channels?.has(channel)) continue
      if (owner ? conn.userId !== owner : !conn.admin) continue
      this.deliverToConn(ws, conn, { ...envelope, channel } as Envelope)   // the channel kept beside the recipient's address (a person's UserDO delivers by it)
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
    return this.j({ access: rows.map(r => ({ ...r, capabilities: r.source === 'org-admin' ? PROJECT_ROLES.admin.capabilities : this.roleCapabilities(r.role_id) })) })
  }

  private async grantAccess(request: Request): Promise<Response> {
    const b = await request.json().catch(() => ({})) as any
    const email = String(b.email ?? '').trim().toLowerCase()
    if (!email) return this.j({ error: 'email required' }, 400)
    const roleId = b.roleId ? String(b.roleId) : 'member'
    // 'org-admin' is set ONLY by the org's own sync (POST /org-admins), never by a grant arriving here.
    const exists = !!builtinRole('project', roleId) || [...this.ctx.storage.sql.exec('SELECT 1 FROM roles WHERE id = ? AND builtin = 0', roleId)].length > 0
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

  /** The roles a person may be given here: the built-in ones (their capabilities the code's) and the project's own. */
  private listRoles(): Response {
    const custom = ([...this.ctx.storage.sql.exec('SELECT id, name FROM roles WHERE builtin = 0 ORDER BY name')] as any[]).map((r) => ({ id: r.id, name: r.name, capabilities: this.roleCapabilities(r.id), builtin: false }))
    return this.j({ roles: [...Object.values(PROJECT_ROLES), ...custom] })
  }

  /** A custom role, made or changed by someone with project.people — never with a capability they do not hold. */
  private async upsertRole(request: Request): Promise<Response> {
    const b = await request.json().catch(() => ({})) as any
    const held = this.capsOfRequest(request)
    const { role, problems } = checkRole('project', { id: b.id, name: b.name, capabilities: b.capabilities ?? b.permissions })
    if (!role) return this.j({ error: problems.join('; ') }, 400)
    const over = beyond(role.capabilities, held)
    if (over.length) return this.j({ error: `you cannot give what you do not hold: ${over.join(', ')}` }, 403)
    this.ctx.storage.sql.exec(
      'INSERT INTO roles (id, name, permissions) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, permissions = excluded.permissions',
      role.id, role.name, JSON.stringify(role.capabilities))
    this.audit.record({ actor: this.actorOf(request, b), via: 'admin', action: 'role.set', target: role.id, outcome: 'ok', detail: { name: role.name, capabilities: role.capabilities } })
    return this.j({ ok: true, role })
  }

  private async deleteRole(request: Request): Promise<Response> {
    const b = await request.json().catch(() => ({})) as any
    const id = String(b.id ?? '')
    if (builtinRole('project', id)) return this.j({ error: 'built-in roles cannot be deleted' }, 400)
    const [row] = [...this.ctx.storage.sql.exec('SELECT 1 FROM roles WHERE id = ?', id)]
    if (!row) return this.j({ error: 'no such role' }, 404)
    const holders = [...this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM access WHERE role_id = ?', id)][0] as any
    if (Number(holders?.n) > 0) return this.j({ error: `${holders.n} ${Number(holders.n) === 1 ? 'person holds' : 'people hold'} this role — give them another first` }, 400)
    this.ctx.storage.sql.exec('DELETE FROM roles WHERE id = ?', id)
    this.audit.record({ actor: this.actorOf(request, b), via: 'admin', action: 'role.remove', target: id, outcome: 'ok' })
    return this.j({ ok: true, id })
  }

  /** Who a REST call is from (the worker stamps it). */
  private actorOf(request: Request, body?: any): { kind: 'user'; id: string; email?: string } {
    let a: any = null
    try { a = JSON.parse(request.headers.get('x-sa-actor') ?? 'null') } catch { /* none */ }
    const email = String(a?.email ?? body?.by ?? '').toLowerCase()
    return { kind: 'user', id: email || String(a?.id ?? 'unknown'), ...(email.includes('@') ? { email } : {}) }
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
    // `online`: an engine is connected to this project now.
    const online = [...this.connByWs.values()].some((c) => c.type === 'code-engine')
    return Response.json({ ...(p ?? { profile: null, version: 0, updatedBy: null, updatedAt: 0 }), running: this.runningProfile, online })
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
      this.emit(ws, { from: { id: 'hub', type: 'hub' }, to: { id: wsId, type: role } }, payload)
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
        ws.send(JSON.stringify(msg.from ? msg : { from: { id: 'hub', type: 'hub' }, payload: msg.payload }))
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
    const rows = [...this.ctx.storage.sql.exec(`
      SELECT d.id, d.name, d.build_id, d.files, d.bytes, d.uploaded_by, d.uploaded_at, d.created_at,
             (SELECT n FROM dashboard_builds b WHERE b.dash_id = d.id AND b.build_id = d.build_id) AS version,
             (SELECT COUNT(*) FROM dashboard_builds b WHERE b.dash_id = d.id) AS builds
      FROM dashboards d ORDER BY d.created_at DESC`)]
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
    const buildId = String(b?.buildId ?? ''), files = Number(b?.files ?? 0), bytes = Number(b?.bytes ?? 0), by = String(b?.by ?? ''), at = Date.now()
    const contentHash = b?.contentHash ? String(b.contentHash) : null
    const [last] = this.ctx.storage.sql.exec('SELECT MAX(n) AS n FROM dashboard_builds WHERE dash_id = ?', id)
    const n = Number((last as any)?.n ?? 0) + 1
    this.ctx.storage.sql.exec("INSERT INTO dashboard_builds (dash_id, build_id, n, files, bytes, uploaded_by, uploaded_at, content_hash, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'publish')", id, buildId, n, files, bytes, by, at, contentHash)
    this.ctx.storage.sql.exec('UPDATE dashboards SET build_id = ?, files = ?, bytes = ?, uploaded_by = ?, uploaded_at = ? WHERE id = ?', buildId, files, bytes, by, at, id)
    return Response.json({ ok: true, version: n })
  }

  /** Every build this dashboard has had, newest first, with which one is current. */
  private listDashboardBuilds(id: string, hash: string | null = null): Response {
    const [d] = this.ctx.storage.sql.exec('SELECT build_id FROM dashboards WHERE id = ?', id)
    if (!d) return new Response('no such dashboard', { status: 404 })
    const cols = 'build_id, n, files, bytes, uploaded_by, uploaded_at, content_hash, kind, from_n, pruned_at'
    const rows = (hash
      ? [...this.ctx.storage.sql.exec(`SELECT ${cols} FROM dashboard_builds WHERE dash_id = ? AND content_hash = ? AND pruned_at IS NULL ORDER BY n DESC`, id, hash)]
      : [...this.ctx.storage.sql.exec(`SELECT ${cols} FROM dashboard_builds WHERE dash_id = ? ORDER BY n DESC`, id)])
    const top = Math.max(0, ...rows.map((r: any) => Number(r.n)))
    return Response.json({ builds: rows.map((r: any) => ({ ...r, current: Number(r.n) === top && r.build_id === (d as any).build_id, pruned: r.pruned_at != null })) })
  }

  /** Make an earlier build live again: a NEW version that points at that build's files. The ledger only grows;
   *  the bytes never move; the row it came from says which version this restores. */
  private async rollDashboardTo(id: string, request: Request): Promise<Response> {
    const b: any = await request.json().catch(() => ({}))
    const buildId = String(b?.buildId ?? ''), by = String(b?.by ?? '')
    const [row] = this.ctx.storage.sql.exec('SELECT * FROM dashboard_builds WHERE dash_id = ? AND build_id = ? AND pruned_at IS NULL ORDER BY n ASC LIMIT 1', id, buildId)
    if (!row) return new Response('no such build of this dashboard, or its files are gone', { status: 404 })
    const r: any = row
    const [last] = this.ctx.storage.sql.exec('SELECT MAX(n) AS n FROM dashboard_builds WHERE dash_id = ?', id)
    const n = Number((last as any)?.n ?? 0) + 1, at = Date.now()
    this.ctx.storage.sql.exec("INSERT INTO dashboard_builds (dash_id, build_id, n, files, bytes, uploaded_by, uploaded_at, content_hash, kind, from_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'restore', ?)", id, buildId, n, r.files, r.bytes, by, at, r.content_hash, r.n)
    this.ctx.storage.sql.exec('UPDATE dashboards SET build_id = ?, files = ?, bytes = ?, uploaded_by = ?, uploaded_at = ? WHERE id = ?', buildId, r.files, r.bytes, by, at, id)
    return Response.json({ ok: true, version: n, restores: r.n })
  }

  /** A build whose bytes were pruned from the bucket stays in the ledger and says so: nothing to restore from. */
  private markDashboardBuildPruned(id: string, buildId: string): Response {
    this.ctx.storage.sql.exec('UPDATE dashboard_builds SET pruned_at = ? WHERE dash_id = ? AND build_id = ? AND pruned_at IS NULL', Date.now(), id, buildId)
    return Response.json({ ok: true })
  }

  private deleteDashboard(id: string): Response {
    this.ctx.storage.sql.exec('DELETE FROM dashboards WHERE id = ?', id)
    this.ctx.storage.sql.exec('DELETE FROM dashboard_builds WHERE dash_id = ?', id)
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
