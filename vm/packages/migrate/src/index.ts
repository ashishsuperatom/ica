// ── Migrations — one way for every SQLite database to change shape ────────────────────────────────────────────
//
// Every database the platform keeps (the engine's composition graph, datasource index, agent sessions …, and every
// Durable Object's SQLite) changes shape only through numbered migrations, applied in order when it is opened and
// recorded in the database itself. The rules, kept simple so they hold:
//
//   · A migration has a number (1, 2, 3 … with no gaps), a name and an `up` — SQL, or a function for a change SQL
//     cannot say. It runs inside a transaction together with the row that records it: all of it, or none of it.
//   · Never edited once shipped. A migration's SQL is fingerprinted; a recorded migration whose SQL or name no longer
//     matches the code is refused — the change is a new migration.
//   · No down migrations. The way back is the backup taken before pending migrations run.
//   · A database migrated by newer code is refused: older code never writes to a shape it does not know.
//
// This file depends on nothing — the engine (node:sqlite) and the control plane (Durable Object SQL) both use it,
// each through a small adapter that says how to run SQL and how to make a transaction.
//
// COST. Migrations run once per open, never per request: the engine migrates a database when it opens it; a Durable
// Object migrates in its constructor, inside ctx.blockConcurrencyWhile, once each time it wakes. And when nothing is
// pending, that once is a single-row read — the last applied migration's id and fingerprint against the code's last.
// The full record is compared only when something is pending, and always by verifyMigrations in tests.

export interface Migration {
  /** 1, 2, 3 … — the order, with no gaps. */
  id: number
  /** What it does, in a few words. Part of its identity: renaming a shipped migration is refused. */
  name: string
  /** SQL statements, or a function for a change SQL cannot express (copying data in code, a guarded change). */
  up: string | ((db: MigrationDb) => void)
}

/** What the runner needs of a database. */
export interface MigrationDb {
  /** Run one or more statements. */
  exec(sql: string): void
  /** Rows of one statement. */
  all(sql: string, ...params: unknown[]): Record<string, unknown>[]
  /** Run `fn` in one transaction: all of it, or none of it. */
  transaction(fn: () => void): void
}

export interface MigrateOptions {
  /** The database, as people know it — named in every refusal. */
  name: string
  /** Called once before pending migrations run on a database that already has a shape: take a backup. */
  backup?: () => void
  /** The clock (tests). */
  now?: () => string
  /** A database whose shape was kept by an earlier scheme (a version counter of its own): how many of these
   *  migrations it already has. Asked only when the database has no migration record yet; those are recorded as
   *  applied, without running, and the rest run. */
  adopt?: (db: MigrationDb) => number
  /** The table its record is kept in (default _migrations): a second set of migrations in the same database — a
   *  package's own, kept by that package — keeps its record apart. */
  table?: string
}

export interface MigrateResult {
  /** The migrations applied now, by id. */
  applied: number[]
  /** The migration the database is at. */
  current: number
}

export class MigrationError extends Error {}

/** The record table: _migrations, or a package's own (a name of letters, digits and underscores). */
const ledger = (table?: string) => {
  if (table === undefined) return '_migrations'
  if (!/^_?[a-z][a-z0-9_]{0,40}$/.test(table)) throw new MigrationError(`"${table}" is not a migration record table name`)
  return table
}

/** A short fingerprint of a migration — its name, and its SQL (a function migration: its name only): FNV-1a, 64 bits,
 *  as hex. Sync and dependency-free, because a Worker has no synchronous crypto. */
export function fingerprint(m: Migration): string {
  const text = `${m.name}\n${typeof m.up === 'string' ? m.up.replace(/\s+/g, ' ').trim() : 'fn'}`
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x0100019d) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/** The migration list, checked: numbered 1…n with no gaps or repeats, each named. */
function checkList(name: string, migrations: Migration[]): Migration[] {
  const list = [...migrations].sort((a, b) => a.id - b.id)
  list.forEach((m, i) => {
    if (m.id !== i + 1) throw new MigrationError(`${name}: migrations must be numbered 1, 2, 3 … with no gaps; found ${m.id} where ${i + 1} belongs`)
    if (!m.name?.trim()) throw new MigrationError(`${name}: migration ${m.id} has no name`)
  })
  return list
}

/** The last migration a database recorded, or null when it has no record yet (one indexed row). */
function lastApplied(db: MigrationDb, TABLE: string): { id: number; fingerprint: string } | null {
  try {
    const [r] = db.all(`SELECT id, fingerprint FROM ${TABLE} ORDER BY id DESC LIMIT 1`)
    return r ? { id: Number(r.id), fingerprint: String(r.fingerprint) } : null
  } catch { return null }   // no record table: a new database, or one made before migrations
}

/** Bring a database up to the last migration. Refuses, with a sentence, a database it must not touch. When nothing is
 *  pending it costs one single-row read. */
