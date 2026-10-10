// The graph on Node: a store in a SQLite file (an engine's replica, the CLI, tests), and verifying against written
// knowledge (which needs a scratch store). Everything else is the package itself (index.ts), which a Worker loads.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrateFile } from '@superatom/migrate/node'
import { Store, MIGRATIONS, type GraphDb } from './store.js'
import { verifyAgainst as against, type Finding } from './verify.js'
import type { WrittenDomain, WrittenSetting } from './import.js'
import type { ConceptBody } from './compose.js'

export * from './index.js'

/** A SQLite file (or ':memory:') as a graph's database, migrated: a unit of work is a savepoint, so units nest. */
export function fileGraphDb(file: string): GraphDb {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 15000')
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  migrateFile(db, file, MIGRATIONS, 'composition.sqlite')
  let depth = 0
  return {
    prepare: (sql) => {
      const st = db.prepare(sql)
      return { get: (...p) => st.get(...(p as any[])), all: (...p) => st.all(...(p as any[])), run: (...p) => st.run(...(p as any[])) }
    },
    atomic: (fn) => {
      const sp = `cg_${depth++}`
      db.exec(`SAVEPOINT ${sp}`)
      try { const r = fn(); db.exec(`RELEASE ${sp}`); return r }
      catch (e) { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); throw e }
      finally { depth-- }
    },
    close: () => db.close(),
  }
}

/** A graph in a SQLite file (or ':memory:'). */
export const openStore = (file: string) => new Store(fileGraphDb(file))

/** The graph against the project's written knowledge (verify.ts), importing into a scratch store in memory. */
export function verifyAgainst(store: Store, domains: WrittenDomain[], readFile: (domain: string, file: string) => string, settings: WrittenSetting[] = [], concepts: (ConceptBody & { name?: string })[] = []): Finding[] {
  return against(store, domains, readFile, settings, () => openStore(':memory:'), concepts)
}
