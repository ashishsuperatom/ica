// THE BIGQUERY CONNECTOR (manifest.json) — over the BigQuery REST API (HTTPS, no driver). Signed in as a service account:
// its JSON key signs a JWT (RS256), exchanged at Google's token endpoint for an access token, kept until shortly before
// it expires. A query runs with jobs.query (standard SQL); one not done within the first answer is polled with
// getQueryResults, and its further pages followed by pageToken. @name is BigQuery's own parameter syntax: the values are
// sent as named query parameters, never written into the text. Its tables are described from the REST metadata —
// datasets, tables (description, rows), their schemas (RECORD fields flattened as a.b) and the keys BigQuery keeps.
// Read-only by the service account's roles (BigQuery Data Viewer and Job User): it may read and run queries, not write.
//
//   settings: { project?, datasets?, location? }    secrets: { key }  (the service account's JSON key)

import { randomUUID } from 'node:crypto'
import { call, ident, isTransientError, listOf, named, plainNumber, privateKeyOf, signJwt, signaturesOf, sleep, SourceError } from '../../src/warehouse'

const SYSTEM = 'BigQuery'
const API = 'https://bigquery.googleapis.com/bigquery/v2'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/bigquery'
const DEADLINE_MS = 150_000
const PAGE = 10_000
const PARALLEL = 8
const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/

type Schema = { name: string; type: string; mode?: string; description?: string; fields?: Schema[] }

/** One value as the API gives it (f/v cells, text) → plain JSON by its field: a record an object, a repeated field a
 *  list, numbers as numbers where a double holds them, a TIMESTAMP (microseconds) an ISO time. */
function valueOf(v: any, f: Schema): unknown {
  if (f.mode === 'REPEATED') return Array.isArray(v) ? v.map((x: any) => valueOf(x?.v, { ...f, mode: 'NULLABLE' })) : []
  if (v === null || v === undefined) return null
  switch (f.type) {
    case 'RECORD': case 'STRUCT': return Object.fromEntries((f.fields ?? []).map((sub, i) => [sub.name, valueOf(v?.f?.[i]?.v, sub)]))
    case 'INTEGER': case 'INT64': case 'NUMERIC': case 'BIGNUMERIC': return plainNumber(v)
    case 'FLOAT': case 'FLOAT64': { const n = Number(v); return Number.isFinite(n) ? n : String(v) }
    case 'BOOLEAN': case 'BOOL': return v === 'true' || v === true
    case 'TIMESTAMP': return /^-?\d+$/.test(String(v)) ? new Date(Number(v) / 1000).toISOString() : String(v)
    case 'JSON': try { return JSON.parse(v) } catch { return v }
    default: return v
  }
}

/** A value as a named query parameter: its type and value (a list as an ARRAY of its first item's type). */
function parameter(name: string, v: unknown): Record<string, unknown> {
  const typeOf = (x: unknown): string => typeof x === 'boolean' ? 'BOOL' : typeof x === 'bigint' || (typeof x === 'number' && Number.isInteger(x)) ? 'INT64' : typeof x === 'number' ? 'FLOAT64' : x instanceof Date ? 'TIMESTAMP' : 'STRING'
  const text = (x: unknown) => (x instanceof Date ? x.toISOString() : String(x))
  if (Array.isArray(v)) {
    if (v.some((x) => x !== null && typeof x === 'object' && !(x instanceof Date))) throw new SourceError(`@${name}: a list of plain values can be bound, not of objects`)
    return { name, parameterType: { type: 'ARRAY', arrayType: { type: typeOf(v.find((x) => x !== null && x !== undefined) ?? '') } }, parameterValue: { arrayValues: v.map((x) => ({ value: text(x) })) } }
  }
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) throw new SourceError(`@${name}: an object cannot be bound — bind each value on its own`)
  return { name, parameterType: { type: typeOf(v) }, parameterValue: v === null || v === undefined ? {} : { value: text(v) } }
}

/** A table's fields as columns: a RECORD's fields flattened as a.b (a field inside a repeated record is read with UNNEST). */
function columnsOf(fields: Schema[], prefix = '', repeated = false): any[] {
  const out: any[] = []
  for (const f of fields ?? []) {
    const name = prefix ? `${prefix}.${f.name}` : f.name
    const inArray = repeated || f.mode === 'REPEATED'
    if ((f.type === 'RECORD' || f.type === 'STRUCT') && f.fields?.length) { out.push(...columnsOf(f.fields, name, inArray)); continue }
    const said = [repeated ? `Inside a repeated record: read it with UNNEST.` : '', f.description ?? ''].filter(Boolean).join(' ')
    out.push({ name, type: f.mode === 'REPEATED' ? `ARRAY<${f.type}>` : f.type, nullable: f.mode !== 'REQUIRED' || repeated, ...(said ? { description: said } : {}) })
  }
  return out
}

/** At most `n` at a time, in order. */
async function inTurn<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await f(items[i]) } }))
  return out
}

