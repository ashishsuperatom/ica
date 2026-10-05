// THE CONNECTOR CONTRACT — what every connector is, whatever system it reaches. A connector is two small modules and a
// manifest, built once and kept by hash (like a program):
//
//   manifest.json   who it is (id, name, icon, what it reaches), how a connection is made (the fields a person or an agent
//                   fills, which of them are secrets, the auth), the hosts it may call, and what it offers: DATA (entities
//                   it can describe and read) and ACTIONS (things it can do in the other system, each saying what it
//                   changes and whether a person must confirm it)
//   server.ts       the Node.js side, run in a sandbox (a Cloudflare Dynamic Worker): introspect, read, act — written
//                   against the SDK (src/sdk.ts), which brings what every connector needs (HTTP with retries and paging,
//                   rows from JSON, the record of every call) so no connector copies it
//   web.tsx         optional: its own React view for making a connection or previewing what it reads; without one, the
//                   platform draws the connection form from the manifest's fields
//
// What a connector never does: hold a secret (the gateway adds credentials to the requests it makes), reach a host its
// manifest does not name, decide who may read what (the platform's grants and policies do), or keep state of its own.

/** A field of the connection form: what a person (or an agent filling it for them) gives. */
export interface ConnectionField {
  key: string
  label: string
  /** What it is, in the user's words (shown under the field, and to an agent filling it). */
  help?: string
  type: 'text' | 'url' | 'secret' | 'number' | 'boolean' | 'select'
  required?: boolean
  options?: string[]
  placeholder?: string
  default?: string | number | boolean
}

/** How a request is authenticated. The gateway applies it; the connector's code never sees the secret. */
export type Auth =
  | { kind: 'none' }
  /** A secret field sent as a header ("Authorization: Bearer {token}", "X-Api-Key: {key}"). */
  | { kind: 'header'; header: string; template: string }
  /** A secret field sent as a query parameter. */
  | { kind: 'query'; param: string; field: string }
  /** User and password fields as HTTP Basic. */
  | { kind: 'basic'; user: string; password: string }
  /** OAuth 2 (authorization code): the platform runs the flow and keeps the tokens; requests carry the access token. */
  | { kind: 'oauth2'; authorizeUrl: string; tokenUrl: string; scopes: string[] }

/** A column of an entity: its name, its type as the platform's data types, what it means. */
export interface Field { name: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'timestamp' | 'json'; description?: string; /** It identifies a row. */ key?: boolean; /** An action's input that must be given. */ required?: boolean }
/** Something the connector can read: a table, a collection, a resource. */
export interface Entity { name: string; label?: string; description?: string; fields: Field[]; /** How rows can be narrowed at the source. */ filters?: string[]; /** It has a time a change can be read from (incremental reads). */ cursorField?: string }

/** Something the connector can do in the other system. */
export interface Action {
  name: string
  label: string
  description: string
  /** What it takes, as fields. */
  input: Field[]
  /** What it changes: nothing (a lookup), something reversible, or something that cannot be undone. */
  effect: 'read' | 'write' | 'irreversible'
  /** A person must confirm it before it runs (always so for irreversible actions). */
  confirm?: boolean
}

export interface Manifest {
  id: string
  name: string
  version: number
  /** An iconify icon and an accent token, as agents carry. */
  icon: string
  accent?: string
  /** One line: what it reaches. */
  says: string
  category: 'database' | 'saas' | 'files' | 'messaging' | 'mcp' | 'api' | 'other'
  /** The hosts its requests may go to; a field's value may be named as {field} (a host the person gives). */
  hosts: string[]
  fields: ConnectionField[]
  auth: Auth
  offers: { data: boolean; actions: boolean }
  /** Its own React view (web/index.js), when it has one. */
  ui?: { blocks: string[] }
}

/** A read: an entity, perhaps narrowed, a page at a time. */
export interface ReadRequest { entity: string; filters?: Record<string, string | number | boolean>; cursor?: string | null; since?: string | null; limit?: number }
export interface ReadResult { rows: Record<string, unknown>[]; next?: string | null; total?: number | null }
export interface ActRequest { action: string; input: Record<string, unknown> }
export interface ActResult { ok: boolean; result?: unknown; message?: string }

