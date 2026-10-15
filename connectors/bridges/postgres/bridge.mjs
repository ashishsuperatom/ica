// THE POSTGRESQL CONNECTOR (manifest.json) — loaded by the data source manager (createBridge({ settings, secrets })); one
// module, immutable by its hash, every connection made with it an instance of its own with a small pool. Read-only by the
// session (default_transaction_read_only), bound values as $n parameters, its tables described with their columns and
// estimated rows so the index needs no code of the platform's for it.
//
//   settings: { host, port?, database, user, schemas?, ssl? }    secrets: { password }

import pg from 'pg'   // bundled into the connector when the connectors are built: the engine installs nothing for it

const POOL = 4
const STATEMENT_TIMEOUT_MS = 120_000

/** @name → $n, in order of first appearance (the same name, the same $n). */
function bind(sql, params = {}) {
  const order = []
  const text = sql.replace(/(^|[^:@\w])@(\w+)/g, (m, pre, n) => {
    if (!Object.prototype.hasOwnProperty.call(params, n)) return m
    let i = order.indexOf(n); if (i < 0) { order.push(n); i = order.length - 1 }
    return `${pre}$${i + 1}`
  })
  return { text, values: order.map((n) => params[n]) }
}
const plain = (v) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? v.toString('base64') : v)

export function createBridge({ settings = {}, secrets = {} } = {}) {
  const configured = !!(settings.host && settings.database && settings.user && secrets.password)
  const schemas = String(settings.schemas ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  let pool = null
  const poolOf = () => (pool ??= new pg.Pool({
    host: String(settings.host), port: Number(settings.port) || 5432, database: String(settings.database), user: String(settings.user), password: String(secrets.password),
    max: POOL, idleTimeoutMillis: 60_000, connectionTimeoutMillis: 20_000, statement_timeout: STATEMENT_TIMEOUT_MS,
    ssl: String(settings.ssl ?? 'require') === 'disable' ? false : { rejectUnauthorized: false },
    options: '-c default_transaction_read_only=on',
  }))

  async function query(sql, params = {}) {
    if (!configured) throw new Error('this source is not configured: host, database, user and password')
    const { text, values } = bind(sql, params)
    const r = await poolOf().query({ text, values, rowMode: undefined })
    return (r.rows ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)])))
  }
  function isTransient(e) {
    return ['57P01', '57P02', '57P03', '53300', '08000', '08003', '08006', '40001'].includes(e?.code) || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|Connection terminated|timeout exceeded when trying to connect/i.test(String(e?.message ?? e))
  }
  async function introspect() {
    const filter = schemas.length ? `c.table_schema = ANY($1)` : `c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'`
    const r = await poolOf().query({ text: `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable, cl.reltuples
      FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      LEFT JOIN pg_namespace n ON n.nspname = c.table_schema LEFT JOIN pg_class cl ON cl.relnamespace = n.oid AND cl.relname = c.table_name
      WHERE ${filter} AND t.table_type IN ('BASE TABLE', 'VIEW') ORDER BY c.table_schema, c.table_name, c.ordinal_position`, values: schemas.length ? [schemas] : [] })
    const tables = new Map()
    for (const x of r.rows) {
      const name = x.table_schema === 'public' ? x.table_name : `${x.table_schema}.${x.table_name}`
      const t = tables.get(name) ?? { name, columns: [], ...(Number(x.reltuples) >= 0 ? { rows: Math.round(Number(x.reltuples)) } : {}) }
      t.columns.push({ name: x.column_name, type: x.data_type, nullable: x.is_nullable === 'YES' })
      tables.set(name, t)
    }
    return { kind: 'sql', dialect: 'postgres', tables: [...tables.values()] }
  }

  return {
    id: 'postgres', kind: 'sql', dialect: 'postgres',
    description: String(settings.description ?? '') || 'PostgreSQL: LIMIT n, "double quotes" for identifiers, now(); a table outside public is schema.table; bind values with @name.',
    ready: () => configured,
    test: async () => { await query('SELECT 1 AS ok'); return `signed in as ${settings.user} on ${settings.database}` },
    // Its own setup checks (manifest.json setup, check: custom): what this user may read, by schema.
    async check(name) {
      if (name !== 'tables') throw new Error(`there is no check ${name}`)
      const filter = schemas.length ? `table_schema = ANY($1)` : `table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%'`
      const r = await poolOf().query({ text: `SELECT table_schema AS s, count(*)::int AS n FROM information_schema.tables WHERE ${filter} AND table_type IN ('BASE TABLE', 'VIEW')
        AND has_table_privilege(quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT') GROUP BY 1 ORDER BY 2 DESC`, values: schemas.length ? [schemas] : [] })
      const total = r.rows.reduce((n, x) => n + x.n, 0)
      if (!total) throw new Error(`permission denied: ${settings.user} may read no table${schemas.length ? ` in ${schemas.join(', ')}` : ''}`)
      return `${settings.user} may read ${total} table${total === 1 ? '' : 's'} (${r.rows.map((x) => `${x.s} ${x.n}`).join(', ')})`
    },
    isTransient, query, introspect,
    close: () => { const p = pool; pool = null; p?.end().catch(() => {}) },
  }
}