export function migrate(db: MigrationDb, migrations: Migration[], opts: MigrateOptions): MigrateResult {
  const list = checkList(opts.name, migrations)
  const last = list.at(-1)
  const at = lastApplied(db, ledger(opts.table))
  if (last && at && at.id === last.id && at.fingerprint === fingerprint(last)) return { applied: [], current: last.id }
  return migrateFully(db, list, opts)
}

/** Every recorded migration against the code — refuses an edited, renamed or unknown one. For tests and CI: the
 *  runtime check is the last migration only, and the full one when something is pending. */
export function verifyMigrations(db: MigrationDb, migrations: Migration[], name: string, table?: string): void {
  const list = checkList(name, migrations)
  checkRecord(db, list, name, ledger(table))
}

function checkRecord(db: MigrationDb, list: Migration[], name: string, TABLE: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, fingerprint TEXT NOT NULL, applied_at TEXT NOT NULL)`)
  const done = db.all(`SELECT id, name, fingerprint FROM ${TABLE} ORDER BY id`).map((r) => ({ id: Number(r.id), name: String(r.name), fingerprint: String(r.fingerprint) }))
  const opts = { name }

  // What the database has must be what the code says, in order.
  done.forEach((d, i) => {
    if (d.id !== i + 1) throw new MigrationError(`${opts.name}: its migration record has a gap at ${i + 1}; it was changed by hand — restore it from a backup`)
    const m = list[d.id - 1]
    if (!m) throw new MigrationError(`${opts.name} was migrated by newer code (it is at migration ${done.at(-1)!.id}, "${done.at(-1)!.name}"; this code knows up to ${list.length}). Update the code; never run older code on it.`)
    if (m.name !== d.name || fingerprint(m) !== d.fingerprint)
      throw new MigrationError(`${opts.name}: migration ${d.id} ("${d.name}") has changed since it was applied. A shipped migration is never edited — put the change in a new migration.`)
  })
  return done
}

function migrateFully(db: MigrationDb, list: Migration[], opts: MigrateOptions): MigrateResult {
  const TABLE = ledger(opts.table)
  const now = opts.now ?? (() => new Date().toISOString())
  let done = checkRecord(db, list, opts.name, TABLE)
  if (!done.length && opts.adopt) {
    const had = opts.adopt(db)
    if (!Number.isInteger(had) || had < 0 || had > list.length) throw new MigrationError(`${opts.name}: an earlier scheme says it has ${had} migrations; this code knows ${list.length}. Update the code.`)
    if (had > 0) {
      db.transaction(() => { for (const m of list.slice(0, had)) db.all(`INSERT INTO ${TABLE} (id, name, fingerprint, applied_at) VALUES (?, ?, ?, ?) RETURNING id`, m.id, m.name, fingerprint(m), `adopted ${now()}`) })
      done = checkRecord(db, list, opts.name, TABLE)
    }
  }
  const pending = list.slice(done.length)
  if (!pending.length) return { applied: [], current: done.length }
  // A database that already has a shape is backed up first; a new one has nothing to lose.
  const hasShape = done.length > 0 || db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '${TABLE}' LIMIT 1`).length > 0
  if (hasShape) opts.backup?.()
  const applied: number[] = []
  for (const m of pending) {
    try {
      let ran = false
      db.transaction(() => {
        // Another process may have applied it while this one waited for the lock: inside the transaction, look again.
        if (db.all(`SELECT 1 FROM ${TABLE} WHERE id = ?`, m.id).length) return
        if (typeof m.up === 'string') db.exec(m.up)
        else m.up(db)
        db.all(`INSERT INTO ${TABLE} (id, name, fingerprint, applied_at) VALUES (?, ?, ?, ?) RETURNING id`, m.id, m.name, fingerprint(m), now())
        ran = true
      })
      if (ran) applied.push(m.id)
    } catch (e: any) {
      throw new MigrationError(`${opts.name}: migration ${m.id} ("${m.name}") failed and was not applied: ${e?.message ?? e}`)
    }
  }
  return { applied, current: list.length }
}

/** For a first migration that adopts a database made before migrations existed: add a column only when it is missing. */
export function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
  // Where the table's columns can be read, read them; a Durable Object's SQLite may refuse pragma_table_info, and
  // then the ALTER itself answers — "duplicate column" means it is already there, anything else is a real failure.
  let has: boolean | null = null
  try { has = db.all(`SELECT name FROM pragma_table_info(?)`, table).some((r) => r.name === column) } catch { has = null }
  if (has) return
  try { db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`) }
  catch (e: any) { if (has === null && /duplicate column/i.test(String(e?.message ?? e))) return; throw e }
}

/** A Durable Object's SQLite (`ctx.storage`): its own transactions, since BEGIN is not allowed there. */
export function durableObjectDb(storage: { sql: { exec(sql: string, ...params: unknown[]): Iterable<Record<string, unknown>> }; transactionSync<T>(fn: () => T): T }): MigrationDb {
  return {
    exec: (sql) => { storage.sql.exec(sql) },
    all: (sql, ...params) => [...storage.sql.exec(sql, ...params)],
    transaction: (fn) => { storage.transactionSync(fn) },
  }
}
