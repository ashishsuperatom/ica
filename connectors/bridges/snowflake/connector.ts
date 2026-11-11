// THE SNOWFLAKE CONNECTOR (manifest.json) — over Snowflake's SQL API v2 (HTTPS, no driver): a statement is posted to
// /api/v2/statements; one that takes longer than the first answer is polled by its handle (202 until done); a large
// result comes in partitions, read one after another. Its columns' types (resultSetMetaData.rowType) turn the API's text
// values into plain JSON — numbers, ISO dates and times. @name values are bound as the API's positional bindings, never
// written into the text.
//
// Sign-in: a programmatic access token (Bearer, token type PROGRAMMATIC_ACCESS_TOKEN), or a key pair — a JWT signed
// with the user's private key (RS256), made again before it expires. Snowflake has no read-only session: it reads with a
// role that may only read (the setup grants one), and the platform's rewrite sends it SELECTs only.
//
//   settings: { account, auth?, user?, warehouse?, role?, database, schemas? }    secrets: { token? | privateKey, passphrase? }

import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { call, ident, isTransientError, listOf, named, plainNumber, privateKeyOf, reachable, signJwt, signaturesOf, sleep, SourceError } from '../../src/warehouse'

const SYSTEM = 'Snowflake'
const STATEMENT_TIMEOUT_S = 120
const DEADLINE_MS = 150_000
/** An identifier Snowflake reads as written, without quotes (it stores it upper-case). */
const BARE = /^[A-Z_][A-Z0-9_$]*$/

/** Whatever a person pastes for their account → the host the API answers on and the account as a key-pair JWT names it.
 *  Accepted: an account URL (https://xy12345.eu-west-1.snowflakecomputing.com), a Snowsight URL
 *  (https://app.snowflake.com/myorg/myaccount/…), an organisation and account (myorg-myaccount or myorg.myaccount), or
 *  a locator with its region (xy12345.eu-west-1, xy12345.us-east-2.aws; a bare locator is in AWS us-west-2). */
