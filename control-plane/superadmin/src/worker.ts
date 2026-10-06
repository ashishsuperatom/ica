// Superadmin worker
//
// Routing:
//   /_ws/{projectId}  → a person: their UserDO (which links them to the project); engines, agents, services: ProjectDO
//   /ws               → OrgDO      (admin WS: real-time broadcast)
//   /api/*            → OrgDO      (users, projects, datasources, conversations)
//   /*                → React SPA via ASSETS
//
// Auth flow:
//   POST /api/auth/token  → validates Clerk session → returns our JWT
//   (Clerk is used once for login; all subsequent calls use our JWT)

export { OrgDO } from './do.js'
export { ProjectDO } from './project-do.js'
export { GlobalDO } from './global-do.js'
export { ChannelDO } from './channel-do.js'
export { DecisionDO } from './decision-do.js'
export { UserDO } from './user-do.js'
export { ConnectorGateway, ConnectorProxy } from './connectors/runtime.js'
// The channel-agnostic messaging module (Teams/Slack/… adapters) — imported, never inlined.
import { channelAdapter } from '../../../clients/messaging/index.js'
// Speech-to-text for voice clients (mobile). A SELF-CONTAINED module in src/transcription/ —
// this import and the /api/transcribe route below are its ONLY touchpoints in the worker.
import { handleTranscribe } from './transcription/index.js'
// proxy.superatom.site — self-contained. Delete src/proxy/ and these two lines and nothing else changes.
import { handleProxyHost, PROXY_SUBDOMAIN } from './proxy/index.js'
import { checkProfile, modelLists } from './model-lists.js'
import { createMachine, stopMachine, FLY_APP } from './fly.js'
// Auth: token primitives + Clerk→platform-token mint (./auth/tokens.ts) and the mobile browser-redirect
// device flow (./auth/mobile.ts). worker.ts only routes to these; the rules live in the module.
import { verifyJwt, signJwt, mintPlatformTokenFromClerk, type JwtClaims } from './auth/tokens.js'
import { routeSocket } from './ws-route.js'
import { LIMITS, keyOf as fileKeys } from './files.js'
import { handleParcelRoute } from './parcels.js'
import { mobileAuthPage, handleMobileCode, handleMobileExchange, handleMeProjects } from './auth/mobile.js'
import { can, capabilitiesOf, orgRouteNeeds, projectRouteNeeds, beyond, builtinRole, type Capability, type RouteNeed } from '../../shared/permissions.js'
import { orgOfKey } from './agent-keys.js'

// ── Auth ────────────────────────────────────────────────────────────────────
// Token primitives, the Clerk→platform-token mint, and SUPERADMIN_EMAILS live in ./auth/tokens.ts (imported
// above). The mobile browser-redirect device flow lives in ./auth/mobile.ts. worker.ts only routes.

// Admin/provisioning routes require a valid superadmin JWT (Authorization: Bearer <jwt>). Returns the claims,
// or null if missing/invalid — closing the hole where these routes forwarded to the DO with NO auth at all.
async function requireSuperadmin(request: Request, env: Env): Promise<JwtClaims | null> {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const claims = await verifyJwt(m[1], env.JWT_SECRET)
  return claims && claims.role === 'superadmin' ? claims : null
}

// ── Authorization ───────────────────────────────────────────────────────────
// Three levels, checked HERE rather than in a UI: a hidden button is not access control, and the admin SPA is
// served to anyone who asks for it.
//   superadmin  — the hard-coded address in auth/tokens.ts. Everything.
//   org admin   — users.role='admin' in that org's OrgDO. Its org and every project in it.
//   member      — has a row in that project's own access table. That project only, as its role says.
// Each answer needs one DO read, so it stays cheap enough to run on every request.

/** The name the session cookie goes by. One constant, because it is read in the worker and written by the
 *  browser and the two have to agree. */
const SESSION_COOKIE = 'sa_session'

function cookieToken(request: Request): string | null {
  const raw = request.headers.get('cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join('=')) || null
  }
  return null
}

/** WHO is asking — from the Authorization header, or failing that the session cookie.
 *
 *  The header is how an SPA calls an API: its JS attaches the token. A browser NAVIGATING to a page attaches
 *  nothing, because no JS of ours has run yet — so a header-only check can never protect a document, only the
 *  calls a page makes after it has loaded. That is why the SPA shells are public today.
 *
 *  The cookie closes that, for every path at once. It is the same JWT, set once by /api/auth/session and sent
 *  by the browser on every request to this host: the document, its assets, and any static thing served later.
 *  Header first, so an explicit token always wins over an ambient one. */
async function claimsOf(request: Request, env: Env): Promise<JwtClaims | null> {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  const token = m ? m[1] : cookieToken(request)
  return token ? await verifyJwt(token, env.JWT_SECRET) : null
}

/** The caller's standing in ONE project, and what they hold there (shared/permissions.ts). ONE read, of the PROJECT's
 *  own DO — never the org's. A project is asked about on every request, so it has to answer alone: its access table
 *  already holds everyone who may touch it, including the org's owners and admins, mirrored in whenever that changes. */
