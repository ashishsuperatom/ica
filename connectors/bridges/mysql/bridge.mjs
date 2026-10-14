// THE MYSQL AND MARIADB CONNECTOR (manifest.json) — loaded by the data source manager (createBridge({ settings, secrets }));
// every connection an instance with a small pool. Read-only by the session (SET SESSION TRANSACTION READ ONLY), bound
// values as named placeholders, its tables described with their columns and estimated rows.
//
//   settings: { host, port?, database, user, ssl? }    secrets: { password }

import mysql from 'mysql2/promise'   // bundled into the connector when the connectors are built

const POOL = 4

const plain = (v) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? v.toString('base64') : v)

export function createBridge({ settings = {}, secrets = {} } = {}) {
  const configured = !!(settings.host && settings.database && settings.user && secrets.password)
  let pool = null
  const poolOf = () => {
    if (pool) return pool
    pool = mysql.createPool({ host: String(settings.host), port: Number(settings.port) || 3306, database: String(settings.database), user: String(settings.user), password: String(secrets.password),
      connectionLimit: POOL, connectTimeout: 20_000, namedPlaceholders: true, dateStrings: false, supportBigNumbers: true, bigNumberStrings: false,
      ssl: String(settings.ssl ?? 'require') === 'disable' ? undefined : { rejectUnauthorized: false } })
    pool.on('connection', (c) => { c.query('SET SESSION TRANSACTION READ ONLY') })
    return pool
  }
  async function query(sql, params = {}) {
    if (!configured) throw new Error('this source is not configured: host, database, user and password')
    // @name → :name (mysql2's named placeholders), only for names given
    const text = sql.replace(/(^|[^:@\w])@(\w+)/g, (m, pre, n) => (Object.prototype.hasOwnProperty.call(params, n) ? `${pre}:${n}` : m))
    const [rows] = await poolOf().query({ sql: text, timeout: 120_000 }, params)
    return (Array.isArray(rows) ? rows : []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)])))
  }
  function isTransient(e) {
    return ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ER_CON_COUNT_ERROR', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(e?.code) || /ECONNRESET|socket hang up/i.test(String(e?.message ?? e))
  }
  async function introspect() {
    const [cols] = await poolOf().query(`SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.DATA_TYPE AS ty, c.IS_NULLABLE AS n, c.COLUMN_KEY AS k, tb.TABLE_ROWS AS r
      FROM information_schema.COLUMNS c JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`)
    const tables = new Map()
    for (const x of cols) {
      const t = tables.get(x.t) ?? { name: x.t, columns: [], ...(x.r != null ? { rows: Number(x.r) } : {}) }
      t.columns.push({ name: x.c, type: x.ty, nullable: x.n === 'YES', ...(x.k === 'PRI' ? { key: true } : {}) })
      tables.set(x.t, t)
    }
    return { kind: 'sql', dialect: 'mysql', tables: [...tables.values()] }
  }
  return {
    id: 'mysql', kind: 'sql', dialect: 'mysql',
    description: String(settings.description ?? '') || 'MySQL / MariaDB: LIMIT n, `backticks` for identifiers, NOW(); bind values with @name.',
    ready: () => configured,
    test: async () => { await query('SELECT 1 AS ok') },
    isTransient, query, introspect,
    close: () => { const p = pool; pool = null; p?.end().catch(() => {}) },
  }
}
