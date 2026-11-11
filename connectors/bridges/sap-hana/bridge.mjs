// THE SAP HANA CONNECTOR (manifest.json) — SAP HANA Cloud, an on-premise HANA (the database under S/4HANA and
// BW/4HANA) or HANA express, through SAP's own pure-JavaScript client (hdb). One module, immutable by its hash; every
// connection an instance of its own with a small pool. Values bound as ? parameters of a prepared statement; HANA's
// decimals turned into numbers only where the column is a decimal (so a code like 00123 stays text). Its tables
// described from HANA's own catalog — their comments, keys and foreign keys, and row counts — and a signature per table
// from one catalog query, so the index reads again only what changed (docs/connectors-enterprise.md 2c, 2d).
//
//   settings: { host, port?, database?, tls?, schemas? }    secrets: { password }

import hdb from 'hdb'   // bundled into the connector when the connectors are built: the engine installs nothing for it
import { signatureOf } from '../../src/api.ts'

const POOL = 3
const CONNECT_TIMEOUT_MS = 20_000
/** Schemas of HANA itself, never a person's data — left out unless named in the connection's schemas. */
const SYSTEM_SCHEMAS = ['SYS', 'SYSTEM', 'PUBLIC', 'UIS', 'HANA_XS_BASE', 'SAP_XS_LM', 'SAP_REST_API', 'SAP_SQL_ANALYZER', 'SAP_PA_APL']
/** hdb's type codes of HANA's decimal types: their values come as text, and are numbers. */
const DECIMALS = new Set([5, 76, 81, 82])

