// THE CLICKHOUSE CONNECTOR (manifest.json) — over ClickHouse's HTTP interface; read-only by the session (readonly = 1);
// bound values inlined as safe literals; its tables described with their columns and total rows (system.tables).
//
//   settings: { url, database, user }    secrets: { password? }

import { createClient } from '@clickhouse/client'   // bundled into the connector when the connectors are built

const lit = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`bad numeric param: ${v}`); return String(v) }
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

export function createBridge({ settings = {}, secrets = {} } = {}) {
  const configured = !!(settings.url && settings.database && settings.user)
  let client = null
  const clientOf = () => (client ??= createClient({ url: String(settings.url), database: String(settings.database), username: String(settings.user), password: String(secrets.password ?? ''),
    request_timeout: 120_000, max_open_connections: 4, clickhouse_settings: { readonly: '1', max_result_rows: '100000', result_overflow_mode: 'break' } }))
  async function query(sql, params = {}) {
    if (!configured) throw new Error('this source is not configured: a URL, a database and a user')
    const text = sql.replace(/(^|[^:@\w])@(\w+)/g, (m, pre, n) => (Object.prototype.hasOwnProperty.call(params, n) ? `${pre}${lit(params[n])}` : m)).replace(/;\s*$/, '')
    const r = await clientOf().query({ query: text, format: 'JSONEachRow' })
    return await r.json()
  }
  function isTransient(e) { return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|Timeout error|TOO_MANY_SIMULTANEOUS_QUERIES/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`) }
  async function introspect() {
    const cols = await query(`SELECT c.table AS t, c.name AS c, c.type AS ty, tb.total_rows AS r FROM system.columns c JOIN system.tables tb ON tb.database = c.database AND tb.name = c.table
      WHERE c.database = currentDatabase() ORDER BY c.table, c.position`)
    const tables = new Map()
    for (const x of cols) {
      const t = tables.get(x.t) ?? { name: x.t, columns: [], ...(x.r != null ? { rows: Number(x.r) } : {}) }
      t.columns.push({ name: x.c, type: x.ty, nullable: /^Nullable\(/.test(x.ty) })
      tables.set(x.t, t)
    }
    return { kind: 'sql', dialect: 'clickhouse', tables: [...tables.values()] }
  }
  return {
    id: 'clickhouse', kind: 'sql', dialect: 'clickhouse',
    description: String(settings.description ?? '') || 'ClickHouse: LIMIT n, `backticks` or "double quotes" for identifiers, now(), toStartOfMonth(); bind values with @name.',
    ready: () => configured,
    test: async () => { await query('SELECT 1 AS ok') },
    isTransient, query, introspect,
    close: () => { const c = client; client = null; c?.close().catch(() => {}) },
  }
}
