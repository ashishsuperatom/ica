// ── The parcel store a client passes to the transport ────────────────────────────────────────────────────────
//
// A parcel is a message body kept beside the wire: in the platform's object store, under the project, named by
// the SHA-256 of its bytes, fetched with a ticket the platform signed when the body was put. This is the one
// HTTP client for it, shared by every TypeScript end — the engine (Node), the web clients (browser) and the
// Durable Objects (workers) — so the route is spelled in exactly one place:
//
//   PUT  <api>/api/projects/<project>/objects/parcel/<hash>            body · Authorization: Bearer <project key | jwt | agent key>
//   GET  <api>/api/projects/<project>/objects/parcel/<hash>?ticket=…   → the body
//
// `put` needs a credential: the engine's project key or a user's token. `get` needs only the ticket, which is
// the credential — it names the project, the hash and when it stops working, and cannot be forged or moved to
// another body. The Swift twin is Transport.store in clients/ios.
import type { Parcel, ParcelStore } from './transport.js'

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

/** SHA-256 of a string's UTF-8 bytes, as hex — Web Crypto, so it runs in Node 20+, browsers and workers. */
export async function sha256(body: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))
}

export interface ParcelClientOptions {
  /** The platform's HTTP origin ("https://superatom.site"); '' means same origin (a browser page the worker serves). */
  api: string
  projectId: string
  /** What `put` sends as the bearer credential: the project key on an engine, a user token on a client. Without it the store only fetches. */
  credential?: string
  fetch?: typeof fetch
}

/** A parcel store over the platform's parcel route. Without a credential it can only `get`. */
export function parcelStore(o: ParcelClientOptions): ParcelStore {
  const f = o.fetch ?? fetch
  const url = (hash: string) => `${o.api.replace(/\/$/, '')}/api/projects/${encodeURIComponent(o.projectId)}/objects/parcel/${hash}`
  const store: ParcelStore = {
    get: async (parcel: Parcel) => {
      const r = await f(`${url(parcel.hash)}?ticket=${encodeURIComponent(parcel.ticket)}`)
      if (!r.ok) throw new Error(`the parcel could not be fetched (${r.status})`)
      return r.text()
    },
  }
  if (o.credential) store.put = async (body: string) => {
    const hash = await sha256(body)
    const r = await f(url(hash), { method: 'PUT', headers: { authorization: `Bearer ${o.credential}`, 'content-type': 'application/json' }, body })
    if (!r.ok) throw new Error(`the parcel was not stored (${r.status}${await r.text().then((t) => (t ? `: ${t.slice(0, 120)}` : '')).catch(() => '')})`)
    const p = await r.json() as Parcel
    if (p?.hash !== hash || typeof p.ticket !== 'string') throw new Error('the platform answered without a ticket')
    return p
  }
  return store
}

/** The HTTP origin of a hub socket URL: wss://host → https://host, ws://host → http://host. */
export const apiOfHub = (hubWs: string) => hubWs.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/_ws\/.*$/, '').replace(/\/$/, '')
