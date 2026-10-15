// THE CONNECTOR CONTRACT — one kind of connector: the engine connector (docs/platform-architecture.md "Connectors"). A
// connector is one folder (bridges/<id>/): manifest.json (who it is, the connection form, how a connection may sign in),
// bridge.mjs (createBridge: ready, test, introspect, query, act?, close — run on the engine, one process per
// connection) and package.json with its own driver. How it reaches its data is its own business: a database driver, an
// HTTP API (src/api.ts), a worker of ours in front of one. The platform's catalogue, the connection form and the index
// all come from its manifest and its own description.

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

/** A read: an entity, perhaps narrowed, a page at a time. */
/** A row may say what it opens — `_open`: the entity to read next (a spreadsheet → its sheets → a sheet's rows). The
 *  connection page follows it on a click; an agent reads it as the next query's entity. */
export const OPENS = '_open'
export interface ReadRequest { entity: string; filters?: Record<string, string | number | boolean>; cursor?: string | null; since?: string | null; limit?: number }
export interface ReadResult { rows: Record<string, unknown>[]; next?: string | null; total?: number | null }
export interface ActRequest { action: string; input: Record<string, unknown> }
export interface ActResult { ok: boolean; result?: unknown; message?: string }

/** What an API connector's code is given (src/api.ts): its connection's settings and secrets, and fetch with its
 *  sign-in added. */
export interface ConnectorContext {
  settings: Record<string, any>
  secrets: Record<string, string>
  fetch: typeof fetch
  log: (message: string, detail?: Record<string, unknown>) => void
}

// ── ENGINE CONNECTORS (bridges/<id>/: manifest.json + bridge.mjs + package.json with its own driver) ────────────────────
// docs/platform-architecture.md "Connectors": a connector is one folder with everything it needs; the platform's catalogue,
// the connection form and the index all come from its manifest. Its code runs on the engine (createBridge).

export interface EngineField { name: string; label: string; type: 'text' | 'secret' | 'number' | 'url' | 'select' | 'textarea'; required?: boolean; options?: string[]; help?: string; placeholder?: string
  /** Asked for only when another field has this value (e.g. { auth: 'sql' }). */
  when?: Record<string, string> }
export interface EngineManifest {
  id: string; title: string; description: string; icon?: string
  /** sql (a SQL dialect, through the rewrite: policies and caps), documents or api (its own query language: no policies can apply). */
  kind: 'sql' | 'documents' | 'api'
  /** The SQL dialect, as SQLGlot names it (or one the rewrite maps). */
  dialect: string
  levels: ('project' | 'user')[]
  /** How a connection signs in: one account for everyone, a person's own key, a person's own sign-in (OAuth). */
  identity: ('shared' | 'person-key' | 'person-oauth')[]
  fields: EngineField[]
  /** A person signs in with this provider (identity person-oauth): its id (control-plane/shared/oauth.ts) and the scopes asked. */
  oauth?: { provider: string; scopes: string[] }
  /** Native packages the engine supplies (not bundled), e.g. DuckDB. */
  native?: string[]
  /** The platform's own source, in every project, never connected by people. */
  builtin?: boolean
}

export function checkEngineManifest(m: any): string[] {
  const bad: string[] = []
  if (!m || typeof m !== 'object') return ['manifest.json is not an object']
  if (!/^[a-z][a-z0-9-]*$/.test(m.id ?? '')) bad.push('id is lower-case letters, digits and dashes')
  for (const k of ['title', 'description', 'dialect']) if (typeof m[k] !== 'string' || !m[k]) bad.push(`${k} is required`)
  if (!['sql', 'documents', 'api'].includes(m.kind)) bad.push('kind is sql, documents or api')
  if (!Array.isArray(m.levels) || !m.levels.length || m.levels.some((l: any) => !['project', 'user'].includes(l))) bad.push('levels are project and/or user')
  if (!Array.isArray(m.identity) || !m.identity.length || m.identity.some((l: any) => !['shared', 'person-key', 'person-oauth'].includes(l))) bad.push('identity is shared, person-key and/or person-oauth')
  if (Array.isArray(m.identity) && m.identity.includes('person-oauth') && !(typeof m.oauth?.provider === 'string' && Array.isArray(m.oauth?.scopes) && m.oauth.scopes.length && m.oauth.scopes.every((x: any) => typeof x === 'string')))
    bad.push('a connector people sign in to (person-oauth) names its provider and scopes: oauth { provider, scopes }')
  if (!Array.isArray(m.fields)) bad.push('fields is a list')
  else for (const f of m.fields) {
    if (!f?.name || !f?.label) bad.push('each field has a name and a label')
    if (!['text', 'secret', 'number', 'url', 'select', 'textarea'].includes(f?.type)) bad.push(`field ${f?.name}: type is text, secret, number, url, select or textarea`)
    if (f?.type === 'select' && (!Array.isArray(f.options) || !f.options.length)) bad.push(`field ${f?.name}: a select has options`)
    if (f?.when) for (const [k, v] of Object.entries(f.when)) { const o = m.fields.find((x: any) => x.name === k); if (!o) bad.push(`field ${f.name}: when names ${k}, which is not a field`); else if (o.options && !o.options.includes(v)) bad.push(`field ${f.name}: when ${k} is ${v}, which ${k} cannot be`) }
  }
  return bad
}
