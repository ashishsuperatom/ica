// THE PLATFORM, over HTTP, as this project's engine: the calls it makes with the project's key (never a person's).
// The address comes from the hub's: wss://<host>/_ws/<project>… → https://<host>/api/engine/<project>/…

import type { ProgramBundle } from '@superatom/programs'

export interface Platform {
  uploadProgram(bundle: ProgramBundle, by: string): Promise<{ added: boolean; entry: Record<string, unknown> }>
  fetchProgram(hash: string): Promise<ProgramBundle>
  listPrograms(q?: { name?: string; published?: boolean }): Promise<{ hash: string; name: string; uploaded_at: string; published_at: string | null }[]>
}

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
    listPrograms: async (q = {}) => (await call(`/programs?${new URLSearchParams({ ...(q.name ? { name: q.name } : {}), ...(q.published !== undefined ? { published: String(q.published) } : {}) })}`)).programs,
  }
}
