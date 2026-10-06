// THE PLATFORM, over HTTP, as this project's engine: the calls it makes with the project's key (never a person's).
// The address comes from the hub's: wss://<host>/_ws/<project>… → https://<host>/api/engine/<project>/…

import type { ProgramBundle } from '@superatom/programs'

export interface Platform {
  uploadProgram(bundle: ProgramBundle, by: string): Promise<{ added: boolean; entry: Record<string, unknown> }>
  fetchProgram(hash: string): Promise<ProgramBundle>
  listPrograms(q?: { name?: string; published?: boolean }): Promise<{ hash: string; name: string; uploaded_at: string; published_at: string | null }[]>
  /** A session's file, as its person put it in (kept on the platform under the session, by its hash). */
  fetchAttachment(session: string, hash: string): Promise<Uint8Array>
  /** The project's app as the platform has it now (its hash), and a version's files by hash. */
  currentApp(): Promise<{ hash: string; at: string; by: string } | null>
  fetchApp(hash: string): Promise<Record<string, string>>
  /** A connection's bridge code, by its hash. */
  fetchBridge(hash: string): Promise<string>
  /** A bridge written here (by the connector agent), up to the platform for the connection of that name. */
  uploadBridge(name: string, code: string): Promise<{ name: string; bridge: string; changed: boolean }>
}

/** The largest session file the platform keeps (its LIMITS.attachment). */
const ATTACHMENT_MAX = 20 * 1024 * 1024

export function platformOf(o: { hub: string; project: string; key: string; fetch?: typeof fetch }): Platform {
  const u = new URL(o.hub)
  const base = `${u.protocol === 'ws:' ? 'http:' : 'https:'}//${u.host}/api/engine/${o.project}`
  const f = o.fetch ?? fetch
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await f(base + path, { ...init, headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
    const body: any = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }))
    if (!r.ok) throw new Error(body?.error ?? `the platform answered ${r.status}`)
    return body
  }
  return {
    uploadProgram: (bundle, by) => call(`/programs/${bundle.hash}`, { method: 'PUT', body: JSON.stringify(bundle), headers: { 'x-sa-by': by } }),
    fetchProgram: (hash) => call(`/programs/${hash}`),
    fetchAttachment: async (session, hash) => {
      const r = await f(`${base}/attachments/${encodeURIComponent(session)}/${hash}`, { headers: { authorization: `Bearer ${o.key}` } })
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as any)?.error ?? `the platform answered ${r.status}`)
      // Within the platform's limit for a session's file (control-plane/superadmin/src/files.ts) — refused before reading more.
      if (Number(r.headers.get('content-length') ?? 0) > ATTACHMENT_MAX) throw new Error(`the file is larger than ${ATTACHMENT_MAX / 1024 / 1024} MB`)
      const bytes = new Uint8Array(await r.arrayBuffer())
      if (bytes.length > ATTACHMENT_MAX) throw new Error(`the file is larger than ${ATTACHMENT_MAX / 1024 / 1024} MB`)
      return bytes
    },
    fetchBridge: async (hash) => {
      const r = await f(`${base}/bridges/${hash}`, { headers: { authorization: `Bearer ${o.key}` } })
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as any)?.error ?? `the platform answered ${r.status}`)
      return r.text()
    },
    currentApp: async () => (await call('/app')).app ?? null,
    fetchApp: (hash) => call(`/app/${hash}`),
    uploadBridge: (name, code) => call(`/connections/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ bridge: code }) }),
    listPrograms: async (q = {}) => (await call(`/programs?${new URLSearchParams({ ...(q.name ? { name: q.name } : {}), ...(q.published !== undefined ? { published: String(q.published) } : {}) })}`)).programs,
  }
}