/** host[:port] as pasted, and the port given (HANA Cloud: 443). */
function addressOf(settings) {
  const raw = String(settings.host ?? '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
  const [host, inPort] = raw.split(':')
  return { host, port: Number(settings.port) || Number(inPort) || 443 }
}

/** @name → ?, in order (the same name bound each time it appears). */
function bind(sql, params = {}) {
  const values = []
  const text = sql.replace(/(^|[^:@\w])@(\w+)/g, (m, pre, n) => {
    if (!Object.prototype.hasOwnProperty.call(params, n)) return m
    values.push(params[n]); return `${pre}?`
  })
  return { text, values }
}
const plain = (v, decimal) => (typeof v === 'bigint' ? Number(v) : decimal && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && Math.abs(Number(v)) < 2 ** 53 ? Number(v)
  : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? v.toString('base64') : v)
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`

export function createBridge({ settings = {}, secrets = {} } = {}) {
  const { host, port } = addressOf(settings)
  const configured = !!(host && settings.user && secrets.password)
  const schemas = String(settings.schemas ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const tls = String(settings.tls ?? 'on') !== 'off'

  // A SMALL POOL: a client is taken for one statement and given back; a broken one is dropped and a new one made.
  const idle = [], waiting = []
  let open = 0
  function connect() {
    return new Promise((resolve, reject) => {
      const client = hdb.createClient({ host, port, user: String(settings.user), password: String(secrets.password),
        ...(settings.database ? { databaseName: String(settings.database) } : {}), ...(tls ? { useTLS: true, rejectUnauthorized: false } : {}),
        connectTimeout: CONNECT_TIMEOUT_MS })
      client.on('error', () => { /* a broken connection: dropped when next used */ })
      client.connect((err) => (err ? reject(err) : resolve(client)))
    })
  }
  async function take() {
    const c = idle.pop()
    if (c && c.readyState === 'connected') return c
    if (open < POOL) { open++; try { return await connect() } catch (e) { open--; throw e } }
    return new Promise((resolve) => waiting.push(resolve))
  }
  function give(c, broken) {
    if (broken || c.readyState !== 'connected') { open--; try { c.close() } catch { /* gone */ } ; const w = waiting.shift(); if (w) take().then(w, () => {}); return }
    const w = waiting.shift(); if (w) w(c); else idle.push(c)
  }
  async function run(sql, values = []) {
    const c = await take()
    try {
      const rows = await new Promise((resolve, reject) => c.prepare(sql, (err, st) => {
        if (err) return reject(err)
        st.exec(values, (e, r) => {
          const decimals = new Set((st.resultSetMetadata ?? []).filter((m) => DECIMALS.has(m.dataType)).map((m) => m.columnDisplayName))
          st.drop(() => {})
          if (e) return reject(e)
          resolve((r ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v, decimals.has(k))]))))
        })
      }))
      give(c, false)
      return rows
    } catch (e) { give(c, isTransient(e)); throw e }
  }

  async function query(sql, params = {}) {
    if (!configured) throw new Error('this source is not configured: host, user and password')
    const { text, values } = bind(sql, params)
    return run(text, values)
  }
  function isTransient(e) {
    return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket|Connection closed|connection lost|timeout/i.test(String(e?.message ?? e)) || e?.code === 'EHDBCLOSE'
  }

  /** Which schemas: those named, else every schema but HANA's own. */
  const schemaFilter = (col) => (schemas.length ? `${col} IN (${schemas.map(quote).join(', ')})` : `${col} NOT IN (${SYSTEM_SCHEMAS.map(quote).join(', ')}) AND ${col} NOT LIKE '\\_SYS%' ESCAPE '\\'`)
  const nameOf = (schema, table) => `${schema}.${table}`
  /** Every column of every table and view the user may read (HANA's catalog shows only those), in order. */
  const columns = () => run(`SELECT SCHEMA_NAME, TABLE_NAME, COLUMN_NAME, DATA_TYPE_NAME, IS_NULLABLE, COMMENTS, POSITION FROM SYS.TABLE_COLUMNS WHERE ${schemaFilter('SCHEMA_NAME')}
    UNION ALL SELECT SCHEMA_NAME, VIEW_NAME, COLUMN_NAME, DATA_TYPE_NAME, IS_NULLABLE, COMMENTS, POSITION FROM SYS.VIEW_COLUMNS WHERE ${schemaFilter('SCHEMA_NAME')}
    ORDER BY 1, 2, 7`)

  async function introspect() {
    const [cols, tables, keys, refs, counts] = await Promise.all([
      columns(),
      run(`SELECT SCHEMA_NAME, TABLE_NAME, COMMENTS FROM SYS.TABLES WHERE ${schemaFilter('SCHEMA_NAME')} UNION ALL SELECT SCHEMA_NAME, VIEW_NAME, COMMENTS FROM SYS.VIEWS WHERE ${schemaFilter('SCHEMA_NAME')}`).catch(() => []),
      run(`SELECT SCHEMA_NAME, TABLE_NAME, COLUMN_NAME FROM SYS.CONSTRAINTS WHERE IS_PRIMARY_KEY = 'TRUE' AND ${schemaFilter('SCHEMA_NAME')}`).catch(() => []),
      run(`SELECT SCHEMA_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_SCHEMA_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM SYS.REFERENTIAL_CONSTRAINTS WHERE ${schemaFilter('SCHEMA_NAME')}`).catch(() => []),
      // row counts from HANA's monitoring view — cheap, and only where the user may see it
      run(`SELECT SCHEMA_NAME, TABLE_NAME, RECORD_COUNT FROM SYS.M_TABLES WHERE ${schemaFilter('SCHEMA_NAME')}`).catch(() => []),
    ])
    const key = (s, t, c) => `${s}\u0000${t}\u0000${c ?? ''}`
    const pk = new Set(keys.map((k) => key(k.SCHEMA_NAME, k.TABLE_NAME, k.COLUMN_NAME)))
    const fk = new Map(refs.map((r) => [key(r.SCHEMA_NAME, r.TABLE_NAME, r.COLUMN_NAME), `${nameOf(r.REFERENCED_SCHEMA_NAME, r.REFERENCED_TABLE_NAME)}.${r.REFERENCED_COLUMN_NAME}`]))
    const about = new Map(tables.map((t) => [key(t.SCHEMA_NAME, t.TABLE_NAME), t.COMMENTS]))
    const rows = new Map(counts.map((c) => [key(c.SCHEMA_NAME, c.TABLE_NAME), Number(c.RECORD_COUNT)]))
    const out = new Map()
    for (const c of cols) {
      const k = key(c.SCHEMA_NAME, c.TABLE_NAME), name = nameOf(c.SCHEMA_NAME, c.TABLE_NAME)
      const t = out.get(k) ?? { name, ...(about.get(k) ? { description: about.get(k) } : {}), ...(Number.isFinite(rows.get(k)) ? { rows: rows.get(k) } : {}), columns: [] }
      const ck = key(c.SCHEMA_NAME, c.TABLE_NAME, c.COLUMN_NAME)
      t.columns.push({ name: c.COLUMN_NAME, type: c.DATA_TYPE_NAME, nullable: c.IS_NULLABLE === 'TRUE',
        ...(c.COMMENTS ? { description: c.COMMENTS } : {}), ...(pk.has(ck) ? { key: true } : {}), ...(fk.has(ck) ? { references: fk.get(ck) } : {}) })
      out.set(k, t)
    }
    return { kind: 'sql', dialect: 'hana', tables: [...out.values()] }
  }

  /** For each table, a value that changes exactly when its columns do — from one read of the catalog. */
  async function signatures() {
    const by = new Map()
    for (const c of await columns()) { const n = nameOf(c.SCHEMA_NAME, c.TABLE_NAME); by.set(n, [...(by.get(n) ?? []), `${c.COLUMN_NAME}:${c.DATA_TYPE_NAME}`]) }
    return Object.fromEntries([...by].map(([n, cs]) => [n, signatureOf(cs)]))
  }

  return {
    id: 'sap-hana', kind: 'sql', dialect: 'hana',
    description: String(settings.description ?? '') || 'SAP HANA SQL: name a table as SCHEMA.TABLE (names are upper case unless created in "double quotes" — then quote them the same way); LIMIT n OFFSET m; CURRENT_DATE, ADD_DAYS(d, n), DAYS_BETWEEN(a, b); TO_VARCHAR, TO_DECIMAL; bind values with @name.',
    ready: () => configured,
    test: async () => { const [r] = await query('SELECT CURRENT_USER AS U, CURRENT_SCHEMA AS S FROM DUMMY'); return `signed in as ${r.U} on ${settings.database || host}` },
    // Its own setup check (manifest.json setup, check: custom): what this user may read, by schema.
    async check(name) {
      if (name !== 'tables') throw new Error(`there is no check ${name}`)
      const r = await run(`SELECT SCHEMA_NAME AS S, COUNT(*) AS N FROM (SELECT SCHEMA_NAME FROM SYS.TABLES WHERE ${schemaFilter('SCHEMA_NAME')} UNION ALL SELECT SCHEMA_NAME FROM SYS.VIEWS WHERE ${schemaFilter('SCHEMA_NAME')}) GROUP BY SCHEMA_NAME ORDER BY 2 DESC`)
      const total = r.reduce((n, x) => n + Number(x.N), 0)
      if (!total) throw new Error(`permission denied: ${settings.user} may read no table${schemas.length ? ` in ${schemas.join(', ')}` : ''}`)
      return `${settings.user} may read ${total} table${total === 1 ? '' : 's'} and view${total === 1 ? '' : 's'} (${r.slice(0, 8).map((x) => `${x.S} ${x.N}`).join(', ')}${r.length > 8 ? ', …' : ''})`
    },
    isTransient, query, introspect, signatures,
    close: () => { for (const c of idle.splice(0)) { try { c.close() } catch { /* gone */ } } open = 0 },
  }
}