export function accountOf(raw: unknown): { host: string; account: string } {
  let s = String(raw ?? '').trim().replace(/^jdbc:snowflake:\/\//i, 'https://')
  if (!s) throw new SourceError('give the Snowflake account (its URL, or myorg-myaccount)')
  let host = ''
  if (/^[a-z]+:\/\//i.test(s) || /^app\.snowflake\.com\//i.test(s)) {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`)
    if (/^app\.snowflake\.com$/i.test(u.hostname)) {
      const [a, b] = u.pathname.split('/').filter(Boolean)
      if (!a || !b) throw new SourceError(`${s} names no account — copy the account URL (Snowsight: your name → Account → View account details)`)
      // app.snowflake.com/<region>/<locator> (older) or app.snowflake.com/<org>/<account>
      s = /^[a-z]{2,}-[a-z]+-\d+(\.[a-z]+)?$/i.test(a) ? `${b}.${a}` : `${a}-${b}`
    } else host = u.hostname
  }
  if (!host) {
    s = s.replace(/\/.*$/, '')
    if (/\.snowflakecomputing\.(com|cn)$/i.test(s)) host = s
    else {
      const parts = s.split('.')
      // a locator with its region (xy12345.eu-west-1[.aws]) keeps its dots; myorg.myaccount is the org-account form
      const regional = parts.length > 1 && /^[a-z]{2,}-[a-z]+(-[a-z]+)?-\d+$/i.test(parts[1])
      const id = regional ? s : parts.length === 2 ? `${parts[0]}-${parts[1]}` : s
      host = `${id}.snowflakecomputing.com`
    }
  }
  host = host.toLowerCase().replace(/_/g, '-')
  if (!/^[a-z0-9][a-z0-9.-]*\.snowflakecomputing\.(com|cn)$/.test(host)) throw new SourceError(`${String(raw)} is not a Snowflake account — copy its URL, or give it as myorg-myaccount`)
  return { host, account: host.split('.')[0].toUpperCase() }
}

/** One value as the API gives it (text) → plain JSON by its column's type. Dates are days since 1970; times and
 *  timestamps are seconds since then (a TIMESTAMP_TZ followed by its offset). */
function valueOf(v: unknown, col: { type?: string; scale?: number }): unknown {
  if (v === null || v === undefined) return null
  const s = String(v), t = String(col.type ?? '').toLowerCase()
  if (t === 'fixed') return plainNumber(s)
  if (t === 'real') return Number(s)
  if (t === 'boolean') return s === 'true' || s === '1' || s === 'TRUE'
  if (t === 'date') return /^-?\d+$/.test(s) ? new Date(Number(s) * 86_400_000).toISOString().slice(0, 10) : s
  if (t === 'time') { const n = Number(s); if (!Number.isFinite(n)) return s; return new Date(n * 1000).toISOString().slice(11, 23) }
  if (t.startsWith('timestamp')) {
    const n = Number(s.split(' ')[0]); if (!Number.isFinite(n)) return s
    const iso = new Date(Math.round(n * 1000)).toISOString()
    return t === 'timestamp_ntz' ? iso.slice(0, -1) : iso   // NTZ holds no zone: written without one
  }
  if (t === 'variant' || t === 'object' || t === 'array') { try { return JSON.parse(s) } catch { return s } }
  return s
}

/** A value bound to a statement: the API's binding type and its value as text. */
function binding(v: unknown): { type: string; value: string | null } {
  if (v === null || v === undefined) return { type: 'TEXT', value: null }
  if (typeof v === 'boolean') return { type: 'BOOLEAN', value: String(v) }
  if (typeof v === 'number' || typeof v === 'bigint') return { type: Number.isInteger(Number(v)) ? 'FIXED' : 'REAL', value: String(v) }
  if (v instanceof Date) return { type: 'TEXT', value: v.toISOString() }
  if (typeof v === 'object') throw new SourceError('a list or an object cannot be bound to @name — bind each value on its own')
  return { type: 'TEXT', value: String(v) }
}

const DESCRIPTION = 'Snowflake SQL: tables are SCHEMA.TABLE (the database is the session\'s); unquoted names are upper-case, a name in "double quotes" is case-sensitive; LIMIT n; DATE_TRUNC(\'month\', d), DATEADD(day, n, d), IFF(c, a, b), ILIKE; a VARIANT is read with col:field::type. Bind values with @name.'

export function createBridge({ settings = {}, secrets = {}, fetch: given }: { settings?: Record<string, any>; secrets?: Record<string, string>; fetch?: typeof fetch } = {}) {
  const fetchFn = given ?? fetch
  const keyPair = String(settings.auth ?? 'token') === 'key-pair'
  const configured = !!(settings.account && settings.database && (keyPair ? settings.user && secrets.privateKey : secrets.token))
  const schemas = listOf(settings.schemas)
  const at = () => accountOf(settings.account)
  const db = () => ident(String(settings.database ?? ''), /^[A-Za-z_][A-Za-z0-9_$]*$/)

  // A key pair's JWT, made once and again five minutes before its hour is up.
  let jwt: { token: string; until: number } | null = null
  function authHeaders(): Record<string, string> {
    if (!keyPair) {
      if (!secrets.token) throw new SourceError('give a programmatic access token')
      return { authorization: `Bearer ${secrets.token}`, 'x-snowflake-authorization-token-type': 'PROGRAMMATIC_ACCESS_TOKEN' }
    }
    if (!jwt || Date.now() > jwt.until) {
      const key = privateKeyOf(String(secrets.privateKey ?? ''), secrets.passphrase)
      const fingerprint = 'SHA256:' + createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('base64')
      const user = String(settings.user ?? '').toUpperCase(), account = at().account, now = Math.floor(Date.now() / 1000)
      jwt = { token: signJwt({ iss: `${account}.${user}.${fingerprint}`, sub: `${account}.${user}`, iat: now, exp: now + 3600 }, key), until: Date.now() + 55 * 60_000 }
    }
    return { authorization: `Bearer ${jwt.token}`, 'x-snowflake-authorization-token-type': 'KEYPAIR_JWT' }
  }
  const said = (d: any) => (d?.message ? { message: String(d.message).replace(/\s+/g, ' ').trim(), code: d.code ? String(d.code) : undefined } : undefined)
  const api = (path: string, o: { method?: string; body?: unknown } = {}) =>
    call(fetchFn, `https://${at().host}${path}`, { system: SYSTEM, ...o, headers: { ...authHeaders(), 'user-agent': 'Superatom/1.0' }, said })

  /** Run one statement: posted, polled while it runs, every partition of its result read. Rows as objects by column. */
  async function run(statement: string, bindings?: Record<string, { type: string; value: string | null }>): Promise<Record<string, unknown>[]> {
    const body = {
      statement, timeout: STATEMENT_TIMEOUT_S, database: String(settings.database),
      ...(settings.warehouse ? { warehouse: String(settings.warehouse) } : {}), ...(settings.role ? { role: String(settings.role) } : {}),
      ...(bindings && Object.keys(bindings).length ? { bindings } : {}),
    }
    let r: { status: number; data: any }
    try { r = await api(`/api/v2/statements?requestId=${randomUUID()}`, { body }) }
    catch (e: any) { throw failed(e) }
    const deadline = Date.now() + DEADLINE_MS
    let wait = 250
    while (r.status === 202) {
      const handle = String(r.data?.statementHandle ?? '')
      if (Date.now() > deadline) {
        await api(`/api/v2/statements/${handle}/cancel`, { method: 'POST', body: {} }).catch(() => {})
        throw new SourceError(`${SYSTEM}: the statement did not finish in ${DEADLINE_MS / 1000} seconds (timed out) and was cancelled`)
      }
      await sleep(wait); wait = Math.min(wait * 2, 2000)
      try { r = await api(`/api/v2/statements/${handle}`) } catch (e: any) { throw failed(e) }
    }
    const meta = r.data?.resultSetMetaData ?? {}
    const cols: { name: string; type?: string; scale?: number }[] = meta.rowType ?? []
    const handle = String(r.data?.statementHandle ?? '')
    const data: unknown[][] = [...(r.data?.data ?? [])]
    const parts = Array.isArray(meta.partitionInfo) ? meta.partitionInfo.length : 1
    for (let p = 1; p < parts; p++) {
      const next = await api(`/api/v2/statements/${handle}?partition=${p}`)
      data.push(...(next.data?.data ?? []))
    }
    return data.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, valueOf(row[i], c)])))
  }
  /** A statement's failure (422) said as Snowflake said it. */
  function failed(e: any) {
    if (e instanceof SourceError && e.status === 422) return new SourceError(`${SYSTEM}: ${e.message.replace(/^Snowflake answered 422: /, '')}`, 422, e.code)
    if (e instanceof SourceError && e.status === 408) return new SourceError(`${SYSTEM}: the statement ran longer than ${STATEMENT_TIMEOUT_S} seconds (timed out)`, 408, e.code)
    return e
  }

  async function query(sql: string, params: Record<string, unknown> = {}) {
    if (!configured) throw new SourceError('this source is not configured: the account, the database and a token (or a user and its private key)')
    const { text, occurrences } = named(sql, params, () => '?')
    const bindings = Object.fromEntries(occurrences.map((n, i) => [String(i + 1), binding(params[n])]))
    return run(text.replace(/;\s*$/, ''), bindings)
  }

  /** The schemas asked for, as a filter on an INFORMATION_SCHEMA view (its TABLE_SCHEMA), and their bindings. */
  const where = (alias: string) => ({
    sql: `${alias}.TABLE_SCHEMA <> 'INFORMATION_SCHEMA'${schemas.length ? ` AND UPPER(${alias}.TABLE_SCHEMA) IN (${schemas.map(() => '?').join(', ')})` : ''}`,
    bindings: Object.fromEntries(schemas.map((s, i) => [String(i + 1), { type: 'TEXT', value: s.toUpperCase() }])),
  })
  const tableName = (schema: string, table: string) => `${ident(schema, BARE)}.${ident(table, BARE)}`
  const typeOf = (x: any) => (String(x.DATA_TYPE) === 'NUMBER' && x.NUMERIC_PRECISION != null ? `NUMBER(${x.NUMERIC_PRECISION},${x.NUMERIC_SCALE ?? 0})` : String(x.DATA_TYPE))
  const COLUMNS = (w: { sql: string }) => `SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.IS_NULLABLE, c.COMMENT,
      t.TABLE_TYPE, t.COMMENT AS TABLE_COMMENT, t.ROW_COUNT
    FROM ${db()}.INFORMATION_SCHEMA.COLUMNS c JOIN ${db()}.INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
    WHERE ${w.sql} ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`

  /** The keys the role may see: SHOW PRIMARY KEYS / SHOW IMPORTED KEYS (Snowflake keeps them, though it does not enforce
   *  them). A role that may not run them leaves the tables without keys, never without their columns. */
  async function keys() {
    const lower = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])) as Record<string, any>
    const pk = await run(`SHOW PRIMARY KEYS IN DATABASE ${db()}`).then((rs) => rs.map(lower)).catch(() => [])
    const fk = await run(`SHOW IMPORTED KEYS IN DATABASE ${db()}`).then((rs) => rs.map(lower)).catch(() => [])
    const primary = new Set(pk.map((k) => `${tableName(k.schema_name, k.table_name)}\n${k.column_name}`))
    const refs = new Map(fk.map((k) => [`${tableName(k.fk_schema_name, k.fk_table_name)}\n${k.fk_column_name}`, `${tableName(k.pk_schema_name, k.pk_table_name)}.${k.pk_column_name}`]))
    return { primary, refs }
  }

  async function introspect() {
    const w = where('c')
    const rows = await run(COLUMNS(w), w.bindings)
    const { primary, refs } = await keys()
    const tables = new Map<string, any>()
    for (const x of rows as any[]) {
      const name = tableName(x.TABLE_SCHEMA, x.TABLE_NAME)
      const t = tables.get(name) ?? { name, ...(x.TABLE_COMMENT ? { description: String(x.TABLE_COMMENT) } : {}), ...(x.ROW_COUNT != null ? { rows: Number(x.ROW_COUNT) } : {}), columns: [] }
      const k = `${name}\n${x.COLUMN_NAME}`
      t.columns.push({ name: x.COLUMN_NAME, type: typeOf(x), nullable: x.IS_NULLABLE === 'YES', ...(x.COMMENT ? { description: String(x.COMMENT) } : {}), ...(primary.has(k) ? { key: true } : {}), ...(refs.has(k) ? { references: refs.get(k) } : {}) })
      tables.set(name, t)
    }
    return { kind: 'sql', dialect: 'snowflake', tables: [...tables.values()] }
  }

  /** Per table, a hash of its columns and their types — from one query of the catalog. (LAST_ALTERED moves with every
   *  write to a table's rows too, so it would say a table changed when only its data did.) */
  async function signatures() {
    const w = where('c')
    const rows = await run(`SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.NUMERIC_PRECISION, c.NUMERIC_SCALE
      FROM ${db()}.INFORMATION_SCHEMA.COLUMNS c WHERE ${w.sql}`, w.bindings)
    return signaturesOf(rows.map((x: any) => ({ table: tableName(x.TABLE_SCHEMA, x.TABLE_NAME), column: String(x.COLUMN_NAME), type: typeOf(x) })))
  }

  return {
    id: 'snowflake', kind: 'sql' as const, dialect: 'snowflake',
    description: String(settings.description ?? '') || DESCRIPTION,
    ready: () => configured,
    async test() {
      const [r] = await run('SELECT CURRENT_USER() AS "user", CURRENT_ROLE() AS "role", CURRENT_WAREHOUSE() AS "warehouse", CURRENT_DATABASE() AS "database"') as any[]
      if (!r?.database) throw new SourceError(`signed in as ${r?.user}, but the database ${settings.database} does not exist or role ${r?.role} may not use it`)
      if (!r?.warehouse) throw new SourceError(`signed in as ${r?.user}, but there is no warehouse to run queries: name one that role ${r?.role} may use`)
      return `signed in as ${r.user} (role ${r.role}) on ${at().host}, warehouse ${r.warehouse}, database ${r.database}`
    },
    // Its own setup checks (manifest.json setup, check: custom).
    async check(name: string): Promise<string> {
      if (name === 'account') { const { host } = at(); await reachable(fetchFn, `https://${host}/api/v2/statements`, SYSTEM); return `found the account at ${host}` }
      if (name === 'tables') {
        const w = where('t')
        const rows = await run(`SELECT t.TABLE_SCHEMA AS "s", COUNT(*) AS "n" FROM ${db()}.INFORMATION_SCHEMA.TABLES t WHERE ${w.sql} GROUP BY 1 ORDER BY 2 DESC`, w.bindings) as any[]
        const total = rows.reduce((n, x) => n + Number(x.n), 0)
        if (!total) throw new SourceError(`permission denied: the role may read no table in ${settings.database}${schemas.length ? ` (${schemas.join(', ')})` : ''}`)
        return `it may read ${total} table${total === 1 ? '' : 's'} (${rows.map((x) => `${x.s} ${x.n}`).join(', ')})`
      }
      throw new SourceError(`there is no check ${name}`)
    },
    isTransient: isTransientError, query, introspect, signatures,
    close: () => { jwt = null },
  }
}
