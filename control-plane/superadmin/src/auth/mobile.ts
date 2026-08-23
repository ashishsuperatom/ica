// Mobile (and any non-browser client) login — the browser-redirect device flow. See clients/ios/AUTH-HANDOFF.md.
//
//   app ──ASWebAuthenticationSession──▶ GET  /mobile/auth?code_challenge&redirect_uri   (Clerk sign-in page)
//       ◀──redirect──────────────────  superatom://auth?code=<one-time>
//   app ──HTTPS──────────────────────▶ POST /api/auth/mobile/exchange { code, code_verifier }
//       ◀────────────────────────────  { token, userId, role }
//   app ──HTTPS──────────────────────▶ GET  /api/me/projects  (Bearer)
//
// OAuth 2.0 authorization-code-for-native-apps (RFC 8252): the token never rides the redirect (only a
// single-use, 60s, PKCE-bound code does), so an intercepted redirect is worthless without the verifier.
// Fully additive — nothing existing changes. This module owns the flow; the worker only routes to it.

import { mintPlatformTokenFromClerk, verifyJwt, b64url } from './tokens.js'

const CODE_TTL_MS = 60_000
const ALLOWED_REDIRECTS = new Set(['superatom://auth'])   // allow-list: never reflect an arbitrary scheme (open-redirect → code theft)
const global = (env: Env) => env.GLOBAL.get(env.GLOBAL.idFromName('global'))

// Clerk's frontend API host is encoded in the publishable key: pk_test_<base64("<host>$")>.
function clerkFrontendApi(pk: string): string {
  try { return atob(pk.split('_').slice(2).join('_')).replace(/\$+$/, '') } catch { return '' }
}

// ── GET /mobile/auth ────────────────────────────────────────────────────────
// Minimal page: if the browser already has a Clerk session (the whole point — you're signed in at /u), it
// silently exchanges and redirects back to the app; otherwise it mounts Clerk sign-in. PKCE challenge +
// redirect_uri come from the app's query (redirect is allow-listed).
export function mobileAuthPage(env: Env): Response {
  const pk = env.CLERK_PUBLISHABLE_KEY || ''
  const fapi = clerkFrontendApi(pk)
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Superatom</title>
<style>
  html,body{height:100%;margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f3f1ec;color:#3a352f}
  .wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px}
  #status{color:#8a8276}
  #signin{width:100%;max-width:400px}
</style></head>
<body><div class="wrap"><div id="status">Signing you in…</div><div id="signin"></div></div>
<script async crossorigin="anonymous" data-clerk-publishable-key="${pk}"
  src="https://${fapi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>
<script>
  const q = new URLSearchParams(location.search);
  const challenge = q.get('code_challenge');
  const redirectUri = q.get('redirect_uri') || 'superatom://auth';
  const ALLOWED = ${JSON.stringify([...ALLOWED_REDIRECTS])};
  const setStatus = (t) => { document.getElementById('status').textContent = t; };
  async function finish() {
    if (!challenge) return setStatus('Missing PKCE challenge.');
    if (!ALLOWED.includes(redirectUri)) return setStatus('Unrecognized redirect.');
    try {
      const clerkToken = await window.Clerk.session.getToken();
      const r = await fetch('/api/auth/mobile/code', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ clerkToken, code_challenge: challenge }) });
      if (!r.ok) return setStatus('Sign-in failed. Please try again.');
      const { code } = await r.json();
      location.replace(redirectUri + '?code=' + encodeURIComponent(code));
    } catch (e) { setStatus('Error: ' + (e && e.message || e)); }
  }
  window.addEventListener('load', async () => {
    try {
      await window.Clerk.load();
      if (window.Clerk.session) return finish();
      setStatus('Please sign in');
      window.Clerk.mountSignIn(document.getElementById('signin'), { afterSignInUrl: location.href, afterSignUpUrl: location.href });
    } catch (e) { setStatus('Could not load sign-in.'); }
  });
</script></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

// ── POST /api/auth/mobile/code ──────────────────────────────────────────────
// { clerkToken, code_challenge } → { code, expiresIn }. Mints the platform token (shared rules), then hands
// out a single-use PKCE-bound code stored in the strongly-consistent GlobalDO.
export async function handleMobileCode(request: Request, env: Env): Promise<Response> {
  let body: any
  try { body = await request.json() } catch { return Response.json({ error: 'invalid request' }, { status: 400 }) }
  const challenge = String(body?.code_challenge || '')
  if (!challenge) return Response.json({ error: 'missing code_challenge (PKCE required)' }, { status: 400 })
  const minted = await mintPlatformTokenFromClerk(body?.clerkToken, env)
  if (!minted.ok) return Response.json({ error: minted.error }, { status: minted.status })
  const code = b64url(crypto.getRandomValues(new Uint8Array(24)))   // 192-bit, single-use
  const res = await global(env).fetch(new Request('http://do/mobile-code', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, token: minted.token, userId: minted.userId, role: minted.role, codeChallenge: challenge, expiresAt: Date.now() + CODE_TTL_MS }),
  }))
  if (!res.ok) return Response.json({ error: 'could not issue code' }, { status: 502 })
  return Response.json({ code, expiresIn: CODE_TTL_MS / 1000 })
}

// ── POST /api/auth/mobile/exchange ──────────────────────────────────────────
// { code, code_verifier } → { token, userId, role }. Single-use; identical 401 for missing/expired/claimed/bad
// verifier so the endpoint can't be probed.
export async function handleMobileExchange(request: Request, env: Env): Promise<Response> {
  let body: any
  try { body = await request.json() } catch { return new Response('unauthorized', { status: 401 }) }
  const res = await global(env).fetch(new Request('http://do/mobile-code/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(body?.code || ''), codeVerifier: String(body?.code_verifier || '') }),
  }))
  if (!res.ok) return new Response('unauthorized', { status: 401 })
  const { token, userId, role } = await res.json() as any
  return Response.json({ token, userId, role })
}

// ── GET /api/me/projects ────────────────────────────────────────────────────
// Bearer platform JWT → the orgs + projects this identity may reach. Org membership is the gate for now
// (project-level grants land with docs/identity-and-access.md). Superadmin sees every org.
export async function handleMeProjects(request: Request, env: Env): Promise<Response> {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return new Response('unauthorized', { status: 401 })
  const claims = await verifyJwt(m[1], env.JWT_SECRET)
  if (!claims) return new Response('unauthorized', { status: 401 })
  const isSuper = claims.role === 'superadmin'
  const clerkUserId = claims.userId   // handleTokenExchange signs the Clerk user id as userId

  const g = global(env)
  const orgsRes = await g.fetch(new Request('http://do/organizations'))
  const orgs = orgsRes.ok ? (await orgsRes.json() as any[]) : []

  const out: any[] = []
  for (const org of orgs) {
    const orgStub = env.ORG.get(env.ORG.idFromName(org.id))
    if (!isSuper) {
      // Member of this org? 404 = no.
      const mr = await orgStub.fetch(new Request('http://do/user-by-clerk-id', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clerkUserId }),
      }))
      if (!mr.ok) continue
    }
    const pr = await orgStub.fetch(new Request('http://do/projects'))
    const projects = pr.ok ? (await pr.json() as any[]) : []
    out.push({
      org: { id: org.id, name: org.name },
      projects: projects.map((p: any) => ({ id: p.id, name: p.name, subdomain: p.subdomain })),
    })
  }
  return Response.json(out)
}
