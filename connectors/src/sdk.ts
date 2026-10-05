// THE CONNECTOR SDK — what every connector needs, written once. A connector imports these and keeps only what is its own
// (its endpoints, its entities, its actions). A better way of doing any of this is written here, and every connector gets
// it at its next build.
//
//   defineConnector   the server side from its parts; reads and actions it does not offer refuse plainly
//   json              one HTTP call through the gateway: JSON in and out, retries on 429/5xx (Retry-After honoured),
//                     errors in words (what the other system said)
//   pages             walk a paged API (link header, a cursor field, offset/limit, page numbers) to at most N rows
//   flatten / fieldsOf  rows from nested JSON (a.b.c columns), and the fields they hold, typed
//   ConnectorError    a failure to show a person as it is ("the token was refused", "no such board")

import type { Action, ActRequest, ActResult, ConnectorContext, ConnectorServer, Entity, Field, ReadRequest, ReadResult } from './contract'

export class ConnectorError extends Error {
  constructor(message: string, public status?: number) { super(message) }
}

export interface Parts {
  test: ConnectorServer['test']
  /** Fixed entities and actions, or a function that asks the system (its tables, boards, lists). */
  entities?: Entity[] | ((ctx: ConnectorContext) => Promise<Entity[]>)
  actions?: Action[] | ((ctx: ConnectorContext) => Promise<Action[]>)
  /** One reader per entity name; `*` reads any entity the introspection found. */
  read?: Record<string, (ctx: ConnectorContext, req: ReadRequest) => Promise<ReadResult>>
  /** One handler per action name. */
  /** One handler per action name; `*` handles any action the introspection found (given the action's name). */
  act?: Record<string, (ctx: ConnectorContext, input: Record<string, unknown>, action: string) => Promise<ActResult | unknown>>
}

/** A connector's server side from its parts: introspection, reads by entity, actions by name — with the checks every
 *  connector needs (an unknown entity or action is refused by name; an action's required inputs are present). */
export function defineConnector(p: Parts): ConnectorServer {
  const entities = async (ctx: ConnectorContext) => (typeof p.entities === 'function' ? p.entities(ctx) : p.entities ?? [])
  const actions = async (ctx: ConnectorContext) => (typeof p.actions === 'function' ? p.actions(ctx) : p.actions ?? [])
  return {
    test: p.test,
    async introspect(ctx) { return { entities: await entities(ctx), actions: await actions(ctx) } },
    async read(ctx, req): Promise<ReadResult> {
      const reader = p.read?.[req.entity] ?? p.read?.['*']
      if (!reader) throw new ConnectorError(`there is nothing called "${req.entity}" to read`)
      const limit = Math.max(1, Math.min(req.limit ?? 100, 5000))
      const r = await reader(ctx, { ...req, limit })
      return { rows: r.rows.slice(0, limit), next: r.next ?? null, total: r.total ?? null }
    },
    async act(ctx, req: ActRequest): Promise<ActResult> {
      const spec = (await actions(ctx)).find((a) => a.name === req.action)
      const handler = p.act?.[req.action] ?? (spec ? p.act?.['*'] : undefined)
      if (!handler || !spec) throw new ConnectorError(`there is no action "${req.action}"`)
      for (const f of spec?.input ?? []) if (f.required && (req.input?.[f.name] === undefined || req.input?.[f.name] === '')) throw new ConnectorError(`the action needs ${f.name}`)
      const out = await handler(ctx, req.input ?? {}, req.action)
      return out && typeof out === 'object' && 'ok' in (out as object) ? out as ActResult : { ok: true, result: out }
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One HTTP call through the gateway, JSON in and out; retried on 429 and 5xx (at most `retries` times, backing off,
 *  honouring Retry-After). A refusal says what the other system said. */
export async function json<T = any>(ctx: ConnectorContext, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; retries?: number } = {}): Promise<{ data: T; headers: Headers; status: number }> {
  const retries = init.retries ?? 3
  for (let attempt = 0; ; attempt++) {
    const r = await ctx.fetch(url, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers: { accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) })
    if ((r.status === 429 || r.status >= 500) && attempt < retries) {
      const after = Number(r.headers.get('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 20_000) : 300 * 2 ** attempt)
      continue
    }
    const text = await r.text()
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!r.ok) {
      const said = typeof data === 'object' && data ? (data.message ?? data.error?.message ?? data.error_description ?? data.error ?? data.errors?.[0]?.message) : text
      throw new ConnectorError(r.status === 401 ? `the credentials were refused${said ? `: ${String(said).slice(0, 200)}` : ''}` : r.status === 403 ? `not allowed${said ? `: ${String(said).slice(0, 200)}` : ''}` : r.status === 404 ? `not found${said ? `: ${String(said).slice(0, 200)}` : ''}` : `${r.status}${said ? `: ${String(said).slice(0, 300)}` : ''}`, r.status)
    }
    return { data: data as T, headers: r.headers, status: r.status }
  }
}

/** The URL of the next page in a Link header (rel="next"), as GitHub and many others give it. */
export function nextLink(headers: Headers): string | null {
  const link = headers.get('link'); if (!link) return null
  for (const part of link.split(',')) { const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim()); if (m) return m[1] }
  return null
}

/** Walk pages until `limit` rows or the end: `first` is the first page's URL, `pageOf` reads a page's rows and its next
 *  page (a URL, or null at the end). Returns the rows and where to continue (a cursor a later read passes back). */
export async function pages(ctx: ConnectorContext, first: string, limit: number, pageOf: (data: any, headers: Headers, url: string) => { rows: Record<string, unknown>[]; next: string | null }): Promise<ReadResult> {
  const rows: Record<string, unknown>[] = []
  let url: string | null = first
  while (url && rows.length < limit) {
    const { data, headers } = await json(ctx, url)
    const p = pageOf(data, headers, url)
    rows.push(...p.rows)
    url = p.next
  }
  return { rows: rows.slice(0, limit), next: url }
}

/** A nested JSON object as one row: { a: { b: 1 } } → { 'a.b': 1 }; arrays and deeper objects past `depth` stay as JSON. */
export function flatten(v: unknown, depth = 2, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) { out[prefix || 'value'] = v; return out }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (x && typeof x === 'object' && !Array.isArray(x) && depth > 0) flatten(x, depth - 1, key, out)
    else out[key] = x
  }
  return out
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/, ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/
/** The fields a set of rows holds, each typed by what its values are (the first 200 rows). */
export function fieldsOf(rows: Record<string, unknown>[]): Field[] {
  const seen = new Map<string, Set<Field['type']>>()
  for (const r of rows.slice(0, 200)) for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined) { if (!seen.has(k)) seen.set(k, new Set()); continue }
    const t: Field['type'] = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v === 'string' ? (ISO_DAY.test(v) ? 'date' : ISO_TIME.test(v) ? 'timestamp' : 'string') : 'json'
    ;(seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(t)
  }
  return [...seen.entries()].map(([name, ts]) => ({ name, type: ts.size === 1 ? [...ts][0] : ts.size === 2 && ts.has('integer') && ts.has('number') ? 'number' : ts.size === 0 ? 'string' : 'string' }))
}

/** The connection's settings URL joined with a path (a base URL the person gave, without a trailing slash). */
export const join = (base: unknown, path: string) => `${String(base ?? '').replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

export type { ConnectorContext, Entity, Action, Field, ReadRequest, ReadResult, ActResult } from './contract'
