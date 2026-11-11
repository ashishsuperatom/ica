// THE DATABRICKS CONNECTOR (manifest.json) — over the Databricks SQL Statement Execution API (HTTPS, no driver): a
// statement is posted to /api/2.0/sql/statements with its SQL warehouse, waits up to 30 seconds for its answer, and one
// still running is polled by its id; a large result comes in chunks, followed by next_chunk_index. Its columns' types
// (manifest.schema) turn the API's text values into plain JSON. @name values are sent as the API's named parameters
// (:name), never written into the text. Its tables come from the catalog's information_schema (Unity Catalog), with their
// comments and the keys it keeps.
//
// Sign-in: a personal access token (Bearer). Databricks has no read-only session: it reads as a user (or service
// principal) granted only USE CATALOG, USE SCHEMA and SELECT, and the platform's rewrite sends it SELECTs only.
//
//   settings: { workspace, warehouse?, catalog?, schemas? }    secrets: { token }

import { call, ident, isTransientError, keysFrom, keysSql, listOf, named, plainNumber, reachable, signaturesOf, sleep, SourceError } from '../../src/warehouse'

const SYSTEM = 'Databricks'
const DEADLINE_MS = 150_000
const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whatever a person pastes for the workspace → its address, and the warehouse when what was pasted names one: a
 *  workspace URL (https://adb-123.4.azuredatabricks.net/?o=123), a server hostname (dbc-a1b2c3d4-e5f6.cloud.databricks.com)
 *  or a warehouse's JDBC URL (jdbc:databricks://host:443/default;…;httpPath=/sql/1.0/warehouses/abc123). */
export function workspaceOf(raw: unknown): { url: string; warehouse?: string } {
  const s = String(raw ?? '').trim()
  if (!s) throw new SourceError('give the workspace (its URL, or the server hostname)')
  const jdbc = /^jdbc:(?:databricks|spark):\/\/([^/:;]+)/i.exec(s)
  const host = jdbc ? jdbc[1] : (() => { try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).hostname } catch { return '' } })()
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(host)) throw new SourceError(`${s} is not a Databricks workspace — copy its URL from the browser, or the Server hostname (SQL Warehouses → your warehouse → Connection details)`)
  const path = /httpPath=([^;]+)/i.exec(s)?.[1] ?? (jdbc ? '' : (() => { try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).pathname } catch { return '' } })())
  const warehouse = warehouseOf(path, true)
  return { url: `https://${host.toLowerCase()}`, ...(warehouse ? { warehouse } : {}) }
}
/** A warehouse's id, or its HTTP path (/sql/1.0/warehouses/<id>; older ones /sql/1.0/endpoints/<id>) → its id. */
export function warehouseOf(raw: unknown, quiet = false): string | undefined {
  const s = String(raw ?? '').trim()
  const m = /\/sql\/[\d.]+\/(?:warehouses|endpoints)\/([\w-]+)/.exec(s)
  if (m) return m[1]
  if (/^[\w-]+$/.test(s)) return s
  if (s && !quiet) throw new SourceError(`${s} is not a SQL warehouse — give its ID, or its HTTP path (/sql/1.0/warehouses/…)`)
  return undefined
}

/** One value as the API gives it (text) → plain JSON by its column's type. */
function valueOf(v: unknown, type: string): unknown {
  if (v === null || v === undefined) return null
  const s = String(v)
  switch (type) {
    case 'BYTE': case 'SHORT': case 'INT': case 'LONG': case 'DECIMAL': return plainNumber(s)
    case 'FLOAT': case 'DOUBLE': { const n = Number(s); return Number.isFinite(n) ? n : s }
    case 'BOOLEAN': return s === 'true'
    case 'ARRAY': case 'MAP': case 'STRUCT': try { return JSON.parse(s) } catch { return s }
    default: return s
  }
}

/** A value as a named parameter: its type (as Databricks SQL names it) and its value as text (none: NULL). */
function parameter(name: string, v: unknown): { name: string; type: string; value?: string } {
  if (v === null || v === undefined) return { name, type: 'STRING' }
  if (typeof v === 'boolean') return { name, type: 'BOOLEAN', value: String(v) }
  if (typeof v === 'number' || typeof v === 'bigint') return { name, type: Number.isInteger(Number(v)) ? 'BIGINT' : 'DOUBLE', value: String(v) }
  if (v instanceof Date) return { name, type: 'TIMESTAMP', value: v.toISOString() }
  if (typeof v === 'object') throw new SourceError(`@${name}: a list or an object cannot be bound — bind each value on its own`)
  return { name, type: 'STRING', value: String(v) }
}

