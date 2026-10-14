// THE ORACLE CONNECTOR (manifest.json) — node-oracledb in THIN mode: pure JavaScript, no Oracle client on the engine.
// Every connection an instance with a small pool; bound values as :name; its tables (the schema's, or the user's own)
// described with their columns and the optimiser's row counts.
//
//   settings: { host, port?, service, user, schema? }    secrets: { password }

import oracledb from 'oracledb'   // bundled into the connector when the connectors are built (thin mode: no native code)

const POOL = 4

const plain = (v) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? v.toString('base64') : v)

export function createBridge({ settings = {}, secrets = {} } = {}) {
  const configured = !!(settings.host && settings.service && settings.user && secrets.password)
  const owner = String(settings.schema ?? settings.user ?? '').toUpperCase()
  let pool = null
  const poolOf = async () => (pool ??= await oracledb.createPool({ user: String(settings.user), password: String(secrets.password),
    connectString: `${settings.host}:${Number(settings.port) || 1521}/${settings.service}`, poolMin: 0, poolMax: POOL, poolTimeout: 60, queueTimeout: 60_000 }))
  async function query(sql, params = {}) {
    if (!configured) throw new Error('this source is not configured: host, service, user and password')
    const names = []
    const text = sql.replace(/(^|[^:@\w])@(\w+)/g, (m, pre, n) => { if (!Object.prototype.hasOwnProperty.call(params, n)) return m; names.push(n); return `${pre}:${n}` }).replace(/;\s*$/, '')
    const binds = Object.fromEntries([...new Set(names)].map((n) => [n, params[n]]))
    const c = await (await poolOf()).getConnection()
    try {
      c.callTimeout = 120_000
      // READ ONLY: every read in a read-only transaction (Oracle has no read-only session), rolled back after it.
      await c.execute('SET TRANSACTION READ ONLY')
      const r = await c.execute(text, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 100_000 })
      return (r.rows ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)])))
    } finally { await c.rollback().catch(() => {}); await c.close().catch(() => {}) }
  }
  function isTransient(e) { return /NJS-(500|501|503|510)|ORA-(03113|03114|03135|12170|12541|12543)|ECONNRESET|ETIMEDOUT/i.test(String(e?.message ?? e)) }
  async function introspect() {
    const rows = await query(`SELECT c.TABLE_NAME AS T, c.COLUMN_NAME AS C, c.DATA_TYPE AS TY, c.NULLABLE AS N, t.NUM_ROWS AS R
      FROM ALL_TAB_COLUMNS c JOIN ALL_TABLES t ON t.OWNER = c.OWNER AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.OWNER = @owner ORDER BY c.TABLE_NAME, c.COLUMN_ID`, { owner })
    const tables = new Map()
    for (const x of rows) {
      const t = tables.get(x.T) ?? { name: x.T, columns: [], ...(x.R != null ? { rows: Number(x.R) } : {}) }
      t.columns.push({ name: x.C, type: x.TY, nullable: x.N === 'Y' })
      tables.set(x.T, t)
    }
    return { kind: 'sql', dialect: 'oracle', tables: [...tables.values()] }
  }
  return {
    id: 'oracle', kind: 'sql', dialect: 'oracle',
    description: String(settings.description ?? '') || 'Oracle: FETCH FIRST n ROWS ONLY (not LIMIT), "DOUBLE QUOTES" for identifiers (names are UPPER CASE), SYSDATE, FROM DUAL; bind values with @name.',
    ready: () => configured,
    test: async () => { await query('SELECT 1 AS OK FROM DUAL') },
    isTransient, query, introspect,
    close: () => { const p = pool; pool = null; p?.close(0).catch(() => {}) },
  }
}
