// The database the datasource index lives in: one SQLite file per project, holding only the index.
//
// The index used to share project.sqlite with an earlier engine's concept and intent graph. A new file is opened
// here instead of that one, and on first open the index rows are copied across from it; project.sqlite itself is
// left untouched.

import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATASOURCE_INDEX_SCHEMA } from './datasource-index.js'

export class DataSourceIndex {
  readonly db: Database.Database

  constructor(path = ':memory:') {
    const fresh = path === ':memory:' || !existsSync(path)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    // The index is rebuilt by one process while the agents' ./find-schema reads it: wait for a lock, never fail on one.
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(DATASOURCE_INDEX_SCHEMA)
    if (fresh && path !== ':memory:') this.#carryOver(join(dirname(path), 'project.sqlite'))
  }

  #carryOver(earlier: string): void {
    if (!existsSync(earlier)) return
    try {
      this.db.prepare('ATTACH DATABASE ? AS earlier').run(earlier)
      const columns = (this.db.prepare(`PRAGMA earlier.table_info(datasource_index)`).all() as any[]).map((c) => c.name)
      if (columns.length) {
        const list = columns.map((c) => `"${c}"`).join(', ')
        this.db.exec(`INSERT OR IGNORE INTO datasource_index (${list}) SELECT ${list} FROM earlier.datasource_index`)
      }
      this.db.exec('DETACH DATABASE earlier')
    } catch { /* nothing to carry over: the index is built afresh */ }
  }

  close() { this.db.close() }
}
