// DUCKDB as a source — wherever DuckDB itself reads:
//   source file        a DuckDB database file on the engine's disk (an application's own data beside its engine): read by
//                      programs and agents, written by programs (rows appended to a table)
//   source files       Parquet, CSV or JSON files in storage or on the web (s3://, gs://, az://, https://), each
//                      line of `files` a table: its name, then where its files are (a * reads every match as one table);
//                      read only. Private ones: an S3-compatible key (AWS, R2, MinIO, Google Cloud Storage HMAC) or an
//                      Azure connection string — given to DuckDB as a secret, in memory
//   source motherduck  a MotherDuck database (its token)
// A connection made before `source` existed has only `path`: a file.
//
// DuckDB's driver is native, so it is not bundled here: the data source manager supplies it (drivers.duckdb). One
// connection serves the reads and the writes in turn (DuckDB writes one at a time).

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

const q = (v) => `'${String(v).replace(/'/g, "''")}'`
/** `files`: one table a line — its name, then where its files are. */
export function tablesOf(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const m = l.match(/^([A-Za-z_][\w]*)\s+(\S+)$/)
    if (!m) throw new Error(`"${l}": write a table's name, then where its files are (orders s3://bucket/orders/*.parquet)`)
    return { name: m[1], at: m[2] }
  })
}

export function createBridge({ settings = {}, secrets = {}, drivers = {}, dataDir = '' } = {}) {
  const source = String(settings.source ?? (settings.path ? 'file' : ''))
  const given = String(settings.path ?? '')
  const path = !given || given.startsWith('/') || !dataDir ? given : `${dataDir.replace(/\/$/, '')}/${given}`
  const tables = source === 'files' ? tablesOf(settings.files) : []
  let opened = null
  let queue = Promise.resolve()
  /** One at a time: DuckDB's single connection serves reads and writes in turn. */
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.then(() => undefined, () => undefined); return p }

  async function connection() {
    if (!opened) opened = (async () => {
      if (!drivers.duckdb) throw new Error('this data source manager does not supply the DuckDB driver')
      const { DuckDBInstance } = await drivers.duckdb()
      if (source === 'motherduck') {
        const instance = await DuckDBInstance.create(`md:${settings.database}`, { motherduck_token: String(secrets.token ?? '') })
        return { instance, conn: await instance.connect() }
      }
      if (source !== 'files') { const instance = await DuckDBInstance.create(path); return { instance, conn: await instance.connect() } }
      // files: an in-memory database, each table a view over its files; the key given to DuckDB as a secret
      const instance = await DuckDBInstance.create(':memory:')
      const conn = await instance.connect()
      const remote = tables.some((t) => /^(s3|gs|gcs|az|azure|abfss|https?):\/\//.test(t.at))
      if (remote) { await conn.run('INSTALL httpfs'); await conn.run('LOAD httpfs') }
      if (settings.storage === 's3') {
        const endpoint = String(settings.endpoint ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')
        await conn.run(`CREATE SECRET sa_files (TYPE s3, KEY_ID ${q(settings.keyId ?? '')}, SECRET ${q(secrets.secret ?? '')}${settings.region ? `, REGION ${q(settings.region)}` : ''}${endpoint ? `, ENDPOINT ${q(endpoint)}, URL_STYLE 'path'` : ''})`)
        // gs:// addresses: Google Cloud Storage with the same (HMAC) key
        if (tables.some((t) => /^gc?s:\/\//.test(t.at))) await conn.run(`CREATE SECRET sa_gcs (TYPE gcs, KEY_ID ${q(settings.keyId ?? '')}, SECRET ${q(secrets.secret ?? '')})`)
      }
      if (settings.storage === 'azure') {
        await conn.run('INSTALL azure'); await conn.run('LOAD azure')
        await conn.run(`CREATE SECRET sa_files (TYPE azure, CONNECTION_STRING ${q(secrets.connectionString ?? '')})`)
      }
      for (const t of tables) await conn.run(`CREATE VIEW ${ident(t.name)} AS SELECT * FROM ${q(t.at)}`)
      return { instance, conn }
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
    ready() { return source === 'files' ? tables.length > 0 : source === 'motherduck' ? !!(settings.database && secrets.token) : !!path },
    /** Opened, and each table read (one row): what it reaches, said. */
    test: () => serial(async () => {
      const conn = await connection()
      if (source !== 'files') { await conn.runAndReadAll('SELECT 1'); return source === 'motherduck' ? `opened ${settings.database} in MotherDuck` : `opened ${given}` }
      for (const t of tables) { try { await conn.runAndReadAll(`SELECT * FROM ${ident(t.name)} LIMIT 1`) } catch (e) { throw new Error(`${t.name} (${t.at}): ${e?.message ?? e}`) } }
      return `reads ${tables.length} table${tables.length === 1 ? '' : 's'}: ${tables.map((t) => t.name).join(', ')}`
    }),
    query: (sql, params = {}) => serial(() => rows(bind(sql, params))),
    /** Rows appended to one table, each an object by column; the table's other columns take their defaults. */
    append: (table, list) => serial(async () => {
      if (source !== 'file') throw new Error('only a DuckDB file is written to — files in storage and MotherDuck are read here')
      const conn = await connection()
      const cols = [...new Set(list.flatMap((r) => Object.keys(r)))]
      const values = list.map((r) => `(${cols.map((c) => lit(r[c])).join(', ')})`).join(', ')
      await conn.run(`INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES ${values}`)
      return { rows: list.length }
    }),
    introspect: () => serial(async () => {
      const cols = await rows(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'main' ORDER BY table_name, ordinal_position`)
      // a file's own tables say how many rows they hold; a view over files does not (counting would read them all)
      const counts = Object.fromEntries((await rows(`SELECT table_name, estimated_size FROM duckdb_tables() WHERE schema_name = 'main'`)).map((r) => [r.table_name, Number(r.estimated_size)]))
      const tables = new Map()
      for (const c of cols) (tables.get(c.table_name) ?? tables.set(c.table_name, []).get(c.table_name)).push({ name: c.column_name, type: String(c.data_type).toLowerCase() })
      return { kind: 'sql', dialect: 'duckdb', tables: [...tables.entries()].map(([name, columns]) => ({ name, columns, ...(Number.isFinite(counts[name]) ? { rows: counts[name] } : {}) })) }
    }),
    close() { opened?.then(({ instance }) => { try { instance.closeSync?.() } catch { /* closing */ } }).catch(() => {}) },
  }
}