const DESCRIPTION = 'BigQuery GoogleSQL (standard SQL): tables are dataset.table (a name with a dash in `backticks`: `dataset.my-table`); LIMIT n; DATE_TRUNC(d, MONTH), DATE_SUB(d, INTERVAL 7 DAY), SAFE_DIVIDE(a, b), COUNTIF(c); a column a.b is a RECORD\'s field; a repeated field is read with UNNEST. Bind values with @name (a list: x IN UNNEST(@list)).'

export function createBridge({ settings = {}, secrets = {}, fetch: given }: { settings?: Record<string, any>; secrets?: Record<string, string>; fetch?: typeof fetch } = {}) {
  const fetchFn = given ?? fetch
  const configured = !!secrets.key
  const only = listOf(settings.datasets)

  /** The service account's key, read from its JSON, refused in words. */
  let parsed: { client_email: string; private_key: string; private_key_id?: string; project_id?: string } | null = null
  function key() {
    if (parsed) return parsed
    let k: any
    try { k = JSON.parse(String(secrets.key ?? '')) } catch { throw new SourceError('the service account key is not JSON — paste the whole key file, from { to }') }
    if (k?.type !== 'service_account' || !k.client_email || !k.private_key) throw new SourceError('that is not a service account key: it has no client_email and private_key (make a JSON key for a service account)')
    return (parsed = k)
  }
  const project = () => String(settings.project || key().project_id || '')

  // The access token: a JWT signed with the key, exchanged at Google's token endpoint; kept until a minute before it ends.
  let token: { value: string; until: number } | null = null
  async function bearer(): Promise<string> {
    if (token && Date.now() < token.until) return token.value
    const k = key(), now = Math.floor(Date.now() / 1000)
    const assertion = signJwt({ iss: k.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }, privateKeyOf(k.private_key), k.private_key_id ? { kid: k.private_key_id } : {})
    try {
      const { data } = await call(fetchFn, TOKEN_URL, { system: 'Google', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' },
        said: (d) => ({ message: [d?.error, d?.error_description].filter(Boolean).join(': '), code: d?.error }) })
      token = { value: String(data.access_token), until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 }
      return token.value
    } catch (e: any) { throw new SourceError(`Google refused the service account's key (${k.client_email}): ${e.message.replace(/^Google answered \d+: /, '')}`, e.status, e.code) }
  }
  const said = (d: any) => (d?.error ? { message: String(d.error.message ?? d.error), code: d.error.errors?.[0]?.reason ?? d.error.status } : undefined)
  const api = async (path: string, o: { method?: string; body?: unknown } = {}) =>
    (await call(fetchFn, `${API}${path}`, { system: SYSTEM, ...o, headers: { authorization: `Bearer ${await bearer()}` }, said })).data
  const p = () => `/projects/${encodeURIComponent(project())}`

  /** Run a query: posted, polled until done, every page followed. Rows as objects by field. */
  async function run(sql: string, params: Record<string, unknown> = {}, location?: string): Promise<Record<string, unknown>[]> {
    const { names } = named(sql, params, (n) => `@${n}`)
    const loc: Record<string, string> = location || settings.location ? { location: String(location || settings.location) } : {}
    let r: any = await api(`${p()}/queries`, { body: {
      query: sql, useLegacySql: false, requestId: randomUUID(), timeoutMs: 20_000, maxResults: PAGE, formatOptions: { useInt64Timestamp: true }, ...loc,
      ...(names.length ? { parameterMode: 'NAMED', queryParameters: names.map((n) => parameter(n, params[n])) } : {}),
    } })
    const job = r.jobReference ?? {}
    // getQueryResults: where the job ran, how long to wait for it, a page's size, timestamps as microseconds
    const at: Record<string, string> = { ...loc, ...(job.location ? { location: String(job.location) } : {}), timeoutMs: '20000', maxResults: String(PAGE), 'formatOptions.useInt64Timestamp': 'true' }
    const deadline = Date.now() + DEADLINE_MS
    while (!r.jobComplete) {
      if (Date.now() > deadline) {
        await api(`${p()}/jobs/${encodeURIComponent(job.jobId)}/cancel?${new URLSearchParams(job.location ? { location: job.location } : {})}`, { method: 'POST' }).catch(() => {})
        throw new SourceError(`${SYSTEM}: the query did not finish in ${DEADLINE_MS / 1000} seconds (timed out) and was cancelled`)
      }
      await sleep(200)
      r = await api(`${p()}/queries/${encodeURIComponent(job.jobId)}?${new URLSearchParams(at)}`)
    }
    const fields: Schema[] = r.schema?.fields ?? []
    const rows: Record<string, unknown>[] = []
    const take = (page: any) => { for (const row of page.rows ?? []) rows.push(Object.fromEntries(fields.map((f, i) => [f.name, valueOf(row.f?.[i]?.v, f)]))) }
    take(r)
    while (r.pageToken) {
      r = await api(`${p()}/queries/${encodeURIComponent(job.jobId)}?${new URLSearchParams({ ...at, pageToken: String(r.pageToken) })}`)
      take(r)
    }
    return rows
  }

  async function query(sql: string, params: Record<string, unknown> = {}) {
    if (!configured) throw new SourceError('this source is not configured: the service account key')
    return run(String(sql).replace(/;\s*$/, ''), params)
  }

  /** Every page of a REST listing (datasets, tables): its items under `field`. */
  async function listAll(path: string, field: string): Promise<any[]> {
    const out: any[] = []
    let pageToken = ''
    do {
      const d = await api(`${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({ maxResults: '1000', ...(pageToken ? { pageToken } : {}) })}`)
      out.push(...(d?.[field] ?? []))
      pageToken = d?.nextPageToken ?? ''
    } while (pageToken)
    return out
  }
  /** The datasets to read: those named, else every one the project holds — with where each is. */
  async function datasets(): Promise<{ id: string; location?: string }[]> {
    if (only.length) return inTurn(only, PARALLEL, async (id) => ({ id, location: (await api(`${p()}/datasets/${encodeURIComponent(id)}`))?.location }))
    return (await listAll(`${p()}/datasets`, 'datasets')).map((d) => ({ id: d.datasetReference.datasetId, location: d.location }))
  }
  const tableName = (dataset: string, table: string) => (BARE.test(dataset) && BARE.test(table) ? `${dataset}.${table}` : ident(`${dataset}.${table}`, /^$/, '`'))
  const refName = (r: { projectId?: string; datasetId: string; tableId: string }) => (r.projectId && r.projectId !== project() ? `${r.projectId}.` : '') + tableName(r.datasetId, r.tableId)

  async function introspect() {
    const tables: any[] = []
    for (const ds of await datasets()) {
      const listed = await listAll(`${p()}/datasets/${encodeURIComponent(ds.id)}/tables`, 'tables')
      const full = await inTurn(listed, PARALLEL, (t) => api(`${p()}/datasets/${encodeURIComponent(ds.id)}/tables/${encodeURIComponent(t.tableReference.tableId)}`))
      for (const t of full) {
        const name = tableName(ds.id, t.tableReference.tableId)
        const pk = new Set<string>(t.tableConstraints?.primaryKey?.columns ?? [])
        const refs = new Map<string, string>()
        for (const fk of t.tableConstraints?.foreignKeys ?? []) for (const c of fk.columnReferences ?? []) refs.set(c.referencingColumn, `${refName(fk.referencedTable)}.${c.referencedColumn}`)
        tables.push({
          name, ...(t.description ? { description: t.description } : {}), ...(t.type === 'TABLE' && t.numRows != null ? { rows: Number(t.numRows) } : {}),
          columns: columnsOf(t.schema?.fields ?? []).map((c) => ({ ...c, ...(pk.has(c.name) ? { key: true } : {}), ...(refs.has(c.name) ? { references: refs.get(c.name) } : {}) })),
        })
      }
    }
    return { kind: 'sql', dialect: 'bigquery', tables }
  }

  /** Per table, a hash of its columns and their types: one query of each dataset's INFORMATION_SCHEMA.COLUMNS (a
   *  RECORD's type there names its fields, so a nested change is seen too). lastModifiedTime moves with every write to a
   *  table's rows, so it would say a table changed when only its data did. */
  async function signatures() {
    const out: Record<string, string> = {}
    for (const ds of await datasets()) {
      const rows = await run(`SELECT table_name, column_name, data_type FROM \`${project()}.${ds.id}\`.INFORMATION_SCHEMA.COLUMNS`, {}, ds.location)
      Object.assign(out, signaturesOf(rows.map((x: any) => ({ table: tableName(ds.id, x.table_name), column: x.column_name, type: x.data_type }))))
    }
    return out
  }

  return {
    id: 'bigquery', kind: 'sql' as const, dialect: 'bigquery',
    description: String(settings.description ?? '') || DESCRIPTION,
    ready: () => configured,
    async test() {
      const [r] = await run('SELECT SESSION_USER() AS user') as any[]
      return `signed in as ${r?.user ?? key().client_email} on project ${project()}`
    },
    // Its own setup checks (manifest.json setup, check: custom): the tables it may read, by dataset.
    async check(name: string): Promise<string> {
      if (name !== 'tables') throw new SourceError(`there is no check ${name}`)
      const counts = await inTurn(await datasets(), PARALLEL, async (ds) => [ds.id, (await listAll(`${p()}/datasets/${encodeURIComponent(ds.id)}/tables`, 'tables')).length] as const)
      const total = counts.reduce((n, [, c]) => n + c, 0)
      if (!total) throw new SourceError(`permission denied: the service account may read no table in project ${project()}${only.length ? ` (${only.join(', ')})` : ''}`)
      return `it may read ${total} table${total === 1 ? '' : 's'} (${counts.filter(([, c]) => c).map(([d, c]) => `${d} ${c}`).join(', ')})`
    },
    isTransient: (e: any) => isTransientError(e) || /rateLimitExceeded|backendError|internalError/.test(String(e?.code ?? '')),
    query, introspect, signatures,
    close: () => { token = null },
  }
}
