// Superadmin worker
//
// Routing:
//   /_ws/{projectId}  → ProjectDO  (WS hub: code-engine + users)
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
// The channel-agnostic messaging module (Teams/Slack/… adapters) — imported, never inlined.
import { channelAdapter } from '../../../clients/messaging/index.js'
// Speech-to-text for voice clients (mobile). A SELF-CONTAINED module in src/transcription/ —
// this import and the /api/transcribe route below are its ONLY touchpoints in the worker.
import { handleTranscribe } from './transcription/index.js'
import { createMachine, stopMachine } from './fly.js'
// Auth: token primitives + Clerk→platform-token mint (./auth/tokens.ts) and the mobile browser-redirect
// device flow (./auth/mobile.ts). worker.ts only routes to these; the rules live in the module.
import { verifyJwt, signJwt, mintPlatformTokenFromClerk, type JwtClaims } from './auth/tokens.js'
import { mobileAuthPage, handleMobileCode, handleMobileExchange, handleMeProjects } from './auth/mobile.js'

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

async function claimsOf(request: Request, env: Env): Promise<JwtClaims | null> {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  return m ? await verifyJwt(m[1], env.JWT_SECRET) : null
}

/** The caller's standing in ONE project: superadmin / org admin / its own access row / nothing. */
async function projectAccessOf(request: Request, env: Env, projectId: string):
    Promise<{ ok: boolean; level: 'superadmin' | 'org-admin' | 'member' | 'none'; email: string; roleId?: string; permissions?: string[] }> {
  const claims = await claimsOf(request, env)
  const email = (claims?.email || '').toLowerCase()
  if (!claims) return { ok: false, level: 'none', email: '' }
  if (claims.role === 'superadmin') return { ok: true, level: 'superadmin', email }

  // Org admin? The project tells us which org owns it; that org's user list says whether this person runs it.
  const proj = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
  const info: any = await proj.fetch('https://do/status').then(r => r.json()).catch(() => ({}))
  const orgId = info?.project?.orgId ?? info?.orgId
  if (orgId && email) {
    const org = env.ORG.get(env.ORG.idFromName(orgId))
    const users: any = await org.fetch('https://do/users').then(r => r.json()).catch(() => ({}))
    const me = (users?.users ?? users ?? []).find?.((u: any) => String(u.email || '').toLowerCase() === email)
    if (me && me.role === 'admin') return { ok: true, level: 'org-admin', email }
  }

  // Otherwise: does this project itself grant them anything?
  if (email) {
    const acc: any = await proj.fetch('https://do/access').then(r => r.json()).catch(() => ({}))
    const row = (acc?.access ?? []).find((a: any) => String(a.email || '').toLowerCase() === email)
    if (row) return { ok: true, level: 'member', email, roleId: row.role_id, permissions: row.permissions ?? [] }
  }
  return { ok: false, level: 'none', email }
}

