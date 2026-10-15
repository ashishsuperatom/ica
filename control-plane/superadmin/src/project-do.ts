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
import { flyPlace, flySetImage, flyMachine, flyRemoveMachine, flyHasImage, flySuspend, flyStop, flyStart, flyRunning, FLY_IMAGES, slugOf, type FlyPlace } from './fly.js'
import { AnswerBuffer } from './answer-buffer.js'
import { receiver, sender as wireSender, FRAME_LIMIT, isParcelled } from '../../../clients/transport.js'
import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { PROJECT_MIGRATIONS, adoptProjectSchemaVersion } from './migrations.js'
import { listEngineReleases } from './engine-releases.js'
import { bucketStore } from './parcels.js'
import { AuditLog, auditScope } from './audit.js'
import { AgentKeys, KeyRefusal, type AgentKey } from './agent-keys.js'
import { HUB_MESSAGES } from '../../shared/hub-messages.js'
import { ALL, can, beyond, builtinRole, capabilitiesOf, checkRole, isCapability, messageNeeds, whyNot, PROJECT_ROLES, type Capability } from '../../shared/permissions.js'
import { SUPERADMIN_EMAILS } from './auth/tokens.js'
import { ProgramCatalogue, CatalogueRefusal } from './program-catalogue.js'
import { TAG, modelOnlyKeyOf, profileProblems } from '../../../vm/packages/agent-contract/contract.mjs'
import { stepOf } from '../../../vm/packages/decision/src/index.js'
import { checkPolicy, resolve as resolvePolicies, type AccessPolicy } from './access-policies.js'
import { costOf, priceFor, type Price } from './metering.js'
import { createRecorder, type Recorder } from './records.js'
import { connectorById, checkConnection, connectorOfManifest, CONNECTORS, SA_WAREHOUSE, type Connector } from '../../shared/connectors.js'
import { connectorObjectKey } from './org-connectors.js'
import { checkEngineManifest } from '../../../connectors/src/contract.js'
import { PLATFORM_MODELS } from '../../shared/models.js'
import { readyBridge } from './bridges.js'
import { seal, unseal } from './proxy/seal.js'
import { signTicket, tokenCall } from './oauth-flow.js'
import { OAUTH_PROVIDERS, OAUTH_CALLBACK, type OAuthTokens } from '../../shared/oauth.js'
import { projectGraph, migrateGraph, GRAPH_MESSAGES, GRAPH_VIEWS, type Who } from './graph.js'
import { changesFingerprint } from '../../../vm/packages/composition-graph/src/fingerprint.js'
import { projectDsi, DsiRefusal } from './dsi.js'
/** THE ONLY PAYLOADS THAT CARRY SECRETS: a project's connections, unsealed for its engine (and one connection, for one
 *  person). They are sent inline on the engine's authenticated socket — never as a parcel, never into the bucket, the
 *  audit, the record stream or a log. A secret enters the platform only through the connections routes (sealed at once,
 *  proxy/seal.ts) and leaves only in these. */
export const SECRET_PAYLOADS = new Set(['connections:list', 'connection:got'])
import { projectLineage, LineageRefusal } from './lineage.js'
import { projectJobs, JobRefusal, type Job } from './jobs.js'
import { projectWorkloads, type WorkloadRow } from './workloads.js'
import { WORKLOAD_KINDS, isWorkloadKind, specOf } from '../../../vm/packages/platform-types/src/index.js'
import { putObject, removeObjects, kindOfKey, projectOfKey as projectOfObject, KINDS, type Ledger, type LedgerRow } from './storage.js'
import { keyOf as fileKeys } from './files.js'
import { ensureSignInAccount } from './auth/clerk-users.js'
import { sourceFiles } from '../../../vm/packages/programs/src/bundle.js'
import { DevEnvs, DevRefusal } from './dev-envs.js'
import { personHome, personId } from '../../shared/identity.js'


// How long a question queued for a sleeping machine is still worth waking up for. Past this the person has
// gone, and delivering it produces an answer nobody is waiting for. Dropped, and said so in the log.
const QUEUE_MAX_AGE_MS = 60 * 60 * 1000        // 60 min

// IDLE ON FLY — money. The engine only connects OUT to the hub, so Fly's own auto-stop (which watches traffic through its
// proxy) never sees it: this object watches real activity and suspends, stops and wakes the machine itself.
// Any work wakes it at once and starts the clock again; it stays awake a whole day after the last, and only then sleeps.
const SUSPEND_AFTER_MS = 24 * 60 * 60 * 1000       // 24 h idle (no real activity) → suspend (RAM snapshot kept → ~1-2s WARM wake, no agent re-warm)
const STOP_AFTER_MS    = 7 * 24 * 60 * 60 * 1000   // 7 days idle → stop (release the RAM snapshot; next wake is a COLD boot + agent warm-up)

// ── Types ──────────────────────────────────────────────────────────────────────

interface ConnInfo {
  wsId: string
  type: string       // "code-engine" | "runtime" | "admin" | "agent"
  userId?: string    // only for user connections; an agent key's is `agent:<keyId>`
  email?: string     // the person's address, from their token — or the person a key of their own acts as
  maker?: string     // who made an agent key: the key acts for them, cut to what they hold now
  admin?: boolean    // a person who administers this project (superadmin, org admin, or the project's admin role)
  orgRole?: string   // "admin" | "member" — from JWT, used for persona enforcement
  instanceId?: string // singleton identity: which process this connection belongs to (stable per boot)
  epoch?: number     // singleton generation: the process boot time — a NEWER process has a higher epoch
  channels?: Set<string>   // agent-LOG channels this connection has attached to (composer-log / analyst-log / narration)
}

/** An engine switch as the box's Engine Updater reported it, step by step. */
interface EngineSwitch {
  id: string; to: string; tag: string | null; from: string | null; startedAt: string; endedAt?: string
  state: 'switching' | 'switched' | 'rolled-back' | 'refused'
  steps: { step: string; at: string; note?: string }[]
  reason?: string; fix?: string; logTail?: string
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

/** A connection as wanted, as a spec (workloads): its connector, settings, bridge and secrets (by their sealed form) —
 *  the engine echoes it once it runs exactly that. */
function connectionSpec(r: { connector: string; settings: string; bridge?: string | null; secrets_sealed?: string | null; auth?: string | null }): string {
  let settings: unknown = r.settings
  try { settings = JSON.parse(r.settings) } catch { /* kept as written */ }
  return specOf({ connector: r.connector, settings, bridge: r.bridge ?? null, secrets: r.secrets_sealed ? specOf(r.secrets_sealed) : null, ...(r.auth === 'per-user' ? { auth: 'per-user' } : {}) })
}

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

/** What using a project takes — holding only these is not administering anything, so the admin console is not for them. */
const CONSOLE_FREE: readonly Capability[] = ['project.view', 'project.ask', 'project.approve', 'project.connect', 'warehouse.use']

/** What the platform wants of a workload: its spec (empty: nothing to run), and what is said beside it. */
type Wanted = { spec: string; label?: string; newer?: string; canRollBack?: boolean; blocked?: string }

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

  // Grace for a briefly-absent engine before a routed message errors "offline" (or wakes a machine): only if it
  // heartbeated within ENGINE_RECENT_MS (so we don't stall a genuinely-off box), wait up to ENGINE_GRACE_MS.
  private static ENGINE_RECENT_MS = 30_000
  private static ENGINE_GRACE_MS = 5_000

