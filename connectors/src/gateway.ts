// THE GATEWAY — every request a connector makes passes here: only to the hosts its manifest names (resolved from the
// connection's settings), with the connection's credentials added as its auth says (the connector's code never sees
// them), and recorded (method, host, path, status, time, size — never a header or a body). The platform runs this in its
// Worker as the Dynamic Worker's only way out; tests run it in process. One copy for both.

import type { Manifest } from './contract'

export interface CallRecord { at: string; method: string; host: string; path: string; status: number; ms: number; bytes: number; refused?: string }

const hostOf = (v: string) => { try { return new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).host.toLowerCase() } catch { return '' } }
const fill = (template: string, values: Record<string, unknown>) => template.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ''))

/** The hosts a connection may call: the manifest's, with {field} replaced by the host of that setting. */
export function allowedHosts(m: Manifest, settings: Record<string, unknown>): string[] {
  return m.hosts.map((h) => hostOf(/\{\w+\}/.test(h) ? fill(h, settings) : h)).filter(Boolean)
}

/** The request with the connection's credentials added, as the manifest's auth says; nothing added when a secret it
 *  needs was not given (an API that needs none). */
export function authorize(m: Manifest, settings: Record<string, unknown>, secrets: Record<string, string>, url: URL, headers: Headers, oauthToken?: string | null): void {
  const values = { ...settings, ...secrets }
  const a = m.auth
  const has = (t: string) => (t.match(/\{(\w+)\}/g) ?? []).every((r) => { const k = r.slice(1, -1); return values[k] !== undefined && values[k] !== '' })
  if (a.kind === 'header' && has(a.template)) headers.set(fill(a.header, values) || 'Authorization', fill(a.template, values))
  if (a.kind === 'query' && secrets[a.field]) url.searchParams.set(a.param, secrets[a.field])
  if (a.kind === 'basic' && secrets[a.password] !== undefined) headers.set('authorization', `Basic ${btoa(`${values[a.user] ?? ''}:${secrets[a.password]}`)}`)
  if (a.kind === 'oauth2' && oauthToken) headers.set('authorization', `Bearer ${oauthToken}`)
}

export class GatewayRefusal extends Error {}

/** fetch as a connector sees it: hosts checked, credentials added, each call recorded. */
export function gatewayFetch(o: { manifest: Manifest; settings: Record<string, unknown>; secrets: Record<string, string>; record: (c: CallRecord) => void; fetcher?: typeof fetch; oauthToken?: string | null }): typeof fetch {
  const allowed = new Set(allowedHosts(o.manifest, o.settings))
  const out: typeof fetch = o.fetcher ?? ((input, init) => fetch(input, init))
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init)
    const url = new URL(req.url)
    const at = new Date().toISOString(), t0 = Date.now()
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(url.host))) {
      o.record({ at, method: req.method, host: url.host, path: url.pathname, status: 0, ms: 0, bytes: 0, refused: 'not https' }); throw new GatewayRefusal(`${url.host}: only https is allowed`)
    }
    if (!allowed.has(url.host.toLowerCase())) {
      o.record({ at, method: req.method, host: url.host, path: url.pathname, status: 0, ms: 0, bytes: 0, refused: 'host not allowed' }); throw new GatewayRefusal(`${url.host} is not a host this connector may call`)
    }
    const headers = new Headers(req.headers)
    authorize(o.manifest, o.settings, o.secrets, url, headers, o.oauthToken)
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    const res = await out(url.toString(), { method: req.method, headers, body, redirect: 'manual' })
    const buf = await res.arrayBuffer()
    o.record({ at, method: req.method, host: url.host, path: url.pathname, status: res.status, ms: Date.now() - t0, bytes: buf.byteLength })
    // A redirect elsewhere is not followed with the credentials on it.
    return new Response(res.status >= 300 && res.status < 400 ? null : buf, { status: res.status, statusText: res.statusText, headers: res.headers })
  }) as typeof fetch
}
