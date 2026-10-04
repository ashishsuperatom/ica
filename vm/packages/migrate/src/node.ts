// The engine's side: a node:sqlite database as a MigrationDb, and opening a database file with its migrations
// applied and a backup taken beside it before any pending migration runs.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { migrate, type Migration, type MigrationDb, type MigrateResult } from './index.js'

/** A Node SQLite connection — node:sqlite's DatabaseSync or better-sqlite3's Database; both have exec and prepare().all. */
export interface NodeSqlite { exec(sql: string): unknown; prepare(sql: string): { all(...params: any[]): unknown[] } }

export function nodeDb(db: NodeSqlite): MigrationDb {
  return {
    exec: (sql) => { db.exec(sql) },
    all: (sql, ...params) => db.prepare(sql).all(...(params as any[])) as Record<string, unknown>[],
    transaction: (fn) => {
      db.exec('BEGIN IMMEDIATE')
      try { fn(); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch { /* already rolled back */ } throw e }
    },
  }
}

/** How many backups of one database are kept beside it. */
const KEEP = 3

/** Apply a file database's migrations. Before pending migrations run on an existing database, a consistent copy is
 *  written to `backups/<file>.<time>.bak` beside it (VACUUM INTO), keeping the latest few. */
export function migrateFile(db: NodeSqlite, file: string, migrations: Migration[], name = basename(file)): MigrateResult {
  return migrate(nodeDb(db), migrations, {
    name,
    backup: file === ':memory:' ? undefined : () => {
      const dir = join(dirname(file), 'backups')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = join(dir, `${basename(file)}.${stamp}.bak`)
      if (!existsSync(target)) db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
      const mine = readdirSync(dir).filter((f) => f.startsWith(`${basename(file)}.`) && f.endsWith('.bak')).sort()
      for (const old of mine.slice(0, Math.max(0, mine.length - KEEP))) rmSync(join(dir, old), { force: true })
    },
  })
}