async function projectAccessOf(request: Request, env: Env, projectId: string):
    Promise<{ ok: boolean; level: 'superadmin' | 'org-admin' | 'project-admin' | 'member' | 'none'; email: string; roleId?: string; caps: Capability[] }> {
  const claims = await claimsOf(request, env)
  const email = (claims?.email || '').toLowerCase()
  if (!claims) return { ok: false, level: 'none', email: '', caps: [] }
  if (claims.role === 'superadmin') return { ok: true, level: 'superadmin', email, caps: [...capabilitiesOf('project')] }   // token alone; no DO at all
  if (!email) return { ok: false, level: 'none', email, caps: [] }
  const proj = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
  const acc: any = await proj.fetch('https://do/access').then(r => r.json()).catch(() => ({}))
  let row = (acc?.access ?? []).find((a: any) => String(a.email || '').toLowerCase() === email)
  // Not on the list yet: their verified domain may let them in (enterprise sign-in, provisioned on first arrival).
  if (!row) {
    const arrived = (await proj.fetch('https://do/access/arrive', { method: 'POST', body: JSON.stringify({ email }) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as any)?.access
    if (arrived) row = ((await proj.fetch('https://do/access').then(r => r.json()).catch(() => ({}))) as any)?.access?.find((a: any) => String(a.email || '').toLowerCase() === email)
  }
  if (!row) return { ok: false, level: 'none', email, caps: [] }
  // Only a row the ORG put here means org admin. A project's own 'admin' role administers THAT project — it
  // does not confer anything over the organisation, and must not be able to edit what the org owns.
  const level = row.source === 'org-admin' ? 'org-admin' : row.role_id === 'admin' ? 'project-admin' : 'member'
  return { ok: true, level, email, roleId: row.role_id, caps: Array.isArray(row.capabilities) ? row.capabilities : [] }
}

/** The caller's standing in ONE org: their role there and what it holds (the platform's superadmin everything). */
async function orgAccessOf(request: Request, env: Env, orgId: string):
    Promise<{ ok: boolean; level: 'superadmin' | 'org-admin' | 'member' | 'none'; email: string; role: string | null; caps: Capability[]; userId?: string }> {
  const claims = await claimsOf(request, env)
  const email = (claims?.email || '').toLowerCase()
  const userId = claims?.userId ? String(claims.userId) : undefined
  if (!claims) return { ok: false, level: 'none', email: '', role: null, caps: [] }
  if (claims.role === 'superadmin') return { ok: true, level: 'superadmin', email, role: 'superadmin', caps: [...capabilitiesOf('org')], userId }
  if (!email) return { ok: false, level: 'none', email, role: null, caps: [] }
  const org = env.ORG.get(env.ORG.idFromName(orgId))
  const me: any = await org.fetch(`https://do/me?email=${encodeURIComponent(email)}`).then(r => r.json()).catch(() => ({}))
  if (!me?.member) return { ok: false, level: 'none', email, role: null, caps: [] }
  const caps: Capability[] = Array.isArray(me.capabilities) ? me.capabilities : []
  return { ok: true, level: me.role === 'owner' || me.role === 'admin' ? 'org-admin' : 'member', email, role: String(me.role), caps, userId }
}

/** Does this standing meet what a route needs? */
function meets(need: RouteNeed, level: string, caps: readonly Capability[]): boolean {
  if (need === 'any') return true
  if (need === 'internal') return false
  if (need === 'platform') return level === 'superadmin'
  if (need === 'org-people') return level === 'superadmin' || level === 'org-admin'
  return can(caps, need)
}

// ── Token exchange: Clerk session → our JWT ─────────────────────────────────
// Strategy: decode the Clerk JWT to extract the session id, then validate the
// session against Clerk's REST API. If Clerk says it's valid, we trust it and
// issue our own JWT. No external verification libraries needed.

async function handleTokenExchange(request: Request, env: Env): Promise<Response> {
  try {
    const { clerkToken } = await request.json() as { clerkToken?: string }
    const r = await mintPlatformTokenFromClerk(clerkToken, env)   // shared rules (Clerk validation + superadmin gate + 30-day JWT)
    return r.ok
      ? Response.json({ token: r.token, userId: r.userId, role: r.role })
      : Response.json({ error: r.error }, { status: r.status })
  } catch (err: any) {
    console.error(`[auth] token exchange failed: ${err.message}`)
    return Response.json({ error: 'invalid session' }, { status: 401 })
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url  = new URL(request.url)
    const path = url.pathname
    const isWs = request.headers.get('upgrade') === 'websocket'

    // ── proxy.superatom.site — model traffic ──────────────────────────────────
    // BEFORE the site routing below, which would otherwise resolve `proxy` as a project subdomain and hand
    // back an app. Everything behind this line lives in src/proxy/ and is reachable only from here.
    // The HOST HEADER, not url.hostname: `wrangler dev` rewrites the request URL to localhost, so a hostname
    // check cannot be exercised locally at all. Reading the header is also simply what a worker behind any
    // proxy should do, and in production Cloudflare sets both to the same thing.
    // x-forwarded-host first: `wrangler dev` rewrites BOTH url.hostname and the Host header to localhost, so
    // without it this route cannot be exercised outside production at all. Cloudflare sets it in front of the
    // worker, and it is the conventional header for "the host the client actually asked for".
    const reqHost = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.hostname)
      .split(':')[0].toLowerCase()
    if (reqHost === `${PROXY_SUBDOMAIN}${SITE_SUFFIX}`) return handleProxyHost(request, env, ctx)

    // ── *.superatom.site — subdomain-addressed apps ───────────────────────────
    // Only document/SPA requests are host-routed here; /_ws/*, /api/*, and /mobile/* (the device-login page)
    // share this same worker and fall through to the normal handlers below, so the browser connects to
    // wss://<same-host>/_ws/<projectId> with nothing hardcoded.
    // (superatom.site / superatom.ai are untouched — different host, skipped.)
    if ((url.hostname === 'superatom.site' || url.hostname.endsWith(SITE_SUFFIX)) &&
        !path.startsWith('/_ws/') && !path.startsWith('/api/') && !path.startsWith('/mobile/') && !isWs) {
      return handleSiteRequest(url.hostname, request, env)
    }

    // ── Project WebSocket hub ─────────────────────────────────────────────────
    const wsMatch = path.match(/^\/_ws\/(.+)/)
    if (wsMatch) {
      // Require a credential in the URL — reject immediately with 401 if missing.
      // The DO validates the key/token inside handleHello (after WS upgrade).
      // We CANNOT call stub.fetch() for verification here — a second stub.fetch()
      // after verify-conn breaks the WS upgrade on the same DO instance.
      const key = url.searchParams.get('key')
      const token = url.searchParams.get('token')
      // An agent declares itself and sends its key only in its hello, never in a URL (URLs end up in logs).
      const agent = url.searchParams.get('agent') === '1'
      if (!key && !token && !agent) return new Response('authentication required', { status: 401 })
      return routeSocket(request, env, decodeURIComponent(wsMatch[1].split('?')[0]))   // a person: their UserDO (ws-route.ts)
    }

    // ── Project API (machine status, etc.) ─────────────────────────────────
    // ── Messaging ingress: /api/messaging/<projectId>/<channel>/<hook> ─────────
    // Project-scoped by URL (no KV, no global DO). Verify + parse via the channel
    // adapter, hand the turn to that project's ChannelDO (a separate DO, so the
    // ProjectDO stays clean). The Worker only routes + acks; the ChannelDO owns the
    // engine round-trip and the reply.
    const msgMatch = path.match(/^\/api\/messaging\/([^/]+)\/([^/]+)\/(.+)/)
    if (msgMatch) {
      const [, projectId, channel, hook] = msgMatch
      const chan = env.CHANNEL.get(env.CHANNEL.idFromName(`chan:${projectId}`))

      // Onboarding: store the hub service token + per-channel bot secrets. Superadmin only.
      if (hook === 'config') {
        // Administering THIS PROJECT's channels — its admins, not only superadmin, or an organisation cannot
        // run its own. (projectAccessOf grants superadmin everywhere.)
        { const acc = await projectAccessOf(request, env, projectId)
          if (!acc.ok) return new Response('unauthorized', { status: 401 })
          if (acc.level === 'member') return new Response('forbidden', { status: 403 }) }
        return chan.fetch('https://do/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: await request.text() })
      }

      // Read-only connection status for the admin UI (masked ids + secret-present flag; never the secret). Superadmin only.
      if (hook === 'status') {
        // Administering THIS PROJECT's channels — its admins, not only superadmin, or an organisation cannot
        // run its own. (projectAccessOf grants superadmin everywhere.)
        { const acc = await projectAccessOf(request, env, projectId)
          if (!acc.ok) return new Response('unauthorized', { status: 401 })
          if (acc.level === 'member') return new Response('forbidden', { status: 403 }) }
        return chan.fetch('https://do/status', { method: 'GET' })
      }

      // TEST-ONLY: run one engine turn and return the answer (no channel reply). The
      // service token goes in the body (it IS the credential), so this proves the
      // ChannelDO↔hub↔engine loop in Cloudflare without any Azure/Teams setup.
      if (hook === 'selftest') {
        // Had no check at all. It runs a REAL engine turn — compute someone pays for — and took the project id
        // from the caller, so possession of a service token was the only thing standing in the way.
        const acc = await projectAccessOf(request, env, projectId)
        if (!acc.ok) return new Response('unauthorized', { status: 401 })
        if (acc.level === 'member') return new Response('forbidden', { status: 403 })
        const body = JSON.parse((await request.text()) || '{}'); body.projectId = projectId
        return chan.fetch('https://do/selftest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      }

      // Real channel webhook (Teams 'messages', Slack 'events'): parse + forward. The auth token travels to
      // the ChannelDO, which VERIFIES it against the project's bot App ID before touching the hub (the worker
      // has no secrets). We always 200 the channel fast; a forged request is dropped in the DO, unanswered.
      const adapter = channelAdapter(channel)
      if (!adapter) return new Response('unknown channel', { status: 404 })
      const authToken = (request.headers.get('authorization') || '').replace(/^bearer\s+/i, '') || null
      const message = await adapter.parseInbound(request)
      if (!message) return new Response('', { status: 200 })   // non-message event → ack, nothing to do
      ctx.waitUntil(chan.fetch('https://do/inbound', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, channel, message, authToken }) }))
      return new Response('', { status: 200 })   // ack the channel immediately; reply comes proactively
    }

    // ── Parcels: message bodies beside the wire (parcels.ts) ─────────────────────────────────────────────────
    // A GET needs only the ticket in the pointer. A PUT is the engine with the project's key, or a member with
    // their token — the two credentials the hub itself accepts, checked the same way.
    const parcelMatch = path.match(/^\/api\/projects\/([^/]+)\/parcels\/([^/?]+)$/)
    if (parcelMatch) {
      const projectId = parcelMatch[1]
      return handleParcelRoute({
        request, bucket: env.PACKAGES, secret: env.JWT_SECRET, projectId, hash: parcelMatch[2], after: (p) => ctx.waitUntil(p),
        authorize: async () => {
          const bearer = (request.headers.get('authorization') || '').replace(/^bearer\s+/i, '')
          if (!bearer) return false
          if (bearer.startsWith('sk-proj-')) {
            const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
            const r = await stub.fetch('https://do/verify-conn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: bearer }) })
            return r.ok
          }
          return (await projectAccessOf(request, env, projectId)).ok
        },
      })
    }

    // ── An agent over HTTP: POST /api/agent/<projectId> with its key as the bearer, the message as the body. The
    //    project's DO checks the key and sends it the same way as over the agent's WebSocket. ──
    // ── A file a person adds to their session: to their own UserDO, which keeps it by hash and tells the engine. ──
    const attach = path.match(/^\/api\/sessions\/([0-9a-f-]{36})\/([\w-]{1,80})\/attachments$/)
    if (attach && request.method === 'POST') {
      const claims = await claimsOf(request, env)
      if (!claims?.userId || claims.role === 'service') return Response.json({ error: 'sign in to add a file' }, { status: 401 })
      const fwd = new Request(`http://do/attach?project=${attach[1]}&session=${attach[2]}&${url.searchParams}`, request)
      fwd.headers.set('x-sa-claims', JSON.stringify({ userId: claims.userId, email: claims.email, role: claims.role }))
      return env.USER.get(env.USER.idFromName(`user:${claims.userId}`)).fetch(fwd)
    }
    // ── The engine's own calls with its project key: programs it uploads and fetches; the files people put in sessions. ──
    const engineCall = path.match(/^\/api\/engine\/([0-9a-f-]{36})\/(programs(?:\/[0-9a-f]{64})?|attachments\/[\w-]{1,80}\/[0-9a-f]{64})$/)
    if (engineCall) {
      const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${engineCall[1]}`))
      const fwd = new Request(`http://do/engine/${engineCall[2]}${url.search}`, request)
      fwd.headers.set('x-sa-project', engineCall[1])
      return stub.fetch(fwd)
    }
    const agentCall = path.match(/^\/api\/agent\/([0-9a-f-]{36})$/)
    if (agentCall) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${agentCall[1]}`))
      const fwd = new Request(`http://do/agent-call${url.search}`, request)
      fwd.headers.set('x-sa-project', agentCall[1])
      return stub.fetch(fwd)
    }
    const projMatch = path.match(/^\/api\/projects\/([^/]+)\/(.+)/)
    if (projMatch) {
      const projectId = projMatch[1]
      const subPath   = projMatch[2]
      // Who is asking, and what may they do HERE? Superadmin and the owning org's admin get the provisioning
      // surface; a project member gets read-only. Enforced at this boundary, so hiding a button in the SPA is
      // never what protects anything.
      const acc = await projectAccessOf(request, env, projectId)
      if (!acc.ok) return new Response('unauthorized', { status: 401 })
      // What the caller holds here, and what they are: asked of the shared table, not of the SPA.
      if (subPath === 'me') return Response.json({ project: projectId, level: acc.level, role: acc.roleId ?? (acc.level === 'superadmin' ? 'superadmin' : null), capabilities: acc.caps })
      // Every call this makes to the project's DO says who the caller is (from the token checked above). The DO alone
      // records the audit history — one path, whichever way a change arrives.
      const actor = JSON.stringify({ kind: 'user', id: acc.email || acc.level, ...(acc.email ? { email: acc.email } : {}) })
      const toDO = (input: Request | string, init?: RequestInit) => {
        const req = new Request(input as any, init)
        req.headers.set('x-sa-actor', actor); req.headers.set('x-sa-project', projectId)
        req.headers.set('x-sa-caps', JSON.stringify(acc.caps))   // what they hold; the DO applies it, the table above decided it
        return env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`)).fetch(req)
      }
      // WHAT THIS CALL NEEDS (shared/permissions.ts): a capability of the caller's role here, the platform, the
      // organisation's people decision, or never public (the platform's own calls into the project: setup, the API key,
      // warehouse grants, connector records, the audit's writing, domain arrival, org admins, service members).
      const need = projectRouteNeeds(request.method, subPath)
      if (need === 'internal') return new Response(subPath === 'access' ? 'use /api/assignments — access is granted by the organisation' : 'not found', { status: subPath === 'access' ? 405 : 404 })
      if (!meets(need, acc.level, acc.caps)) return Response.json({ error: `this needs ${need}, which your role here does not hold` }, { status: 403 })
      // status: ONE generalized machine view — the backend fills it per provider
      // (Fly state for managed, hub-connection liveness for local/EC2). No separate
      // provider-specific endpoint; the frontend just renders status.machine.
      if (subPath === 'status') {
        return handleProjectStatus(projectId, env)
      }
      // Mint a long-lived SERVICE token for a headless client surface (Teams/Slack bot, mobile service, …).
      // It's a normal platform JWT whose userId is a per-channel SERVICE MEMBER of this project — so the hub
      // authorizes it as a `runtime` (it can ask questions), scoped by that membership. Revoke by removing the
      // member. Superadmin-only (guarded above). This is the headless equivalent of the Clerk→JWT web login.
      if (subPath === 'service-token') {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
        if (acc.level !== 'superadmin') return new Response('forbidden', { status: 403 })   // mints long-lived credentials
        const secret = env.JWT_SECRET
        if (!secret) return new Response('server misconfigured: JWT_SECRET not set', { status: 500 })
        const body = await request.json().catch(() => ({})) as { channel?: string; ttlDays?: number }
        const channel = (body.channel || 'bot').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'bot'
        const ttlDays = Math.min(Math.max(body.ttlDays ?? 365, 1), 3650)
        const userId = `svc:${channel}`
        const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
        // Register the service member in this project's DO (idempotent — INSERT OR REPLACE).
        const mr = await toDO(new Request('http://do/members', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId, role: 'service' }),
        }))
        if (!mr.ok) return new Response('failed to register service member', { status: 502 })
        const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400
        const token = await signJwt({ userId, role: 'service', exp }, secret)
        // Canonical hub host (the apex the web app also uses) — never the admin host.
        const wsUrl = 'wss://superatom.site'
        return Response.json({ token, userId, channel, projectId, wsUrl, expiresAt: exp * 1000 })
      }
      // Uploading a BUILD: multipart, one part per file, the field name being its path inside the build
      // (`index.html`, `assets/index-abc.js`). Everything lands under a fresh build id and the dashboard is
      // only pointed at it once every object is written — so a failed upload leaves the previous build serving
      // rather than a half-written one.
      const up = subPath.match(/^dashboards\/([^/]+)\/upload$/)
      if (up && request.method === 'POST') return uploadDashboardBuild(up[1], projectId, acc.email, request, env)

      // Deleting a dashboard has to take its BYTES with it. The DO row goes either way; without this the
      // objects stay in R2 for a dashboard that no longer exists, and nothing will ever refer to them again.
      // Rolling back is the DO's one UPDATE, but the worker remembers which build it is serving for a few
      // seconds — forget that, or the old build keeps being served for up to 15s after the console said done.
      const roll = subPath.match(/^dashboards\/([^/]+)\/current$/)
      if (roll && request.method === 'PUT') {
        const body = JSON.stringify({ ...(await request.json().catch(() => ({})) as object), by: acc.email })
        const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
        const r = await toDO(new Request(`http://do/${subPath}`, { method: 'PUT', body }))
        if (r.ok) { const b = JSON.parse(body || '{}'); if (b?.buildId) buildCache.set(`${projectId}/${roll[1]}`, { buildId: String(b.buildId), at: Date.now() }) }
        return r
      }

      const del = subPath.match(/^dashboards\/([^/]+)$/)
      if (del && request.method === 'DELETE') {
        await deleteDashboardObjects(del[1], projectId, env)
        // fall through to the DO, which removes the row
      }

      const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
      // Agent keys are made and revoked by someone: the DO records who, from the caller the gate just checked.
      if (/^(agent-keys|access-policies|access-attributes|access-domains|groups|roles)/.test(subPath) && request.method !== 'GET') {
        const by = acc.email || (acc.level === 'superadmin' ? 'superadmin' : '')
        const body = request.method === 'POST' || request.method === 'PUT' ? JSON.stringify({ ...(await request.json().catch(() => ({})) as object), by }) : undefined
        const fwd = new Request(`http://do/${subPath}${url.search ? url.search + '&' : '?'}by=${encodeURIComponent(by)}`, { method: request.method, headers: { 'content-type': 'application/json', 'x-sa-project': projectId }, body })
        return toDO(fwd)
      }
      const fwd = new Request(`http://do/${subPath}${url.search}`, request)
      fwd.headers.set('x-sa-project', projectId)   // the DO learns its own id from every call, not only from a socket
      return toDO(fwd)
    }

    // ── Auth: exchange Clerk session for our JWT ─────────────────────────────
    if (request.method === 'POST' && path === '/api/auth/token') {
      return handleTokenExchange(request, env)
    }

    // ── The session cookie ──────────────────────────────────────────────────
    // The SPA already holds a JWT; this hands the same token to the BROWSER so it travels on plain navigations
    // — a document, its assets, anything static served later — where no JS of ours has run to set a header.
    //
    // Set for every path, ENFORCED only where a route asks for it (today: /dashboard). Existing routes keep
    // authenticating by header exactly as before, so nothing that works now changes behaviour.
    //
    // HttpOnly so page scripts cannot read it, Secure, SameSite=Lax so it survives a normal navigation but not
    // a cross-site POST, and the same lifetime as the token it carries.
    if (request.method === 'POST' && path === '/api/auth/session') {
      const claims = await claimsOf(request, env)
      if (!claims) return new Response('unauthorized', { status: 401 })
      const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
      if (!m) return new Response('send the token as a Bearer header', { status: 400 })
      const maxAge = claims.exp ? Math.max(0, claims.exp - Math.floor(Date.now() / 1000)) : 3600
      return new Response(JSON.stringify({ ok: true, expiresIn: maxAge }), {
        headers: {
          'content-type': 'application/json',
          'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(m[1])}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
        },
      })
    }
    if (request.method === 'DELETE' && path === '/api/auth/session') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json',
                   'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
      })
    }

    // ── Mobile / device login (browser-redirect PKCE flow — see clients/ios/AUTH-HANDOFF.md) ──
    if (request.method === 'GET'  && path === '/mobile/auth')              return mobileAuthPage(env)
    if (request.method === 'POST' && path === '/api/auth/mobile/code')     return handleMobileCode(request, env)
    if (request.method === 'POST' && path === '/api/auth/mobile/exchange') return handleMobileExchange(request, env)
    if (request.method === 'GET'  && path === '/api/me/projects')          return handleMeProjects(request, env)

    // ── Audio transcription (module: src/transcription/) ────────────────────
    // Voice clients (iOS/Android) record speech, cut it into chunks with an on-device
    // voice-activity detector, and POST each chunk here to get its text back. Audio
    // is the ONE thing that does not go over the hub WebSocket: it is bulk binary and
    // each chunk must be retryable on its own. The resulting text is then asked as an
    // ordinary `analyse` question over the socket, so nothing downstream knows or cares
    // that it was spoken. All speech-to-text logic lives in the module; this route and
    // the import above are the only lines it adds to the worker.
    if (request.method === 'POST' && path === '/api/transcribe') {
      return handleTranscribe(request, env, (token, secret) => verifyJwt(token, secret))
    }

    // ── Credentials: what keys exist, who may use them ──────────────────────
    // Superadmin only, and POLICY only. It reports whether each named secret is PRESENT, never its value —
    // an admin screen that can display a key is an admin screen that leaks one. Putting a value in stays a
    // deliberate `wrangler secret put`, because a worker able to write its own secrets is a worker able to
    // hand them out.
    if (path.startsWith('/api/credentials')) {
      if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
      return handleCredentialsAdmin(request, env, path)
    }

    // ── WHAT EVERY PROJECT IS ACTUALLY RUNNING ──────────────────────────────
    // Superadmin ASSIGNS a profile; whether a box took it is a fact only that box can report, and it reports
    // to its own project's DO. So there was nowhere to see the fleet at once — you could push a change to
    // twelve projects and have no way to tell which of them had applied it.
    //
    // This fans out: every org's projects, then each project's own DO for the profile it has stored and the
    // one its engine last said it was running. Settled, not raced — a project whose DO is slow or whose engine
    // is asleep must appear in the list as exactly that, rather than removing the whole answer.
    if (path === '/api/once-org-ids' && request.method === 'POST') {   // ONE-TIME, removed after
      if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
      const g = env.GLOBAL.get(env.GLOBAL.idFromName('global'))
      const orgs = await (await g.fetch(new Request('http://do/organizations'))).json() as any[]
      const out: any[] = []
      for (const o of orgs) {
        const projects = await (await env.ORG.get(env.ORG.idFromName(o.id)).fetch(new Request('http://do/projects'))).json() as any[]
        for (const pr of projects) {
          const r = await env.PROJECT.get(env.PROJECT.idFromName(`proj:${pr.id}`)).fetch(new Request('http://do/once-org-id', { method: 'POST', body: JSON.stringify({ orgId: o.id }) }))
          out.push({ org: o.name, project: pr.name, ...(await r.json() as any) })
        }
      }
      return Response.json(out)
    }
    if (path === '/api/profiles') {
      if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
      const g = env.GLOBAL.get(env.GLOBAL.idFromName('global'))
      const orgs = await (await g.fetch(new Request('http://do/organizations'))).json() as any[]
      const perOrg = await Promise.allSettled(orgs.map(async (o: any) => {
        const orgStub = env.ORG.get(env.ORG.idFromName(o.id))   // an organisation's DO is named by its id, as every org route opens it (do_name is the global record's, unused)
        const projects = await (await orgStub.fetch(new Request('http://do/projects'))).json() as any[]
        return Promise.all(projects.map(async (pr: any) => {
          const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${pr.id}`))
          try {
            const d = await (await stub.fetch(new Request('http://do/profile'))).json() as any
            return { org: o.name, orgId: o.id, projectId: pr.id, project: pr.name,
                     // `running`: whether an engine is connected now (the profile it adopted is the profile page's business)
                     savedVersion: d.version ?? 0, updatedAt: d.updatedAt ?? 0, running: typeof d.online === 'boolean' ? d.online : null }
          } catch (e: any) {
            return { org: o.name, orgId: o.id, projectId: pr.id, project: pr.name,
                     savedVersion: null, running: null, error: String(e?.message ?? e).slice(0, 120) }
          }
        }))
      }))
      const rows = perOrg.flatMap(r => r.status === 'fulfilled' ? r.value : [])
      // An organisation that could not be read is said, not silently left out (it read as "no engines known").
      const errors = perOrg.flatMap((r, i) => r.status === 'rejected' ? [{ org: orgs[i]?.name ?? null, error: String((r.reason as any)?.message ?? r.reason).slice(0, 200) }] : [])
      return Response.json({ projects: rows, ...(errors.length ? { errors } : {}) })
    }

    // ── The MODEL CATALOGUE: which models each provider may be asked for ────
    // Superadmin only, and platform-wide — "opencode-go carries kimi-k3" is true for every project, so it is
    // held once in GlobalDO rather than copied into each one. It is the list the profile editor CHOOSES from;
    // it never travels to a project or to an engine, which are given decisions rather than options.
    //
    // Here rather than in the engine image so that adding or removing a model is an edit, not a rebuild and a
    // roll of every box.
    // The platform's price list (metering.ts): every version kept with who set it.
    if (path === '/api/prices') {
      if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
      const g = env.GLOBAL.get(env.GLOBAL.idFromName('global'))
      if (request.method === 'GET') return g.fetch(new Request('http://do/prices'))
      if (request.method === 'PUT') { const c = await claimsOf(request, env); return g.fetch(new Request('http://do/prices', { method: 'PUT', body: JSON.stringify({ ...(await request.json().catch(() => ({})) as object), by: c?.email ?? 'superadmin' }) })) }
      return Response.json({ error: 'use GET or PUT' }, { status: 405 })
    }
    if (path === '/api/catalogue') {
      if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
      const g = env.GLOBAL.get(env.GLOBAL.idFromName('global'))
      if (request.method === 'GET') {
        // The PROVIDERS come from the routing contract, not from a list the editor carries: a provider the
        // proxy cannot route is one no project should be offered, and the contract is the only thing that
        // knows. Same reason the credentials screen reads them from there.
        const { UPSTREAMS, isDisabled, disabledReason, HARNESSES } = await import('../../../vm/packages/agent-contract/contract.mjs')
        const r = await g.fetch(new Request('http://do/catalogue'))
        const body = await r.json() as any
        // OpenRouter's models are its own published list, never one typed here.
        body.models = await modelLists(body.models ?? {})
        // WITH THEIR ROUTE AND WHETHER THEY ARE TURNED OFF. A disabled provider still belongs in the catalogue
        // — it is a real account whose models we know, and switching it back on should not mean re-entering
        // them — but assigning a project to one is a choice that cannot work, and a plain list of names cannot
        // say so. openrouter is the live example: present, catalogued, and refused by both proxies.
        const providers = Object.keys(UPSTREAMS).map(name => ({
          name,
          route: (UPSTREAMS as any)[name].route,
          disabled: isDisabled(name) ? disabledReason(name) : null,
        }))
        // WHICH ACCOUNTS EACH HARNESS CAN REACH, so the editor narrows its dropdowns from the same table the
        // engine validates against rather than a second opinion written in a React file.
        return Response.json({ ...body, providers, harnesses: HARNESSES })
      }
      if (request.method === 'PUT') {
        return g.fetch(new Request('http://do/catalogue', {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: await request.text(),
        }))
      }
      return Response.json({ error: 'use GET or PUT' }, { status: 405 })
    }

    // ── Rotating a project's API key ────────────────────────────────────────
    // Superadmin only. The key sits in every engine's .env and on the proxy box, and it unlocks that
    // project's pooled provider credentials — so it must be rotatable, and rotating it must not require an
    // outage. Two steps, deliberately separate: /rotate issues a SECOND key (both work), then /prune drops
    // everything except the one now in use. A rotation that costs downtime is one nobody performs, which is
    // how an exposed key stays live.
    if (path.startsWith('/api/project-key/')) {
      if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
      const rest = path.slice('/api/project-key/'.length)
      const [projectId, action] = rest.split('/')
      if (!projectId || !action) return Response.json({ error: 'use /api/project-key/<projectId>/rotate|prune' }, { status: 400 })
      const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
      if (request.method === 'POST' && action === 'rotate') {
        return stub.fetch(new Request('http://do/keys/add', { method: 'POST' }))
      }
      if (request.method === 'POST' && action === 'prune') {
        return stub.fetch(new Request('http://do/keys/prune', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: await request.text(),
        }))
      }
      return Response.json({ error: 'unknown action' }, { status: 404 })
    }

    // ── A project's ENGINE PROFILE: which harness/provider/model each agent runs on ──────────────────────
    // Superadmin only, for the same reason the key above is: this decides which model answers the project's
    // questions and what that costs — a platform decision, not a tenant one. Stored in the project's own DO,
    // delivered to its engine in the welcome and pushed on change.
    //
    // GET returns two different facts and keeps them apart: the profile SAVED for the project, and what the
    // engine last reported it is actually RUNNING. They differ whenever a box is asleep, unreachable, or still
    // finishing a question, and an editor that conflated them would report success for a change nothing had
    // applied.
    if (path.startsWith('/api/projects/') && path.endsWith('/profile')) {
      if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
      const projectId = path.slice('/api/projects/'.length, -'/profile'.length)
      if (!projectId || projectId.includes('/')) return Response.json({ error: 'bad project id' }, { status: 400 })
      const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
      if (request.method === 'GET') return stub.fetch(new Request('http://do/profile'))
      if (request.method === 'PUT') {
        // CHECKED ON SAVE, and each model put in its account's own spelling — see model-lists.ts.
        const body = await request.json().catch(() => null) as any
        if (!body?.profile || typeof body.profile !== 'object') return Response.json({ error: 'body must be { profile }' }, { status: 400 })
        const g = env.GLOBAL.get(env.GLOBAL.idFromName('global'))
        const catalogue = ((await (await g.fetch(new Request('http://do/catalogue'))).json()) as any)?.models ?? {}
        const { profile, problems } = checkProfile(body.profile, await modelLists(catalogue))
        if (problems.length) return Response.json({ error: problems.join('; '), problems }, { status: 400 })
        return stub.fetch(new Request('http://do/profile', {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, profile }),
        }))
      }
      return Response.json({ error: 'use GET or PUT' }, { status: 405 })
    }

    // ── Project creation (with Fly Machine provisioning) ────────────────────
    if (request.method === 'POST' && path === '/api/projects') {
      // An organisation runs its own projects — whoever holds org.projects creates them. Superadmin may act anywhere.
      const oa = await orgAccessOf(request, env, request.headers.get('x-org-id') ?? 'default')
      if (!oa.ok) return new Response('unauthorized', { status: 401 })
      if (!can(oa.caps, 'org.projects')) return Response.json({ error: 'creating a project needs org.projects' }, { status: 403 })
      return handleCreateProject(request, env, url, ctx)
    }

    // ── Project deletion / restore (body-forwarding for DO) ─────────────────
    if ((request.method === 'DELETE' || request.method === 'PUT') && path === '/api/projects') {
      // Authorise against the PROJECT NAMED IN THE BODY, not the org header. The row update is scoped to the
      // caller's own OrgDO and would harmlessly match nothing, but the delete path also tears down the Fly
      // MACHINE by that id — so trusting the header alone let an admin of one organisation destroy another's
      // engine by naming its project.
      const target = String(((await request.clone().json().catch(() => ({}))) as any)?.id ?? '')
      if (!target) return new Response('id required', { status: 400 })
      // Removing a project from the organisation is the ORGANISATION's act (org.projects), and only of a project that is
      // the organisation's. Someone who administers the project runs it; they do not get to delete it out from under it.
      const orgId = request.headers.get('x-org-id') ?? 'default'
      const oa = await orgAccessOf(request, env, orgId)
      if (!oa.ok) return new Response('unauthorized', { status: 401 })
      if (!can(oa.caps, 'org.projects')) return Response.json({ error: 'removing a project needs org.projects' }, { status: 403 })
      const theirs = await (await env.ORG.get(env.ORG.idFromName(orgId)).fetch(new Request(`http://do/projects${request.method === 'PUT' ? '?deleted=1' : ''}`))).json().catch(() => []) as any[]
      if (!(Array.isArray(theirs) ? theirs : []).some((p: any) => p.id === target)) return Response.json({ error: 'that project is not in this organisation' }, { status: 404 })
      return handleProjectMutate(request, env, ctx)
    }

    // ── Domains API (subdomain → projectId registry; forwarded to GlobalDO) ──
    if (path.startsWith('/api/domains')) {
      // RESERVED NAMES. Some subdomains are answered by this worker itself, so letting a project claim one
      // would take an address the platform is already using — the claim would appear to succeed and then
      // quietly never route, which is the worst way for it to fail. Checked here, at the only place a name is
      // taken, rather than trusted to nobody trying.
      if (request.method === 'POST' && path === '/api/domains/claim') {
        const b = await request.clone().json().catch(() => ({})) as any
        const want = String(b?.subdomain ?? '').toLowerCase().trim()
        if (want && RESERVED_SUBDOMAINS.has(want)) {
          return new Response(JSON.stringify({ ok: false, error: `"${want}" is reserved by the platform` }),
            { status: 409, headers: { 'content-type': 'application/json' } })
        }
      }
      // A subdomain decides which project a visitor's browser is handed, so claiming one is an act ON that
      // project and needs the same standing as provisioning it. Releasing one takes a customer's address away.
      // This forwarded to the DO with no auth at all.
      const claims = await claimsOf(request, env)
      if (!claims) return new Response('unauthorized', { status: 401 })
      if (request.method !== 'GET') {
        const b = await request.clone().json().catch(() => ({})) as any
        const target = String(b?.projectId ?? '')
        if (!target) return new Response('projectId required', { status: 400 })
        const acc = await projectAccessOf(request, env, target)
        if (!acc.ok) return new Response('unauthorized', { status: 401 })
        if (!can(acc.caps, 'project.manage')) return Response.json({ error: 'a project\'s address needs project.manage' }, { status: 403 })
      }
      return handleDomainsApi(request, env, url)
    }

    // ── Global routes (organizations) ──────────────────────────────────────
    // CREATING or DELETING an organisation is superadmin's alone. LISTING is allowed to anyone signed in, but
    // the result is filtered to the orgs they actually belong to — otherwise the org list is a directory of
    // every customer on the platform. This forwarded to the DO with NO auth before.
    if (path.startsWith('/api/organizations')) {
      const claims = await claimsOf(request, env)
      if (!claims) return new Response('unauthorized', { status: 401 })
      const isSuper = claims.role === 'superadmin'
      if (request.method !== 'GET' && !isSuper) return new Response('forbidden', { status: 403 })
      const stub = env.GLOBAL.get(env.GLOBAL.idFromName('global'))
      const res = await stub.fetch(new Request(request.url.replace(/^(https?:\/\/[^/]+)\/api/, '$1'), request))
      if (isSuper || request.method !== 'GET') return res
      // Filter to the caller's own orgs — one membership check per org, and only their own comes back.
      const body: any = await res.json().catch(() => null)
      const list: any[] = body?.organizations ?? body?.orgs ?? (Array.isArray(body) ? body : [])
      const mine: any[] = []
      for (const o of list) {
        const id = o?.id ?? o?.orgId
        if (!id) continue
        const a = await orgAccessOf(request, env, String(id))
        if (a.ok) mine.push({ ...o, myLevel: a.level })
      }
      return Response.json(Array.isArray(body) ? mine : { ...body, organizations: mine })
    }

    // ── Org routes (admin WS + REST API) ──────────────────────────────────────
    // The organisation's own WebSocket is not served: no surface opens it, and the object behind it took the
    // caller's identity from query parameters. Every live socket goes through /_ws/<project>, which authenticates.
    if (isWs && path === '/ws') return new Response('not found', { status: 404 })
    // ── An organisation key (sak_org_<org>_…): an agent working for the organisation. The key names its organisation;
    //    the OrgDO verifies it and cuts it to what its maker holds now. No session involved.
    if (path === '/api/org-agent') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const key = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      const org = orgOfKey(key)
      if (!org) return Response.json({ error: 'an organisation key is required (sak_org_…)' }, { status: 401 })
      return env.ORG.get(env.ORG.idFromName(org)).fetch(new Request('http://do/agent', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-sa-org': org }, body: await request.text() }))
    }

    if (path.startsWith('/api/')) {
      const orgId = request.headers.get('x-org-id') ?? 'default'
      // x-org-id comes from the CLIENT, so it is a request, not a fact: without this check anyone could name any
      // org and read or mutate it. Membership decides; what the call needs is the shared table's (shared/permissions.ts).
      const oa = await orgAccessOf(request, env, orgId)
      if (!oa.ok) return new Response('unauthorized', { status: 401 })
      const sub = path.slice('/api'.length)
      const need = orgRouteNeeds(request.method, sub)
      // Assigning someone to a project is the organisation's people decision — or that project's own (project.people).
      const assigning = sub === '/assignments'
      if (need === 'internal') return new Response('not found', { status: 404 })
      if (!assigning && !meets(need, oa.level, oa.caps)) return Response.json({ error: `this needs ${need === 'platform' ? 'the platform' : need}, which your role in this organisation does not hold` }, { status: 403 })
      const org = env.ORG.get(env.ORG.idFromName(orgId))
      const by = oa.email || 'superadmin'
      const orgHeaders = { 'content-type': 'application/json', 'x-sa-org': orgId, 'x-sa-actor': JSON.stringify({ kind: 'user', id: by, email: oa.email }), 'x-sa-caps': JSON.stringify(oa.caps) }
      const projectsOfOrg = async (): Promise<any[]> => { const r = await (await org.fetch(new Request('http://do/projects'))).json().catch(() => []); return Array.isArray(r) ? r : [] }
      if (sub === '/me') return Response.json({ org: orgId, level: oa.level, role: oa.role, capabilities: oa.caps })
      // Budgets are set by whoever holds org.billing (assigning credits the organisation was given).
      if (sub === '/credits/budgets' && request.method === 'POST') {
        const body = JSON.stringify({ ...(await request.json().catch(() => ({})) as object), by })
        return org.fetch(new Request('https://do/credits/budgets', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
      }
      if (sub === '/credits/grant') {
        const body = JSON.stringify({ ...(await request.json().catch(() => ({})) as object), by })
        return org.fetch(new Request('https://do/credits/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
      }
      // A member sees the projects they are in; org.projects / org.people see them all.
      if (sub === '/projects' && request.method === 'GET' && !can(oa.caps, 'org.projects') && !can(oa.caps, 'org.people')) {
        const all = await projectsOfOrg()
        const mine = await Promise.all(all.map(async (p: any) => ((await projectAccessOf(request, env, p.id)).ok ? p : null)))
        return Response.json(mine.filter(Boolean))
      }
      // Giving someone a project role: the organisation's people decision, or that project's (project.people); either way
      // only to the organisation's people, and never a role holding more than the giver holds in that project.
      if (assigning) {
        const q = new URL(request.url).searchParams
        const body: any = request.method === 'GET' ? {} : await request.clone().json().catch(() => ({}))
        const projectId = String(q.get('projectId') ?? body.projectId ?? '')
        if (!(await projectsOfOrg()).some((p: any) => p.id === projectId)) return Response.json({ error: 'that project is not in this organisation' }, { status: 404 })
        const pa = await projectAccessOf(request, env, projectId)
        if (!can(oa.caps, 'org.people') && !can(pa.caps, 'project.people')) return Response.json({ error: 'this needs org.people, or project.people in that project' }, { status: 403 })
        if (request.method === 'POST') {
          const roleId = String(body.roleId ?? 'member')
          const roles: any = await env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`)).fetch(new Request('http://do/roles', { headers: { 'x-sa-project': projectId } })).then((r) => r.json()).catch(() => ({}))
          const role = (roles?.roles ?? []).find((r: any) => r.id === roleId)
          if (!role) return Response.json({ error: `there is no role "${roleId}" in that project` }, { status: 400 })
          const held = oa.level === 'superadmin' || oa.level === 'org-admin' ? [...capabilitiesOf('project')] : pa.caps
          const over = beyond(role.capabilities ?? [], held)
          if (over.length) return Response.json({ error: `you cannot give what you do not hold there: ${over.join(', ')}` }, { status: 403 })
        }
        if (request.method === 'DELETE') {
          // Taking someone's project role away needs holding at least what they hold there.
          const acc: any = await env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`)).fetch(new Request('http://do/access', { headers: { 'x-sa-project': projectId } })).then((r) => r.json()).catch(() => ({}))
          const theirs = (acc?.access ?? []).find((a: any) => a.email === String(body.email ?? '').toLowerCase())
          const held = oa.level === 'superadmin' || oa.level === 'org-admin' ? [...capabilitiesOf('project')] : pa.caps
          if (theirs && beyond(theirs.capabilities ?? [], held).length) return Response.json({ error: 'they hold more there than you do' }, { status: 403 })
        }
      }
      // THE ORGANISATION'S WAREHOUSE (warehouse/): tables made by warehouse.manage, appended to by warehouse.write,
      // read by warehouse.query; a project's grant — what it may read, and write — set by warehouse.manage and kept by
      // the project. Listing shows what the caller's warehouse capabilities let them see.
      if (sub === '/warehouse' || sub.startsWith('/warehouse/')) {
        const headers = { 'content-type': 'application/json', 'x-sa-org': orgId }
        if (sub === '/warehouse/grants') {
          const project = new URL(request.url).searchParams.get('project') ?? ''
          if (!(await projectsOfOrg()).some((p) => p.id === project)) return Response.json({ error: 'that project is not in this organisation' }, { status: 404 })
          const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${project}`))
          const ph = { 'content-type': 'application/json', 'x-sa-project': project }
          if (request.method === 'GET') return stub.fetch(new Request('http://do/warehouse/grants', { headers: ph }))
          const body = JSON.stringify({ ...(await request.json().catch(() => ({})) as object), by })
          return stub.fetch(new Request('http://do/warehouse/grants', { method: request.method, headers: ph, body }))
        }
        if (request.method === 'GET' && sub === '/warehouse') {
          const r: any = await (await org.fetch(new Request('http://do/warehouse', { headers }))).json()
          const sees = ['warehouse.query', 'warehouse.write', 'warehouse.manage'].some((c) => can(oa.caps, c as Capability))
          return Response.json({ configured: r.configured, org: r.org, tables: sees ? r.tables : [], ops: can(oa.caps, 'warehouse.query') || can(oa.caps, 'warehouse.manage') ? r.ops : [], capabilities: oa.caps.filter((c) => c.startsWith('warehouse.')) })
        }
        // One's own queries over this warehouse live in one's UserDO (the organisation's page: project '').
        const me = oa.userId ? (env as any).USER.get((env as any).USER.idFromName(`user:${oa.userId}`)) : null
        if (sub === '/warehouse/queries' || sub.startsWith('/warehouse/queries/')) {
          if (!me) return Response.json({ error: 'who is asking is not known' }, { status: 401 })
          const qs = `org=${encodeURIComponent(orgId)}&project=`
          if (request.method === 'POST') return me.fetch(new Request('http://do/warehouse/queries', { method: 'POST', body: JSON.stringify({ ...(await request.json().catch(() => ({})) as object), org: orgId, project: '' }) }))
          return me.fetch(new Request(`http://do${sub}?${qs}`, { method: request.method }))
        }
        if (request.method === 'GET') return org.fetch(new Request(`http://do${sub}`, { headers }))
        const asked: any = await request.json().catch(() => ({}))
        if (sub === '/warehouse/explore' && asked?.query && me) {
          // A query run (its first page, as written): the organisation answers, the person's UserDO records it.
          const res = await org.fetch(new Request(`http://do${sub}`, { method: 'POST', headers, body: JSON.stringify({ ...asked, by, grant: 'all' }) }))
          if (!res.ok || asked.op !== 'rows' || Number(asked.page ?? 1) !== 1 || asked.q || asked.where?.length || asked.sort) return res
          const out: any = await res.json()
          const rec: any = await me.fetch(new Request('http://do/warehouse/runs', { method: 'POST', body: JSON.stringify({ org: orgId, project: '', sql: asked.query.sql, columns: out.columns, rows: out.total, sample: (out.rows ?? []).slice(0, 5) }) })).then((r: Response) => r.json()).catch(() => null)
          return Response.json({ ...out, ...(rec?.id ? { recorded: { id: rec.id } } : {}) })
        }
        const body = JSON.stringify({ ...asked, by, ...(sub === '/warehouse/query' || sub === '/warehouse/explore' ? { grant: 'all' } : {}) })
        if (request.method === 'DELETE') return org.fetch(new Request(`http://do${sub}`, { method: 'DELETE', headers }))
        return org.fetch(new Request(`http://do${sub}`, { method: request.method, headers, body }))
      }
      // USAGE PER PERSON across the organisation's projects: what each of its people used (tokens, cache, credits), and
      // what no turn named ('unattributed'). An admin sees everyone; a member sees themselves.
      if (path === '/api/usage/people' && request.method === 'GET') {
        const q = new URL(request.url).searchParams
        const params = new URLSearchParams({ by: 'person', ...(q.get('since') ? { since: q.get('since')! } : {}), ...(q.get('until') ? { until: q.get('until')! } : {}) })
        const projects = await projectsOfOrg()
        const got = await Promise.allSettled((Array.isArray(projects) ? projects : []).map(async (pr: any) => {
          const d = await (await env.PROJECT.get(env.PROJECT.idFromName(`proj:${pr.id}`)).fetch(new Request(`http://do/usage?${params}`, { headers: { 'x-sa-project': pr.id } }))).json() as any
          return { project: { id: pr.id, name: pr.name }, people: (d?.people ?? []) as any[] }
        }))
        const N = ['calls', 'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write', 'credits_micro', 'unpriced'] as const
        const byPerson = new Map<string, any>()
        for (const r of got) {
          if (r.status !== 'fulfilled') continue
          for (const p of r.value.people) {
            const row = byPerson.get(p.person) ?? { person: p.person, ...Object.fromEntries(N.map((k) => [k, 0])), projects: [] as any[] }
            for (const k of N) row[k] += Number(p[k]) || 0
            row.projects.push({ ...r.value.project, ...Object.fromEntries(N.map((k) => [k, Number(p[k]) || 0])) })
            byPerson.set(p.person, row)
          }
        }
        const mine = `email:${oa.email}`
        const people = [...byPerson.values()].filter((p) => can(oa.caps, 'org.billing') || p.person === mine).sort((a, b) => b.credits_micro - a.credits_micro || b.tokens_in - a.tokens_in)
        return Response.json({ since: params.get('since'), until: params.get('until'), people, failed: got.filter((r) => r.status === 'rejected').length })
      }
      const doUrl = request.url.replace(/^(https?:\/\/[^/]+)\/api/, '$1')
      let doReq: Request
      if (request.method === 'GET' || request.method === 'HEAD') {
        doReq = new Request(doUrl, { method: request.method, headers: orgHeaders })
      } else {
        // Clone before reading body — DO fetch needs a fresh body
        const body = await request.clone().text()
        doReq = new Request(doUrl, { method: request.method, headers: orgHeaders, body })
      }
      return org.fetch(doReq)
    }

    // ── Any other WS ──────────────────────────────────────────────────────────
    // Same rule as /ws above: x-org-id is the client asking, not a fact. Without this, a socket to any path
    // other than /ws reached an organisation unauthenticated.
    if (isWs) {
      const orgId = request.headers.get('x-org-id') ?? 'default'
      const oa = await orgAccessOf(request, env, orgId)
      if (!oa.ok) return new Response('unauthorized', { status: 401 })
      return env.ORG.get(env.ORG.idFromName(orgId)).fetch(request)
    }

    // ── Two SPAs under prefixes (real files served by the asset layer before the
    // worker; the worker only runs on asset misses = SPA client routes) ──────────
    //   /        → user app (default)
    //   /u/*     → user app   (user-ui)
    //   /admin/* → admin app  (superadmin)
    if (path === '/') return Response.redirect(new URL('/u/', request.url).toString(), 302)
    if (path === '/admin' || path.startsWith('/admin/'))
      return env.ASSETS.fetch(new Request(new URL('/admin/index.html', request.url)))
    if (path === '/u' || path.startsWith('/u/'))
      return env.ASSETS.fetch(new Request(new URL('/u/index.html', request.url)))
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

// ── Project creation: OrgDO + ProjectDO + Fly Machine ────────────────────────

async function handleCreateProject(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const orgId = request.headers.get('x-org-id') ?? 'default'

  // provider: 'fly' (default, managed) or 'external' (local/EC2 — user runs the
  // code-engine themselves and it connects out to the hub; no Fly machine, no lifecycle).
  let reqProvider: string | undefined, reqName: string | undefined
  try { const b = await request.clone().json() as any; reqProvider = b?.provider; reqName = b?.name } catch {}
  const provider = (reqProvider === 'external' || reqProvider === 'local') ? 'external' : 'fly'

  // 1. Create project in OrgDO
  const orgRes = await env.ORG.get(env.ORG.idFromName(orgId)).fetch(
    new Request(request.url.replace(/^(https?:\/\/[^/]+)\/api/, '$1'), request)
  )
  if (!orgRes.ok) return orgRes
  const { id: projectId } = await orgRes.json() as { id: string }

  // 2. Generate API key + initialize ProjectDO (records the provider)
  const apiKey = `sk-proj-${crypto.randomUUID()}`
  const projStub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
  await projStub.fetch(new Request('http://do/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, provider, name: reqName, orgId }),   // ProjectDO is source of truth for the name; orgId says who owns it
  }))

  // External compute: no Fly machine to create. Return the connection info so the user
  // can point their local/EC2 code-engine at the hub.
  if (provider === 'external') {
    const wsUrl = `wss://${url.host}/_ws/${projectId}?key=${apiKey}`
    return Response.json({ id: projectId, apiKey, provider, wsUrl }, { status: 201 })
  }

  // 3. Check if machine already exists (idempotency)
  const statusRes = await projStub.fetch(new Request('http://do/status'))
  const status = await statusRes.json() as any
  if (status.machine?.id) {
    console.log(`[worker] machine already exists for ${projectId}, skipping creation`)
    return Response.json({ id: projectId, apiKey }, { status: 201 })
  }

  // 4. Create Fly Machine (keep Worker alive until it completes)
  ctx.waitUntil(
    createMachine(env.FLY_API_TOKEN, {
      projectId, apiKey,
      workerWsHost: url.host,
      flyOrgSlug: env.FLY_ORG_SLUG ?? 'personal',
      flyAppName: FLY_APP,
    })
      .then(m => {
        console.log(`[fly] machine created: ${m.id}`)
        return projStub.fetch(new Request('http://do/machine', {
          method: 'PUT',
          body: JSON.stringify({ machineId: m.id, status: 'running' }),
        }))
      })
      .then(() => projStub.fetch(new Request('http://do/log', {
        method: 'POST',
        body: JSON.stringify({ event: 'machine:created', detail: {} }),
      })))
      .catch(err => {
        console.error(`[fly] create failed: ${err.message}`)
        return projStub.fetch(new Request('http://do/machine', {
          method: 'PUT',
          body: JSON.stringify({ status: 'failed' }),
        }))
      })
  )

  return Response.json({ id: projectId, apiKey }, { status: 201 })
}

// ── Project mutation (delete/restore/pause): forward to OrgDO with body ────
// The generic /api/* route loses request bodies for DELETE/PUT in DO forwarding,
// so we handle them here explicitly. Also stops Fly Machine on delete.

async function handleProjectMutate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const orgId = request.headers.get('x-org-id') ?? 'default'
    const body = await request.json().catch(() => ({})) as any
    console.log(`[worker] project mutate: method=${request.method} body=`, JSON.stringify(body))

    const doUrl = request.url.replace(/^(https?:\/\/[^/]+)\/api/, '$1')
    const doReq = new Request(doUrl, {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    // On delete, stop the Fly Machine
    if (request.method === 'DELETE' && body.id && env.FLY_API_TOKEN) {
      ctx.waitUntil(
        (async () => {
          const projStub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${body.id}`))
          const statusRes = await projStub.fetch(new Request('http://do/status'))
          const status = await statusRes.json() as any
          if (status.machine?.id) {
            try { await stopMachine(env.FLY_API_TOKEN, status.machine.id, FLY_APP) } catch {}
          }
        })()
      )
    }

    return env.ORG.get(env.ORG.idFromName(orgId)).fetch(doReq)
  } catch (err: any) {
    console.error(`[worker] projectMutate error: ${err.message}`)
    return Response.json({ error: err.message }, { status: 500 })
  }
}

// ── *.superatom.site host routing ────────────────────────────────────────────

const SITE_SUFFIX = '.superatom.site'
// Names the platform answers on, or intends to. A project claiming one would shadow a service, so they are
// refused at claim time. Add to this list BEFORE shipping anything that answers on a new subdomain — the
// alternative is discovering a customer already owns the name.
const RESERVED_SUBDOMAINS = new Set([
  PROXY_SUBDOMAIN,
  'tunnel',                                            // the EC2 CONNECT proxy — DNS-only, so it never reaches
                                                       // this worker, but a project claiming the name would
                                                       // still take an address the platform depends on
  'www', 'api', 'app', 'admin', 'auth', 'login', 'account', 'accounts',
  'hub', 'ws', 'gateway', 'gw', 'cdn', 'static', 'assets', 'docs', 'status',
  'mail', 'smtp', 'ftp', 'ns1', 'ns2', 'mx',          // infrastructure names mail/DNS tooling assumes
  'superatom', 'system', 'internal', 'test', 'staging', 'dev',
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Resolve a named subdomain → projectId. Hot path: Workers KV (edge-cached,
// globally distributed). Cold miss: GlobalDO (authoritative), then warm KV.
// The DO is therefore only hit on claims + cache misses, never per page-load.
// ── Dashboards: a built React app per project ────────────────────────────────
// The bytes live in R2 under dashboard/<project>/<dashId>/<build>/, and the DO holds which build is current.
// Nothing is rewritten on the way IN — the object stays exactly what was built, so the same bundle can be
// served at any path and a rollback is a metadata change. The path fixing happens on the way out.

/** Content-Type from the extension. R2 does not infer one, and a .js served as octet-stream is refused as a
 *  module by the browser — the page then goes blank with nothing in the network tab that looks wrong. */
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8', wasm: 'application/wasm',
}
const mimeOf = (path: string) => MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

async function uploadDashboardBuild(dashId: string, projectId: string, by: string, request: Request, env: Env): Promise<Response> {
  if (!env.PACKAGES) return new Response('no bucket bound', { status: 500 })
  const form = await request.formData().catch(() => null)
  if (!form) return new Response('send the build as multipart/form-data, one part per file', { status: 400 })

  // Gather first, decide the root, then write. index.html has to end up at the TOP of what gets stored, because
  // that is the only place the serving side looks — an upload that put it one level down succeeded and then
  // 404'd on every visit, which is a miserable way to find out.
  const incoming: { rel: string; part: File }[] = []
  for (const [rawPath, part] of form.entries()) {
    if (typeof part === 'string') continue
    const rel = rawPath.replace(/^\.?\//, '').split('/').filter((p) => p && p !== '.' && p !== '..').join('/')
    if (rel) incoming.push({ rel, part: part as File })
  }
  if (!incoming.length) return new Response('nothing to upload', { status: 400 })

  // Someone drops the folder CONTAINING their build as often as the build itself. If everything sits under one
  // directory and the index is in there, that directory is the build — strip it, rather than refusing.
  let strip = ''
  if (!incoming.some((f) => f.rel === 'index.html')) {
    const tops = new Set(incoming.map((f) => f.rel.split('/')[0]))
    const only = tops.size === 1 ? [...tops][0] : ''
    if (only && incoming.some((f) => f.rel === `${only}/index.html`)) strip = `${only}/`
  }
  if (!incoming.some((f) => f.rel === (strip ? `${strip}index.html` : 'index.html')))
    return new Response('no index.html at the top of that upload — choose the build directory itself (the folder index.html is in), not its parent', { status: 400 })

  // WHAT THIS BUILD IS, before anything is written: a hash over every file's path and bytes, in path order. The
  // same build dropped twice — nobody remembers whether the last upload took — is one build, and the ledger
  // says so instead of growing a version that is not one.
  const read: Array<{ rel: string; body: ArrayBuffer }> = []
  for (const f of incoming) {
    const rel = strip && f.rel.startsWith(strip) ? f.rel.slice(strip.length) : f.rel
    if (!rel) continue
    read.push({ rel, body: await f.part.arrayBuffer() })
  }
  read.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  // Within the limits (files.ts): each file, and the build as a whole.
  const big = read.find((f) => f.body.byteLength > LIMITS.dashboardFile)
  if (big) return new Response(`${big.rel} is larger than ${LIMITS.dashboardFile / 1024 / 1024} MB — a dashboard build's files are at most that`, { status: 413 })
  const total = read.reduce((n, f) => n + f.body.byteLength, 0)
  if (total > LIMITS.dashboardBuild) return new Response(`the build is ${Math.round(total / 1024 / 1024)} MB — at most ${LIMITS.dashboardBuild / 1024 / 1024} MB`, { status: 413 })
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await new Blob(read.flatMap((f) => [f.rel, '\0', f.body, '\0'])).arrayBuffer()))
  const contentHash = [...digest].map((x) => x.toString(16).padStart(2, '0')).join('')
  const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
  const known: any = await stub.fetch(new Request(`http://do/dashboards/${encodeURIComponent(dashId)}/builds?hash=${contentHash}`)).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const same = known?.builds?.[0]
  if (same) {
    if (same.current) return Response.json({ ok: true, unchanged: true, buildId: same.build_id, version: same.n, files: same.files, bytes: same.bytes, contentHash })
    // The same build is kept as an earlier version: make it current rather than store it again.
    const r = await stub.fetch(new Request(`http://do/dashboards/${encodeURIComponent(dashId)}/current`, { method: 'PUT', body: JSON.stringify({ buildId: same.build_id, by }) }))
    if (r.ok) {
      const made: any = await r.json().catch(() => ({}))
      buildCache.set(`${projectId}/${dashId}`, { buildId: String(same.build_id), at: Date.now() })
      return Response.json({ ok: true, restored: true, buildId: same.build_id, version: made.version ?? null, restores: same.n, files: same.files, bytes: same.bytes, contentHash })
    }
  }

  const buildId = new Date().toISOString().replace(/[:.]/g, '-')
  let base: string
  try { base = fileKeys.dashboardBuild(projectId, dashId, buildId) } catch (e: any) { return new Response(e.message, { status: 400 }) }
  let files = 0, bytes = 0
  for (const f of read) {
    await env.PACKAGES.put(`${base}/${f.rel}`, f.body, { httpMetadata: { contentType: mimeOf(f.rel) } })
    files++; bytes += f.body.byteLength
  }

  // Pointed at LAST: until this line the old build is still the one being served.
  await stub.fetch(new Request(`http://do/dashboards/${encodeURIComponent(dashId)}`, {
    method: 'PUT', body: JSON.stringify({ buildId, files, bytes, by, contentHash }),
  }))
  buildCache.set(`${projectId}/${dashId}`, { buildId, at: Date.now() })   // publish takes effect here, not in 15s
  // Keep a few builds back so a rollback has somewhere to go, and let the rest go. Every publish otherwise
  // leaves its predecessor in the bucket for ever — free-ish, but unbounded, and nobody would notice until it
  // was a bill. Best-effort: a failed sweep must never fail the publish that just succeeded.
  // What the newest versions still point at stays, whichever build folder they point at; the rest goes, and the
  // ledger rows for it are marked rather than removed.
  const ledger: any = await stub.fetch(new Request(`http://do/dashboards/${encodeURIComponent(dashId)}/builds`)).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const referenced = new Set<string>([buildId, ...((ledger?.builds ?? []) as any[]).slice(0, 5).map((b) => String(b.build_id))])
  const pruned = await pruneOldBuilds(dashId, projectId, referenced, env).catch(() => [] as string[])
  for (const b of pruned) await stub.fetch(new Request(`http://do/dashboards/${encodeURIComponent(dashId)}/builds/${encodeURIComponent(b)}/pruned`, { method: 'PUT' })).catch(() => {})
  return Response.json({ ok: true, buildId, files, bytes })
}

/** Serve one file of a dashboard build.
 *
 *  Assets are content-hashed by the bundler, so the path IS the version and they can be cached hard. index.html
 *  never is, or a new build would not take effect and would look broken.
 *
 *  The HTML is rewritten as it streams: a build made with the default base refers to `/assets/x.js`, which at
 *  this URL means the site root and not the dashboard. Rewriting here rather than at upload keeps the stored
 *  object exactly what was built. */
/** Which build is current, remembered briefly.
 *
 *  A page is a document plus a dozen assets, and each one was asking the Durable Object which build to serve —
 *  on top of the access check, so a single page load cost two DO round trips per file. The answer changes only
 *  when someone publishes, so a few seconds of staleness costs nothing and a new build still appears almost at
 *  once. Per isolate, so it needs no invalidation: an isolate that never sees the update simply expires. */
const buildCache = new Map<string, { buildId: string; at: number }>()
const BUILD_TTL_MS = 15_000

async function currentBuild(dashId: string, projectId: string, env: Env): Promise<string | null> {
  const key = `${projectId}/${dashId}`
  const hit = buildCache.get(key)
  if (hit && Date.now() - hit.at < BUILD_TTL_MS) return hit.buildId
  const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
  const meta: any = await stub.fetch(new Request(`http://do/dashboards/${encodeURIComponent(dashId)}`)).then((r) => r.ok ? r.json() : null).catch(() => null)
  const buildId = meta?.build_id ? String(meta.build_id) : null
  if (buildId) buildCache.set(key, { buildId, at: Date.now() })
  return buildId
}

/** Drop all but the newest few builds. Build ids are ISO timestamps, so sorting them as strings is sorting
 *  them by time. The CURRENT one is always kept, whatever its age. */
async function pruneOldBuilds(dashId: string, projectId: string, keepBuilds: Set<string>, env: Env): Promise<string[]> {
  if (!env.PACKAGES) return []
  const prefix = `dashboard/${projectId}/${dashId}/`
  const builds = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await env.PACKAGES.list({ prefix, delimiter: '/', cursor })
    for (const p of page.delimitedPrefixes ?? []) builds.add(p.slice(prefix.length).replace(/\/$/, ''))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  const doomed = [...builds].filter((b) => b && !keepBuilds.has(b))
  for (const b of doomed) {
    let c: string | undefined
    do {
      const page = await env.PACKAGES.list({ prefix: `${prefix}${b}/`, cursor: c })
      if (page.objects.length) await env.PACKAGES.delete(page.objects.map((o) => o.key))
      c = page.truncated ? page.cursor : undefined
    } while (c)
  }
  return doomed
}

/** Remove every object of every build of one dashboard. R2 lists 1000 at a time, so it pages. */
async function deleteDashboardObjects(dashId: string, projectId: string, env: Env): Promise<void> {
  if (!env.PACKAGES) return
  const prefix = `dashboard/${projectId}/${dashId}/`
  let cursor: string | undefined
  do {
    const page = await env.PACKAGES.list({ prefix, cursor })
    if (page.objects.length) await env.PACKAGES.delete(page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  buildCache.delete(`${projectId}/${dashId}`)
}

async function serveDashboard(dashId: string, rest: string, projectId: string, request: Request, env: Env): Promise<Response> {
  if (!env.PACKAGES) return new Response('no bucket bound', { status: 500 })
  const build = await currentBuild(dashId, projectId, env)
  if (!build) return new Response('no such dashboard, or nothing published to it yet', { status: 404 })
  const meta = { build_id: build }

  const base = `dashboard/${projectId}/${dashId}/${meta.build_id}`
  const wanted = rest.replace(/^\/+/, '')
  let key = wanted && !wanted.endsWith('/') ? `${base}/${wanted}` : `${base}/index.html`
  let obj = await env.PACKAGES.get(key)
  // Unknown path → index.html, so a client-side route survives a refresh. Only for documents: a missing ASSET
  // must stay a 404, or a bad script URL silently returns HTML and the failure moves somewhere confusing.
  const isAsset = /\.[a-z0-9]+$/i.test(wanted)
  if (!obj && !isAsset) { key = `${base}/index.html`; obj = await env.PACKAGES.get(key) }
  if (!obj) return new Response('not found', { status: 404 })

  const path = key.slice(base.length + 1)
  const headers = new Headers({
    'content-type': obj.httpMetadata?.contentType ?? mimeOf(path),
    'cache-control': path.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  if (!path.endsWith('.html')) return new Response(obj.body, { headers })

  const prefix = `/dashboard/${dashId}`
  const inject = `<script>window.__PROJECT_ID__=${JSON.stringify(projectId)};window.__DASHBOARD_ID__=${JSON.stringify(dashId)};window.__HUB_URL__="wss://"+location.host</script>`
  return new HTMLRewriter()
    // Root-absolute references mean the SITE root; here they must mean the dashboard's root.
    .on('script[src], link[href], img[src], source[src], use[href]', {
      element(e) {
        const attr = e.hasAttribute('src') ? 'src' : 'href'
        const v = e.getAttribute(attr)
        if (v && v.startsWith('/') && !v.startsWith('//')) e.setAttribute(attr, prefix + v)
      },
    })
    // <base> catches what the rewriter cannot see: a URL built at runtime by the app itself.
    .on('head', { element(e) { e.prepend(`<base href="${prefix}/">`, { html: true }); e.append(inject, { html: true }) } })
    .transform(new Response(obj.body, { headers }))
}

/** The only place a dashboard is let through.
 *
 *  This is where the session COOKIE earns its keep: a browser navigating here sends no Authorization header, so
 *  a header-only check could never protect a document — which is why the SPA shells are public. Every request
 *  for a dashboard, the page and each asset alike, passes the same projectAccessOf() the API uses.
 *
 *  Enforced HERE and nowhere else, deliberately: existing routes keep authenticating exactly as they did, so
 *  turning this on cannot change how anything that already works behaves.
 *
 *  A missing session redirects to the app rather than showing a bare 401 — the person is not signed in yet, and
 *  the app knows how to fix that; ?next= brings them back. Assets do not redirect: an HTML login page arriving
 *  where a script was expected is a worse failure than an honest 401. */
async function gateDashboard(dashId: string, rest: string, projectId: string, request: Request, env: Env): Promise<Response> {
  const acc = await projectAccessOf(request, env, projectId)
  if (!acc.ok) {
    if (/\.[a-z0-9]+$/i.test(rest)) return new Response('unauthorized', { status: 401 })
    const back = encodeURIComponent(new URL(request.url).pathname)
    return Response.redirect(new URL(`/u/?next=${back}`, request.url).toString(), 302)
  }
  return serveDashboard(dashId, rest, projectId, request, env)
}

async function resolveSubdomain(sub: string, env: Env): Promise<string | null> {
  if (env.DOMAINS) {
    const cached = await env.DOMAINS.get(`dom:${sub}`)
    if (cached) return cached
  }
  const stub = env.GLOBAL.get(env.GLOBAL.idFromName('global'))
  const r = await stub.fetch(new Request(`http://do/domains/resolve?subdomain=${encodeURIComponent(sub)}`))
  if (!r.ok) return null
  const { projectId } = await r.json() as { projectId?: string }
  if (projectId && env.DOMAINS) await env.DOMAINS.put(`dom:${sub}`, projectId, { expirationTtl: 3600 })
  return projectId ?? null
}

// Serve the user SPA, injecting the resolved projectId + hub URL into <head> so the
// frontend learns its identity synchronously — no header round-trip, no ?project=.
async function serveUserApp(request: Request, env: Env, projectId: string | null): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL('/u/index.html', request.url)))
  if (!projectId) return new Response(res.body, res)
  const inject = `<script>window.__PROJECT_ID__=${JSON.stringify(projectId)};window.__HUB_URL__="wss://"+location.host</script>`
  return new HTMLRewriter()
    .on('head', { element(e) { e.append(inject, { html: true }) } })
    .transform(res)
}

async function handleSiteRequest(host: string, request: Request, env: Env): Promise<Response> {
  const label = host === 'superatom.site' ? '' : host.slice(0, -SITE_SUFFIX.length)
  const sub = label.split('.')[0].toLowerCase()

  // TWO admin hosts, and the difference is who they are for:
  //   superadmin.superatom.site — the platform console. Only the hard-coded address in auth/tokens.ts gets
  //                               anything back from its API; the app is served to anyone, and is useless to them.
  //   admin.superatom.site      — the customer console. /org/<orgId> and /pro/<projectId> say what is being
  //                               looked at, so no slug registry and no org-vs-project guessing. Bare / lands
  //                               on the org the signed-in person belongs to.
  // Both are the same SPA (built with base /admin/); it renders per scope, and the API decides what it may have.
  if (sub === 'superadmin' || sub === 'admin') {
    const p = new URL(request.url).pathname
    // Built assets live under /admin/ and are fetched by absolute path, so they resolve wherever the page sits.
    if (p.startsWith('/admin/assets/') || p.startsWith('/assets/')) return env.ASSETS.fetch(request)
    // Every other path is an SPA route — /org/<id>, /pro/<id>, or / — and gets the same document. Bare / is not
    // redirected here: the server does not know which org this person belongs to, and the app does as soon as it
    // has their token, so it navigates itself rather than us guessing.
    return env.ASSETS.fetch(new Request(new URL('/admin/index.html', request.url)))
  }

  // apex / www → path-routed: /admin/* is the admin SPA (served on the apex, not just admin.*); everything
  // else is the user app with no project selected (CloudGate prompts for one).
  if (!sub || sub === 'www') {
    const p = new URL(request.url).pathname
    if (p === '/admin' || p.startsWith('/admin/'))
      return env.ASSETS.fetch(new Request(new URL('/admin/index.html', request.url)))
    return serveUserApp(request, env, null)
  }

  // <projectid>.superatom.site → projectId straight from the label (no lookup)
  const pathname = new URL(request.url).pathname
  const dash = pathname.match(/^\/dashboard\/([^/]+)(\/.*)?$/)

  if (UUID_RE.test(sub))
    return dash ? gateDashboard(dash[1], dash[2] ?? '', sub, request, env) : serveUserApp(request, env, sub)

  // <subdomain>.superatom.site → resolve via KV → GlobalDO
  const projectId = await resolveSubdomain(sub, env)
  if (dash && projectId) return gateDashboard(dash[1], dash[2] ?? '', projectId, request, env)
  return serveUserApp(request, env, projectId)   // null → "no project" screen
}

// Domains registry API → GlobalDO, keeping KV (the hot-read cache) in sync on writes.
async function handleDomainsApi(request: Request, env: Env, url: URL): Promise<Response> {
  const doUrl = request.url.replace(/^(https?:\/\/[^/]+)\/api/, '$1')
  const method = request.method
  let body: any = undefined
  if (method !== 'GET' && method !== 'HEAD') body = await request.clone().text()
  const doReq = new Request(doUrl, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body } : {}),
  })
  const res = await env.GLOBAL.get(env.GLOBAL.idFromName('global')).fetch(doReq)

  // Keep KV warm so reads never need the DO. (Claims/releases are rare.)
  if (env.DOMAINS && res.ok && body) {
    try {
      const parsed = JSON.parse(body)
      const sub = (parsed.subdomain ?? '').toLowerCase().trim()
      if (sub && url.pathname === '/api/domains/claim') {
        const out = await res.clone().json() as any
        if (out.ok && out.subdomain) await env.DOMAINS.put(`dom:${out.subdomain}`, parsed.projectId, { expirationTtl: 3600 })
      } else if (sub && method === 'DELETE') {
        await env.DOMAINS.delete(`dom:${sub}`)
      }
    } catch {}
  }
  return res
}

// ── Credentials admin ────────────────────────────────────────────────────────
// The superadmin's view of the credential pool. Everything here is about WHICH key is used and by WHOM; the
// values live in Worker secrets and are only ever reported as present or missing.
async function handleCredentialsAdmin(request: Request, env: Env, path: string): Promise<Response> {
  const kv: any = (env as any).CREDENTIALS
  if (!kv) return Response.json({ error: 'no CREDENTIALS KV bound' }, { status: 503 })
  const master = (env as any).CREDENTIALS_MASTER_KEY
  const { readVault, writeVault, redact, tidy, expiryOf, expiring } = await import('./proxy/vault.js')
  const { readUsage, askUsage, writeUsage, canAsk } = await import('./proxy/usage.js')
  const { UPSTREAMS } = await import('../../../vm/packages/agent-contract/contract.mjs')

  // GET /api/credentials — the whole picture, values removed. One read, one decrypt.
  if (request.method === 'GET' && path === '/api/credentials') {
    const v = await readVault(kv, master)
    const r = redact(v)
    // One read per entry, in parallel — usage lives in its OWN key per credential so nothing can clobber
    // anything else, which is the whole reason it is not in the vault document.
    const usage = await Promise.all(r.entries.map((e: any) => readUsage(kv, e.id)))
    r.entries.forEach((e: any, i: number) => { e.usage = usage[i]; e.canAskUsage = canAsk(e.provider) })
    // Warnings first, because the thing an operator needs to see is what is about to stop working.
    return Response.json({ ...r, providers: Object.keys(UPSTREAMS), sealed: !!master, expiring: expiring(v, 3) })
  }

  // Everything below is read-modify-write on the one document, so each change is atomic and there is never a
  // moment where a credential exists without the policy that governs it.
  if (request.method === 'POST' && path === '/api/credentials/entry') {
    const b = await request.json().catch(() => ({})) as any
    if (!b?.id || !b?.provider || !b?.value) return Response.json({ error: 'body: { id, provider, value, groups?, note? }' }, { status: 400 })
    if (!Object.keys(UPSTREAMS).includes(b.provider)) return Response.json({ error: `no provider named ${b.provider}` }, { status: 400 })
    const v = tidy(await readVault(kv, master))
    // Expiry is READ from the credential, not asked for: a JWT says when it dies, and a field someone types
    // is a field someone forgets to update. `expiresAt` in the body is honoured only for credentials that
    // cannot tell us themselves.
    const entry = { id: String(b.id), provider: String(b.provider), value: String(b.value),
                    groups: Array.isArray(b.groups) ? b.groups : undefined, note: b.note,
                    disabled: b.disabled === true || undefined,
                    addedAt: new Date().toISOString(),
                    expiresAt: expiryOf(String(b.value)) ?? (typeof b.expiresAt === 'number' ? b.expiresAt : undefined) }
    const next = { ...v, entries: [...v.entries.filter((e) => e.id !== entry.id), entry] }
    await writeVault(kv, next, master)
    return Response.json(redact(next))
  }

  const mEntry = /^\/api\/credentials\/entry\/(.+)$/.exec(path)
  if (request.method === 'DELETE' && mEntry) {
    const v = await readVault(kv, master)
    const next = { ...v, entries: v.entries.filter((e) => e.id !== mEntry[1]) }
    await writeVault(kv, next, master)
    return Response.json(redact(next))
  }

  if (request.method === 'POST' && path === '/api/credentials/group') {
    const b = await request.json().catch(() => ({})) as any
    if (!b?.projectId || !b?.group) return Response.json({ error: 'body: { projectId, group }' }, { status: 400 })
    const v = await readVault(kv, master)
    const next = { ...v, groups: { ...v.groups, [b.projectId]: String(b.group) } }
    await writeVault(kv, next, master)
    return Response.json(redact(next))
  }

  // POST /api/credentials/refresh — ask every provider that can tell us how much is left, and store the
  // ABSOLUTE answer per credential. Nothing is accumulated here, so two of these running at once cannot lose
  // each other's work: they write the same observed truth, and the later one is the better one.
  if (request.method === 'POST' && path === '/api/credentials/refresh') {
    const v = await readVault(kv, master)
    const asked = await Promise.all(v.entries.map(async (e) => {
      if (!canAsk(e.provider)) return { id: e.id, skipped: 'provider cannot tell us' }
      const snap = await askUsage(e.provider, e.value)
      if (snap) await writeUsage(kv, e.id, snap)
      return { id: e.id, provider: e.provider, ...(snap?.error ? { error: snap.error } : { percentUsed: snap?.percentUsed, remaining: snap?.remaining }) }
    }))
    return Response.json({ refreshed: asked })
  }

  // GET /api/credentials/audit?project=… — who was handed what. Read from one key per event, so nothing was
  // lost to a concurrent write and the trail can be trusted.
  if (request.method === 'GET' && path === '/api/credentials/audit') {
    const project = new URL(request.url).searchParams.get('project') ?? ''
    const prefix = project ? `audit:${project}:` : 'audit:'
    const keys = (await kv.list({ prefix })).keys.slice(-200)
    const events = await Promise.all(keys.map((k: any) => kv.get(k.name, 'json')))
    return Response.json({ events: events.filter(Boolean).sort((a: any, b: any) => b.at - a.at) })
  }

  // POST /api/credentials/enable/<id> — { enabled: boolean }. Park a credential without losing it.
  const mEnable = /^\/api\/credentials\/enable\/(.+)$/.exec(path)
  if (request.method === 'POST' && mEnable) {
    const b = await request.json().catch(() => ({})) as any
    const v = await readVault(kv, master)
    const next = { ...v, entries: v.entries.map((e) => e.id === mEnable[1] ? { ...e, disabled: b?.enabled === false } : e) }
    await writeVault(kv, next, master)
    return Response.json(redact(next))
  }

  // Put a key back in service by hand, when you know it reset before its cooldown expired.
  const mRevive = /^\/api\/credentials\/revive\/(.+)$/.exec(path)
  if (request.method === 'POST' && mRevive) {
    const v = await readVault(kv, master)
    const spent = { ...(v.spent ?? {}) }; delete spent[mRevive[1]]
    const next = { ...v, spent }
    await writeVault(kv, next, master)
    return Response.json(redact(next))
  }

  return new Response('not found', { status: 404 })
}

// ── Machine details: proxy from Fly API ──────────────────────────────────────

// ONE generalized project status — the frontend polls only this. The DO supplies the
// base (provider, connections, heartbeat, idle); the worker enriches `machine` per
// provider (live Fly state for managed, hub-connection liveness for local/EC2).
async function handleProjectStatus(projectId: string, env: Env): Promise<Response> {
  const projStub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
  const s = await (await projStub.fetch(new Request('http://do/status'))).json() as any
  const provider: string = s.provider ?? s.machine?.provider ?? 'fly'
  const connections = s.connections ?? []
  const machine: any = { provider, lastHeartbeat: s.machine?.lastHeartbeat ?? null, idlePhase: s.machine?.idlePhase ?? null, idleMin: s.machine?.idleMin ?? null }

  if (provider === 'external') {
    // local/EC2: online == the code-engine is connected to the hub. No Fly call.
    machine.state  = connections.some((c: any) => c.type === 'code-engine') ? 'online' : 'offline'
    machine.region = 'local / EC2'
  } else if (s.machine?.id && env.FLY_API_TOKEN) {
    // managed Fly: enrich with the live Fly machine state.
    try {
      const flyRes = await fetch(`https://api.machines.dev/v1/apps/${FLY_APP}/machines/${s.machine.id}`,
        { headers: { Authorization: `Bearer ${env.FLY_API_TOKEN}` } })
      if (flyRes.ok) {
        const fm = await flyRes.json() as any
        machine.id = fm.id; machine.state = fm.state; machine.region = fm.region
        machine.cpus = fm.config?.guest?.cpus; machine.memoryMb = fm.config?.guest?.memory_mb
        machine.diskGb = fm.config?.mounts?.[0]?.size_gb; machine.image = fm.config?.image
      } else machine.state = s.machine.status ?? 'unknown'
    } catch { machine.state = s.machine.status ?? 'unknown' }
  } else {
    machine.state = s.machine?.status ?? 'creating'   // Fly machine not created yet
  }

  // Pass through what the project knows about itself — its name, and which org owns it. The admin console needs
  // the org to route an assignment (only the org grants access), and /pro/<id> has no org in the URL.
  return Response.json({ provider, machine, connections, name: s.name ?? null, orgId: s.orgId ?? null })
}