  // Durable per-user answer buffer + session snapshot — all storage logic lives in answer-buffer.ts; the DO
  // only wires it to transport (relay) and its migration ladder.
  private buffer: AnswerBuffer
  private audit: AuditLog
  private agentKeys: AgentKeys
  private catalogue: ProgramCatalogue
  private devEnvs: DevEnvs
  private record: Recorder

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Its own project id, from its name (proj:<id>) — known from the start, also when it wakes for a socket's message
    // after a restart, where no request has told it yet (an audit event with no project is refused).
    const own = /^proj:([0-9a-f-]{36})$/.exec(ctx.id.name ?? '')?.[1]
    if (own) this._pid = own
    this.buffer = new AnswerBuffer(this.ctx.storage.sql, (e, d) => this.log(e, d))
    this.audit = new AuditLog(this.ctx.storage.sql as any, () => this._pid ?? '', { stream: (env as any).AUDIT, records: createRecorder((env as any).RECORDS, () => this._pid ?? ''), warn: (m) => { this.log('audit:send_failed', { message: m }); console.warn(`[audit] ${m}`) } })
    this.agentKeys = new AgentKeys(this.ctx.storage.sql as any, () => this._pid ?? '')
    this.catalogue = new ProgramCatalogue(this.ctx.storage.sql as any, env.PACKAGES, () => this._pid ?? '', () => this.ledger())
    this.devEnvs = new DevEnvs(this.ctx.storage.sql as any, (id, purge) => this.sendToRole('code-engine', { t: 'dev:clear', env: id, ...(purge ? { purge: true } : {}) }))
    this.devEnvs.onEnd = (owner) => { this.devToPerson(owner); void this.reportDevEnvs(owner) }
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
    this.ctx.blockConcurrencyWhile(async () => { await this.migrate(); this._org = await this.orgId() })
  }

  // ── Schema: migrations (migrations.ts), once per wake; a single-row read when nothing is pending ──
  private async migrate() {
    runMigrations(durableObjectDb(this.ctx.storage), PROJECT_MIGRATIONS, { name: `ProjectDO ${this.ctx.id.toString().slice(0, 8)}`, adopt: adoptProjectSchemaVersion })
    // The composition graph's own tables, by its own migrations (graph.ts).
    migrateGraph(this.ctx.storage)

    // An engine on Fly with a stale heartbeat gets an alarm, so it is suspended within 10 min of this object loading.
    const [m] = this.ctx.storage.sql.exec("SELECT last_heartbeat FROM fly_machine WHERE idle_phase = 'active' AND provider = 'fly' LIMIT 1")
    if (m) {
      const lastHb = (m as any).last_heartbeat as number
      if (lastHb > 0) this.ctx.storage.setAlarm(lastHb + SUSPEND_AFTER_MS)
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
    // What a machine needs to run this project's engine (sacli engine start): the project, its name, the engine's key and
    // the hub — to someone who may run the project (project.manage, checked by the worker); every read recorded.
    if (request.method === 'GET'  && path === '/engine-credentials') {
      const [k] = [...this.ctx.storage.sql.exec('SELECT key FROM api_key LIMIT 1')] as any[]
      if (!k) return Response.json({ error: 'this project has no engine key yet' }, { status: 404 })
      let who = 'unknown'; try { const a = JSON.parse(request.headers.get('x-sa-actor') ?? 'null'); who = a?.email ?? a?.id ?? who } catch { /* none */ }
      this.audit.record({ actor: { kind: 'user', id: who }, via: 'api', action: 'engine.credentials', target: this._pid ?? '', outcome: 'ok' })
      return Response.json({ project: this._pid, name: await this.projectName(), engineKey: k.key, hub: `wss://${(this.env as any).PLATFORM_DOMAIN ?? 'superatom.site'}`, platform: (this.env as any).PLATFORM_DOMAIN ?? 'superatom.site' })
    }
    if (request.method === 'GET'  && path === '/attention')    return this.attention()
    // The organisation's connectors changed (published, blocked, approved): read again; the engine reloads its connections.
    // A person's account connected (the worker's OAuth callback, oauth-flow.ts): their tokens kept where their own key is.
    if (request.method === 'POST' && path === '/oauth/complete') {
      const b: any = await request.json().catch(() => ({}))
      const [c] = [...this.ctx.storage.sql.exec('SELECT id, name, auth FROM connections WHERE id = ? AND removed_at IS NULL', String(b.connection ?? ''))] as any[]
      if (!c) return this.j({ error: 'that connection is gone' }, 404)
      if (c.auth !== 'per-user') return this.j({ error: `${c.name} is no longer read with each person's own account` }, 400)
      const email = String(b.email ?? '').toLowerCase(), master = (this.env as any).CREDENTIALS_MASTER_KEY
      if (!email.includes('@') || !b.tokens?.access_token) return this.j({ error: 'who, and their tokens' }, 400)
      if (!master) return this.j({ error: 'secrets cannot be kept: the platform has no master key' }, 503)
      const kept = await this.personKeys(email, c.id, 'PUT', await seal(JSON.stringify({ oauth: b.tokens }), master))
      if (!kept.ok) return this.j({ error: kept.error }, 502)
      this.audit.record({ actor: { kind: 'user', id: email, email }, via: 'ui', action: 'connection.my-key.oauth', target: c.id, outcome: 'ok', detail: { provider: b.tokens.provider, account: b.tokens.account ?? null } })
      this.sendToRole('code-engine', { t: 'connections:person-key-changed', name: c.name, email })
      return this.j({ ok: true, name: c.name })
    }
    // For the organisation's registry: which connection here runs which connector, at which version (never settings or keys).
    if (request.method === 'GET' && path === '/org-connectors/usage') return this.j({ connections: [...this.ctx.storage.sql.exec("SELECT name, connector, bridge, auth FROM connections WHERE removed_at IS NULL AND level = 'project' ORDER BY name")] })
    if (request.method === 'POST' && path === '/org-connectors/changed') { this.orgCat = null; await this.orgCatalogue(); this.sendToRole('code-engine', { t: 'connections:changed' }); return this.j({ ok: true }) }
    if (path === '/workloads' || path.startsWith('/workloads/')) { await this.orgCatalogue(); return this.workloadRoute(request, path) }
    // A failure dealt with: it leaves Attention (the activity is kept, marked seen; the audit says who and when).
    if (request.method === 'POST' && path === '/attention/dismiss') {
      const { activity } = await request.json().catch(() => ({})) as { activity?: string }
      const row = [...this.ctx.storage.sql.exec("SELECT id, title FROM activities WHERE id = ? AND state = 'failed'", String(activity ?? ''))][0] as any
      if (!row) return Response.json({ error: 'there is no such failure waiting' }, { status: 404 })
      this.ctx.storage.sql.exec("UPDATE activities SET state = 'failed-seen' WHERE id = ?", row.id)
      this.audit.record({ actor: { kind: 'user', id: this.actor(request) }, via: 'admin', action: 'attention.dismiss', target: `${row.id} ${row.title}`, outcome: 'ok' })
      return Response.json({ ok: true })
    }
    // Which release of the engine this project runs: GET what is chosen, what the engine reports it runs, and the releases
    // there are; PUT { tag } or { digest } to choose (project.manage, checked by the worker; docs/deploying-the-engine.md).
    if (request.method === 'GET'  && path === '/engine-release') return this.getEngineRelease()
    if (request.method === 'PUT'  && path === '/engine-release') return this.putEngineRelease(request)
    // The box's Engine Updater, step by step (the worker passes it on with the engine key it sent, checked here).
    if (request.method === 'POST' && path === '/engine-release/progress') return this.engineSwitchStep(request)
    if (path === '/warehouse/grants') return this.warehouseGrants(request)
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
    if (path === '/agent-keys' || path.startsWith('/agent-keys/') || path === '/my-key' || path === '/audit') return this.agentKeysAndAudit(request, path)
    if (request.method === 'POST' && path === '/agent-call') return this.agentCall(request)
    if (request.method === 'GET' && path === '/org-id') return Response.json({ org: await this.orgId() })   // person-home.ts
    if (request.method === 'POST' && path === '/key-access') return this.keyAccess(request)
    if (path === '/engine/programs' || path.startsWith('/engine/programs/')) return this.enginePrograms(request, path)
    if (path === '/engine/connectors') return this.engineConnections(request, path)
    if (path.startsWith('/engine/sa-warehouse/')) return this.engineSaWarehouse(request, path)
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
    if (path === '/connections' || path.startsWith('/connections/') || path === '/connectors' || path.startsWith('/connectors/')) return this.connectionsApi(request, path)
    if (path === '/storage' || path.startsWith('/storage/')) return this.storageApi(request, path)
    // A pipeline tells the project what it read and wrote (an OpenLineage RunEvent), with a project key.
    if (path === '/lineage/openlineage' && request.method === 'POST') {
      const by = request.headers.get('x-sa-actor') ? (JSON.parse(request.headers.get('x-sa-actor')!).email ?? JSON.parse(request.headers.get('x-sa-actor')!).id) : 'pipeline'
      try { const r = this.lineage().openLineage(await request.json(), String(by)); return Response.json(r, { status: 201 }) }
      catch (e: any) { return Response.json({ error: e instanceof LineageRefusal ? e.message : 'not an OpenLineage event' }, { status: 400 }) }
    }
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
    // How conversations work for everyone in the project: `branches` — going back to a step and taking another path keeps
    // both, a branch bar between them (on), or continues from there, what was below it no longer shown (off, the default).
    if (request.method === 'GET' && path === '/conversation-settings') return Response.json(await this.conversationSettings())
    if (request.method === 'PUT' && path === '/conversation-settings') {
      const body = await request.json().catch(() => null) as { branches?: unknown } | null
      if (typeof body?.branches !== 'boolean') return Response.json({ error: 'branches is true or false' }, { status: 400 })
      await this.ctx.storage.put('conversation:branches', body.branches)
      this.audit.record({ actor: { kind: 'user', id: this.actor(request) }, via: 'api', action: 'project.conversations', target: `branches ${body.branches ? 'on' : 'off'}`, outcome: 'ok' })
      const settings = await this.conversationSettings()
      for (const [ws, conn] of this.connByWs) if (conn.type === 'runtime') this.deliverToConn(ws, conn, { from: { id: 'hub', type: 'hub' }, payload: { t: 'project:conversations', ...settings } } as Envelope)
      return Response.json(settings)
    }
    // Everyone's development environments (sacli dev), for the people who run the project; DELETE ?id= ends one.
    if (request.method === 'GET'    && path === '/dev-envs') return Response.json({ envs: this.devEnvs.list(null) })
    if (request.method === 'POST' && path === '/dev-envs/delete-own') {
      const b = await request.json().catch(() => ({})) as { id?: string; owner?: string }
      const owner = String(b.owner ?? '').toLowerCase()
      if (!can(this.capabilitiesOfEmail(owner), 'project.develop')) return Response.json({ error: 'deleting an environment needs project.develop here' }, { status: 403 })
      try { this.devEnvs.delete(owner, b.id); this.audit.record({ actor: { kind: 'user', id: owner, email: owner }, via: 'api', action: 'dev.delete', target: String(b.id), outcome: 'ok' }); return Response.json({ ok: true }) }
      catch (e: any) { return Response.json({ error: String(e?.message ?? e) }, { status: 400 }) }
    }
    if (request.method === 'DELETE' && path === '/dev-envs') {
      try { this.devEnvs.delete(this.actor(request), url.searchParams.get('id'), true); this.audit.record({ actor: { kind: 'user', id: this.actor(request) }, via: 'api', action: 'dev.delete', target: String(url.searchParams.get('id') ?? ''), outcome: 'ok' }); return Response.json({ ok: true }) }
      catch (e: any) { return Response.json({ error: String(e?.message ?? e) }, { status: 400 }) }
    }
    if (request.method === 'PUT'    && path === '/engine-place') return this.placeOnFly(request)
    if (request.method === 'DELETE' && path === '/engine-place') return this.leaveFly(request)
    if (request.method === 'GET'  && path === '/profile')      return this.getProfile()
    if (request.method === 'PUT'  && path === '/profile')      return this.putProfile(request)
    if (request.method === 'POST' && path === '/verify-conn')  return this.verifyConn(request)
    // The model proxy and the tunnel: the engine's key or its model-only key (agents hold only that one); never the hub's door.
    if (request.method === 'POST' && path === '/verify-model') {
      const { key } = await request.json().catch(() => ({})) as { key?: string }
      const ok = !!key && (this.keyMatches(key) || await this.modelKeyMatches(key))
      return Response.json({ ok }, { status: ok ? 200 : 401 })
    }

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
    // A SOCKET'S HELLO FIRST. The hello waits on things outside this object (a key's organisation, the machine provider),
    // and while it waits the socket's next message can arrive — handled before the socket is registered, it was refused as
    // unauthenticated. So a message that arrives while its socket's hello is in hand waits for it; after that, none waits.
    const helloing = this.helloing.get(ws)
    if (helloing) await helloing
    const handled = this.handleMessage(ws, msg).catch(() => { ws.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, payload: { t: 'error', reason: 'Invalid JSON' } })) })
    if (msg?.type === 'hello') { this.helloing.set(ws, handled); try { await handled } finally { this.helloing.delete(ws) } }
    else await handled
  }
  private helloing = new WeakMap<WebSocket, Promise<void>>()
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
          await this.armIdle(now + SUSPEND_AFTER_MS)
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
    // WORKLOADS (workloads.ts): the engine's report of what it runs, sent when something changes; answers to actions and
    // looks it was asked for.
    if (msg.type === 'workload:status' && sender.type === 'code-engine') {
      const { kept, refused } = this.workloads().report(Array.isArray(msg.statuses) ? msg.statuses : [msg.status])
      for (const r of refused) this.log('workload:refused', { problems: r.problems })
      for (const g of Array.isArray(msg.gone) ? msg.gone : []) if (isWorkloadKind(g?.kind) && typeof g?.id === 'string') this.workloads().gone(g.kind, g.id)
      if (kept.length || msg.gone?.length) this.workloadsChanged(kept)
      return
    }
    if ((msg.type === 'workload:acted' || msg.type === 'workload:inspected') && sender.type === 'code-engine') {
      const w = this.engineWaits.get(String(msg.reqId)); if (w) { this.engineWaits.delete(String(msg.reqId)); w(msg) }
      return
    }
    if (msg.type === 'sources:report' && sender.type === 'code-engine') {
      const list = Array.isArray(msg.sources) ? msg.sources.filter((x: any) => typeof x?.id === 'string') : []
      const at = new Date().toISOString()
      this.ctx.storage.transactionSync(() => {
        // What the source is, as its connector says (engine-made information goes up): kept on the connection where nobody said otherwise.
        for (const x of list) this.ctx.storage.sql.exec("UPDATE connections SET kind = COALESCE(kind, ?), dialect = COALESCE(dialect, ?), description = COALESCE(description, ?) WHERE name = ? AND removed_at IS NULL AND level = 'project'",
          x.kind ?? null, x.dialect ?? null, x.description ? String(x.description).slice(0, 4000) : null, x.id)
        // How each stands is its workload (workload:status); this message only says what each source is.
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
    // A PERSON'S OWN KEY for a connection that reads with each person's own (auth per-user), for the instance of it the
    // engine starts for their turn (docs/connectors-plan.md 6a): their values, split as the connector's fields say. None
    // given: the answer says so (the manager then refuses that person's reads, saying how to give one). Audited.
    if (msg.type === 'connection:person-key' && sender.type === 'code-engine') {
      const reply = (payload: Record<string, unknown>) => { this.emit(ws, { from: { id: 'hub', type: 'hub' } }, { t: 'connection:person-key', reqId: msg.reqId, ...payload }) }
      try {
        const name = String(msg.name ?? ''), email = String(msg.email ?? '').toLowerCase()
        const [c] = [...this.ctx.storage.sql.exec("SELECT id, connector, auth FROM connections WHERE name = ? AND removed_at IS NULL AND level = 'project'", name)] as any[]
        if (!c) return reply({ error: `there is no connection ${name}` })
        if (c.auth !== 'per-user') return reply({ error: `${name} reads with one shared key` })
        const k = await this.personKeys(email, c.id, 'GET')
        if (!k.ok) return reply({ error: k.error })
        if (!k.sealed) {
          // none given: for a connector people sign in to, how to connect — else the manager says how to give a key
          await this.orgCatalogue()
          const oauth = this.connectorOf(c.connector)?.oauth
          return reply({ key: null, ...(oauth ? { error: `reads with each person's own ${OAUTH_PROVIDERS[oauth.provider]?.title ?? oauth.provider} account, and ${email} has not connected theirs — in the app: Connections → ${name} → Connect my account` } : {}) })
        }
        const master = (this.env as any).CREDENTIALS_MASTER_KEY
        const values = JSON.parse(await unseal(k.sealed, master)) as Record<string, unknown>
        if (values.oauth) {
          const tokens = await this.freshTokens(email, c.id, values.oauth as OAuthTokens)
          if ('error' in tokens) return reply({ key: null, error: tokens.error })
          this.audit.record({ actor: { kind: 'engine', id: 'engine' }, via: 'engine', action: 'connection.person-key', target: c.id, outcome: 'ok', detail: { for: email, oauth: tokens.provider } })
          return reply({ key: { settings: {}, secrets: { accessToken: tokens.access_token }, expiresAt: tokens.expires_at } })
        }
        await this.orgCatalogue()
        const fields = this.connectorOf(c.connector)?.fields ?? []
        const settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}
        for (const [key, v] of Object.entries(values)) { if (fields.find((f) => f.name === key)?.type === 'secret' || !fields.length) secrets[key] = String(v); else settings[key] = v }
        this.audit.record({ actor: { kind: 'engine', id: 'engine' }, via: 'engine', action: 'connection.person-key', target: c.id, outcome: 'ok', detail: { for: email } })
        reply({ key: { settings, secrets } })
      } catch (e: any) { reply({ error: e?.message ?? String(e) }) }
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
          case 'dsi:finish': {
            this.dsi().finish(msg)
            // The source's tables are datasets of the lineage map from now on.
            const src = String(msg.source ?? '')
            if (src) this.lineage().known(this.dsi().tablesOf(src).map((t) => ({ id: `source:${src}/${t}`, kind: 'source', title: t })))
            break
          }
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
        this.setRunningProfile({ version, agents: msg.agents ?? null, profile: msg.profile ?? null, release: msg.release ?? null, at: Date.now() })
        this.flyConfirm(msg.release)
        this.log('config:applied', { version })
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
      await this.recordHeartbeat()
      if (await this.register(ws, role, undefined, undefined, instanceId, epoch, { modelsHash: typeof msg.modelsHash === 'string' ? msg.modelsHash : undefined })) this.flushQueued(ws)
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
      await this.register(ws, 'agent', `agent:${v.key.id}`, undefined, undefined, undefined, { maker: v.key.created_by, ...(v.key.acts_as ? { email: v.key.acts_as } : {}) })
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

      // A service identity (a bot: the ChannelDO, Teams) on the runtime surface, admitted as a member of this project.
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

  /** A person, by their verified sign-in, on a surface ('admin' = the admin console, 'runtime' = their own apps):
   *  whether they may in, and whether they administer the project. Access is by email (the organisation assigns people
   *  to the project, landing in `access`); `members` keeps service identities that have no address. */
  private admitPerson(claims: { userId: string; email?: string; role?: string }, surface: 'admin' | 'runtime'): { ok: true; admin: boolean } | { ok: false; code: number; reason: string } {
    if (claims.role === 'superadmin') return { ok: true, admin: true }
    // The admin console: anyone who administers something here — the organisation's admins, a project admin, a custom
    // role with more than using it. What each page and message needs is then checked against what they hold (capsOf).
    if (surface === 'admin') {
      const held = this.capabilitiesOfEmail(claims.email)
      return held.some((c) => !CONSOLE_FREE.includes(c)) ? { ok: true, admin: can(held, 'project.audit') }
        : { ok: false, code: 4003, reason: held.length ? 'Your role here does not include the admin console' : 'No access to this project' }
    }
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
    const user = (this.linkStubs.get(conn.wsId) ?? this.userStub(`user:${conn.userId}`))   // their home in this organisation
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
    if (!had) this.log('ws:connected', { wsId, type: surface, userId: a.userId, orgRole: a.role ?? null, via: 'user' })
    return { ok: true as const, wsId, type: surface, welcome: await this.welcomeFor(conn) }
  }
  /** THE WELCOME, one for every connection: who it is here (wsId, type), the project, and — for a person, an agent or a
   *  service — what it sees with (scopes) and may do (caps). The engine's carries what it runs with instead: this project's
   *  profile (absent: nothing configured, the engine keeps its default) and the platform's model list (only when the hash
   *  its hello named is not the platform's). */
  private async welcomeFor(conn: ConnInfo, enginesModelsHash?: string) {
    const base = { t: 'welcome', wsId: conn.wsId, type: conn.type, project: { id: this._pid, name: await this.projectName() } }
    if (conn.type === 'code-engine') return { ...base, profile: this.profileForEngine(), release: this.releaseForEngine(), models: enginesModelsHash === PLATFORM_MODELS.hash ? { hash: PLATFORM_MODELS.hash } : PLATFORM_MODELS }
    const up = this.upgradingNow()
    const dev = conn.type === 'runtime' ? this.devEnvs.attachedOf(this.personOf(conn)) : null
    const conversations = conn.type === 'runtime' ? { conversations: await this.conversationSettings() } : {}
    return { ...base, scopes: this.scopesOf(conn), caps: this.capsOf(conn), ...(up ? { upgrading: conn.type === 'admin' ? { ...up, switch: this.readSwitch() } : up } : {}), ...(dev ? { dev } : {}), ...conversations }
  }
  /** How conversations work in this project (see the /conversation-settings route). */
  private async conversationSettings(): Promise<{ branches: boolean }> {
    return { branches: (await this.ctx.storage.get<boolean>('conversation:branches')) === true }
  }
  /** A person's own key to one of this project's connections, in THEIR UserDO (by project and connection, sealed). */
  /** A person's OAuth tokens with an access token good for five minutes more: renewed with the refresh token (once) when
   *  it ends sooner, the new ones kept. Refused by the provider (revoked there): dropped, and the person told to connect again. */
  private async freshTokens(email: string, connection: string, t: OAuthTokens): Promise<OAuthTokens | { error: string }> {
    if (t.expires_at - Date.now() > 5 * 60_000) return t
    const title = OAUTH_PROVIDERS[t.provider]?.title ?? t.provider
    if (!t.refresh_token) return { error: `your ${title} sign-in ended — connect your account again` }
    const org = await this.orgId()
    const cr = org ? await (this.env as any).ORG.get((this.env as any).ORG.idFromName(org)).fetch(`http://do/oauth-apps/${t.provider}/client`) : null
    const client: any = cr ? await cr.json().catch(() => ({})) : {}
    if (!cr?.ok) return { error: client.error ?? `the organisation's ${title} app could not be read` }
    const x = await tokenCall(t.provider, client, { grant_type: 'refresh_token', refresh_token: t.refresh_token })
    if (!x.ok) {
      if (x.revoked) { await this.personKeys(email, connection, 'DELETE'); return { error: `your ${title} account is no longer connected (it was signed out or revoked) — connect it again` } }
      return { error: x.error }
    }
    const next: OAuthTokens = { ...t, ...x.tokens, refresh_token: x.tokens.refresh_token ?? t.refresh_token, account: x.tokens.account ?? t.account ?? null }
    await this.personKeys(email, connection, 'PUT', await seal(JSON.stringify({ oauth: next }), (this.env as any).CREDENTIALS_MASTER_KEY))
    return next
  }
  private async personKeys(email: string, connection: string, method: 'GET' | 'PUT' | 'DELETE', sealed?: string): Promise<{ ok: true; sealed?: string | null } | { ok: false; error: string }> {
    try {
      const home = (this.env as any).USER.get((this.env as any).USER.idFromName(personHome(await this.orgId(), await personId(email))))
      const r = await home.fetch(`http://do/connection-keys?project=${encodeURIComponent(this._pid)}&connection=${encodeURIComponent(connection)}`, { method, ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sealed }) } : {}) })
      const d: any = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, error: d?.error ?? `their keys did not answer (${r.status})` }
      return { ok: true, ...(method === 'GET' ? { sealed: d?.sealed ?? null } : {}) }
    } catch (e: any) { return { ok: false, error: `their keys could not be reached: ${String(e?.message ?? e).slice(0, 160)}` } }
  }
  /** A person's environments in this project, to their own Durable Object (their index across projects — what sacli
   *  dev list and the console read). The project stays the authority: this replaces its part of the index each time. */
  private async reportDevEnvs(owner: string) {
    try {
      if (!owner.includes('@')) return
      const home = (this.env as any).USER.get((this.env as any).USER.idFromName(personHome(await this.orgId(), await personId(owner))))
      await home.fetch('http://do/dev-envs', { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: this._pid, projectName: await this.projectName(), envs: this.devEnvs.list(owner).map(({ id, name, status, names, last_used }) => ({ id, name, status, names, last_used })) }) })
    } catch (e: any) { this.log('dev:index_failed', { owner, error: String(e?.message ?? e).slice(0, 160) }) }
  }
  /** A person's open tabs told which development environment they are in now (null: none — they see what is published). */
  private devToPerson(owner: string) {
    const env = this.devEnvs.attachedOf(owner)
    for (const [ws, conn] of this.connByWs) if (conn.type === 'runtime' && this.personOf(conn) === owner)
      this.deliverToConn(ws, conn, { from: { id: 'hub', type: 'hub' }, payload: { t: 'dev:env', env } } as Envelope)
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
  private async register(ws: WebSocket, type: string, userId: string | undefined, orgRole: string | undefined, instanceId?: string, epoch?: number, extra: { email?: string; scopes?: string[]; admin?: boolean; maker?: string; modelsHash?: string } = {}): Promise<boolean> {

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

    ws.send(JSON.stringify({ from: { id: 'hub', type: 'hub' }, to: { id: wsId, type }, payload: await this.welcomeFor(conn, extra.modelsHash) }))
    this.log('ws:connected', { wsId, type, userId: userId ?? null, orgRole: orgRole ?? null })
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

    this.log('ws:disconnected', { wsId: conn.wsId, type: conn.type, userId: conn.userId ?? null })
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
    const conn: ConnInfo = { wsId, type: 'agent', userId: `agent:${v.key.id}`, maker: v.key.created_by, ...(v.key.acts_as ? { email: v.key.acts_as } : {}) }
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
    await this.ensureSaWarehouse()
    const master = (this.env as any).CREDENTIALS_MASTER_KEY
    const rows = [...this.ctx.storage.sql.exec("SELECT * FROM connections WHERE removed_at IS NULL AND level = 'project' ORDER BY created_at")] as any[]
    const out = []
    await this.orgCatalogue()
    for (const r of rows.filter((x) => this.connectorOf(x.connector) && !this.blockedFor(x.connector, x.bridge ?? null))) {
      // A connector with no shared account at all (each person signs in with their own): nothing to test for everyone.
      const personOnly = !(this.connectorOf(r.connector)?.identity ?? ['shared']).includes('shared')
      out.push({ id: r.id, name: r.name, connector: r.connector, settings: JSON.parse(r.settings), secrets: r.secrets_sealed && master ? JSON.parse(await unseal(r.secrets_sealed, master)) : {}, bridge: r.bridge ?? null, spec: connectionSpec(r), auth: r.auth ?? 'shared', ...(personOnly ? { personOnly: true } : {}) })
    }
    return out
  }
  /** SA-WAREHOUSE, in every project: the connection made the first time it is needed, its bridge kept the platform's
   *  current one (a new platform's bridge reaches every project the next time its connections are read). */
  private _saWarehouseBridge: string | null = null
  private async ensureSaWarehouse(): Promise<void> {
    const code = readyBridge('sa-warehouse')
    if (!code) return
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((x) => x.toString(16).padStart(2, '0')).join('')
    if (this._saWarehouseBridge === hash) return
    const [r] = [...this.ctx.storage.sql.exec("SELECT id, bridge FROM connections WHERE connector = 'sa-warehouse' AND removed_at IS NULL")] as any[]
    if (r?.bridge === hash) { this._saWarehouseBridge = hash; return }
    let id = r?.id as string | undefined
    if (!id) {
      id = `con_${crypto.randomUUID().slice(0, 12)}`
      this.ctx.storage.sql.exec("INSERT INTO connections (id, connector, name, level, owner, settings, secrets_sealed, kind, dialect, description, auth, created_by, created_at) VALUES (?, 'sa-warehouse', ?, 'project', 'project', '{}', NULL, 'sql', 'sa-warehouse', NULL, 'shared', 'platform', ?)",
        id, SA_WAREHOUSE, new Date().toISOString())
    }
    if (await this.attachBridge(id, code, 'platform')) { this._saWarehouseBridge = hash; this.sendToRole('code-engine', { t: 'connections:changed' }) }
  }
  /** The tables this project may read in the organisation's warehouse, each with only its granted columns. */
  private async grantedWarehouseTables(): Promise<{ configured: boolean; tables: any[] }> {
    const org = await this.orgId()
    if (!org) throw new Error('this project belongs to no organisation')
    const grant = this.grantInForce(), writable = this.writableInForce()
    const r: any = await (await this.env.ORG.get(this.env.ORG.idFromName(org)).fetch(new Request('http://do/warehouse', { headers: { 'x-sa-org': org } }))).json()
    const tables = (r.tables ?? []).filter((t: any) => t.name in grant).map((t: any) => ({ ...t, columns: grant[t.name] === null ? t.columns : t.columns.filter((c: any) => grant[t.name]!.includes(c.name)), writable: writable.includes(t.name) }))
    return { configured: !!r.configured, tables }
  }
  /** SA-WAREHOUSE for this project's engine (its bridge): the tables granted, and a query checked against the grant. */
  private async engineSaWarehouse(request: Request, path: string): Promise<Response> {
    const key = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!key || !this.keyMatches(key)) return this.j({ error: 'only this project\'s engine' }, 401)
    try {
      if (path === '/engine/sa-warehouse/tables' && request.method === 'GET') return this.j(await this.grantedWarehouseTables())
      if (path === '/engine/sa-warehouse/query' && request.method === 'POST') {
        const b: any = await request.json().catch(() => ({}))
        const org = await this.orgId()
        if (!org) throw new Error('this project belongs to no organisation')
        const res = await this.env.ORG.get(this.env.ORG.idFromName(org)).fetch(new Request('http://do/warehouse/query', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-org': org },
          body: JSON.stringify({ sql: String(b.sql ?? ''), limit: Math.min(Number(b.limit) || 100, 5000), grant: this.grantInForce(), project: this._pid, by: 'engine' }) }))
        const out: any = await res.json()
        if (!res.ok) return this.j({ error: out.error ?? `the warehouse answered ${res.status}` }, 400)
        return this.j(out)
      }
    } catch (e: any) { return this.j({ error: e?.message ?? String(e) }, 400) }
    return this.j({ error: 'not found' }, 404)
  }
  /** The engine's own calls about connections: download a bridge by its hash; upload a bridge written on the engine (by
   *  the connector agent) — the engine generates it, so it comes up here first and goes back down like any other. */
  private async engineConnections(request: Request, path: string): Promise<Response> {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const key = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!key || !this.keyMatches(key)) return json({ error: 'only this project\'s engine' }, 401)
    const bucket = (this.env as any).PACKAGES as R2Bucket | undefined
    if (!bucket) return json({ error: 'no bucket' }, 503)
    // THE CONNECTOR AGENT'S DRAFT, PUBLISHED (R5 — the one door): the engine sends the code it wrote for a connection (and
    // its manifest, or one made from the connection's own settings and secrets), as the person who asked; it is published
    // to the organisation's registry and the connection moved onto it (pinned; the code it ran kept for a rollback).
    if (request.method === 'POST' && path === '/engine/connectors') {
      const body: any = await request.json().catch(() => null)
      const name = String(body?.connection ?? ''), code = typeof body?.code === 'string' ? body.code : ''
      const by = typeof body?.by === 'string' && body.by.includes('@') ? body.by : 'engine'
      const [have] = [...this.ctx.storage.sql.exec("SELECT * FROM connections WHERE name = ? AND level = 'project' AND removed_at IS NULL", name)] as any[]
      if (!have) return json({ error: `there is no connection ${name} — make it in the console first (Connections → Custom source), then the connector agent writes its code` }, 404)
      const master = (this.env as any).CREDENTIALS_MASTER_KEY
      const secretsNow = have.secrets_sealed && master ? JSON.parse(await unseal(have.secrets_sealed, master)) : {}
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source'
      const made = { id: /^[a-z]/.test(slug) && !connectorById(slug) ? slug : `source-${slug}`, title: name, kind: have.kind === 'documents' || have.kind === 'api' ? have.kind : 'sql', dialect: have.dialect || have.kind || 'sql',
        description: have.description || `${name}, written by the connector agent.`, levels: ['project'], identity: ['shared'],
        fields: [...Object.keys(JSON.parse(have.settings ?? '{}')).map((k) => ({ name: k, label: k, type: 'text' })), ...Object.keys(secretsNow).map((k) => ({ name: k, label: k, type: 'secret' }))] }
      const pub = await this.publishToRegistry(body?.manifest && typeof body.manifest === 'object' ? body.manifest : made, code, by, 'engine')
      if ('error' in pub) return json({ error: pub.error }, pub.status)
      if (pub.status !== 'ready') return json({ ...pub, note: 'published; it waits for an organisation admin\'s approval before the connection runs it' })
      if (have.connector === pub.id) {
        const moved = await this.connectionVersion(name, 'update', by)
        return json({ ...pub, connection: name, note: moved.note ?? moved.error })
      }
      const moved = await this.switchConnector(have.id, pub.id, by)
      if ('error' in moved) return json({ ...pub, error: moved.error }, moved.status)
      this.audit.record({ actor: { kind: 'engine', id: 'engine' }, via: 'engine', action: 'connection.connector', target: have.id, outcome: 'ok', detail: { from: have.connector, to: pub.id, bridge: moved.bridge, for: by } })
      return json({ ...pub, connection: name, bridge: moved.bridge })
    }
    return json({ error: 'not found' }, 404)
  }

  // ── The project's app: published here, downloaded by the engine (one path) ──────────────────────────────────────
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
    // How a code connection stands is its workload (workloads.ts), as the engine last reported it.
    const online = this.engineOnline()
    const ran = new Map(this.workloads().list().filter((w) => w.kind === 'connection').map((w) => [w.id, w]))
    return ([...this.ctx.storage.sql.exec('SELECT id, connector, name, level, owner, settings, kind, dialect, description, auth, created_by, created_at, bridge, previous_bridge FROM connections WHERE removed_at IS NULL ORDER BY created_at')] as any[])
      .filter((r) => admin || r.level === 'project' || r.owner === who).map((r) => {
        // a code connection runs on the engine: runnable when its workload is ready
        const w = ran.get(r.name)
        // How it stands, from proof: no code to run it yet; the engine away; given to it but not reported yet; as reported.
        const blocked = this.blockedFor(r.connector, r.bridge ?? null)
        const state = blocked ? `not run: ${blocked}` : !r.bridge ? 'no code yet' : !online ? 'engine not connected' : !w ? 'waiting for the engine'
          : w.state === 'ready' ? 'ready' : w.state === 'degraded' ? 'not reachable' : w.state === 'failed' ? `failed: ${w.error?.what ?? 'see Running'}` : 'starting'
        // Said where it is shown: a person's own key is kept for a "per-user" source, but not yet the one it reads with.
        const note = r.auth === 'per-user' ? "each person reads with their own key (sacli datasources my-key); its shared settings are for the platform's own work (its index)" : undefined
        return { ...r, ...(note ? { note } : {}), settings: JSON.parse(r.settings), state, runnable: online && w?.state === 'ready', ...(r.kind || r.dialect ? { source: { kind: r.kind, dialect: r.dialect, description: r.description } } : {}), origin: 'platform' }
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
  /** Objects still in use are not deleted: a source's bridge, a program in the catalogue. */
  private inUse(key: string): string | null {
    const kind = kindOfKey(key), hash = key.split('/').pop()?.replace(/\.json$/, '') ?? ''
    if (kind === 'bridge' && this.ctx.storage.sql.exec('SELECT name FROM connections WHERE bridge = ? AND removed_at IS NULL', hash).toArray().length) return 'a data source runs this bridge'
    if (kind === 'program' && this.ctx.storage.sql.exec('SELECT 1 FROM programs WHERE hash = ?', hash).toArray().length) return 'it is a program in the catalogue'
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
    // A connector's code (its bridge) runs on the engine: made or changed only by who may change connectors.
    const coder = can(this.capsOfRequest(request), 'project.connectors')
    const actor = { kind: 'user' as const, id: email || 'unknown', ...(email ? { email } : {}) }
    if (path === '/connectors' && request.method === 'GET') return this.j({ connectors: await this.connectorCatalogue() })
    // Everything about connectors here, for the console's Connectors page: Superatom's (their current build), the
    // organisation's registry as it is (every version, blocked and waiting ones too), and which connection here runs what.
    if (path === '/connectors/registry' && request.method === 'GET') {
      const org = await this.orgId()
      const reg: any = org ? await (this.env as any).ORG.get((this.env as any).ORG.idFromName(org)).fetch('http://do/connectors').then((x: Response) => x.json()).catch(() => null) : null
      await this.orgCatalogue(true)
      const used = ([...this.ctx.storage.sql.exec("SELECT id, name, connector, bridge, previous_bridge, auth FROM connections WHERE removed_at IS NULL AND level = 'project' ORDER BY name")] as any[])
      return this.j({ superatom: CONNECTORS.filter((c) => c.id !== 'code'), organisation: reg?.connectors ?? [], approval: !!reg?.approval, connections: used, ...(reg ? {} : { note: 'the organisation\'s registry could not be read just now' }) })
    }
    // A version's code, read only: what will run on the engine (Superatom's current build, or an organisation version).
    const codeOf = path.match(/^\/connectors\/([a-z][a-z0-9-]*)\/code\/([0-9a-f]{64})$/)
    if (codeOf && request.method === 'GET') {
      if (!admin && !coder) return this.j({ error: 'a connector\'s code is read by who may change connections (project.data) or connectors (project.connectors)' }, 403)
      const [, id, hash] = codeOf
      const ours = connectorById(id)
      if (ours) return ours.version === hash ? this.j({ id, hash, code: readyBridge(id) ?? '' }) : this.j({ error: `${id}'s build here is ${String(ours.version ?? '').slice(0, 12)}` }, 404)
      const org = await this.orgId()
      const reg: any = org ? await (this.env as any).ORG.get((this.env as any).ORG.idFromName(org)).fetch('http://do/connectors').then((x: Response) => x.json()).catch(() => null) : null
      const v = (reg?.connectors ?? []).find((c: any) => c.id === id)?.versions?.find((x: any) => x.hash === hash)
      if (!v) return this.j({ error: `${id} has no version ${hash.slice(0, 12)}` }, 404)
      const o = await ((this.env as any).PACKAGES as R2Bucket | undefined)?.get(connectorObjectKey(v.from_project, id, hash))
      return o ? this.j({ id, hash, code: await o.text() }) : this.j({ error: 'its code is not in the bucket' }, 404)
    }
    // A connector published to the organisation's registry from here (project.connectors — the worker checked).
    if (path === '/connectors' && request.method === 'POST') { if (!email) return this.j({ error: 'who is publishing it?' }, 400); return this.publishConnector(body, email) }
    if (path === '/connections' && request.method === 'GET') { await this.ensureSaWarehouse(); await this.orgCatalogue(); return this.j({ connections: this.connectionRows(who, admin) }) }
    if (!who) return this.j({ error: 'who is making the change?' }, 400)
    if (path === '/connections' && request.method === 'POST') {
      const c = (await this.connectorCatalogue()).find((x) => x.id === String(body.connector ?? '')) ?? connectorById(String(body.connector ?? ''))
      if (!c || c.builtin) return this.j({ error: c ? `${c.title} is in every project already; it is not connected again` : `there is no connector ${body.connector}` }, 400)
      const level = body.level === 'user' ? 'user' : 'project'
      if (!c.levels.includes(level)) return this.j({ error: `${c.title} is connected ${c.levels.map((l) => l === 'project' ? 'for the whole project' : 'per person').join(' or ')}` }, 400)
      if (level === 'project' && !admin) return this.j({ error: 'a connection shared by the whole project is made by a project administrator; connect your own instead' }, 403)
      const ready = await this.newestBridge(c.id)
      if (!ready && !coder) return this.j({ error: `${c.title} runs code written for it on the engine: it is added by someone who may change connectors` }, 403)
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
        about.kind ?? c.kind ?? null, about.dialect ?? null, about.description ?? null, (c.identity && !c.identity.includes('shared')) ? 'per-user' : about.auth ?? 'shared', email, new Date().toISOString())
      this.audit.record({ actor, via: 'ui', action: 'connection.create', target: id, outcome: 'ok', detail: { connector: c.id, name, level, settings } })   // never the secrets
      // Its connector's ready bridge, attached now — so the source runs whatever door it was made from.
      const bridge = ready ? await this.attachBridge(id, ready, email || 'platform') : null
      this.sendToRole('code-engine', { t: 'connections:changed' })
      return this.j({ connection: { id, connector: c.id, name, level, settings, bridge, runnable: false, state: bridge ? 'waiting for the engine' : 'no code yet' } }, 201)
    }
    const m = path.match(/^\/connections\/(con_[\w-]+)$/)
    // The platform's own source is kept by the platform: nobody changes, re-codes or removes it.
    const target = path.match(/^\/connections\/(con_[\w-]+)/)?.[1]
    if (target && request.method !== 'GET' && !path.endsWith('/my-key')) {
      const [t] = [...this.ctx.storage.sql.exec('SELECT connector, name FROM connections WHERE id = ?', target)] as any[]
      if (t && this.connectorOf(t.connector)?.builtin) return this.j({ error: `${t.name} is the platform's own source, in every project; it is not changed or removed` }, 400)
    }
    // A source's settings, secrets (a secret left out is kept), what it is, and how people reach it — its admins change them.
    if (m && request.method === 'PATCH') {
      const [r] = [...this.ctx.storage.sql.exec('SELECT * FROM connections WHERE id = ? AND removed_at IS NULL', m[1])] as any[]
      if (!r) return this.j({ error: `there is no connection ${m[1]}` }, 404)
      if (!admin && r.owner !== who) return this.j({ error: 'only its owner, or someone with project.data, changes a connection' }, 403)
      // Moved onto another connector (the one door: code reaches a connection only as a published connector's version).
      if (typeof body.connector === 'string' && body.connector !== r.connector) {
        if (!coder) return this.j({ error: "a source's code is changed by someone who may change connectors" }, 403)
        const moved = await this.switchConnector(m[1], body.connector, email || 'unknown')
        if ('error' in moved) return this.j({ error: moved.error }, moved.status)
        this.audit.record({ actor, via: 'ui', action: 'connection.connector', target: m[1], outcome: 'ok', detail: { from: r.connector, to: body.connector, bridge: moved.bridge } })
        return this.j({ connection: this.connectionRows(who, admin).find((x: any) => x.id === m[1]) })
      }
      await this.orgCatalogue()
      const c = this.connectorOf(r.connector)
      if (!c) return this.j({ error: `its connector ${r.connector} is not in the catalogue (removed from the organisation?)` }, 400)
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
      this.sendToRole('code-engine', { t: 'connections:changed' })
      return this.j({ connection: this.connectionRows(who, admin).find((x: any) => x.id === m[1]) })
    }
    // Connecting one's own account (OAuth) to a connection read with each person's own: a signed ticket for the browser to
    // take to the provider (oauth-flow.ts) — the tokens come back through the callback, kept as their own key is.
    const signIn = path.match(/^\/connections\/(con_[\w-]+)\/oauth\/start$/)
    if (signIn && request.method === 'POST') {
      const [r] = [...this.ctx.storage.sql.exec('SELECT * FROM connections WHERE id = ? AND removed_at IS NULL', signIn[1])] as any[]
      if (!r) return this.j({ error: `there is no connection ${signIn[1]}` }, 404)
      const email = String(who ?? '').replace(/^email:/, '').toLowerCase()
      if (!email.includes('@')) return this.j({ error: 'an account is connected by a person, signed in' }, 400)
      if (r.auth !== 'per-user') return this.j({ error: `${r.name} is reached with one shared key, not each person's own` }, 400)
      await this.orgCatalogue()
      const k = this.connectorOf(r.connector)
      if (!k?.oauth || !(k.identity ?? []).includes('person-oauth')) return this.j({ error: `${k?.title ?? r.connector} does not sign people in with an account — give your own key instead` }, 400)
      const org = await this.orgId()
      if (!org) return this.j({ error: 'this project is in no organisation' }, 400)
      const ticket = await signTicket((this.env as any).JWT_SECRET, { p: this._pid, o: org, c: r.id, e: email, prov: k.oauth.provider, sc: k.oauth.scopes })
      return this.j({ url: `${new URL(OAUTH_CALLBACK).origin}/api/oauth/begin?t=${encodeURIComponent(ticket)}`, provider: k.oauth.provider })
    }
    // A person's own key for a source that reaches each person with their own (auth "per-user"): sealed here, kept in THEIR
    // UserDO by (project, connection) — never in this project's storage, never shared with another project.
    const mine = path.match(/^\/connections\/(con_[\w-]+)\/my-key$/)
    if (mine) {
      const [r] = [...this.ctx.storage.sql.exec('SELECT * FROM connections WHERE id = ? AND removed_at IS NULL', mine[1])] as any[]
      if (!r) return this.j({ error: `there is no connection ${mine[1]}` }, 404)
      const email = String(who ?? '').replace(/^email:/, '').toLowerCase()
      if (!email.includes('@')) return this.j({ error: 'a key of one\'s own is a person\'s, signed in' }, 400)
      // Their key changed or went: the client the engine holds with it ends now.
      const told = () => this.sendToRole('code-engine', { t: 'connections:person-key-changed', name: r.name, email })
      if (request.method === 'DELETE') {
        const gone = await this.personKeys(email, mine[1], 'DELETE')
        if (!gone.ok) return this.j({ error: gone.error }, 502)
        this.audit.record({ actor, via: 'ui', action: 'connection.my-key.remove', target: mine[1], outcome: 'ok' }); told(); return this.j({ removed: true })
      }
      // Whether you gave yours — never the key itself.
      if (request.method === 'GET') {
        const k = await this.personKeys(email, mine[1], 'GET')
        if (!k.ok) return this.j({ error: k.error }, 502)
        if (!k.sealed) return this.j({ given: false })
        // an account connected: whose, with which provider — never a token
        const v = JSON.parse(await unseal(k.sealed, (this.env as any).CREDENTIALS_MASTER_KEY)) as any
        return this.j({ given: true, ...(v?.oauth ? { account: { provider: v.oauth.provider, email: v.oauth.account ?? null } } : {}) })
      }
      if (request.method !== 'PUT') return this.j({ error: 'GET whether you gave yours, PUT it, or DELETE it' }, 405)
      if (r.auth !== 'per-user') return this.j({ error: `${r.name} is reached with one shared key, not each person's own` }, 400)
      await this.orgCatalogue()
      const signsIn = this.connectorOf(r.connector)
      if (signsIn?.oauth && !(signsIn.identity ?? []).includes('person-key')) return this.j({ error: `${r.name} reads with each person's own ${OAUTH_PROVIDERS[signsIn.oauth.provider]?.title ?? signsIn.oauth.provider} account, not a key — connect it in the app: Connections → ${r.name} → Connect my account` }, 400)
      const master = (this.env as any).CREDENTIALS_MASTER_KEY
      if (!master) return this.j({ error: 'secrets cannot be kept: the platform has no master key' }, 503)
      const values = body.values && typeof body.values === 'object' ? body.values : {}
      if (!Object.keys(values).length) return this.j({ error: 'your key is the values the source asks of each person' }, 400)
      const kept = await this.personKeys(email, mine[1], 'PUT', await seal(JSON.stringify(values), master))
      if (!kept.ok) return this.j({ error: kept.error }, 502)
      this.audit.record({ actor, via: 'ui', action: 'connection.my-key.set', target: mine[1], outcome: 'ok' })
      told()
      return this.j({ saved: true })
    }
    if (m && request.method === 'DELETE') {
      const [r] = [...this.ctx.storage.sql.exec('SELECT level, owner, removed_at FROM connections WHERE id = ?', m[1])] as any[]
      if (!r || r.removed_at) return this.j({ error: `there is no connection ${m[1]}` }, 404)
      if (!admin && r.owner !== who) return this.j({ error: 'only its owner, or someone with project.data, removes a connection' }, 403)
      this.ctx.storage.sql.exec('UPDATE connections SET removed_at = ?, removed_by = ? WHERE id = ?', new Date().toISOString(), email, m[1])
      // Its index: every table marked gone (kept, with its history) — find-schema and get-schema stop offering it.
      const [named] = [...this.ctx.storage.sql.exec('SELECT name FROM connections WHERE id = ?', m[1])] as any[]
      const gone = named ? this.dsi().forget(named.name, email || 'platform') : 0
      if (gone) this.dsiChanged()
      this.audit.record({ actor, via: 'ui', action: 'connection.remove', target: m[1], outcome: 'ok', detail: { indexGone: gone } })
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
    // Every reader that has attributes, with them — the page lists readers, not one looked up at a time.
    if (path === '/access-attributes' && request.method === 'GET' && !url.searchParams.get('subject')) {
      const readers = new Map<string, Record<string, unknown>>()
      for (const r of this.ctx.storage.sql.exec('SELECT subject, key, value FROM access_attributes ORDER BY subject, key') as any) {
        const a = readers.get(r.subject) ?? {}; a[r.key] = JSON.parse(r.value); readers.set(r.subject, a)
      }
      return json({ readers: [...readers].map(([subject, attributes]) => ({ subject, attributes })) })
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
    if (!engineHere) items.push({ id: 'engine', kind: 'engine', state: 'critical', title: 'The engine is not connected', detail: 'Questions, sessions and programs wait until it is back.', place: 'engine' })
    // A workload that needs a person, by its kind's rule: failed at once, degraded once it has lasted (only while the engine
    // is here — without it the one item above says it all).
    if (engineHere) for (const w of this.workloads().list()) {
      const k = WORKLOAD_KINDS[w.kind] as any
      if (!k || !(w.state === 'failed' || (w.state === 'degraded' && Date.now() - w.since > k.attentionAfterMs))) continue
      items.push({ id: `workload:${w.kind}/${w.id}`, kind: 'workload', state: w.state === 'failed' ? 'critical' : 'attention', title: `${k.label} ${w.id}: ${w.state}`, detail: w.error?.what ?? undefined, place: 'running', workload: `${w.kind}/${w.id}`, at: new Date(w.since).toISOString() })
    }
    const since = new Date(Date.now() - 86_400_000).toISOString()
    for (const a of [...this.ctx.storage.sql.exec("SELECT id, owner, kind, title, detail, started_at, updated_at FROM activities WHERE state = 'failed' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 20", since)] as any[])
      items.push({ id: `failed:${a.id}`, kind: 'failed', state: 'critical', title: `Failed: ${a.title}`, detail: a.detail ?? undefined, at: a.updated_at,
        activity: a.id, what: a.title, owner: String(a.owner).replace(/^(email|user):/, ''), work: a.kind, started: a.started_at })
    for (const d of [...this.ctx.storage.sql.exec(`SELECT r.* FROM decision_register r JOIN (SELECT artifact, MAX(version) AS m FROM decision_register GROUP BY artifact) x ON x.artifact = r.artifact AND x.m = r.version WHERE r.status = 'pending' ORDER BY r.at`)] as any[])
      items.push({ id: `approval:${d.artifact}`, kind: 'approval', state: 'attention', title: `Approve: ${d.title}`, detail: `Recorded by ${String(d.by).replace(/^(email|user):/, '')}${d.agent ? ` with ${d.agent}` : ''}`, session: d.session, artifact: d.artifact, at: d.at })
    try {
      for (const s of this.graph().open()) items.push({ id: `suggestion:${s.id}`, kind: 'suggestion', state: 'attention', title: s.scope ? `Publish ${s.name} to ${s.scope === 'global' ? 'everyone' : s.scope}` : `Change suggested to ${s.name}`, detail: `${String(s.by).replace(/^(email|user|agent):/, '')}: ${s.reason}`, suggestion: s.id, name: s.name, at: s.at })
    } catch { /* the graph replica unreachable: its suggestions are not listed */ }
    return this.j({ items })
  }

  // ── WORKLOADS (workloads.ts; vm/packages/platform-types workloads.ts) ───────────────────────────────────────────────
  private _workloads?: ReturnType<typeof projectWorkloads>
  private workloads() { return (this._workloads ??= projectWorkloads(this.ctx.storage)) }
  /** Answers the engine owes: an action's outcome, an aspect looked into — by request id. */
  private engineWaits = new Map<string, (m: any) => void>()
  private askEngine(msg: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    const reqId = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.engineWaits.delete(reqId); resolve({ error: `the engine did not answer in ${timeoutMs / 1000}s` }) }, timeoutMs)
      this.engineWaits.set(reqId, (m) => { clearTimeout(timer); resolve(m) })
      if (!this.sendToRole('code-engine', { ...msg, reqId })) { clearTimeout(timer); this.engineWaits.delete(reqId); resolve({ error: 'the engine is not connected' }) }
    })
  }
  /** What is wanted of each workload, as a spec the engine echoes once it has acted on it. */
  private wantedSpecs(): Map<string, Wanted> {
    const out = new Map<string, Wanted>()
    for (const r of [...this.ctx.storage.sql.exec("SELECT name, connector, settings, bridge, secrets_sealed, previous_bridge, auth FROM connections WHERE removed_at IS NULL AND level = 'project'")] as any[]) {
      const k = this.connectorOf(r.connector)
      if (!k) continue
      // Its connector has a newer build than the one it is pinned to: said, never applied on its own (update does).
      const newer = !!(k.version && r.bridge && k.version !== r.bridge && k.bridge && k.bridge !== 'its own')
      // Blocked by the organisation: not given to the engine (wantedConnections leaves it out) — shown stopped, saying why.
      const blocked = this.blockedFor(r.connector, r.bridge ?? null)
      out.set(`connection/${r.name}`, { spec: blocked ? '' : connectionSpec(r), label: r.connector, ...(blocked ? { blocked } : {}), ...(newer ? { newer: k.version!.slice(0, 12) } : {}), ...(r.previous_bridge ? { canRollBack: true } : {}) })
    }
    const rel = [...this.ctx.storage.sql.exec('SELECT digest, tag FROM engine_release LIMIT 1')][0] as any
    out.set('engine/self', { spec: rel?.digest ? specOf(rel.digest) : 'none', label: rel?.tag ?? undefined })
    // Each development environment: whose, and whether attached (the platform is its authority; nothing to compare —
    // an attached one is listed even before the engine holds a build of it).
    for (const e of this.devEnvs.list(null)) if (e.status === 'attached' || this.workloads().one('dev-env', e.id)) out.set(`dev-env/${e.id}`, { spec: '', label: `${e.owner} · ${e.name} · ${e.status}` })
    return out
  }
  /** A connection moved to its connector's newest build, or back to the one it ran before; the engine is told. */
  private async connectionVersion(name: string, action: 'update' | 'rollback', by: string): Promise<{ note?: string; error?: string }> {
    const [c] = [...this.ctx.storage.sql.exec("SELECT id, connector, bridge, previous_bridge FROM connections WHERE name = ? AND removed_at IS NULL AND level = 'project'", name)] as any[]
    if (!c) return { error: `there is no connection ${name}` }
    if (action === 'rollback') {
      if (!c.previous_bridge) return { error: 'it has not been updated: there is nothing to roll back to' }
      this.ctx.storage.sql.exec('UPDATE connections SET bridge = ?, previous_bridge = ? WHERE id = ?', c.previous_bridge, c.bridge, c.id)
    } else {
      const code = await this.newestBridge(c.connector)
      if (!code) return { error: `${c.connector} has no build to update to${this.blockedFor(c.connector, null) ? ' (it is blocked by the organisation)' : ''}` }
      const was = c.bridge
      const hash = await this.attachBridge(c.id, code, by)
      if (!hash) return { error: 'the platform could not keep its new version' }
      if (hash === was) return { note: 'it already runs the newest version' }
      this.ctx.storage.sql.exec('UPDATE connections SET previous_bridge = ? WHERE id = ?', was, c.id)
    }
    const [now] = [...this.ctx.storage.sql.exec('SELECT bridge, previous_bridge FROM connections WHERE id = ?', c.id)] as any[]
    this.sendToRole('code-engine', { t: 'connections:changed' })
    return { note: `it runs ${String(now.bridge).slice(0, 12)} from now on (it ran ${String(now.previous_bridge ?? '').slice(0, 12) || 'nothing'}); the engine loads it now` }
  }
  /** Every workload: as reported, with what is wanted of it (changed, not yet taken) and "unknown" when no engine is here. */
  private workloadView(r: WorkloadRow | null, key: string, wanted?: Wanted, online = this.engineOnline()) {
    const [kind, ...rest] = key.split('/'), id = rest.join('/')
    const base = wanted?.blocked ? { ...(r ?? { kind, id, version: null, spec: null, restarts: 0, health: null, since: 0, reportedAt: 0 }), state: 'stopped' as const, error: { what: `not run: ${wanted.blocked}` } }
      : r ?? { kind, id, state: 'pending', version: null, spec: null, restarts: 0, error: null, health: null, since: 0, reportedAt: 0 }
    return { ...base, ...(online || wanted?.blocked ? {} : { state: 'unknown', reported: base.state }), wanted: wanted?.spec || null, taken: !wanted?.spec || !r ? !wanted?.spec : r.spec === wanted.spec, ...(wanted?.label ? { label: wanted.label } : {}), ...(wanted?.newer ? { newer: wanted.newer } : {}), ...(wanted?.canRollBack ? { canRollBack: true } : {}) }
  }
  private engineOnline() { return [...this.connByWs.values()].some((c) => c.type === 'code-engine') }
  /** Whoever may see workloads hears when any changes (the console's activity view). */
  private workloadsChanged(rows: WorkloadRow[]) {
    const wanted = this.wantedSpecs()
    const envelope = { from: { id: 'hub', type: 'hub' }, payload: { t: 'workload:update', workloads: rows.map((r) => this.workloadView(r, `${r.kind}/${r.id}`, wanted.get(`${r.kind}/${r.id}`))) } }
    for (const [cws, conn] of this.connByWs) {
      if (conn.type === 'code-engine' || conn.wsId.startsWith('http-')) continue
      if (can(this.capsOf(conn), 'project.view')) this.deliverToConn(cws, conn, envelope as any)
    }
  }
  private async workloadRoute(request: Request, path: string): Promise<Response> {
    const caps = this.capsOfRequest(request)
    const by = this.actor(request)
    // An error's detail (a host, a driver's words) is for operators; anyone else who sees a workload sees what it means.
    const operator = can(caps, 'project.manage') || can(caps, 'project.data')
    const shown = <T extends { error: { what: string; detail?: string } | null }>(w: T): T => (operator || !w.error?.detail ? w : { ...w, error: { what: w.error.what } })
    const parts = path.split('/').slice(2).map(decodeURIComponent)   // ['', 'workloads', …] → [kind, id, verb, aspect]
    if (request.method === 'GET' && (parts.length === 0 || (parts.length === 1 && parts[0] === ''))) {
      const wanted = this.wantedSpecs(), rows = new Map(this.workloads().list().map((r) => [`${r.kind}/${r.id}`, r]))
      const keys = [...new Set([...wanted.keys(), ...rows.keys()])].filter((k) => { const kind = k.split('/')[0]; return isWorkloadKind(kind) && can(caps, WORKLOAD_KINDS[kind].see as Capability) })
      return this.j({ online: this.engineOnline(), workloads: keys.sort().map((k) => shown(this.workloadView(rows.get(k) ?? null, k, wanted.get(k)) as any)) })
    }
    if (request.method === 'GET' && parts[0] === 'events' && parts.length === 1) {
      const u = new URL(request.url).searchParams
      const kind = u.get('kind') ?? undefined
      if (kind && !isWorkloadKind(kind)) return this.j({ error: `"${kind}" is not a workload kind` }, 400)
      const events = this.workloads().events({ kind, id: u.get('id') ?? undefined, since: Number(u.get('since')) || undefined, before: Number(u.get('before')) || undefined, limit: Number(u.get('limit')) || undefined })
        .filter((e) => isWorkloadKind(e.kind) && can(caps, WORKLOAD_KINDS[e.kind].see as Capability)).map((e) => (operator ? e : { ...e, detail: null }))
      return this.j({ events, next: events.length ? events[events.length - 1].seq : null })
    }
    const [kind, id, verb, aspect] = parts
    if (!isWorkloadKind(kind)) return this.j({ error: `"${kind}" is not a workload kind (${Object.keys(WORKLOAD_KINDS).join(', ')})` }, 404)
    const k = WORKLOAD_KINDS[kind] as any
    if (!can(caps, k.see)) return this.j({ error: `seeing ${k.label.toLowerCase()} workloads needs ${k.see}` }, 403)
    if (!id) return this.j({ error: 'which one? /workloads/<kind>/<id>' }, 400)
    if (request.method === 'GET' && !verb) {
      const key = `${kind}/${id}`, r = this.workloads().one(kind, id), wanted = this.wantedSpecs().get(key)
      if (!r && !wanted) return this.j({ error: `there is no workload ${key}` }, 404)
      return this.j({ workload: shown(this.workloadView(r, key, wanted) as any), events: this.workloads().events({ kind, id, limit: 50 }).map((e) => (operator ? e : { ...e, detail: null })), actions: k.actions, aspects: k.aspects })
    }
    if (request.method === 'POST' && verb === 'act') {
      const b: any = await request.json().catch(() => ({}))
      const action = String(b.action ?? '')
      const a = k.actions[action]
      if (!a) return this.j({ error: `${kind} has no action "${action}"${Object.keys(k.actions).length ? ` (it has ${Object.keys(k.actions).join(', ')})` : ''}` }, 400)
      if (!can(caps, a.needs)) return this.j({ error: `${a.label} needs ${a.needs}` }, 403)
      // A connection's version is the platform's to change (the bridge it is pinned to); its index is rebuilt as the platform
      // rebuilds any (a tracked job) — neither by a second door in the engine.
      const r = kind === 'dev-env' && action === 'close' ? (() => { try { const e = this.devEnvs.close(id); return { note: `${e.owner}'s ${e.name} is closed; its builds are let go` } } catch (e: any) { return { error: e?.message ?? String(e) } } })()
        : kind === 'connection' && (action === 'update' || action === 'rollback') ? await this.connectionVersion(id, action, by)
        : kind === 'connection' && action === 'refresh-index'
        ? (() => { if (!this.engineOnline()) return { error: 'the engine is not connected' }; const x = this.askIndexBuild({ sources: [id] }, by); return x.asked ? { note: 'its index is being read again (Data sources shows the build)' } : { note: 'an index build is already running; this source is read with it or after it' } })()
        : await this.askEngine({ t: 'workload:act', kind, id, action, by })
      const ok = !r.error
      this.workloads().event(kind, id, `${a.label}${ok ? '' : ' — failed'}`, { by, detail: r.error ?? r.note ?? null })
      this.audit.record({ actor: this.actorOf(request, b), via: 'admin', action: `workload.${action}`, target: `${kind}/${id}`, outcome: ok ? 'ok' : 'error', detail: { ...(r.error ? { error: String(r.error).slice(0, 300) } : {}) } })
      this.workloadsChanged([])
      return this.j(ok ? { ok: true, note: r.note ?? null } : { error: r.error }, ok ? 200 : 502)
    }
    if (request.method === 'GET' && verb === 'inspect') {
      const x = k.aspects[aspect]
      if (!x) return this.j({ error: `${kind} has no aspect "${aspect}"${Object.keys(k.aspects).length ? ` (it has ${Object.keys(k.aspects).join(', ')})` : ''}` }, 400)
      if (!can(caps, x.needs)) return this.j({ error: `looking into its ${x.label.toLowerCase()} needs ${x.needs}` }, 403)
      const u = new URL(request.url).searchParams
      const r = await this.askEngine({ t: 'workload:inspect', kind, id, aspect, page: Number(u.get('page')) || 0 })
      return this.j(r.error ? { error: r.error } : { data: r.data ?? null, next: r.next ?? null }, r.error ? 502 : 200)
    }
    return this.j({ error: 'GET /workloads, /workloads/events, /workloads/<kind>/<id>, /workloads/<kind>/<id>/inspect/<aspect>; POST /workloads/<kind>/<id>/act { action }' }, 404)
  }

  /** The project's composition graph, held here (graph.ts). */
  private _graph?: ReturnType<typeof projectGraph>
  private graph() {
    if (this._graph) return this._graph
    this._graph = projectGraph(this.ctx.storage, this.env, () => this._pid)
    // Every project has a default agent from its start: put in the first time this graph is opened (default-agent.ts).
    if (this._graph.ensureDefaultAgent()) this.sendToRole('code-engine', { t: 'graph:changed', cursor: this._graph.cursor() })
    return this._graph
  }
  private _dsi?: ReturnType<typeof projectDsi>
  private dsi() { return (this._dsi ??= projectDsi(this.ctx.storage)) }
  private _jobs?: ReturnType<typeof projectJobs>
  private jobs() { return (this._jobs ??= projectJobs(this.ctx.storage)) }
  // ── THE CATALOGUE: Superatom's connectors and the organisation's own (its registry, org-connectors.ts) ──
  /** The organisation's connectors, as its registry says (kept 30 s; read again after a publish). */
  private orgCat: { at: number; list: Connector[] } | null = null
  private async orgCatalogue(fresh = false): Promise<Connector[]> {
    if (!fresh && this.orgCat && Date.now() - this.orgCat.at < 30_000) return this.orgCat.list
    const org = await this.orgId()
    if (!org) return (this.orgCat = { at: Date.now(), list: [] }).list
    try {
      const r: any = await (this.env as any).ORG.get((this.env as any).ORG.idFromName(org)).fetch('http://do/connectors').then((x: Response) => x.json())
      const list = (r?.connectors ?? []).filter((c: any) => !connectorById(c.id)).map((c: any): Connector => {
        const shown = c.current ?? c.versions?.[0]
        return { ...connectorOfManifest(shown?.manifest ?? { id: c.id, title: c.title, fields: [], levels: ['project'], identity: ['shared'] }, c.current?.hash ?? null),
          org: { madeBy: c.made_by, fromProject: c.from_project, blocked: !!c.blocked_at, blockedVersions: (c.versions ?? []).filter((v: any) => v.blocked_at).map((v: any) => v.hash), ...(c.current ? { currentFrom: c.current.from_project } : {}) } }
      })
      return (this.orgCat = { at: Date.now(), list }).list
    } catch { return this.orgCat?.list ?? [] }
  }
  /** A connector by id: Superatom's, else the organisation's (as last read — orgCatalogue() first where it matters). */
  private connectorOf(id: string): Connector | undefined { return connectorById(id) ?? this.orgCat?.list.find((c) => c.id === id) }
  /** What may be connected now: every connector but the platform's own, and the organisation's that have a usable version. */
  private async connectorCatalogue(): Promise<Connector[]> { return [...CONNECTORS.filter((c) => !c.builtin), ...(await this.orgCatalogue()).filter((c) => c.version && !c.org?.blocked)] }
  /** A connector's newest code to run: Superatom's (shipped with the platform), or the organisation's current version. */
  private async newestBridge(id: string): Promise<string | null> {
    const ours = readyBridge(id)
    if (ours) return ours
    const c = (await this.orgCatalogue()).find((x) => x.id === id)
    if (!c?.version || c.org?.blocked || !c.org?.currentFrom) return null
    const o = await ((this.env as any).PACKAGES as R2Bucket | undefined)?.get(connectorObjectKey(c.org.currentFrom, id, c.version))
    return o ? await o.text() : null
  }
  /** An organisation's connector blocked, or the version a connection runs blocked: it is not run. */
  private blockedFor(connector: string, bridge: string | null): string | null {
    const c = this.orgCat?.list.find((x) => x.id === connector)
    if (!c?.org) return null
    if (c.org.blocked) return `${c.title} is blocked by the organisation`
    if (bridge && c.org.blockedVersions.includes(bridge)) return `the version it runs (${bridge.slice(0, 12)}) is blocked by the organisation`
    return null
  }
  /** A connector published to the organisation's registry from this project (sacli connectors publish): built with the one
   *  build tool — its manifest checked, its code kept by hash in the bucket, the organisation told. */
  private async publishConnector(body: any, by: string): Promise<Response> {
    const r = await this.publishToRegistry(body?.manifest, typeof body?.code === 'string' ? body.code : '', by, 'ui')
    if ('error' in r) return this.j({ error: r.error }, r.status)
    return this.j(r, r.already ? 200 : 201)
  }
  /** THE ONE DOOR for a connector's code (R5): built, checked, kept by hash, published to the organisation's registry —
   *  from a person (sacli connectors publish) or from the engine (the connector agent's draft, as the person who asked). */
  private async publishToRegistry(manifest: any, code: string, by: string, via: 'ui' | 'engine'): Promise<{ id: string; version: string; status: string; already?: boolean } | { error: string; status: number }> {
    const bad = checkEngineManifest(manifest)
    if (bad.length) return { error: `its manifest: ${bad.join('; ')}`, status: 400 }
    if (connectorById(manifest.id)) return { error: `${manifest.id} is one of Superatom's connectors — name yours another way`, status: 409 }
    if (manifest.builtin) return { error: 'only the platform\'s own source is builtin', status: 400 }
    if (!code.trim() || code.length > 6_000_000) return { error: 'its code is the built module, at most 6 MB (sacli connectors build)', status: 400 }
    if (!/export\s+(async\s+)?function\s+createBridge|export\s+(const|let)\s+createBridge|export\s*\{[^}]*\bcreateBridge\b[^}]*\}/.test(code)) return { error: 'a connector exports createBridge({ settings, secrets })', status: 400 }
    const org = await this.orgId()
    if (!org) return { error: 'this project is in no organisation', status: 400 }
    const bucket = (this.env as any).PACKAGES as R2Bucket | undefined
    if (!bucket) return { error: 'no bucket to keep it in', status: 503 }
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((x) => x.toString(16).padStart(2, '0')).join('')
    const bytes = new TextEncoder().encode(code).byteLength
    await putObject(bucket, this.ledger(), { key: connectorObjectKey(this._pid, manifest.id, hash), kind: 'connector', bytes, by, body: code, contentType: 'text/javascript', once: true })
    const r: any = await (this.env as any).ORG.get((this.env as any).ORG.idFromName(org)).fetch('http://do/connectors/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest, hash, bytes, by, project: this._pid }) }).then((x: Response) => x.json())
    this.audit.record({ actor: { kind: 'user', id: by, ...(by.includes('@') ? { email: by } : {}) }, via, action: 'connector.publish', target: manifest.id, outcome: r?.ok ? 'ok' : 'refused', detail: { hash, bytes, status: r?.status ?? null, error: r?.error ?? null } })
    if (!r?.ok) return { error: r?.error ?? 'the organisation did not take it', status: 400 }
    await this.orgCatalogue(true)
    this.sendToRole('code-engine', { t: 'connections:changed' })   // a connection pinned to it may read "newer version"
    return { id: manifest.id, version: hash, status: r.status, ...(r.already ? { already: true } : {}) }
  }
  /** A connection moved onto a connector (its current version, pinned; the one it ran kept for a rollback): its values
   *  read again against that connector's form. */
  private async switchConnector(id: string, to: string, by: string): Promise<{ ok: true; bridge: string } | { error: string; status: number }> {
    const [r] = [...this.ctx.storage.sql.exec('SELECT * FROM connections WHERE id = ? AND removed_at IS NULL', id)] as any[]
    if (!r) return { error: `there is no connection ${id}`, status: 404 }
    const c = (await this.connectorCatalogue()).find((x) => x.id === to)
    if (!c || c.id === 'code') return { error: `there is no connector ${to} to move it to (sacli connectors list)`, status: 400 }
    const code = await this.newestBridge(c.id)
    if (!code) return { error: `${c.title} has no version to run${c.org && !c.version ? ' (waiting for approval)' : ''}`, status: 400 }
    const master = (this.env as any).CREDENTIALS_MASTER_KEY
    const secretsWere = r.secrets_sealed && master ? JSON.parse(await unseal(r.secrets_sealed, master)) : {}
    // what the new form asks for, from what it had (the rest is left behind)
    const had: Record<string, unknown> = { ...JSON.parse(r.settings), ...secretsWere }
    const asks = new Set((c.fields ?? []).map((f) => f.name))
    const { problems, settings, secrets } = checkConnection(c, asks.size ? Object.fromEntries(Object.entries(had).filter(([k]) => asks.has(k))) : had)
    if (problems.length) return { error: `its values do not fit ${c.title}: ${problems.join('; ')}`, status: 400 }
    const was = r.bridge
    const hash = await this.attachBridge(id, code, by)
    if (!hash) return { error: 'no bucket to keep it in', status: 503 }
    this.ctx.storage.sql.exec('UPDATE connections SET connector = ?, settings = ?, secrets_sealed = ?, kind = ?, dialect = ?, previous_bridge = ? WHERE id = ?',
      c.id, JSON.stringify(settings), Object.keys(secrets).length ? await seal(JSON.stringify(secrets), master) : null, c.kind, c.dialect ?? null, was, id)
    this.sendToRole('code-engine', { t: 'connections:changed' })
    return { ok: true, bridge: hash }
  }
  /** A connection's bridge: kept in the bucket by its hash (recorded in the ledger) and named on the connection. Null when
   *  there is no bucket to keep it in. */
  private async attachBridge(connection: string, code: string, by: string): Promise<string | null> {
    const bucket = (this.env as any).PACKAGES as R2Bucket | undefined
    if (!bucket) return null
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map((x) => x.toString(16).padStart(2, '0')).join('')
    await putObject(bucket, this.ledger(), { key: `bridge/${this._pid}/${hash}`, kind: 'bridge', bytes: new TextEncoder().encode(code).byteLength, by, body: code, contentType: 'text/javascript', once: true })
    this.ctx.storage.sql.exec('UPDATE connections SET bridge = ? WHERE id = ?', hash, connection)
    return hash
  }
  private _lineage?: ReturnType<typeof projectLineage>
  private lineage() { return (this._lineage ??= projectLineage(this.ctx.storage)) }
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
    return ([...this.ctx.storage.sql.exec("SELECT name, connector FROM connections WHERE removed_at IS NULL AND level = 'project'")] as any[]).filter((r) => this.connectorOf(r.connector) ?? true).map((r) => String(r.name))
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
  /** A principal's own Durable Object: a person's home in this project's organisation (person:<org>:<id>), or an agent
   *  key's own (agent:<key>). */
  private _org: string | null = null
  private userStub(principal: string) {
    const name = principal.startsWith('user:') ? personHome(this._org, principal.slice(5)) : principal
    return (this.env as any).USER.get((this.env as any).USER.idFromName(name))
  }
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
  /** Where a person stands in the hierarchy (shared/permissions.ts compare): what they hold here — an organisation owner
   *  or admin (mirrored here) above every project role, the platform's superadmin above everyone. */
  private standingOf(email: string | null | undefined): string[] {
    const e = String(email ?? '').toLowerCase()
    if (e === 'superadmin' || SUPERADMIN_EMAILS.includes(e)) return [...ALL]
    const [row] = [...this.ctx.storage.sql.exec('SELECT source FROM access WHERE email = ?', e)] as any[]
    return row?.source === 'org-admin' ? [...PROJECT_ROLES.admin.capabilities, 'org.people'] : this.capabilitiesOfEmail(e)
  }
  /** Whether a caller may revoke a key (null) or why not: their own; one whose maker now holds nothing here (it holds
   *  nothing either); one made by someone they are above. Equals leave each other's keys alone. */
  private whyNotRevoke(by: string, callerCaps: string[] | null, k: { name: string; created_by: string }): string | null {
    if (by.toLowerCase() === k.created_by.toLowerCase()) return null
    const maker = this.standingOf(k.created_by)
    if (!maker.length) return null
    return whyNot(callerCaps ?? this.standingOf(by), maker, `"${k.name}" was made by ${k.created_by}`)
  }
  private capabilitiesOfEmail(email: string | null | undefined): Capability[] {
    const e = String(email ?? '').toLowerCase()
    if (!e) return []
    if (e === 'superadmin' || SUPERADMIN_EMAILS.includes(e)) return [...capabilitiesOf('project')]
    const [row] = [...this.ctx.storage.sql.exec('SELECT role_id, source FROM access WHERE email = ?', e)] as any[]
    if (!row) return []
    return row.source === 'org-admin' ? [...PROJECT_ROLES.admin.capabilities] : this.roleCapabilities(row.role_id)
  }
  /** What a connection holds now, read each time so a change of role applies at once: a person their role's; a service
   *  member (a chat channel) a member's; an agent key its maker's (its scopes cut it further); the platform admin
   *  everything; someone in the admin console what their role here holds. */
  /** The person a connection acts for, by address: themself, or — for an agent key — the person who made it. */
  private personOf(c: ConnInfo): string | null {
    if (c.type === 'agent') { const k = this.agentKeys.get(String(c.userId ?? '').replace(/^agent:/, '')); return k?.created_by ? k.created_by.toLowerCase() : null }
    return c.email ? c.email.toLowerCase() : null
  }
  private capsOf(c: ConnInfo): Capability[] {
    if (c.orgRole === 'superadmin') return [...capabilitiesOf('project')]
    if (c.type === 'admin') return this.capabilitiesOfEmail(c.email)
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
    // An agent key is a member as itself; a person (or a key of their own, which acts as them) by their address.
    const members = [c.type === 'agent' ? c.userId : null, c.email ? `email:${c.email.toLowerCase()}` : null].filter(Boolean)
    const groups = [...new Set(members.flatMap((m) => [...this.ctx.storage.sql.exec('SELECT grp FROM group_members WHERE member = ?', m)].map((r: any) => `group:${r.grp}`)))]
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
  private static NOT_ACTIONS = new Set(['session:list', 'activity:list', 'tick', 'ping', 'ui:resize', 'term:input', 'term:detach', 'sync:req', 'answer:get', 'answer:ack', 'log:attach', 'log:detach', 'session:file', 'view:open', 'view:intent'])
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
    // a query of one's own on a source: which, and what was asked (never what came back)
    else if (t === 'connector:query') { detail.source = String(pl.source ?? pl.connection ?? ''); detail.sql = String(pl.sql ?? '').slice(0, 4000) }
    else if (t === 'connector:act') { detail.connection = String(pl.connection ?? ''); detail.action = String(pl.action ?? '') }
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
      // Whether the caller may revoke a key, or why not — one answer for the list and the revoke: a key reaches only the
      // keys below it; a person (and a key, for its person, cut to what it holds) only those made by someone they are above.
      const whyNotKey = (id: string): string | null => {
        if (!by) return 'who is asking is not known'
        if (!this.agentKeys.reaches(request.headers.get('x-sa-key'), id)) return 'a key revokes only the keys below it'
        const target = this.agentKeys.get(id)
        return target ? this.whyNotRevoke(by, request.headers.get('x-sa-key') ? callerCaps : null, target) : null
      }
      if (path === '/agent-keys' && request.method === 'GET') return json({ keys: this.agentKeys.list().map((k) => { const no = whyNotKey(k.id); return { ...k, mayRevoke: !no, ...(no ? { whyNot: no } : {}) } }) })
      // A key of one's own (sacli login, through the browser): it acts as the person who signed in, never holds more
      // than they hold here now, and expires (90 days unless said). No project.keys needed — it is no more than them.
      if (path === '/my-key' && request.method === 'POST') {
        if (!by.includes('@')) return json({ error: 'a key of one\'s own is made by a person, signed in' }, 400)
        const holds = this.capabilitiesOfEmail(by)
        if (!holds.length) return json({ error: 'you are not in this project' }, 403)
        const asked: string[] = Array.isArray(body.capabilities) ? body.capabilities.map(String) : holds
        const over = beyond(asked, holds)
        if (over.length) return json({ error: `a key cannot hold what you do not: ${over.join(', ')}` }, 403)
        const r = await this.agentKeys.create({ name: String(body.name ?? 'sacli').slice(0, 80), capabilities: asked, by, madeByKey: null, actsAs: by, expiresAt: body.expiresAt ?? new Date(Date.now() + 90 * 86_400_000).toISOString() })
        this.audit.record({ actor: admin, via: 'admin', action: 'agent-key.create', target: r.record.id, outcome: 'ok', detail: { name: r.record.name, capabilities: r.record.capabilities, own: true } })
        return json(r, 201)
      }
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
        const no = whyNotKey(m[1])
        if (no) { this.audit.record({ actor: admin, via: 'admin', action: 'agent-key.revoke', target: m[1], outcome: 'refused', detail: { reason: no } }); return json({ error: no }, 403) }
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

    // A person sending a message is real activity → the idle clock starts again.
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
    // The sender's attached development environment, stamped from the project's own row (docs/dev-mode.md): only theirs,
    // only while attached and holding project.develop; what it names is read first, the rest is what is published.
    if (caps && can(caps, 'project.develop')) { const dev = this.devEnvs.overlayFor(this.personOf(sender)); if (dev) (envelope.from as any).dev = dev }
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
    // ── The composition graph: held here (graph.ts) — read and changed here, never by an engine ──
    if ((GRAPH_MESSAGES.has(String(pl.t)) || (pl.t === 'inspect:req' && GRAPH_VIEWS.has(String(pl.view)))) && (sender.type === 'runtime' || sender.type === 'admin' || sender.type === 'agent')) {
      if (!sender.userId) { hubReply({ t: 'graph:refused', reason: 'who is asking is not known', reqId: pl.reqId }); return }
      const graph = this.graph()
      if (pl.t === 'inspect:req') { hubReply({ t: 'inspect:res', reqId: pl.reqId, view: pl.view, ...graph.view(String(pl.view), pl) }); return }
      const who: Who = { id: sender.type === 'agent' ? sender.userId : `user:${sender.userId}`, admin: !!envelope.from.admin, ...(sender.email ? { email: sender.email } : {}), scopes: this.scopesOf(sender) }
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
    if (typeof pl.t === 'string' && /^(dsi:(show|stats|describe|enable|build|snapshot|failures|tag|tags)|job:(list|get)|lineage:(map|declare|remove))$/.test(pl.t) && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      const who = this.principalOf(sender)
      if (!who) { hubReply({ t: 'dsi:refused', reason: 'who is asking is not known', reqId: pl.reqId }); return }
      const actor = sender.type === 'agent' ? { kind: 'agent' as const, id: who } : { kind: 'user' as const, id: who, ...(sender.email ? { email: sender.email } : {}) }
      const via = sender.type === 'agent' ? 'agent' : sender.type === 'admin' ? 'admin' : 'ui'
      try {
        switch (pl.t) {
          case 'dsi:show': hubReply({ t: 'dsi:items', items: this.dsi().show(pl), reqId: pl.reqId }); break
          case 'dsi:stats': hubReply({ t: 'dsi:stats', ...this.dsi().stats(), running: this.jobs().running('dsi'), reqId: pl.reqId }); break
          case 'dsi:failures': hubReply({ t: 'dsi:failures', source: pl.source, failures: this.dsi().failures(pl), reqId: pl.reqId }); break
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
          case 'dsi:tag': {
            const tag = this.dsi().tag(pl, sender.email ?? who)
            this.audit.record({ actor, via, action: 'dsi.tag', target: [tag.source, tag.table, tag.field].filter(Boolean).join('.'), outcome: 'ok', detail: { owner: tag.owner, sensitivity: tag.sensitivity } })
            hubReply({ t: 'dsi:tagged', tag, reqId: pl.reqId }); break
          }
          case 'dsi:tags': hubReply({ t: 'dsi:tags', source: pl.source, tags: this.dsi().tags(pl.source), reqId: pl.reqId }); break
          case 'lineage:map': hubReply({ t: 'lineage:map', ...this.lineage().map(), reqId: pl.reqId }); break
          case 'lineage:declare': {
            const r = this.lineage().declare(pl, sender.email ?? who, sender.type === 'agent' ? 'agent' : 'person')
            this.audit.record({ actor, via, action: 'lineage.declare', target: `${(pl.edges ?? []).length} edges`, outcome: 'ok', detail: { added: r.added } })
            hubReply({ t: 'lineage:declared', ...r, reqId: pl.reqId }); break
          }
          case 'lineage:remove': {
            const r = this.lineage().remove(pl, sender.email ?? who)
            this.audit.record({ actor, via, action: 'lineage.remove', target: String(r.removed), outcome: 'ok' })
            hubReply({ t: 'lineage:removed', ...r, reqId: pl.reqId }); break
          }
          case 'job:list': hubReply({ t: 'job:list', jobs: this.jobs().list({ kind: pl.kind ? String(pl.kind) : undefined, active: !!pl.active }), reqId: pl.reqId }); break
          case 'job:get': hubReply({ t: 'job:got', job: this.jobs().get(String(pl.id ?? '')), reqId: pl.reqId }); break
        }
      } catch (e: any) {
        if (e instanceof DsiRefusal || e instanceof JobRefusal || e instanceof LineageRefusal) hubReply({ t: String(pl.t).startsWith('lineage:') ? 'lineage:refused' : 'dsi:refused', reason: e.message, reqId: pl.reqId }); else throw e
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
    if (typeof pl.t === 'string' && pl.t.startsWith('dev:') && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      // Development environments: every change a request, the person's own (the hub checked project.develop).
      const owner = this.personOf(sender)
      try {
        if (!owner) throw new DevRefusal('who is asking has no address')
        const r = pl.t === 'dev:create' ? { env: this.devEnvs.create(owner, String(pl.name ?? '')) }
          : pl.t === 'dev:list' ? { envs: this.devEnvs.list(pl.all && caps && can(caps, 'project.manage') ? null : owner) }
          : pl.t === 'dev:attach' ? { env: this.devEnvs.attach(owner, pl.env, pl.overrides, sender.type === 'agent' ? (this.agentKeys.get(String(sender.userId ?? '').replace(/^agent:/, ''))?.name ?? 'a key') : 'the console') }
          : pl.t === 'dev:ping' ? (this.devEnvs.ping(owner, pl.env), {})
          : pl.t === 'dev:detach' ? (this.devEnvs.detach(owner, pl.env), {})
          : pl.t === 'dev:delete' ? (this.devEnvs.delete(owner, pl.env, !!caps && can(caps, 'project.manage')), {})
          : null
        if (!r) throw new DevRefusal(`there is no ${pl.t}`)
        if (pl.t !== 'dev:ping' && pl.t !== 'dev:list') this.audit.record({ actor: { kind: sender.type === 'agent' ? 'agent' : 'user', id: this.principalOf(sender) ?? owner, email: owner }, via: sender.type === 'agent' ? 'agent' : sender.type === 'admin' ? 'admin' : 'ui', action: pl.t.replace(':', '.'), target: String(pl.env ?? pl.name ?? ''), outcome: 'ok' })
        hubReply({ t: `${pl.t}:ok`, ...r, reqId: pl.reqId })
        if (pl.t === 'dev:attach') this.devToPerson(owner)   // attached, or rebuilt: their tabs show it and run their view again
        if (pl.t === 'dev:create' || pl.t === 'dev:attach') void this.reportDevEnvs(owner)   // (ended ones report through onEnd)
      } catch (e: any) { hubReply({ t: 'dev:refused', reason: e instanceof DevRefusal ? e.message : `the environment could not be changed: ${e?.message ?? e}`, reqId: pl.reqId }) }
      return
    }
    if ((pl.t === 'program:list' || pl.t === 'program:publish' || pl.t === 'program:source') && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      const who = this.principalOf(sender)
      if (!who) { hubReply({ t: 'program:refused', reason: 'who is asking is not known', reqId: pl.reqId }); return }
      const actor = sender.type === 'agent' ? { kind: 'agent' as const, id: who } : { kind: 'user' as const, id: who, ...(sender.email ? { email: sender.email } : {}) }
      try {
        if (pl.t === 'program:source') {
          // The source a program was built from, to edit and build again (sacli agent pull): by hash, or by name — its
          // newest published build, else its newest build. Kept inside the build's hash, so it is exactly what was built.
          if (!pl.hash && !pl.name) { hubReply({ t: 'program:refused', reason: 'name the program (or its hash)', reqId: pl.reqId }); return }
          const all = this.catalogue.list({ name: pl.hash ? undefined : String(pl.name) })
          const pick = pl.hash ? all.find((p) => p.hash === String(pl.hash))
            : [...all].sort((a, b) => Number(!!b.published_at) - Number(!!a.published_at) || b.version - a.version)[0]
          if (!pick) { hubReply({ t: 'program:refused', reason: `there is no program ${pl.hash ? String(pl.hash).slice(0, 12) : `"${pl.name}"`}`, reqId: pl.reqId }); return }
          const files = sourceFiles(await this.catalogue.bundle(pick.hash))
          hubReply({ t: 'program:source', program: pick, files, reqId: pl.reqId })
          return
        }
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
    // ── What can be connected (no engine needed); a connection's own operations (test, read, act) go to the engine ──
    if (pl.t === 'connector:catalog' && (sender.type === 'runtime' || sender.type === 'agent' || sender.type === 'admin')) {
      hubReply({ t: 'connector:catalog', connectors: await this.connectorCatalogue(), reqId: pl.reqId })
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
          hubReply({ t: 'warehouse:tables', ...(await this.grantedWarehouseTables()), reqId: pl.reqId })
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

    // If target is code-engine and the engine is DOWN: on Fly, queue + wake it from OUTSIDE (this object calls the Fly
    // API; the engine never wakes itself). "Down" is decided from this object's OWN record + the role registry, NEVER a
    // frozen WebSocket: a Fly suspend rarely delivers a clean close. `idle_phase` is set when the machine is put to sleep.
    // A person's message is the only wake trigger; an idle browser tab never wakes the machine.
    const to = msg.to as { id?: string; type?: string; channel?: string } | undefined
    if (to?.type === 'code-engine') {
      const [pm] = this.ctx.storage.sql.exec('SELECT provider, idle_phase, last_heartbeat FROM fly_machine LIMIT 1')
      const phase = (pm as any)?.idle_phase as string | undefined
      const fly = (pm as any)?.provider === 'fly'
      let engineDown = !this.roleRegistry.has('code-engine') || (fly && (phase === 'suspended' || phase === 'stopped'))
      // GRACE: an engine that is not asleep but momentarily absent is almost always mid-reconnect (every platform deploy
      // drops the hub's sockets; it is back in about a second). If it heartbeated recently, wait a few seconds for it.
      if (engineDown && phase !== 'suspended' && phase !== 'stopped') {
        const lastHb = Number((pm as any)?.last_heartbeat ?? 0)
        if (lastHb && Date.now() - lastHb < ProjectDO.ENGINE_RECENT_MS) {
          await this.waitForEngine(ProjectDO.ENGINE_GRACE_MS)
          engineDown = !this.roleRegistry.has('code-engine')
        }
      }
      if (engineDown) {
        if (!fly) {
          // A machine of one's own, which the platform cannot start.
          senderWs.send(JSON.stringify({ from: { id: 'hub', type: 'hub' },
            payload: { t: 'error', source: 'compute', message: 'This project is offline right now. Try again in a minute; if it stays offline, tell your administrator.' } }))
          return
        }
        // Fly: queue the message (with who sent it, so the reply finds them) + wake the machine.
        this.ctx.storage.sql.exec('INSERT INTO message_queue (msg_json) VALUES (?)', JSON.stringify(envelope))
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
    const [m] = [...this.ctx.storage.sql.exec('SELECT status, last_heartbeat, idle_phase, provider FROM fly_machine LIMIT 1')] as any[]
    const provider = m?.provider === 'fly' ? 'fly' : 'external'
    const fly = provider === 'fly' ? await this.flyPlaceOf() : null
    const machine = m ? { status: m.status, provider, lastHeartbeat: m.last_heartbeat, ...(fly ? { fly, idlePhase: m.idle_phase } : {}) } : null
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
  /** A model-only key (agent-contract modelOnlyKeyOf) derived from one of this project's engine keys. */
  private async modelKeyMatches(key: string): Promise<boolean> {
    if (!key.startsWith('sk-proj-m-')) return false
    for (const r of [...this.ctx.storage.sql.exec('SELECT key FROM api_key')] as any[]) if (await modelOnlyKeyOf(String(r.key)) === key) return true
    return false
  }
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
    if (typeof orgId === 'string' && orgId) { await this.ctx.storage.put('orgId', orgId); this._org = orgId }
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
    this.graph()   // a new project's graph, with its default agent from the start
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
    // Their sign-in account, made now: no one signs up on their own (auth/clerk-users.ts).
    const account = await ensureSignInAccount(email, (this.env as any).CLERK_SECRET_KEY)
    if (typeof account === 'object') console.error(`[access] ${email}: given access, but no sign-in account — ${account.problem}`)
    return this.j({ ok: true, email, roleId, signIn: typeof account === 'object' ? 'not ready' : 'ready' })
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
    // Checked at the door (agent-contract profileProblems — the rule the engine applies too), against the platform's
    // models: an agent that is not one, a harness that cannot use that account, a model the account does not list.
    const { problems, unknown } = profileProblems(profile, (PLATFORM_MODELS as any).providers)
    for (const name of unknown) problems.push(`"${name}" is not an agent`)
    if (problems.length) return Response.json({ error: `the profile was not saved: ${problems.join('; ')}`, problems }, { status: 400 })
    const prev = this.readProfile()
    const version = (prev?.version ?? 0) + 1
    const stored = { ...profile, version }
    this.ctx.storage.sql.exec('DELETE FROM profile')
    this.ctx.storage.sql.exec('INSERT INTO profile (json, version, updated_by, updated_at) VALUES (?, ?, ?, ?)',
      JSON.stringify(stored), version, body?.by ?? null, Date.now())
    this.log('profile:saved', { version, by: body?.by ?? null })
    this.audit.record({ actor: this.actorOf(req, body), via: 'admin', action: 'profile.change', target: 'profile', outcome: 'ok', detail: { version, agents: Object.fromEntries(Object.entries((profile as any).agents ?? {}).map(([n, a]: [string, any]) => [n, `${a.harness} · ${a.provider} · ${a.model}${a.thinking ? ` · ${a.thinking}` : ''}`])) } })
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
  private get runningProfile(): { version: number; agents?: any; profile?: any; release?: any; at: number } | null {
    try {
      const [row] = this.ctx.storage.sql.exec('SELECT json, version, at FROM engine_running LIMIT 1')
      if (!row) return null
      return { ...JSON.parse((row as any).json), version: (row as any).version, at: (row as any).at }
    } catch { return null }
  }
  private setRunningProfile(v: { version: number; agents?: any; profile?: any; release?: any; at: number } | null) {
    try {
      this.ctx.storage.sql.exec('DELETE FROM engine_running')
      if (v) this.ctx.storage.sql.exec('INSERT INTO engine_running (json, version, at) VALUES (?, ?, ?)',
        JSON.stringify({ agents: v.agents ?? null, profile: v.profile ?? null, release: v.release ?? null }), v.version, v.at)
    } catch (err: any) {
      this.log('config:running_write_failed', { error: String(err?.message ?? err).slice(0, 160) })
    }
  }

  // ── The engine release this project runs (docs/deploying-the-engine.md) ──────────────────────────────────────────
  // CHOSEN here, RUN by the box. The choice is a registry digest — the exact bytes — never a moving name, and it is held
  // apart from what the engine reports it runs: the two differ while a box switches, is away, or rolled a release back.
  // Pushed when chosen and given again in every welcome, so a box that was off learns it when it comes back.
  private static readonly REGISTRY = 'registry.superatom.ai'
  private static readonly ENGINE_IMAGE = 'superatom-engine'

  private readRelease(): { digest: string; tag: string | null; setBy: string | null; setAt: number } | null {
    try {
      const [row] = [...this.ctx.storage.sql.exec('SELECT digest, tag, set_by, set_at FROM engine_release LIMIT 1')] as any[]
      return row ? { digest: row.digest, tag: row.tag ?? null, setBy: row.set_by ?? null, setAt: Number(row.set_at) } : null
    } catch { return null }   // a welcome is never refused for want of a release: the box keeps what it runs
  }
  private releaseForEngine(): { digest: string; tag: string | null; image: string; chosenAt: string } | null {
    const r = this.readRelease()
    // chosenAt: choosing the same release again (after it rolled back) is a new choice, which the updater tries again.
    return r ? { digest: r.digest, tag: r.tag, image: `${ProjectDO.REGISTRY}/${ProjectDO.ENGINE_IMAGE}@${r.digest}`, chosenAt: new Date(r.setAt).toISOString() } : null
  }

  private engineReleases() { return listEngineReleases((this.env as any).REGISTRY as R2Bucket | undefined) }

  private async getEngineRelease(): Promise<Response> {
    const online = [...this.connByWs.values()].some((c) => c.type === 'code-engine')
    const { releases, problem } = await this.engineReleases().catch((e: any) => ({ releases: [], problem: `the releases could not be read: ${e?.message ?? e}` }))
    return Response.json({ desired: this.readRelease(), running: this.runningProfile?.release ?? null, online, switch: this.readSwitch(), releases, ...(problem ? { problem } : {}) })
  }

  private async putEngineRelease(req: Request): Promise<Response> {
    const body = await req.json().catch(() => ({})) as any
    let who = 'unknown'; try { const a = JSON.parse(req.headers.get('x-sa-actor') ?? 'null'); who = a?.email ?? a?.id ?? who } catch { /* none */ }
    const tag = typeof body?.tag === 'string' && body.tag.trim() ? body.tag.trim() : null
    let digest = typeof body?.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(body.digest) ? body.digest : null
    if (!tag && !digest) return Response.json({ error: 'say which release: { "tag": "dev-20261010-1a2b3c4d" } or { "digest": "sha256:…" }' }, { status: 400 })
    // A NAME IS RESOLVED NOW, to the digest it names now: the choice is those bytes, and stays them if the name moves.
    if (tag) {
      const { releases, problem } = await this.engineReleases()
      const hit = releases.find((x) => x.tag === tag)
      if (!hit) return Response.json({ error: problem ?? `there is no release "${tag}" — the newest are ${releases.slice(0, 5).map((x) => x.tag).join(', ') || 'none yet'}` }, { status: 404 })
      digest = hit.digest
    }
    // THE BOX MUST BE ABLE TO PULL IT: read through the address boxes use, before anything is chosen.
    const res = await fetch(`https://${ProjectDO.REGISTRY}/v2/${ProjectDO.ENGINE_IMAGE}/manifests/${digest}`, { method: 'HEAD' }).catch(() => null)
    if (!res?.ok) return Response.json({ error: `${ProjectDO.REGISTRY} does not serve ${digest} (${res ? res.status : 'unreachable'}) — a box could not pull it; see docs/deploying-the-engine.md` }, { status: 409 })
    this.ctx.storage.sql.exec('DELETE FROM engine_release')
    this.ctx.storage.sql.exec('INSERT INTO engine_release (digest, tag, set_by, set_at) VALUES (?, ?, ?, ?)', digest, tag, who, Date.now())
    this.audit.record({ actor: { kind: 'user', id: who }, via: 'api', action: 'engine.release', target: `${this._pid ?? ''} ${tag ?? ''} ${digest}`.trim(), outcome: 'ok' })
    this.log('engine:release', { digest, tag, by: who })
    if (this.onFly()) { const fly = await this.flySwitch({ digest: digest!, tag }); return Response.json({ ok: true, desired: this.readRelease(), fly }) }
    const delivered = this.sendToRole('code-engine', { t: 'engine:release', release: this.releaseForEngine() })
    return Response.json({ ok: true, desired: this.readRelease(), delivered })
  }

  // ── The engine switch, as the box's Engine Updater reports it ──────────────────────────────────────────────────────
  // The engine is down mid-switch, so the updater speaks for the box: every step, with its time, kept whole here — a page
  // opened halfway shows what happened so far — and pushed to the people who have a tab open now (this hub's links: one
  // per connected person, never every member). The admin console gets the whole record; a person using the project gets
  // only that it is updating, to which version and since when.
  private readSwitch(): EngineSwitch | null {
    try { const [row] = [...this.ctx.storage.sql.exec('SELECT json FROM engine_switch LIMIT 1')] as any[]; return row ? JSON.parse(row.json) : null }
    catch { return null }
  }
  /** The update under way, for the people using the project — none when nothing is switching, or when the box has said
   *  nothing for 10 minutes (it is shown to the admin console as unfinished instead of keeping a banner up forever). */
  private upgradingNow(): { state: 'switching'; version: string | null; startedAt: string } | null {
    const sw = this.readSwitch()
    if (!sw || sw.state !== 'switching') return null
    const lastAt = Date.parse(sw.steps.at(-1)?.at ?? sw.startedAt)
    if (Date.now() - lastAt > 10 * 60_000) return null
    return { state: 'switching', version: sw.tag, startedAt: sw.startedAt }
  }
  private async engineSwitchStep(req: Request): Promise<Response> {
    if (!this.keyMatches(req.headers.get('x-engine-key') ?? '')) return Response.json({ error: 'the engine key does not match this project' }, { status: 401 })
    const b = await req.json().catch(() => null) as any
    const steps = ['started', 'pulled', 'stopped', 'db-copied', 'started-new', 'waiting', 'switched', 'rolled-back', 'refused']
    if (!b || typeof b.id !== 'string' || !steps.includes(b.step)) return Response.json({ error: `a step is { id, step: ${steps.join('|')}, to, tag, from, at, … }` }, { status: 400 })
    this.recordSwitch(b)
    return Response.json({ ok: true })
  }
  /** One step of a switch — from a machine's updater, or from this object for an engine on Fly. */
  private recordSwitch(b: { id: string; step: string; to?: string; tag?: string | null; from?: string | null; at?: string; note?: string; reason?: string; fix?: string; logTail?: string }) {
    const at = typeof b.at === 'string' ? b.at : new Date().toISOString()
    const prev = this.readSwitch()
    const sw: EngineSwitch = prev && prev.id === b.id ? prev
      : { id: b.id, to: String(b.to ?? ''), tag: b.tag ?? null, from: b.from ?? null, startedAt: at, state: 'switching', steps: [] }
    if (!sw.steps.some((x) => x.step === b.step)) sw.steps.push({ step: b.step, at, ...(b.note ? { note: String(b.note).slice(0, 300) } : {}) })
    if (['switched', 'rolled-back', 'refused'].includes(b.step)) {
      sw.state = b.step as EngineSwitch['state']; sw.endedAt = at
      for (const k of ['reason', 'fix', 'logTail'] as const) { const v = b[k]; if (typeof v === 'string') sw[k] = v.slice(0, k === 'logTail' ? 6000 : 600) }
    }
    this.ctx.storage.sql.exec('DELETE FROM engine_switch')
    this.ctx.storage.sql.exec('INSERT INTO engine_switch (json, at) VALUES (?, ?)', JSON.stringify(sw), Date.now())
    this.log('engine:switch', { id: sw.id, step: b.step, tag: sw.tag })
    if (sw.state !== 'switching') this.audit.record({ actor: { kind: 'system', id: 'engine-updater' }, via: 'system', action: 'engine.switch', target: `${this._pid ?? ''} ${sw.tag ?? sw.to}`, outcome: sw.state === 'switched' ? 'ok' : 'refused', ...(sw.reason ? { detail: { reason: sw.reason } } : {}) })
    // To whoever has a tab open now — and nobody else.
    const people = { state: sw.state, version: sw.tag, startedAt: sw.startedAt, ...(sw.endedAt ? { endedAt: sw.endedAt } : {}) }
    for (const [ws, conn] of this.connByWs) {
      if (conn.type === 'admin') this.deliverToConn(ws, conn, { from: { id: 'hub', type: 'hub' }, payload: { t: 'engine:switch', switch: sw } } as Envelope)
      else if (conn.type === 'runtime') this.deliverToConn(ws, conn, { from: { id: 'hub', type: 'hub' }, payload: { t: 'project:upgrading', upgrading: people } } as Envelope)
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

  // ── The engine on Fly (fly.ts; docs/deploying-the-engine.md, "On Fly") ──────────────────────────────────────────────
  // There the platform does what the installer and the updater do on a machine of one's own: it places the engine (an
  // app, a volume, a machine on the chosen release), switches it when another release is chosen, and puts back what ran
  // before when the new release does not reach the hub within SWITCH_WAIT_MS. One place at a time: never while this
  // project's engine is connected from somewhere else.
  private static readonly SWITCH_WAIT_MS = 6 * 60_000

  private flyToken(): string {
    const t = (this.env as any).FLY_API_TOKEN as string | undefined
    if (!t) throw new Error('the platform has no Fly token (FLY_API_TOKEN) — docs/deploying-the-engine.md, "On Fly"')
    return t
  }
  private async flyPlaceOf(): Promise<FlyPlace | null> { return (await this.ctx.storage.get<FlyPlace>('flyPlace')) ?? null }
  private onFly(): boolean { const [m] = [...this.ctx.storage.sql.exec('SELECT provider FROM fly_machine LIMIT 1')] as any[]; return m?.provider === 'fly' }
  private setProvider(p: 'fly' | 'external') {
    const [row] = [...this.ctx.storage.sql.exec('SELECT 1 AS x FROM fly_machine LIMIT 1')]
    if (row) this.ctx.storage.sql.exec('UPDATE fly_machine SET provider = ?', p)
    else this.ctx.storage.sql.exec("INSERT INTO fly_machine (machine_id, status, provider, last_active) VALUES (NULL, 'placed', ?, ?)", p, Date.now())
  }
  private actor(req: Request): string { try { const a = JSON.parse(req.headers.get('x-sa-actor') ?? 'null'); return a?.email ?? a?.id ?? 'unknown' } catch { return 'unknown' } }

  /** What the engine runs with on Fly — what the installer gives it on a machine (apps/updater/install.mjs). */
  private async flyEnv(image: string): Promise<Record<string, string>> {
    const [k] = [...this.ctx.storage.sql.exec('SELECT key FROM api_key LIMIT 1')] as any[]
    if (!k) throw new Error('this project has no engine key yet')
    const domain = (this.env as any).PLATFORM_DOMAIN ?? 'superatom.site', name = slugOf(await this.projectName())
    return { ICA_PROJECT: this._pid ?? '', ICA_KEY: k.key, ICA_HUB: `wss://${domain}`, SUPERATOM_PLATFORM: domain, ...(name ? { PROJECT_NAME: name } : {}),
      SUPERATOM_HOME: '/app/data', DATASOURCE_URL: 'http://localhost:4000', DATASOURCE_DATA_DIR: '/app/data/datasources', DATASOURCES_DIR: '/app/data/datasources', SA_ENGINE_IMAGE: image }
  }

  /** The release to run there: the one chosen, else the newest — and Fly's registry must hold it. */
  private async flyRelease(): Promise<{ digest: string; tag: string | null; image: string }> {
    let r: { digest: string; tag: string | null } | null = this.readRelease()
    if (!r) { const x = (await this.engineReleases()).releases[0]; if (!x) throw new Error('there is no engine release yet'); r = { digest: x.digest, tag: x.tag } }
    if (!(await flyHasImage(this.flyToken(), r.digest))) throw Object.assign(new Error(`Fly's registry does not hold ${r.tag ?? r.digest} yet — copy it (GitHub → Actions → engine-to-fly → Run, tag ${r.tag ?? 'of the release'}), then try again`), { status: 409 })
    return { ...r, image: `${FLY_IMAGES}@${r.digest}` }
  }

  /** PUT /engine-place { region? }: the engine on Fly — made, or brought up to date (its data kept). */
  private async placeOnFly(req: Request): Promise<Response> {
    const body = await req.json().catch(() => ({})) as any, who = this.actor(req)
    try {
      if (this.roleRegistry.has('code-engine') && !this.onFly()) return Response.json({ error: 'this project\'s engine is connected from a machine now — stop it there first (sacli engine stop): one place at a time' }, { status: 409 })
      const was = await this.flyPlaceOf()
      // One of the organisation's machines on Fly — the platform's administrators decide whether it has any, and how many.
      const org = await this.orgId()
      if (!org) return Response.json({ error: 'this project belongs to no organisation, so it cannot run on Fly' }, { status: 403 })
      const claim = await (this.env as any).ORG.get((this.env as any).ORG.idFromName(org)).fetch(new Request('http://do/fly/claim', { method: 'POST', body: JSON.stringify({ project: this._pid }) }))
      if (!claim.ok) return Response.json({ error: ((await claim.json().catch(() => ({}))) as any).error ?? 'the organisation may not run engines on Fly' }, { status: claim.status })
      const region = typeof body?.region === 'string' && /^[a-z]{3}$/.test(body.region) ? body.region : was?.region ?? 'sin'
      const r = await this.flyRelease()
      const place = await flyPlace(this.flyToken(), { org: (this.env as any).FLY_ORG_SLUG ?? 'personal', project: this._pid ?? '', name: await this.projectName(), region, image: r.image, env: await this.flyEnv(r.image), was })
      await this.ctx.storage.put('flyPlace', place)
      this.setProvider('fly')
      await flyRunning(this.flyToken(), place)   // running, whatever it was, once Fly has finished changing it
      // A fresh idle window: what was last active here may be from long ago (the engine ran elsewhere), and the idle clock
      // would put the new machine to sleep the moment it came up.
      this.ctx.storage.sql.exec("UPDATE fly_machine SET last_active = ?, idle_phase = 'active', status = 'running'", Date.now())
      await this.armIdle(Date.now() + SUSPEND_AFTER_MS)
      this.audit.record({ actor: { kind: 'user', id: who }, via: 'api', action: 'engine.place', target: `${this._pid ?? ''} fly ${place.app}`, outcome: 'ok' })
      this.log('engine:fly_placed', { ...place, release: r.tag ?? r.digest, by: who })
      return Response.json({ ok: true, fly: place, release: r.tag ?? r.digest })
    } catch (e: any) {
      this.log('engine:fly_failed', { error: String(e?.message ?? e).slice(0, 300), by: who })
      return Response.json({ error: String(e?.message ?? e) }, { status: e?.status === 409 ? 409 : 502 })
    }
  }

  /** DELETE /engine-place: the engine leaves Fly — its machine removed; the app and its volume (the data) kept. */
  private async leaveFly(req: Request): Promise<Response> {
    const place = await this.flyPlaceOf(), who = this.actor(req)
    if (!place?.machine || !this.onFly()) return Response.json({ ok: true, note: 'the engine is not on Fly' })
    try { await flyRemoveMachine(this.flyToken(), place) }
    catch (e: any) { return Response.json({ error: String(e?.message ?? e) }, { status: 502 }) }
    await this.ctx.storage.put('flyPlace', { ...place, machine: '' })
    this.setProvider('external')
    const org = await this.orgId()
    if (org) await (this.env as any).ORG.get((this.env as any).ORG.idFromName(org)).fetch(new Request('http://do/fly/release', { method: 'POST', body: JSON.stringify({ project: this._pid }) })).catch(() => null)
    this.audit.record({ actor: { kind: 'user', id: who }, via: 'api', action: 'engine.leave', target: `${this._pid ?? ''} fly ${place.app}`, outcome: 'ok' })
    this.log('engine:fly_left', { app: place.app, kept: place.volume, by: who })
    return Response.json({ ok: true, kept: { app: place.app, volume: place.volume } })
  }

  /** A release chosen for an engine on Fly: Fly swaps the machine's image; the engine reaching the hub on it is the proof
   *  (flyConfirm), and its absence after SWITCH_WAIT_MS puts back what ran before (alarm). Each step is the switch record
   *  the admin console shows for a machine's updater. */
  private async flySwitch(r: { digest: string; tag: string | null }): Promise<{ ok: boolean; error?: string }> {
    const id = `fly-${Date.now().toString(36)}`, at = () => new Date().toISOString(), image = `${FLY_IMAGES}@${r.digest}`
    const place = await this.flyPlaceOf()
    if (!place?.machine) return { ok: false, error: 'the engine is not placed on Fly' }
    try {
      const token = this.flyToken(), was = (await flyMachine(token, place)).image
      this.recordSwitch({ id, step: 'started', to: image, tag: r.tag, from: was, at: at() })
      if (was === image) { this.recordSwitch({ id, step: 'switched', at: at(), note: 'already running it' }); return { ok: true } }
      if (!(await flyHasImage(token, r.digest))) {
        const reason = `Fly's registry does not hold ${r.tag ?? r.digest}`
        this.recordSwitch({ id, step: 'refused', at: at(), reason, fix: `GitHub → Actions → engine-to-fly → Run with tag ${r.tag ?? '(the release)'}; then choose the release again` })
        return { ok: false, error: reason }
      }
      await flySetImage(token, place, image)
      // A machine asleep is started on its new image: the switch is proven only by the engine coming up on it.
      await flyRunning(token, place)
      this.ctx.storage.sql.exec('UPDATE fly_machine SET idle_phase = ?, last_active = ?', 'active', Date.now())
      this.recordSwitch({ id, step: 'started-new', at: at() })
      this.recordSwitch({ id, step: 'waiting', at: at() })
      await this.ctx.storage.setAlarm(Date.now() + ProjectDO.SWITCH_WAIT_MS)
      return { ok: true }
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 300)
      this.recordSwitch({ id, step: 'refused', to: image, tag: r.tag, at: at(), reason, fix: 'choose the release again; if Fly keeps refusing, docs/deploying-the-engine.md, "On Fly"' })
      return { ok: false, error: reason }
    }
  }
  /** The engine reports what it runs: on Fly, that is the proof a switch worked. */
  private flyConfirm(release: any) {
    const sw = this.readSwitch()
    if (sw?.state === 'switching' && sw.id.startsWith('fly-') && release?.digest && sw.to.endsWith(release.digest)) this.recordSwitch({ id: sw.id, step: 'switched', at: new Date().toISOString() })
  }
  // ── Idle on Fly: heartbeat → alarm → suspend → stop; a person's message wakes it ─────────────────────────────────
  // One alarm serves two things: a release switch under way (its deadline) and the idle clock. A machine is never put to
  // sleep mid-switch; when the switch ends, the idle clock is armed again.

  /** The idle alarm, unless a switch's deadline is pending (that alarm runs first and re-arms this after). */
  private async armIdle(at: number) {
    const sw = this.readSwitch()
    if (sw?.state === 'switching' && sw.id.startsWith('fly-')) return
    await this.ctx.storage.setAlarm(at)
  }

  // On engine connect. A (re)connect is NOT activity: last_active is kept (seeded on the first connect) — except on a
  // WAKE (it was suspended or stopped), which starts a fresh idle window, or the alarm would already be due and suspend
  // it seconds after it came up. Repeated flaps while running cannot extend idle time.
  private async recordHeartbeat() {
    const now = Date.now()
    const [m] = this.ctx.storage.sql.exec('SELECT last_active, idle_phase FROM fly_machine LIMIT 1')
    const la = Number((m as any)?.last_active) || 0
    const phase = (m as any)?.idle_phase as string | undefined
    const wokeUp = la === 0 || phase === 'suspended' || phase === 'stopped' || phase === undefined
    const lastActive = wokeUp ? now : la
    this.ctx.storage.sql.exec('UPDATE fly_machine SET last_heartbeat = ?, last_active = ?, status = ?, idle_phase = ?', now, lastActive, 'running', 'active')
    await this.armIdle(lastActive + SUSPEND_AFTER_MS)
  }

  // A person did something (connected or sent a message): the idle clock starts again. `status` is left alone — it is the
  // machine's real state, set by wakeMachine/alarm/engine connect.
  private markUserActivity() {
    const now = Date.now()
    this.ctx.storage.sql.exec('UPDATE fly_machine SET last_active = ?, idle_phase = ?', now, 'active')
    void this.armIdle(now + SUSPEND_AFTER_MS)
  }

  // Some alarm is always pending, anchored to last_active — so suspend/stop fires even if heartbeats stop. Cost failsafe.
  private async ensureAlarm() {
    if (await this.ctx.storage.getAlarm() != null) return
    const [m] = this.ctx.storage.sql.exec('SELECT last_active, idle_phase FROM fly_machine LIMIT 1')
    if (!m) return
    const la = Number((m as any).last_active) || Date.now()
    await this.armIdle((m as any).idle_phase === 'suspended' ? la + STOP_AFTER_MS : la + SUSPEND_AFTER_MS)
  }

  // Messages queued while the machine slept, delivered on engine connect and on every heartbeat. EVERY ROW LEAVES THE
  // QUEUE before it is attempted, each attempt isolated: one bad row must never replay forever and crash-loop the hub.
  private flushQueued(ws: WebSocket) {
    const queued = [...this.ctx.storage.sql.exec('SELECT id, msg_json, created_at FROM message_queue ORDER BY id')]
    if (queued.length === 0) return
    const nowSec = Math.floor(Date.now() / 1000)
    let sent = 0, stale = 0, failed = 0
    for (const q of queued) {
      const id = (q as any).id
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

  // Forget the engine's connection when WE put the machine to sleep (a suspend rarely delivers a clean close), so the next
  // message sees it down, wakes the machine, and the resumed engine's registration flushes the queue.
  private dropEngine(reason: string) {
    let closed = 0
    for (const [ws, conn] of [...this.connByWs]) {
      if (conn.type === 'code-engine') { try { ws.close(1000, reason) } catch { /* already gone */ } this.handleDisconnect(ws); closed++ }
    }
    this.roleRegistry.delete('code-engine')
    this.log('machine:engine_dropped', { reason, closed })
  }

  // Wake the machine if it is not running — Fly's real state, not this object's record; every outcome logged.
  private async wakeMachine() {
    if (!this.onFly()) return
    const place = await this.flyPlaceOf()
    const token = (this.env as any).FLY_API_TOKEN as string | undefined
    if (!token || !place?.machine) return
    try {
      const { state } = await flyMachine(token, place)
      const now = Date.now()
      if (state === 'started') { this.ctx.storage.sql.exec('UPDATE fly_machine SET status = ?, idle_phase = ?', 'running', 'active'); return }
      this.log('machine:waking', { machine: place.machine, fromState: state })
      await flyStart(token, place)
      this.ctx.storage.sql.exec('UPDATE fly_machine SET status = ?, idle_phase = ?, last_heartbeat = ?, last_active = ?', 'running', 'active', now, now)
      await this.armIdle(now + SUSPEND_AFTER_MS)
      this.log('machine:woke', { machine: place.machine, fromState: state })
    } catch (err: any) {
      this.log('machine:wake_failed', { machine: place.machine, error: err?.message ?? String(err) })
    }
  }

  // The idle state machine, anchored to last_active (real activity):
  //   running   + idle ≥ 24 h               → SUSPEND (CPU and memory no longer billed; ~1-2 s warm wake)
  //   suspended + idle ≥ 7 days, nobody here → STOP (cold wake)
  // A connected person never triggers a cold stop. A failure retries in a minute, so an idle machine is never left running.
  private async idleAlarm() {
    const [m] = this.ctx.storage.sql.exec('SELECT last_active, idle_phase, provider FROM fly_machine LIMIT 1')
    if (!m || (m as any).provider !== 'fly') return
    const place = await this.flyPlaceOf()
    const token = (this.env as any).FLY_API_TOKEN as string | undefined
    if (!token || !place?.machine) return
    const now = Date.now(), lastActive = Number((m as any).last_active) || 0, idleMs = now - lastActive
    const phase = (m as any).idle_phase as string, idleMin = Math.round(idleMs / 60000)
    const hasUser = [...this.connByWs.values()].some(c => c.type === 'runtime')
    if (phase !== 'suspended' && phase !== 'stopped') {
      if (idleMs < SUSPEND_AFTER_MS) { await this.ctx.storage.setAlarm(lastActive + SUSPEND_AFTER_MS); return }
      try {
        await flySuspend(token, place)
        this.ctx.storage.sql.exec('UPDATE fly_machine SET status = ?, idle_phase = ?', 'suspended', 'suspended')
        this.dropEngine('machine suspended')
        this.log('machine:suspended', { machine: place.machine, idleMin })
        await this.ctx.storage.setAlarm(lastActive + STOP_AFTER_MS)
      } catch (err: any) {
        this.log('machine:suspend_failed', { error: err?.message ?? String(err) })
        await this.ctx.storage.setAlarm(now + 60_000)
      }
    } else if (phase === 'suspended') {
      if (idleMs < STOP_AFTER_MS || hasUser) { await this.ctx.storage.setAlarm(Math.max(lastActive + STOP_AFTER_MS, now + 60_000)); return }
      try {
        await flyStop(token, place)
        this.ctx.storage.sql.exec('UPDATE fly_machine SET status = ?, idle_phase = ?', 'stopped', 'stopped')
        this.dropEngine('machine stopped')
        this.log('machine:stopped', { machine: place.machine, idleMin })
      } catch (err: any) {
        this.log('machine:stop_failed', { error: err?.message ?? String(err) })
        await this.ctx.storage.setAlarm(now + 60_000)
      }
    }
    // stopped → nothing to do until a person's message wakes it
  }

  /** The alarm: a release switch's deadline when one is under way on Fly, else the idle clock. */
  async alarm() {
    this.hydrate()   // may fire after a hibernation wake — rebuild the connection maps before reading them
    const sw = this.readSwitch()
    if (sw?.state === 'switching' && sw.id.startsWith('fly-')) { await this.switchDeadline(); return }
    await this.idleAlarm()
  }

  /** SWITCH_WAIT_MS after a switch on Fly: switched, or what ran before is put back. */
  private async switchDeadline() {
    const sw = this.readSwitch()
    if (sw?.state !== 'switching' || !sw.id.startsWith('fly-')) return
    const at = new Date().toISOString(), running = this.runningProfile?.release?.digest
    if (running && sw.to.endsWith(running) && this.roleRegistry.has('code-engine')) { this.recordSwitch({ id: sw.id, step: 'switched', at }); await this.ensureAlarm(); return }
    const place = await this.flyPlaceOf()
    try {
      if (place?.machine && sw.from) await flySetImage(this.flyToken(), place, sw.from)
      this.recordSwitch({ id: sw.id, step: 'rolled-back', at, reason: `${sw.tag ?? 'the release'} did not reach the platform within ${ProjectDO.SWITCH_WAIT_MS / 60_000} minutes`, fix: `the engine runs what it ran before; its log: flyctl logs -a ${place?.app ?? '<app>'}` })
      await this.ensureAlarm()
    } catch (e: any) {
      this.log('engine:fly_rollback_failed', { id: sw.id, error: String(e?.message ?? e).slice(0, 300) })
      await this.ctx.storage.setAlarm(Date.now() + 60_000)   // tried again in a minute
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