/** What the connector's code is given: its connection's settings (never its secrets), HTTP through the gateway, a log. */
export interface ConnectorContext {
  /** The connection's non-secret fields (a base URL, a workspace id). */
  settings: Record<string, string | number | boolean>
  /** fetch through the gateway: credentials added, hosts checked, every call recorded. */
  fetch: typeof fetch
  log: (message: string, detail?: Record<string, unknown>) => void
}

/** The server side every connector exports (src/sdk.ts `defineConnector` makes one). */
export interface ConnectorServer {
  /** Check the connection works (a cheap call); say what is wrong in the user's words when not. */
  test(ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }>
  /** What it can read now (some systems' entities depend on the account: tables, boards, lists). */
  introspect(ctx: ConnectorContext): Promise<{ entities: Entity[]; actions: Action[] }>
  read(ctx: ConnectorContext, req: ReadRequest): Promise<ReadResult>
  act(ctx: ConnectorContext, req: ActRequest): Promise<ActResult>
}

const ID = /^[a-z][a-z0-9-]{1,40}$/
/** The problems with a manifest, in words (empty when it is sound). */
export function checkManifest(m: any): string[] {
  const out: string[] = []
  if (!m || typeof m !== 'object') return ['a manifest is an object']
  if (typeof m.id !== 'string' || !ID.test(m.id)) out.push('id: lowercase letters, digits and -, a letter first')
  for (const k of ['name', 'icon', 'says']) if (typeof m[k] !== 'string' || !m[k].trim()) out.push(`${k} is required`)
  if (!Number.isInteger(m.version) || m.version < 1) out.push('version is a whole number from 1')
  if (!['database', 'saas', 'files', 'messaging', 'mcp', 'api', 'other'].includes(m.category)) out.push('category is one of database, saas, files, messaging, mcp, api, other')
  if (!Array.isArray(m.hosts) || !m.hosts.length || m.hosts.some((h: unknown) => typeof h !== 'string' || !h)) out.push('hosts names at least one host it may call')
  if (!Array.isArray(m.fields)) out.push('fields is a list (it may be empty)')
  else {
    const keys = new Set<string>()
    for (const f of m.fields) {
      if (!f || typeof f.key !== 'string' || !/^[a-z][a-zA-Z0-9_]*$/.test(f.key)) { out.push('every field has a key'); continue }
      if (keys.has(f.key)) out.push(`the field ${f.key} is named twice`); keys.add(f.key)
      if (!['text', 'url', 'secret', 'number', 'boolean', 'select'].includes(f.type)) out.push(`field ${f.key}: type is text, url, secret, number, boolean or select`)
      if (typeof f.label !== 'string' || !f.label) out.push(`field ${f.key}: a label`)
    }
    for (const h of m.hosts ?? []) for (const ref of String(h).match(/\{(\w+)\}/g) ?? []) if (!keys.has(ref.slice(1, -1))) out.push(`host ${h} names a field that does not exist`)
  }
  const a = m.auth
  if (!a || !['none', 'header', 'query', 'basic', 'oauth2'].includes(a.kind)) out.push('auth.kind is none, header, query, basic or oauth2')
  else {
    const secret = (k: string) => (m.fields ?? []).some((f: any) => f.key === k && f.type === 'secret')
    if (a.kind === 'header') { if (!a.header || !a.template) out.push('a header auth names the header and its template'); for (const r of String(a.template ?? '').match(/\{(\w+)\}/g) ?? []) if (!secret(r.slice(1, -1))) out.push(`the auth template's {${r.slice(1, -1)}} must be a secret field`) }
    if (a.kind === 'query' && !secret(a.field)) out.push('a query auth names a secret field')
    if (a.kind === 'basic' && !secret(a.password)) out.push('basic auth\'s password must be a secret field')
    if (a.kind === 'oauth2' && (!a.authorizeUrl || !a.tokenUrl)) out.push('oauth2 names its authorize and token URLs')
  }
  if (!m.offers || typeof m.offers.data !== 'boolean' || typeof m.offers.actions !== 'boolean') out.push('offers says whether it reads data and does actions')
  return out
}
