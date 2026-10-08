// SA-WAREHOUSE bridge — the organisation's warehouse in Superatom (Iceberg tables in the platform's storage), as a SQL
// source of every project. Every read goes to the platform with this engine's own key: the project's grant (its tables,
// and within a table perhaps only some columns) is applied there, and the query checked against it before it runs. Nothing
// to configure: the engine's environment says which platform and project it is (SUPERATOM_PLATFORM, ICA_PROJECT, ICA_KEY).

const MAX_ROWS = 5000   // what the platform returns at most for one query

export function createBridge() {
  const platform = String(process.env.SUPERATOM_PLATFORM ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  const project = String(process.env.ICA_PROJECT ?? ''), key = String(process.env.ICA_KEY ?? '')
  const base = `https://${platform}/api/engine/${project}/sa-warehouse`

  async function call(path, body) {
    const r = await fetch(`${base}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await r.text()
    let j; try { j = JSON.parse(text) } catch { j = { error: text.slice(0, 300) } }
    if (!r.ok || j.error) throw new Error(j.error ?? `SA-WAREHOUSE answered ${r.status}`)
    return j
  }

  // @name values written into the query as literals (agents bind values with @name, as with every SQL source).
  function bind(sql, params) {
    if (!params || !Object.keys(params).length) return sql
    return sql.replace(/@(\w+)/g, (m, name) => {
      if (!(name in params)) return m
      const v = params[name]
      if (v == null) return 'NULL'
      if (typeof v === 'number' || typeof v === 'boolean') return String(v)
      return `'${String(v).replace(/'/g, "''")}'`
    })
  }

  async function query(sql, params = {}) {
    return (await call('query', { sql: bind(sql, params), limit: MAX_ROWS })).rows ?? []
  }

  // The tables this project may read, each with its columns (as granted) and its rows as the warehouse counts them.
  async function introspect() {
    const j = await call('tables')
    return { kind: 'sql', dialect: 'sa-warehouse', tables: (j.tables ?? []).map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type })), ...(Number.isFinite(t.rows) ? { rows: t.rows } : {}) })) }
  }

  return {
    id: 'sa-warehouse',
    kind: 'sql',
    dialect: 'sa-warehouse',
    description:
      'SA-WAREHOUSE — the organisation\'s warehouse in Superatom (Iceberg tables, queried with Cloudflare R2 SQL). Read-only ' +
      'SELECT (or WITH … SELECT), one statement, no comments. Name tables plainly (orders, not a schema.orders) and only the ' +
      'tables and columns this project was granted. A name the query makes (AS x) cannot be a table\'s or a column\'s name. ' +
      'Bind values with @name. At most 5000 rows come back: aggregate in SQL.',
    ready() { return !!(platform && project && key) },
    query,
    introspect,
  }
}
