// A source that speaks SQL Server's protocol (TDS) — SQL Server, Azure SQL, Microsoft Fabric's SQL endpoints — as a
// bridge the data source manager loads (createBridge({ settings, secrets })). A TEMPLATE: a project's data source gets
// its own copy (its bridge, kept by the platform by its hash), and what is specific to that source is written into the
// copy. It signs in with an Entra service principal (settings tenantId, clientId; secret clientSecret) or a SQL login
// (settings user; secret password), and holds a few connections, each one request at a time.
//
//   settings: { server | host, database, port?, tenantId?, clientId?, user?, description?, cheapCounts? }
//   secrets:  { clientSecret? , password? }
//
// cheapCounts: whether the source's own metadata gives definitive row counts (SQL Server's sys.partitions does;
// Fabric's does not — it reports 0 or nothing for tables that have rows), so the index's second phase is asked only
// where it is true.

import tedious from 'tedious'   // bundled into the bridge when the connectors are built: the engine installs nothing for it
const { Connection, Request } = tedious

const POOL = 4                       // as many requests at once as the index builder reads tables at once
const REQUEST_TIMEOUT_MS = 120_000
const MAX_ROWS = 100_000             // protection only: the manager caps what it hands on

// ── T-SQL parameters: @name → a safe literal ──
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`bad numeric param: ${v}`); return String(v) }
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof Date) return `'${v.toISOString()}'`
  return `N'${String(v).replace(/'/g, "''")}'`
}
const bind = (sql, params = {}) => sql.replace(/@(\w+)/g, (w, n) => (Object.prototype.hasOwnProperty.call(params, n) ? lit(params[n]) : w))
const plain = (v) => (typeof v === 'bigint' ? Number(v) : v instanceof Buffer ? v.toString('base64') : v)

export function createBridge({ settings = {}, secrets = {} } = {}) {
  const server = String(settings.server ?? settings.host ?? '').replace(/^tcp:/, '').replace(/,\d+$/, '')
  const database = String(settings.database ?? '')
  const port = Number(settings.port ?? 1433) || 1433
  const sp = !!(settings.tenantId && settings.clientId && secrets.clientSecret)
  const authentication = sp
    ? { type: 'azure-active-directory-service-principal-secret', options: { tenantId: String(settings.tenantId), clientId: String(settings.clientId), clientSecret: String(secrets.clientSecret) } }
    : { type: 'default', options: { userName: String(settings.user ?? ''), password: String(secrets.password ?? '') } }
  const configured = !!(server && database && (sp || (settings.user && secrets.password)))

  const idle = [], waiting = []
  let open = 0
  const connect = () => new Promise((resolve, reject) => {
    const c = new Connection({ server, authentication, options: { database, port, encrypt: true, connectTimeout: 30_000, requestTimeout: REQUEST_TIMEOUT_MS, rowCollectionOnRequestCompletion: false, useColumnNames: false } })
    c.on('connect', (err) => (err ? reject(err) : resolve(c)))
    c.on('error', () => { c.broken = true })
    c.on('end', () => { c.broken = true })
    c.connect()
  })
  async function acquire() {
    while (idle.length) { const c = idle.pop(); if (!c.broken) return c; open-- }
    if (open < POOL) { open++; try { return await connect() } catch (e) { open--; throw e } }
    return new Promise((resolve) => waiting.push(resolve))
  }
  function release(c) {
    if (c.broken) { open--; try { c.close() } catch {}; const w = waiting.shift(); if (w) acquire().then(w, () => {}); return }
    const w = waiting.shift()
    if (w) w(c); else idle.push(c)
  }
  const run = (c, sql) => new Promise((resolve, reject) => {
    const rows = []
    const r = new Request(sql, (err) => (err ? reject(err) : resolve(rows)))
    r.on('row', (cols) => { if (rows.length < MAX_ROWS) rows.push(Object.fromEntries(cols.map((x) => [x.metadata.colName, plain(x.value)]))) })
    c.execSql(r)
  })

  async function query(sql, params = {}) {
    if (!configured) throw new Error('this source is not configured: server, database, and a service principal or a SQL login')
    const c = await acquire()
    try { return await run(c, bind(sql, params)) }
    catch (e) { if (isTransient(e)) c.broken = true; throw e }
    finally { release(c) }
  }
  function isTransient(e) {
    const m = `${e?.code ?? ''} ${e?.message ?? ''}`
    return /ETIMEOUT|ESOCKET|ECONNRESET|ECONNCLOSED|Connection lost|socket hang up|token.*expired/i.test(m)
  }
  async function introspect() {
    const tables = (await query(`SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME`)).map((r) => ({ name: String(r.name) }))
    return { kind: 'sql', dialect: 'mssql', tables, cheapCounts: settings.cheapCounts === true || (settings.cheapCounts === undefined && !/fabric\.microsoft\.com$/i.test(server)) }
  }

  return {
    id: 'mssql',
    kind: 'sql',
    dialect: 'mssql',
    description: String(settings.description ?? '') ||
      'Microsoft SQL Server protocol (T-SQL): TOP n (not LIMIT), [brackets] for identifiers, GETDATE(); bind values with @name.',
    ready: () => configured,
    isTransient,
    query,
    introspect,
  }
}