/** The caller's standing in ONE org: superadmin, its admin, or a member of at least one of its projects. */
async function orgAccessOf(request: Request, env: Env, orgId: string):
    Promise<{ ok: boolean; level: 'superadmin' | 'org-admin' | 'member' | 'none'; email: string }> {
  const claims = await claimsOf(request, env)
  const email = (claims?.email || '').toLowerCase()
  if (!claims) return { ok: false, level: 'none', email: '' }
  if (claims.role === 'superadmin') return { ok: true, level: 'superadmin', email }
  if (!email) return { ok: false, level: 'none', email }
  const org = env.ORG.get(env.ORG.idFromName(orgId))
  const users: any = await org.fetch('https://do/users').then(r => r.json()).catch(() => ({}))
  const me = (users?.users ?? users ?? []).find?.((u: any) => String(u.email || '').toLowerCase() === email)
  if (me?.role === 'admin') return { ok: true, level: 'org-admin', email }
  if (me) return { ok: true, level: 'member', email }
  return { ok: false, level: 'none', email }
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
      if (!key && !token) return new Response('authentication required', { status: 401 })
      const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${wsMatch[1]}`))
      return stub.fetch(request)
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
        if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
        return chan.fetch('https://do/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: await request.text() })
      }

      // Read-only connection status for the admin UI (masked ids + secret-present flag; never the secret). Superadmin only.
      if (hook === 'status') {
        if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
        return chan.fetch('https://do/status', { method: 'GET' })
      }

      // TEST-ONLY: run one engine turn and return the answer (no channel reply). The
      // service token goes in the body (it IS the credential), so this proves the
      // ChannelDO↔hub↔engine loop in Cloudflare without any Azure/Teams setup.
      if (hook === 'selftest') {
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

    const projMatch = path.match(/^\/api\/projects\/([^/]+)\/(.+)/)
    if (projMatch) {
      const projectId = projMatch[1]
      const subPath   = projMatch[2]
      // Who is asking, and what may they do HERE? Superadmin and the owning org's admin get the provisioning
      // surface; a project member gets read-only. Enforced at this boundary, so hiding a button in the SPA is
      // never what protects anything.
      const acc = await projectAccessOf(request, env, projectId)
      if (!acc.ok) return new Response('unauthorized', { status: 401 })
      // Anything that changes the project — machine lifecycle, access, roles, datasources, keys, tokens — is for
      // whoever administers it. A member may look, not provision.
      const PROVISIONING = /^(machine|service-token|access|roles|datasources|members|verify-conn|info|fly|suspend|resume|stop|delete)/
      const isProvisioning = request.method !== 'GET' || PROVISIONING.test(subPath)
      if (isProvisioning && acc.level === 'member') return new Response('forbidden', { status: 403 })
      // `setup` overwrites the project's API key. It's an INTERNAL provisioning primitive — only ever
      // called by handleCreateProject via a direct DO stub — so it must not be reachable publicly.
      if (subPath === 'setup') return new Response('not found', { status: 404 })
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
        const mr = await stub.fetch(new Request('http://do/members', {
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
      const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
      return stub.fetch(new Request(
        `http://do/${subPath}${url.search}`, request
      ))
    }

    // ── Auth: exchange Clerk session for our JWT ─────────────────────────────
    if (request.method === 'POST' && path === '/api/auth/token') {
      return handleTokenExchange(request, env)
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

    // ── Project creation (with Fly Machine provisioning) ────────────────────
    if (request.method === 'POST' && path === '/api/projects') {
      if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
      return handleCreateProject(request, env, url, ctx)
    }

    // ── Project deletion / restore (body-forwarding for DO) ─────────────────
    if ((request.method === 'DELETE' || request.method === 'PUT') && path === '/api/projects') {
      if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })
      return handleProjectMutate(request, env, ctx)
    }

    // ── Domains API (subdomain → projectId registry; forwarded to GlobalDO) ──
    if (path.startsWith('/api/domains')) {
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
    if (path.startsWith('/api/') || (isWs && path === '/ws')) {
      const orgId = request.headers.get('x-org-id') ?? 'default'
      // x-org-id comes from the CLIENT, so it is a request, not a fact: without this check anyone could name any
      // org and read or mutate it. Membership decides. Changing an org (users, assignments, projects) is for its
      // admin; a plain member may read.
      const oa = await orgAccessOf(request, env, orgId)
      if (!oa.ok) return new Response('unauthorized', { status: 401 })
      if (request.method !== 'GET' && oa.level === 'member') return new Response('forbidden', { status: 403 })
      const doUrl = request.url.replace(/^(https?:\/\/[^/]+)\/api/, '$1')
      let doReq: Request
      if (request.method === 'GET' || request.method === 'HEAD') {
        doReq = new Request(doUrl, { method: request.method, headers: request.headers })
      } else {
        // Clone before reading body — DO fetch needs a fresh body
        const body = await request.clone().text()
        doReq = new Request(doUrl, {
          method: request.method,
          headers: { 'content-type': 'application/json' },
          body,
        })
      }
      return env.ORG.get(env.ORG.idFromName(orgId)).fetch(doReq)
    }

    // ── Any other WS ──────────────────────────────────────────────────────────
    if (isWs) {
      const orgId = request.headers.get('x-org-id') ?? 'default'
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
    body: JSON.stringify({ apiKey, provider, name: reqName }),   // ProjectDO is source of truth for the name
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
      flyAppName: 'superatom-code-engine-vm',
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
            try { await stopMachine(env.FLY_API_TOKEN, status.machine.id, 'superatom-code-engine-vm') } catch {}
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Resolve a named subdomain → projectId. Hot path: Workers KV (edge-cached,
// globally distributed). Cold miss: GlobalDO (authoritative), then warm KV.
// The DO is therefore only hit on claims + cache misses, never per page-load.
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
  if (UUID_RE.test(sub)) return serveUserApp(request, env, sub)

  // <subdomain>.superatom.site → resolve via KV → GlobalDO
  const projectId = await resolveSubdomain(sub, env)
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
      const flyRes = await fetch(`https://api.machines.dev/v1/apps/superatom-code-engine-vm/machines/${s.machine.id}`,
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

  return Response.json({ provider, machine, connections })
}