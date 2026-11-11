// AN API CONNECTOR — what every connector to an HTTP API needs, written once. A connector of this kind (bridges/<id>/,
// kind "api") gives only what is its own: how it signs in, its entities, its reads and its actions; `apiConnector` makes
// the engine connector from them (createBridge: ready, test, introspect, query, act, close) — the same contract as a
// database's, so the platform knows one kind of connector. How a connector reaches its data — the API itself, or a
// worker of ours in front of it — is its own business.
//
//   apiConnector      the engine connector from its parts; an entity or action it does not offer is refused by name
//   json              one HTTP call: JSON in and out, retries on 429/5xx (Retry-After honoured), errors in words (what
//                     the other system said); `request` is the same call answering text whatever its status (for XML,
//                     or a refusal to look at first), `refusal` its words
//   pages             walk a paged API (link header, a cursor field, …) to at most N rows
//   flatten / fieldsOf  rows from nested JSON (a.b.c columns), and the fields they hold, typed
//   cachedToken       a sign-in that gives a token (OAuth client credentials): fetched once, kept until refused
//   inParallel        many calls at once, but only a few at a time (describe calls cost a SaaS API's budget)
//   ConnectorError    a failure to show a person as it is ("the credentials were refused", "no such board")
//
// A query is JSON naming what to read: {"entity": "issues", "filters": {"repo": "acme/app"}, "fields": ["title"],
// "limit": 50} — and, where the source has a query language of its own, {"entity": …, "query": "<its condition>"} or a
// whole query in it ({"soql": "SELECT …"}: Parts.native). A connector
// whose source is a tree (src/contract.ts "A SOURCE'S TREE") gives its levels, children(path) and read(path) instead:
// a query names a path — {"path": ["1AbC…", "Q4 plan"]} — and one short of a table lists what is inside it.

import { checkTree, type Action, type ActResult, type Budget, type ChildrenRequest, type ChildrenResult, type ConnectorContext, type Entity, type Field, type ReadRequest, type ReadResult, type TreeLevel } from './contract'

/** A table's signature from its columns (`name:type`), in any order: the same columns, the same signature. */
export function signatureOf(columns: string[]): string {
  let h = 2166136261
  for (const c of [...columns].sort().join('\n')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 }
  return `${columns.length}:${h.toString(16)}`
}

export class ConnectorError extends Error {
  /** status: the HTTP status the other system answered; body: what it said, parsed (for a connector to say more of it). */
  constructor(message: string, public status?: number, public body?: unknown) { super(message) }
}

export interface Parts {
  /** What the agent is told about reading it (its query's shape is said for it). */
  description: string
  /** The headers that sign a request in, from the connection's settings and secrets (none: no sign-in). */
  headers?: (c: { settings: Record<string, any>; secrets: Record<string, string> }) => Record<string, string | undefined>
  /** The fields a connection must have to be tried at all. */
  requires?: string[]
  /** Check it works with a cheap call; say what it reached. */
  test: (ctx: ConnectorContext) => Promise<string>
  /** Fixed entities and actions, or a function that asks the system (its boards, lists, tools). */
  entities?: Entity[] | ((ctx: ConnectorContext) => Promise<Entity[]>)
  actions?: Action[] | ((ctx: ConnectorContext) => Promise<Action[]>)
  /** One reader per entity name; `*` reads any entity it described. */
  read?: Record<string, (ctx: ConnectorContext, req: ReadRequest) => Promise<ReadResult>>
  /** Its source as a tree: its levels (outermost first, the last holding rows), what is inside a node (path: the ids
   *  above, one per level; [] the outermost), and a table's rows by its path. */
  tree?: {
    levels: TreeLevel[]
    children: (ctx: ConnectorContext, req: ChildrenRequest & { limit: number }) => Promise<ChildrenResult>
    read: (ctx: ConnectorContext, req: ReadRequest & { path: string[] }) => Promise<ReadResult>
  }
  /** A whole query in the source's own language, read-only: {"<key>": "<text>"} runs it (e.g. {"soql": "SELECT …"}).
   *  `say` tells the agent what it takes. */
  native?: { key: string; say: string; run: (ctx: ConnectorContext, text: string, limit: number) => Promise<ReadResult> }
  /** What the connection may still spend, from the system's own headers (null: not known yet). */
  budget?: (ctx: ConnectorContext) => Budget | null
  /** Its own setup checks (manifest setup, check: custom): what each found, in words — or an error saying what is wrong. */
  checks?: Record<string, (ctx: ConnectorContext) => Promise<string>>
  /** One handler per action name; `*` handles any action it described (given the action's name). */
  act?: Record<string, (ctx: ConnectorContext, input: Record<string, unknown>, action: string) => Promise<ActResult | unknown>>
}

