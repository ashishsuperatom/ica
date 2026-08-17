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
import { createMachine, stopMachine } from './fly.js'

// ── JWT helpers (Web Crypto, no dependencies) ───────────────────────────────

function b64url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return atob(s)
}

const encoder = new TextEncoder()

interface JwtClaims {
  userId: string
  role?: string
  exp: number
}

async function signJwt(payload: JwtClaims, secret: string): Promise<string> {
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body   = b64url(encoder.encode(JSON.stringify(payload)))
  const input  = `${header}.${body}`
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input)))
  return `${input}.${b64url(sig)}`
}

async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  )
  const sigBytes = Uint8Array.from(b64urlDecode(sig), c => c.charCodeAt(0))
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(`${header}.${body}`))
  if (!ok) return null
  try {
    const claims = JSON.parse(b64urlDecode(body)) as JwtClaims
    if (claims.exp && claims.exp * 1000 < Date.now()) return null
    return claims
  } catch { return null }
}

// Admin/provisioning routes require a valid superadmin JWT (issued by /api/auth/token). The admin
// SPA sends it as `Authorization: Bearer <jwt>`. Returns the claims, or null if missing/invalid —
// closing the hole where these routes forwarded to the DO with NO auth at all.
async function requireSuperadmin(request: Request, env: Env): Promise<JwtClaims | null> {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const claims = await verifyJwt(m[1], env.JWT_SECRET)
  return claims && claims.role === 'superadmin' ? claims : null
}

// ── Token exchange: Clerk session → our JWT ─────────────────────────────────
// Strategy: decode the Clerk JWT to extract the session id, then validate the
// session against Clerk's REST API. If Clerk says it's valid, we trust it and
// issue our own JWT. No external verification libraries needed.

async function handleTokenExchange(request: Request, env: Env): Promise<Response> {
  try {
    const { clerkToken } = await request.json() as { clerkToken?: string }
    if (!clerkToken) {
      return Response.json({ error: 'missing clerkToken' }, { status: 400 })
    }

    // Decode the Clerk JWT to extract session id (safe — Clerk API re-validates)
    const parts = clerkToken.split('.')
    if (parts.length !== 3) {
      return Response.json({ error: 'malformed token' }, { status: 400 })
    }
    const payload = JSON.parse(b64urlDecode(parts[1]))
    const sid = payload.sid
    if (!sid) {
      return Response.json({ error: 'no session id in token' }, { status: 400 })
    }

    // Validate session against Clerk's REST API
    const clerkRes = await fetch(`https://api.clerk.com/v1/sessions/${sid}`, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    })
    if (!clerkRes.ok) {
      console.error(`[auth] Clerk session lookup failed (${clerkRes.status})`)
      return Response.json({ error: 'invalid session' }, { status: 401 })
    }
    const session = await clerkRes.json() as any
    if (session.status !== 'active') {
      return Response.json({ error: 'session not active' }, { status: 401 })
    }

    const userId = session.user_id
    if (!userId) {
      return Response.json({ error: 'no user in session' }, { status: 401 })
    }

    // Issue our JWT (30-day expiry)
    const token = await signJwt({
      userId,
      role: 'superadmin',
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    }, env.JWT_SECRET)

    console.log(`[auth] issued token for user ${userId}`)
    return Response.json({ token, userId })
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
    // Only document/SPA requests are host-routed here; /_ws/* and /api/* on .site
    // share this same worker and fall through to the normal handlers below, so the
    // browser connects to wss://<same-host>/_ws/<projectId> with nothing hardcoded.
    // (superatom.site / superatom.ai are untouched — different host, skipped.)
    if ((url.hostname === 'superatom.site' || url.hostname.endsWith(SITE_SUFFIX)) &&
        !path.startsWith('/_ws/') && !path.startsWith('/api/') && !isWs) {
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
    const projMatch = path.match(/^\/api\/projects\/([^/]+)\/(.+)/)
    if (projMatch) {
      // Admin/provisioning surface — require a valid superadmin JWT (the admin SPA sends it as
      // `Authorization: Bearer <jwt>`). Previously these forwarded to the DO with NO auth, so anyone
      // could reset a project's API key via /setup, add members, mutate the machine, etc.
      if (!(await requireSuperadmin(request, env))) return new Response('unauthorized', { status: 401 })

      const projectId = projMatch[1]
      const subPath   = projMatch[2]
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
        const wsUrl = `wss://${new URL(request.url).host}`
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
    if (path.startsWith('/api/organizations')) {
      const stub = env.GLOBAL.get(env.GLOBAL.idFromName('global'))
      return stub.fetch(new Request(
        request.url.replace(/^(https?:\/\/[^/]+)\/api/, '$1'), request
      ))
    }

    // ── Org routes (admin WS + REST API) ──────────────────────────────────────
    if (path.startsWith('/api/') || (isWs && path === '/ws')) {
      const orgId = request.headers.get('x-org-id') ?? 'default'
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

  // admin.superatom.site → admin SPA. The admin app is built with base /admin/ (router
  // basename /admin), so the root path renders nothing — redirect / to /admin/. Real
  // assets under /admin/* are served by the asset layer before us; deeper SPA routes
  // fall back to the admin index.
  if (sub === 'admin') {
    const p = new URL(request.url).pathname
    if (!p.startsWith('/admin')) return Response.redirect(new URL('/admin/', request.url).toString(), 302)
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