const DESCRIPTION = 'Databricks SQL: tables are schema.table (the catalog is the session\'s; another catalog\'s as catalog.schema.table); identifiers in `backticks` when they need quoting; LIMIT n; date_trunc(\'MONTH\', d), date_add(d, n), try_divide(a, b), a JSON string read with col:field. Bind values with @name.'

export function createBridge({ settings = {}, secrets = {}, fetch: given }: { settings?: Record<string, any>; secrets?: Record<string, string>; fetch?: typeof fetch } = {}) {
  const fetchFn = given ?? fetch
  const schemas = listOf(settings.schemas)
  const where = () => workspaceOf(settings.workspace)
  const warehouse = () => {
    const id = warehouseOf(settings.warehouse) ?? where().warehouse
    if (!id) throw new SourceError('give the SQL warehouse — its ID, or its HTTP path (SQL Warehouses → your warehouse → Connection details)')
    return id
  }
  const configured = !!(settings.workspace && secrets.token && (settings.warehouse || /httpPath=/i.test(String(settings.workspace))))
  const said = (d: any) => (d?.message ? { message: String(d.message), code: d.error_code ? String(d.error_code) : undefined } : undefined)
  const api = async (path: string, o: { method?: string; body?: unknown } = {}) =>
    (await call(fetchFn, `${where().url}${path}`, { system: SYSTEM, ...o, headers: { authorization: `Bearer ${secrets.token ?? ''}`, 'user-agent': 'Superatom/1.0' }, said })).data

  /** Run one statement: posted (waiting up to 30 s), polled while it runs, every chunk of its result read. */
  async function run(statement: string, params: { name: string; type: string; value?: string }[] = []): Promise<Record<string, unknown>[]> {
    let r: any = await api('/api/2.0/sql/statements', { body: {
      statement, warehouse_id: warehouse(), ...(settings.catalog ? { catalog: String(settings.catalog) } : {}),
      ...(params.length ? { parameters: params } : {}), wait_timeout: '30s', on_wait_timeout: 'CONTINUE', disposition: 'INLINE', format: 'JSON_ARRAY',
    } })
    const id = String(r?.statement_id ?? '')
    const deadline = Date.now() + DEADLINE_MS
    let wait = 250
    while (['PENDING', 'RUNNING'].includes(r?.status?.state)) {
      if (Date.now() > deadline) {
        await api(`/api/2.0/sql/statements/${id}/cancel`, { method: 'POST', body: {} }).catch(() => {})
        throw new SourceError(`${SYSTEM}: the statement did not finish in ${DEADLINE_MS / 1000} seconds (timed out) and was cancelled`)
      }
      await sleep(wait); wait = Math.min(wait * 2, 2000)
      r = await api(`/api/2.0/sql/statements/${id}`)
    }
    const state = r?.status?.state
    if (state === 'FAILED') throw new SourceError(`${SYSTEM}: ${r.status.error?.message ?? 'the statement failed'}`, undefined, r.status.error?.error_code)
    if (state !== 'SUCCEEDED') throw new SourceError(`${SYSTEM}: the statement was ${String(state ?? 'not run').toLowerCase()}`)
    const cols: { name: string; type_name: string }[] = r.manifest?.schema?.columns ?? []
    const data: unknown[][] = [...(r.result?.data_array ?? [])]
    let next = r.result?.next_chunk_index
    while (next !== undefined && next !== null) {
      const chunk = await api(`/api/2.0/sql/statements/${id}/result/chunks/${next}`)
      data.push(...(chunk?.data_array ?? []))
      next = chunk?.next_chunk_index
    }
    return data.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, valueOf(row[i], c.type_name)])))
  }

  async function query(sql: string, params: Record<string, unknown> = {}) {
    if (!configured) throw new SourceError('this source is not configured: the workspace, the SQL warehouse and a token')
    const { text, names } = named(sql, params, (n) => `:${n}`)
    return run(text.replace(/;\s*$/, ''), names.map((n) => parameter(n, params[n])))
  }

  // The catalog read: the one named, else the session's own (the workspace's default).
  let cat: string | null = null
  const catalog = async () => (cat ??= String(settings.catalog || (await run('SELECT current_catalog() AS catalog'))[0]?.catalog || ''))
  const at = async () => `${ident(await catalog(), BARE, '`')}.information_schema`
  const filter = (alias: string) => ({
    sql: `${alias}.table_schema <> 'information_schema'${schemas.length ? ` AND lower(${alias}.table_schema) IN (${schemas.map((_, i) => `:schema${i}`).join(', ')})` : ''}`,
    params: schemas.map((s, i) => ({ name: `schema${i}`, type: 'STRING', value: s.toLowerCase() })),
  })
  const tableName = (schema: string, table: string) => `${ident(schema, BARE, '`')}.${ident(table, BARE, '`')}`

  async function introspect() {
    const f = filter('c'), is = await at()
    const rows = await run(`SELECT c.table_schema, c.table_name, c.column_name, c.full_data_type, c.is_nullable, c.comment, t.table_type, t.comment AS table_comment
      FROM ${is}.columns c JOIN ${is}.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE ${f.sql} ORDER BY c.table_schema, c.table_name, c.ordinal_position`, f.params)
    // Keys where the catalog keeps them (Unity Catalog's informational keys); a catalog without the views has none.
    const { primary, refs } = keysFrom(await run(keysSql(is)).catch(() => []), tableName, await catalog())
    const tables = new Map<string, any>()
    for (const x of rows as any[]) {
      const name = tableName(x.table_schema, x.table_name)
      const t = tables.get(name) ?? { name, ...(x.table_comment ? { description: String(x.table_comment) } : {}), columns: [] }
      const k = `${name}\n${x.column_name}`
      t.columns.push({ name: x.column_name, type: x.full_data_type, nullable: x.is_nullable === 'YES', ...(x.comment ? { description: String(x.comment) } : {}), ...(primary.has(k) ? { key: true } : {}), ...(refs.has(k) ? { references: refs.get(k) } : {}) })
      tables.set(name, t)
    }
    return { kind: 'sql', dialect: 'databricks', tables: [...tables.values()] }
  }

  /** Per table, a hash of its columns and their types — from one query of the catalog. */
  async function signatures() {
    const f = filter('c')
    const rows = await run(`SELECT c.table_schema, c.table_name, c.column_name, c.full_data_type FROM ${await at()}.columns c WHERE ${f.sql}`, f.params)
    return signaturesOf(rows.map((x: any) => ({ table: tableName(x.table_schema, x.table_name), column: String(x.column_name), type: String(x.full_data_type) })))
  }

  return {
    id: 'databricks', kind: 'sql' as const, dialect: 'databricks',
    description: String(settings.description ?? '') || DESCRIPTION,
    ready: () => configured,
    async test() {
      const [r] = await run('SELECT current_user() AS user, current_catalog() AS catalog') as any[]
      return `signed in as ${r?.user} on ${new URL(where().url).host}, warehouse ${warehouse()}, catalog ${r?.catalog}`
    },
    // Its own setup checks (manifest.json setup, check: custom).
    async check(name: string): Promise<string> {
      if (name === 'workspace') { const { url } = where(); warehouse(); await reachable(fetchFn, `${url}/api/2.0/sql/statements`, SYSTEM); return `found the workspace at ${new URL(url).host}, warehouse ${warehouse()}` }
      if (name === 'tables') {
        const f = filter('t')
        const rows = await run(`SELECT t.table_schema AS s, count(*) AS n FROM ${await at()}.tables t WHERE ${f.sql} GROUP BY 1 ORDER BY 2 DESC`, f.params) as any[]
        const total = rows.reduce((n, x) => n + Number(x.n), 0)
        if (!total) throw new SourceError(`permission denied: it may read no table in catalog ${await catalog()}${schemas.length ? ` (${schemas.join(', ')})` : ''}`)
        return `it may read ${total} table${total === 1 ? '' : 's'} in ${await catalog()} (${rows.map((x) => `${x.s} ${x.n}`).join(', ')})`
      }
      throw new SourceError(`there is no check ${name}`)
    },
    isTransient: (e: any) => isTransientError(e) || /TEMPORARILY_UNAVAILABLE|TOO_MANY_REQUESTS|RESOURCE_EXHAUSTED/.test(String(e?.code ?? '')),
    query, introspect, signatures,
    close: () => { cat = null },
  }
}