const TRANSIENT = /\b(429|50[234])\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|timed? ?out/i

/** The engine connector of an API, from its parts. `fetch` may be given (tests); otherwise Node's own. */
export function apiConnector(id: string, p: Parts) {
  return function createBridge({ settings = {}, secrets = {}, fetch: given }: { settings?: Record<string, any>; secrets?: Record<string, string>; fetch?: typeof fetch } = {}) {
    const signed = Object.fromEntries(Object.entries(p.headers?.({ settings, secrets }) ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    const base = given ?? fetch
    const ctx: ConnectorContext = {
      settings, secrets,
      fetch: ((url: string, init: RequestInit = {}) => base(url, { ...init, headers: { ...signed, ...(init.headers as Record<string, string> ?? {}) }, signal: init.signal ?? AbortSignal.timeout(60_000) })) as typeof fetch,
      log: () => {},
    }
    const entities = async () => (typeof p.entities === 'function' ? p.entities(ctx) : p.entities ?? [])
    const actions = async () => (typeof p.actions === 'function' ? p.actions(ctx) : p.actions ?? [])
    const tree = p.tree
    if (tree) { const bad = checkTree(tree.levels); if (bad.length) throw new ConnectorError(`${id}: ${bad.join('; ')}`) }
    const pathOf = (v: unknown): string[] => {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) throw new ConnectorError('a path is a list of names, one per level: ["…", "…"]')
      if (tree && v.length > tree.levels.length) throw new ConnectorError(`a path has at most ${tree.levels.length} parts (${tree.levels.map((l) => l.name).join(' › ')})`)
      return v as string[]
    }
    /** What is inside a node: a tree's own children, or — one level — its entities. */
    const children = async (req: ChildrenRequest): Promise<ChildrenResult> => {
      const path = pathOf(req.path ?? []), limit = Math.max(1, Math.min(Number(req.limit) || 100, 1000))
      if (tree) {
        if (path.length >= tree.levels.length) throw new ConnectorError(`${path.at(-1)} is a ${tree.levels.at(-1)!.name.toLowerCase()}: it holds rows, read it`)
        const r = await tree.children(ctx, { path, search: req.search ? String(req.search) : undefined, cursor: req.cursor ?? null, limit })
        return { nodes: r.nodes.slice(0, limit), next: r.next ?? null }
      }
      if (path.length) throw new ConnectorError(`${path[0]} holds rows, read it`)
      const term = String(req.search ?? '').toLowerCase()
      return { nodes: (await entities()).filter((e) => !term || `${e.name} ${e.label ?? ''}`.toLowerCase().includes(term)).slice(0, limit).map((e) => ({ id: e.name, label: e.label ?? e.name, table: true })), next: null }
    }
    const QUERY = tree
      ? `A query is JSON: {"path": [${tree.levels.map((l) => `"<${l.name.toLowerCase()}>"`).join(', ')}], "limit": n} reads a ${tree.levels.at(-1)!.name.toLowerCase()}'s rows; a shorter path lists what is inside it ([] lists every ${tree.levels[0].name.toLowerCase()}), "search" narrowing them by name.`
      : `A query is JSON: {"entity": "<name>", "filters": {…}, "limit": n}.${p.native ? ` Or ${p.native.say}` : ''}`
    return {
      id, kind: 'api' as const, dialect: 'api',
      description: `${String(settings.description ?? '') || p.description} ${QUERY}`,
      /** Its tree's levels (none: one level of entities). */
      ...(tree ? { tree: tree.levels } : {}),
      ready: () => (p.requires ?? []).every((k) => (settings[k] ?? secrets[k]) !== undefined && (settings[k] ?? secrets[k]) !== ''),
      test: () => p.test(ctx),
      /** Its entities as tables (the index reads them), and its actions. */
      async introspect() {
        const [es, as] = await Promise.all([entities(), actions()])
        return { kind: 'api', dialect: 'api', ...(tree ? { tree: tree.levels } : {}), tables: es.map((e) => ({ name: e.name, description: e.description, columns: e.fields.map((f) => ({ name: f.name, type: f.type, ...(f.description ? { description: f.description } : {}), ...(f.key ? { key: true } : {}), ...(f.references ? { references: f.references } : {}), ...(f.nullable !== undefined ? { nullable: f.nullable } : {}) })), ...(e.filters?.length ? { filters: e.filters } : {}) })), actions: as }
      },
      async query(text: string) {
        let q: any
        try { q = JSON.parse(String(text)) } catch { throw new ConnectorError(QUERY) }
        if (q?.path !== undefined) {
          const path = pathOf(q.path), limit = Math.max(1, Math.min(Number(q.limit) || 100, 5000))
          if (!tree || path.length < tree.levels.length) {
            if (!tree && path.length === 1) q = { ...q, entity: path[0] }
            else {
              const r = await children({ path, search: q.search, cursor: q.cursor ?? null, limit })
              const level = tree?.levels[path.length]?.name.toLowerCase() ?? 'entity'
              return r.nodes.map((n) => ({ [level]: n.label, id: n.id, ...(n.detail ?? {}) }))
            }
          } else {
            const r = await tree.read(ctx, { entity: path.join('/'), path, filters: q.filters ?? {}, cursor: q.cursor ?? null, since: q.since ?? null, limit })
            return r.rows.slice(0, limit)
          }
        }
        if (p.native && typeof q?.[p.native.key] === 'string' && q.entity === undefined) {
          const limit = Math.max(1, Math.min(Number(q.limit) || 100, 5000))
          return (await p.native.run(ctx, q[p.native.key], limit)).rows.slice(0, limit)
        }
        const entity = String(q?.entity ?? '')
        const reader = p.read?.[entity] ?? p.read?.['*']
        if (!entity || !reader) throw new ConnectorError(`there is nothing called "${entity}" to read (its entities: ${(await entities()).map((e) => e.name).join(', ') || 'none'})`)
        const limit = Math.max(1, Math.min(Number(q.limit) || 100, 5000))
        if (q.fields !== undefined && (!Array.isArray(q.fields) || q.fields.some((f: unknown) => typeof f !== 'string' || !f))) throw new ConnectorError('fields is a list of field names: ["…", "…"]')
        if (q.query !== undefined && typeof q.query !== 'string') throw new ConnectorError('query is text: a condition in the source\'s own query language')
        const r = await reader(ctx, { entity, filters: q.filters ?? {}, cursor: q.cursor ?? null, since: q.since ?? null, limit, options: q, ...(q.fields?.length ? { fields: q.fields } : {}), ...(q.query ? { query: q.query } : {}) })
        return r.rows.slice(0, limit)
      },
      async act(action: string, input: Record<string, unknown> = {}): Promise<ActResult> {
        const spec = (await actions()).find((a) => a.name === action)
        const handler = p.act?.[action] ?? (spec ? p.act?.['*'] : undefined)
        if (!handler || !spec) throw new ConnectorError(`there is no action "${action}"`)
        for (const f of spec.input ?? []) if (f.required && (input[f.name] === undefined || input[f.name] === '')) throw new ConnectorError(`the action needs ${f.name}`)
        const out = await handler(ctx, input, action)
        return out && typeof out === 'object' && 'ok' in (out as object) ? out as ActResult : { ok: true, result: out }
      },
      children,
      async check(name: string): Promise<string> {
        const f = p.checks?.[name]
        if (!f) throw new ConnectorError(`there is no check ${name}`)
        return f(ctx)
      },
      isTransient: (e: any) => TRANSIENT.test(`${e?.status ?? ''} ${e?.message ?? e}`),
      /** For each entity, a value that changes exactly when its fields do (contract.ts "WHAT A CONNECTOR SAYS"). */
      async signatures() {
        const out: Record<string, string> = {}
        for (const e of await entities()) out[e.name] = signatureOf(e.fields.map((f) => `${f.name}:${f.type}`))
        return out
      },
      /** What the connection may still spend (Parts.budget), or null where the system does not say. */
      budget: async (): Promise<Budget | null> => p.budget?.(ctx) ?? null,
      close: () => {},
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One HTTP call, its answer as text, whatever its status: retried on 429 and 5xx (at most `retries` times, backing off,
 *  honouring Retry-After). For a connector that must look at a refusal before it is one (a token to renew, a header the
 *  system asks for) or that reads something other than JSON (XML); `refusal` turns an answer that is not ok into words. */
export async function request(ctx: ConnectorContext, url: string, init: { method?: string; body?: string; headers?: Record<string, string>; retries?: number } = {}): Promise<{ text: string; headers: Headers; status: number; ok: boolean }> {
  const retries = init.retries ?? 3
  for (let attempt = 0; ; attempt++) {
    const r = await ctx.fetch(url, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}) })
    if ((r.status === 429 || r.status >= 500) && attempt < retries) {
      const after = Number(r.headers.get('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 20_000) : 300 * 2 ** attempt)
      continue
    }
    return { text: await r.text(), headers: r.headers, status: r.status, ok: r.ok }
  }
}

/** What the other system said in a refusal: its message wherever the common shapes keep it — { message } (also the first
 *  of a list, with its errorCode), OAuth's error with its description, { error: { message } } (with its detail),
 *  OData's { error: { message: { value } } } with its code, { errors: [{ message }] }, an API gateway's { fault:
 *  { faultstring } }; or an XML error's <message>; or the text itself. */
export function saidIn(text: string): string {
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  const d: any = Array.isArray(data) ? data[0] : data
  if (d && typeof d === 'object') {
    if (typeof d.error === 'string' && typeof d.error_description === 'string') return `${d.error}: ${d.error_description}`
    if (typeof d.errorCode === 'string' && typeof d.message === 'string') return `${d.message.trim()} (${d.errorCode})`
    const e = d.error
    const m = d.message ?? (e && typeof e.message === 'object' ? e.message?.value : e?.message) ?? d.error_description ?? (typeof e === 'string' ? e : undefined) ?? d.errors?.[0]?.message ?? d.fault?.faultstring
    const detail = e && typeof e === 'object' && typeof e.detail === 'string' && e.detail && e.detail !== m ? ` (${e.detail})` : ''
    const code = typeof e?.code === 'string' && e.code && !String(m ?? '').includes(e.code) ? ` (${e.code})` : ''
    return m !== undefined && m !== null ? `${typeof m === 'string' ? m : JSON.stringify(m)}${detail}${code}` : JSON.stringify(data)
  }
  const xml = /<(?:\w+:)?message\b[^>]*>([\s\S]*?)<\/(?:\w+:)?message>/i.exec(text ?? '')
  return (xml ? xml[1] : String(text ?? '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** An answer that is not ok, as a ConnectorError in words — what it means, then what the system said — carrying the body,
 *  parsed, for a connector to say more of it. */
export function refusal(status: number, text: string): ConnectorError {
  const said = saidIn(text)
  const words = said ? `: ${said.slice(0, 300)}` : ''
  let body: unknown = text
  try { body = text ? JSON.parse(text) : null } catch { /* the text itself */ }
  return new ConnectorError(status === 401 ? `the credentials were refused${words}` : status === 403 ? `not allowed${words}` : status === 404 ? `not found${words}` : `the other system answered ${status}${words}`, status, body)
}

/** One HTTP call, JSON in and out (or a form in: `form`, as OAuth token endpoints take it); retried on 429 and 5xx
 *  (request). A refusal says what the other system said. */
export async function json<T = any>(ctx: ConnectorContext, url: string, init: { method?: string; body?: unknown; form?: Record<string, string>; headers?: Record<string, string>; retries?: number } = {}): Promise<{ data: T; headers: Headers; status: number }> {
  const sent = init.form ? { type: 'application/x-www-form-urlencoded', body: new URLSearchParams(init.form).toString() } : init.body !== undefined ? { type: 'application/json', body: JSON.stringify(init.body) } : null
  const r = await request(ctx, url, { method: init.method ?? (sent ? 'POST' : 'GET'), retries: init.retries, headers: { accept: 'application/json', ...(sent ? { 'content-type': sent.type } : {}), ...(init.headers ?? {}) }, ...(sent ? { body: sent.body } : {}) })
  if (!r.ok) throw refusal(r.status, r.text)
  let data: any = null
  try { data = r.text ? JSON.parse(r.text) : null } catch { data = r.text }
  return { data: data as T, headers: r.headers, status: r.status }
}

/** The URL of the next page in a Link header (rel="next"), as GitHub and many others give it. */
export function nextLink(headers: Headers): string | null {
  const link = headers.get('link'); if (!link) return null
  for (const part of link.split(',')) { const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim()); if (m) return m[1] }
  return null
}

/** Walk pages until `limit` rows or the end: `first` is the first page's URL, `pageOf` reads a page's rows and its next
 *  page (a URL, or null at the end). Returns the rows and where to continue. */
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
  return [...seen.entries()].map(([name, ts]) => ({ name, type: ts.size === 1 ? [...ts][0] : ts.size === 2 && ts.has('integer') && ts.has('number') ? 'number' : 'string' }))
}

/** `fn` over every item, at most `n` at a time; the results in the items' order. */
export async function inParallel<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

/** A sign-in that gives a token (OAuth client credentials): `fetchToken` asks for one; it is kept for the connection
 *  (its context) until the system refuses it — then asked for once more, and the call tried again. Calls made while a
 *  token is being fetched wait for that one. */
export function cachedToken<T extends { token: string }>(fetchToken: (ctx: ConnectorContext) => Promise<T>) {
  const held = new WeakMap<ConnectorContext, Promise<T>>()
  const get = (ctx: ConnectorContext) => {
    let t = held.get(ctx)
    if (!t) { const asked = fetchToken(ctx); t = asked; held.set(ctx, asked); asked.catch(() => { if (held.get(ctx) === asked) held.delete(ctx) }) }
    return t
  }
  return {
    get,
    /** Run `call` with the token; if the system refuses it (401), fetch a new one and run it once more. */
    async with<R>(ctx: ConnectorContext, call: (t: T) => Promise<R>): Promise<R> {
      const t = get(ctx), token = await t   // a sign-in refused is said as it is, not asked again
      try { return await call(token) } catch (e: any) {
        if (e?.status !== 401) throw e
        if (held.get(ctx) === t) held.delete(ctx)
        return call(await get(ctx))
      }
    },
  }
}

/** The connection's base URL joined with a path (a base URL the person gave, without a trailing slash). */
export const join = (base: unknown, path: string) => `${String(base ?? '').replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

export type { ConnectorContext, Entity, Action, Field, ReadRequest, ReadResult, ActResult, Budget, TreeLevel, TreeNode, ChildrenRequest, ChildrenResult } from './contract'
