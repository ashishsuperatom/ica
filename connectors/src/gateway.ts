// THE GATEWAY — every request a connector makes passes here: only to the hosts its manifest names (resolved from the
// connection's settings), with the connection's credentials added as its auth says (the connector's code never sees
// them), and recorded (method, host, path, status, time, size — never a header or a body). The platform runs this in its
// Worker as the Dynamic Worker's only way out; tests run it in process. One copy for both.

import type { Manifest } from './contract'

export interface CallRecord { at: string; method: string; host: string; path: string; status: number; ms: number; bytes: number; refused?: string }

const hostOf = (v: string) => { try { return new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).host.toLowerCase() } catch { return '' } }
const fill = (template: string, values: Record<string, unknown>) => template.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ''))
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

export interface HostRules { /** Domains a connection may never point at (the platform's own), matched with their subdomains. */ refuse?: string[]; /** Plain http to localhost (tests only). */ allowLocal?: boolean }

/** A host a person gave (a connection's setting) may be called only if it is a public name: no IP literal, no port, not
 *  localhost or an internal name, not one of the refused domains. */
function publicHost(host: string, rules: HostRules): string | null {
  if (!host || host.includes(':') || host.startsWith('[')) return null                                   // a port, or IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host)) return null                           // an IPv4 literal
  if (host === 'localhost' || /\.(local|internal|localhost|lan|home|corp)$/.test(host) || !host.includes('.')) return null
  if ((rules.refuse ?? []).some((d) => host === d || host.endsWith(`.${d}`))) return null
  return host
}

/** The hosts a connection may call: the manifest's fixed ones, and those it names from a setting — a whole setting
 *  ({baseUrl}) must be a public host; a value inside a name ({account}.vendor.com) must be one plain label. */
export function allowedHosts(m: Manifest, settings: Record<string, unknown>, rules: HostRules = {}): string[] {
  return m.hosts.flatMap((h) => {
    if (!/\{\w+\}/.test(h)) return [hostOf(h)].filter(Boolean)
    if (/^\{\w+\}$/.test(h)) { const host = publicHost(hostOf(String(settings[h.slice(1, -1)] ?? '')), rules); return host ? [host] : [] }
    const refs = (h.match(/\{(\w+)\}/g) ?? []).map((r) => r.slice(1, -1))
    if (!refs.every((k) => LABEL.test(String(settings[k] ?? '')))) return []
    const host = publicHost(hostOf(fill(h, settings)), rules)
    return host ? [host] : []
  })
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
export function gatewayFetch(o: { manifest: Manifest; settings: Record<string, unknown>; secrets: Record<string, string>; record: (c: CallRecord) => void; fetcher?: typeof fetch; oauthToken?: string | null; rules?: HostRules }): typeof fetch {
  const allowed = new Set(allowedHosts(o.manifest, o.settings, o.rules))
  const out: typeof fetch = o.fetcher ?? ((input, init) => fetch(input, init))
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init)
    const url = new URL(req.url)
    const at = new Date().toISOString(), t0 = Date.now()
    if (url.protocol !== 'https:' && !(o.rules?.allowLocal && url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(url.host))) {
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
