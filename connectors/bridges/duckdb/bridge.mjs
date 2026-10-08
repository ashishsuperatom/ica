// A DuckDB database file as a source — the way an application's own data is kept beside its engine: read by programs
// and agents, written by programs (rows appended to a table). A TEMPLATE: a project's source gets its own copy (its
// bridge, kept by the platform by its hash); what is specific to that source is its settings.
//
//   settings: { path, description? }   path: the database file, on the engine's disk
//
// DuckDB's driver is native, so it is not bundled here: the data source manager supplies it (drivers.duckdb). The file
// is opened once, and one connection serves the reads and the writes in turn (DuckDB writes one at a time).

const MAX_ROWS = 100_000   // protection only: the manager caps what it hands on

// ── @name parameters → safe literals ──
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`bad numeric value: ${v}`); return String(v) }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Date) return `'${v.toISOString()}'`
  return `'${String(v).replace(/'/g, "''")}'`
}
const bind = (sql, params = {}) => sql.replace(/@(\w+)/g, (w, n) => (Object.prototype.hasOwnProperty.call(params, n) ? lit(params[n]) : w))
const ident = (name) => { if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`"${name}" is not a table or column name`); return `"${name}"` }

export function createBridge({ settings = {}, drivers = {} } = {}) {
  const path = String(settings.path ?? '')
  let opened = null
  let queue = Promise.resolve()
  /** One at a time: DuckDB's single connection serves reads and writes in turn. */
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.then(() => undefined, () => undefined); return p }

  async function connection() {
    if (!opened) opened = (async () => {
      if (!drivers.duckdb) throw new Error('this data source manager does not supply the DuckDB driver')
      const { DuckDBInstance } = await drivers.duckdb()
      const instance = await DuckDBInstance.create(path)
      return { instance, conn: await instance.connect() }
    })().catch((e) => { opened = null; throw e })
    return (await opened).conn
  }

  async function rows(sql) {
    const conn = await connection()
    const reader = await conn.runAndReadAll(sql)
    const out = reader.getRowObjectsJson()
    if (out.length > MAX_ROWS) throw new Error(`more than ${MAX_ROWS} rows — aggregate in SQL`)
    return out
  }

  return {
    id: 'duckdb',
    kind: 'sql',
    dialect: 'duckdb',
    description: String(settings.description ?? '') ||
      'A DuckDB database. SELECT (or WITH … SELECT), one statement; DuckDB SQL (date_trunc, strftime, list and struct functions). Bind values with @name. At most 5000 rows come back: aggregate in SQL.',
    ready() { return !!path },
    query: (sql, params = {}) => serial(() => rows(bind(sql, params))),
    /** Rows appended to one table, each an object by column; the table's other columns take their defaults. */
    append: (table, list) => serial(async () => {
      const conn = await connection()
      const cols = [...new Set(list.flatMap((r) => Object.keys(r)))]
      const values = list.map((r) => `(${cols.map((c) => lit(r[c])).join(', ')})`).join(', ')
      await conn.run(`INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES ${values}`)
      return { rows: list.length }
    }),
    introspect: () => serial(async () => {
      const cols = await rows(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'main' ORDER BY table_name, ordinal_position`)
      const counts = Object.fromEntries((await rows(`SELECT table_name, estimated_size FROM duckdb_tables() WHERE schema_name = 'main'`)).map((r) => [r.table_name, Number(r.estimated_size)]))
      const tables = new Map()
      for (const c of cols) (tables.get(c.table_name) ?? tables.set(c.table_name, []).get(c.table_name)).push({ name: c.column_name, type: String(c.data_type).toLowerCase() })
      return { kind: 'sql', dialect: 'duckdb', tables: [...tables.entries()].map(([name, columns]) => ({ name, columns, ...(Number.isFinite(counts[name]) ? { rows: counts[name] } : {}) })) }
    }),
    close() { opened?.then(({ instance }) => { try { instance.closeSync?.() } catch { /* closing */ } }).catch(() => {}) },
  }
}
