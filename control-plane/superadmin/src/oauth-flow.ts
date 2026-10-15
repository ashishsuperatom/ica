// ── OAuth sign-in for a connection read with each person's own account (docs/connectors-plan.md R6) ──────────────────
//
// The project hands the browser a ticket (signed with the platform's secret: who, which project and connection, the
// provider and scopes, a nonce, until when). /api/oauth/begin sets a cookie with the nonce — binding this browser to the
// sign-in — and sends the person to the provider with the ticket as the state; /api/oauth/callback checks the state's
// signature, its time and the cookie (a link someone else started is refused here), exchanges the code with the
// organisation's own app, and gives the tokens to the project, which keeps them sealed in the person's UserDO.

import { OAUTH_PROVIDERS, OAUTH_CALLBACK, type OAuthTokens } from '../../shared/oauth.js'

export interface Ticket { p: string; o: string; c: string; e: string; prov: string; sc: string[]; n: string; exp: number }
export const COOKIE = 'sa_oauth'
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const hmac = async (secret: string, data: string) => b64(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(`oauth:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(data)))

export async function signTicket(secret: string, t: Omit<Ticket, 'n' | 'exp'>, minutes = 15): Promise<string> {
  const body = b64(new TextEncoder().encode(JSON.stringify({ ...t, n: crypto.randomUUID(), exp: Date.now() + minutes * 60_000 })))
  return `${body}.${await hmac(secret, body)}`
}
export async function readTicket(secret: string, token: string): Promise<Ticket | string> {
  const [body, sig] = String(token ?? '').split('.')
  if (!body || !sig || sig !== await hmac(secret, body)) return 'this sign-in link is not one the platform made'
  let t: Ticket
  try { t = JSON.parse(new TextDecoder().decode(unb64(body))) } catch { return 'this sign-in link is damaged' }
  if (!(t.exp > Date.now())) return 'this sign-in took too long — start it again from the connection'
  return t
}

/** The provider's sign-in address for this ticket, with the organisation's client. */
export function authorizeUrl(t: Ticket, ticket: string, clientId: string): string {
  const p = OAUTH_PROVIDERS[t.prov]
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: OAUTH_CALLBACK, response_type: 'code', scope: [...new Set(['openid', 'email', ...t.sc])].join(' '), state: ticket, ...p.params, ...(t.e ? { login_hint: t.e } : {}) })
  return `${p.authorize}?${q}`
}

/** The code exchanged for tokens (or a refresh token for a fresh access token), with the organisation's client. */
export async function tokenCall(provider: string, client: { clientId: string; clientSecret: string }, form: Record<string, string>, fetcher: typeof fetch = fetch): Promise<{ ok: true; tokens: OAuthTokens } | { ok: false; error: string; revoked?: boolean }> {
  const p = OAUTH_PROVIDERS[provider]
  if (!p) return { ok: false, error: `there is no provider ${provider}` }
  let r: Response
  try { r = await fetcher(p.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...form }).toString(), signal: AbortSignal.timeout(20_000) }) }
  catch (e: any) { return { ok: false, error: `${p.title} could not be reached: ${String(e?.message ?? e).slice(0, 120)}` } }
  const d: any = await r.json().catch(() => ({}))
  if (!r.ok || !d.access_token) return { ok: false, error: `${p.title} refused: ${d.error_description ?? d.error ?? r.status}`, revoked: d.error === 'invalid_grant' }
  // who signed in, from the id token the provider just gave over TLS (shown to the person, never trusted for access)
  let account: string | null = null
  try { if (d.id_token) account = JSON.parse(new TextDecoder().decode(unb64(String(d.id_token).split('.')[1]))).email ?? null } catch { /* none */ }
  return { ok: true, tokens: { provider, access_token: d.access_token, refresh_token: d.refresh_token ?? null, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000, ...(d.scope ? { scope: d.scope } : {}), account } }
}

export const cookieOf = (request: Request) => (request.headers.get('cookie') ?? '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE)?.[1] ?? null

/** The page a person lands on after signing in: what happened, in words, and it closes itself when it can. */
export function landing(ok: boolean, text: string): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? 'Connected' : 'Not connected'}</title>
<style>body{font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#1a1a1a}main{max-width:28rem;padding:2rem;border:1px solid #ddd;border-radius:12px;background:#fff}h1{font-size:1.2rem;margin:0 0 .5rem}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}main{background:#1a1a1a;border-color:#333}}</style>
<main><h1>${ok ? 'Connected' : 'Not connected'}</h1><p>${esc(text)}</p><p>${ok ? 'You can close this window.' : 'Close this window and try again from the connection.'}</p></main>
<script>try{window.opener&&window.opener.postMessage({t:'oauth:done',ok:${ok}},'*')}catch(e){}${ok ? 'setTimeout(function(){window.close()},1500)' : ''}</script>`
  return new Response(html, { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `${COOKIE}=; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, 'cache-control': 'no-store' } })
}
