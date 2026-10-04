// The database the datasource index lives in: one SQLite file per project, holding only the index.
//
// Opened with its migrations applied (@superatom/migrate).

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrateFile } from '@superatom/migrate/node'
import { addColumnIfMissing, type Migration } from '@superatom/migrate'
import { DATASOURCE_INDEX_SCHEMA } from './datasource-index.js'

/** The index's migrations (@superatom/migrate): numbered, never edited once shipped — a change is a new one. The
 *  baseline adopts an index made before migrations (which may lack the rows column). */
export const MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: (db) => { db.exec(DATASOURCE_INDEX_SCHEMA); addColumnIfMissing(db, 'datasource_index', 'rows', 'INTEGER') } },
]

export class DataSourceIndex {
  readonly db: Database.Database

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    // The index is rebuilt by one process while the agents' ./find-schema reads it: wait for a lock, never fail on one.
    this.db.pragma('busy_timeout = 5000')
    migrateFile(this.db, path, MIGRATIONS, 'datasource-index.sqlite')
  }

  close() { this.db.close() }
}
