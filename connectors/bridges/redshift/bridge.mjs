// THE AMAZON REDSHIFT CONNECTOR (manifest.json) — over the PostgreSQL wire protocol Redshift speaks, with the `pg` driver
// (bundled with it). Provisioned clusters and Serverless workgroups alike, port 5439, SSL by default. Every query runs in
// a READ ONLY transaction (Redshift has no read-only session setting, but refuses writes inside one), with a statement
// timeout; bound values go as $n parameters. Its tables are described from Redshift's own catalog views — SVV_TABLES and
// SVV_COLUMNS (types, comments), SVV_TABLE_INFO (rows) — and the keys information_schema keeps (Redshift does not
// enforce them, but they say how tables join).
//
//   settings: { host, port?, database?, user, schemas?, ssl? }    secrets: { password }

import net from 'node:net'
import pg from 'pg'   // bundled into the connector when the connectors are built: the engine installs nothing for it
import { ident, keysFrom, keysSql, listOf, named, plainNumber, signaturesOf } from '../../src/warehouse.ts'

const POOL = 4
const STATEMENT_TIMEOUT_MS = 120_000
/** An identifier Redshift reads as written, without quotes (it folds names to lower case). */
const BARE = /^[a-z_][a-z0-9_$]*$/
/** Redshift's own schemas, never read for data. */
const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema', 'pg_internal', 'pg_automv', 'catalog_history', 'pg_auto_copy', 'pg_s3', 'pg_mv')`

/** Whatever a person pastes as the address → host, port and database: the console's Endpoint
 *  (examplecluster.abc123.us-west-2.redshift.amazonaws.com:5439/dev), a JDBC URL (jdbc:redshift://host:5439/dev), or a host. */
export function endpointOf(raw) {
  const s = String(raw ?? '').trim().replace(/^(jdbc:)?(redshift|postgres(ql)?):\/\//i, '').replace(/^[^@/]*@/, '')
  const m = /^([^:/?;\s]+)(?::(\d+))?(?:\/([^?;\s]+))?/.exec(s)
  if (!m) throw new Error('give the address of the cluster or workgroup (its Endpoint)')
  return { host: m[1].toLowerCase(), ...(m[2] ? { port: Number(m[2]) } : {}), ...(m[3] ? { database: decodeURIComponent(m[3]) } : {}) }
}

// Values as plain JSON: 64-bit integers and decimals as numbers where a double holds them exactly (else their text),
// a date as it is written, a timestamp without a zone as an ISO time without one, one with a zone as an ISO instant.
const builtin = pg.types.getTypeParser
const TYPES = {
  getTypeParser(oid, format) {
    if (format === 'binary') return builtin(oid, format)
    if (oid === 20 || oid === 1700) return (s) => plainNumber(s)
    if (oid === 1082 || oid === 1083) return (s) => s
    if (oid === 1114) return (s) => s.replace(' ', 'T')
    if (oid === 1184) { const parse = builtin(oid, format); return (s) => { const d = parse(s); return d instanceof Date && !isNaN(d) ? d.toISOString() : s } }
    return builtin(oid, format)
  },
}
const plain = (v) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? v.toString('base64') : v)

/** The SQL that reads its catalog (exported so its text can be checked without a cluster). `filter` narrows to the
 *  schemas asked for (or every schema but Redshift's own) on the alias given. */
export const CATALOG = {
  filter: (alias, schemas) => (schemas.length ? `${alias}.table_schema IN (${schemas.map((_, i) => `$${i + 1}`).join(', ')})` : `${alias}.table_schema NOT IN ${SYSTEM_SCHEMAS} AND ${alias}.table_schema NOT LIKE 'pg_temp_%'`),
  columns: (schemas) => `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.character_maximum_length, c.numeric_precision, c.numeric_scale, c.is_nullable, c.remarks,
      t.table_type, t.remarks AS table_remarks
    FROM svv_columns c JOIN svv_tables t ON t.table_catalog = c.table_catalog AND t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE ${CATALOG.filter('c', schemas)} ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
  rows: `SELECT "schema" AS table_schema, "table" AS table_name, tbl_rows FROM svv_table_info`,
  signatures: (schemas) => `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.character_maximum_length, c.numeric_precision, c.numeric_scale
    FROM svv_columns c WHERE ${CATALOG.filter('c', schemas)}`,
  tables: (schemas) => `SELECT t.table_schema AS s, count(*) AS n FROM svv_tables t WHERE ${CATALOG.filter('t', schemas)} AND t.table_type IN ('BASE TABLE', 'VIEW')
      AND has_table_privilege(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'SELECT') GROUP BY 1 ORDER BY 2 DESC`,
  keys: keysSql('information_schema'),
}
/** A column's type as the catalog gives it, with its length or precision. */
export const typeOf = (x) => (x.character_maximum_length != null ? `${x.data_type}(${x.character_maximum_length})` : x.numeric_precision != null && /numeric|decimal/.test(x.data_type) ? `${x.data_type}(${x.numeric_precision},${x.numeric_scale ?? 0})` : String(x.data_type))
/** A table as the agent writes it: public's by its name, any other schema's as schema.table. */
export const tableName = (schema, table) => (schema === 'public' ? ident(table, BARE) : `${ident(schema, BARE)}.${ident(table, BARE)}`)

/** The catalog's rows → the tables the index holds: their comments, rows, columns, keys and references. */
export function tablesOf(columns, rowCounts = [], keys = []) {
  const counts = new Map(rowCounts.map((r) => [tableName(r.table_schema, r.table_name), r.tbl_rows]))
  const { primary, refs } = keysFrom(keys, tableName)
  const tables = new Map()
  for (const x of columns) {
    const name = tableName(x.table_schema, x.table_name)
    const n = counts.get(name)
    const t = tables.get(name) ?? { name, ...(x.table_remarks ? { description: String(x.table_remarks) } : {}), ...(n != null && Number.isFinite(Number(n)) ? { rows: Number(n) } : {}), columns: [] }
    const k = `${name}\n${x.column_name}`
    t.columns.push({ name: x.column_name, type: typeOf(x), nullable: x.is_nullable === 'YES', ...(x.remarks ? { description: String(x.remarks) } : {}), ...(primary.has(k) ? { key: true } : {}), ...(refs.has(k) ? { references: refs.get(k) } : {}) })
    tables.set(name, t)
  }
  return [...tables.values()]
}

const TRANSIENT_CODES = ['57P01', '57P02', '57P03', '53300', '08000', '08003', '08006', '40001']

export function createBridge({ settings = {}, secrets = {} } = {}) {
  const configured = !!(settings.host && settings.user && secrets.password)
  const schemas = listOf(settings.schemas)
  const at = () => {
    const e = endpointOf(settings.host)
    return { host: e.host, port: Number(settings.port) || e.port || 5439, database: String(settings.database || e.database || 'dev') }
  }
  let pool = null
  const timed = new WeakSet()   // the connections whose statement timeout is set
  const poolOf = () => (pool ??= new pg.Pool({
    ...at(), user: String(settings.user), password: String(secrets.password),
    max: POOL, idleTimeoutMillis: 60_000, connectionTimeoutMillis: 20_000, types: TYPES,
    ssl: String(settings.ssl ?? 'require') === 'disable' ? false : { rejectUnauthorized: false },
  }))

  /** One statement, in a read-only transaction: a write inside it is refused by Redshift itself. */
  async function run(text, values = []) {
    if (!configured) throw new Error('this source is not configured: host, user and password')
    const c = await poolOf().connect()
    let broken
    try {
      if (!timed.has(c)) { await c.query(`SET statement_timeout TO ${STATEMENT_TIMEOUT_MS}`); timed.add(c) }
      await c.query('BEGIN READ ONLY')
      const r = await c.query({ text, values })
      await c.query('COMMIT')
      return (r.rows ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)])))
    } catch (e) {
      if (isTransient(e)) broken = e
      else await c.query('ROLLBACK').catch((x) => { broken = x })
      // what Redshift said, with its SQLSTATE kept for isTransient
      throw /^[0-9A-Z]{5}$/.test(e?.code ?? '') ? Object.assign(new Error(`Redshift: ${e.message}`), { code: e.code }) : e
    } finally { c.release(broken) }
  }
  async function query(sql, params = {}) {
    const { text, names } = named(sql, params, (_, i) => `$${i + 1}`)
    return run(String(text).replace(/;\s*$/, ''), names.map((n) => params[n]))
  }
  function isTransient(e) {
    return TRANSIENT_CODES.includes(e?.code) || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|Connection terminated|timeout exceeded when trying to connect/i.test(String(e?.message ?? e))
  }
  async function introspect() {
    const columns = await run(CATALOG.columns(schemas), schemas)
    // rows and keys where this user may read them (SVV_TABLE_INFO shows a user only some tables): never without columns
    const counts = await run(CATALOG.rows).catch(() => [])
    const keys = await run(CATALOG.keys).catch(() => [])
    return { kind: 'sql', dialect: 'redshift', tables: tablesOf(columns, counts, keys) }
  }
  /** Per table, a hash of its columns and their types — from one query of SVV_COLUMNS. */
  async function signatures() {
    const rows = await run(CATALOG.signatures(schemas), schemas)
    return signaturesOf(rows.map((x) => ({ table: tableName(x.table_schema, x.table_name), column: String(x.column_name), type: typeOf(x) })))
  }

  return {
    id: 'redshift', kind: 'sql', dialect: 'redshift',
    description: String(settings.description ?? '') || 'Amazon Redshift SQL (PostgreSQL-like): a table outside public is schema.table; "double quotes" for identifiers; LIMIT n; GETDATE(), DATEADD(day, n, d), DATEDIFF(day, a, b), DATE_TRUNC(\'month\', d), LISTAGG(x, \', \'); no arrays or generate_series. Bind values with @name.',
    ready: () => configured,
    async test() {
      const [r] = await run('SELECT current_user AS "user", current_database() AS "database"')
      return `signed in as ${r.user} on ${at().host}, database ${r.database}`
    },
    // Its own setup checks (manifest.json setup, check: custom).
    async check(name) {
      if (name === 'endpoint') {
        const { host, port } = at()
        await new Promise((ok, fail) => {
          const s = net.connect({ host, port, timeout: 15_000 }, () => { s.destroy(); ok() })
          s.on('timeout', () => { s.destroy(); fail(new Error(`${host} did not answer on port ${port} (timed out)`)) })
          s.on('error', (e) => fail(new Error(`${host} could not be reached on port ${port}: ${e.code ?? e.message}`)))
        })
        return `${host} answers on port ${port}`
      }
      if (name === 'tables') {
        const rows = await run(CATALOG.tables(schemas), schemas)
        const total = rows.reduce((n, x) => n + Number(x.n), 0)
        if (!total) throw new Error(`permission denied: ${settings.user} may read no table${schemas.length ? ` in ${schemas.join(', ')}` : ''}`)
        return `${settings.user} may read ${total} table${total === 1 ? '' : 's'} (${rows.map((x) => `${x.s} ${x.n}`).join(', ')})`
      }
      throw new Error(`there is no check ${name}`)
    },
    isTransient, query, introspect, signatures,
    close: () => { const p = pool; pool = null; p?.end().catch(() => {}) },
  }
}
