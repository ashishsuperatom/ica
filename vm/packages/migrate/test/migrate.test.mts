import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, addColumnIfMissing, fingerprint, MigrationError, type Migration } from '../src/index.ts'
import { nodeDb, migrateFile } from '../src/node.ts'

const v1: Migration[] = [
  { id: 1, name: 'people', up: 'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)' },
  { id: 2, name: 'people email', up: 'ALTER TABLE people ADD COLUMN email TEXT' },
]
const fresh = () => new DatabaseSync(':memory:')
const cols = (db: DatabaseSync, t: string) => (db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as any[]).map((r) => r.name)

test('a new database gets every migration, in order, recorded', () => {
  const db = fresh()
  const r = migrate(nodeDb(db), v1, { name: 'test.db' })
  assert.deepEqual(r, { applied: [1, 2], current: 2 })
  assert.deepEqual(cols(db, 'people'), ['id', 'name', 'email'])
  const rows = db.prepare('SELECT id, name, fingerprint FROM _migrations ORDER BY id').all() as any[]
  assert.deepEqual(rows.map((x) => [x.id, x.name, x.fingerprint]), v1.map((m) => [m.id, m.name, fingerprint(m)]))
})

test('opening it again applies nothing', () => {
  const db = fresh()
  migrate(nodeDb(db), v1, { name: 'test.db' })
  assert.deepEqual(migrate(nodeDb(db), v1, { name: 'test.db' }), { applied: [], current: 2 })
})

test('only the new migration runs, and a backup is taken first', () => {
  const db = fresh()
  migrate(nodeDb(db), v1, { name: 'test.db' })
  let backups = 0
  const v2 = [...v1, { id: 3, name: 'teams', up: 'CREATE TABLE teams (id INTEGER PRIMARY KEY)' }]
  assert.deepEqual(migrate(nodeDb(db), v2, { name: 'test.db', backup: () => { backups++ } }), { applied: [3], current: 3 })
  assert.equal(backups, 1)
})

test('a brand-new database is not backed up', () => {
  let backups = 0
  migrate(nodeDb(fresh()), v1, { name: 'test.db', backup: () => { backups++ } })
  assert.equal(backups, 0)
})

test('an edited migration is refused — a shipped migration is never changed', () => {
  const db = fresh()
  migrate(nodeDb(db), v1, { name: 'test.db' })
  const edited = [v1[0], { ...v1[1], up: 'ALTER TABLE people ADD COLUMN mail TEXT' }]
  assert.throws(() => migrate(nodeDb(db), edited, { name: 'test.db' }), (e: any) => e instanceof MigrationError && /migration 2 .* has changed/.test(e.message))
  const renamed = [v1[0], { ...v1[1], name: 'email' }]
  assert.throws(() => migrate(nodeDb(db), renamed, { name: 'test.db' }), /has changed/)
})

test('whitespace in SQL does not change the fingerprint', () => {
  assert.equal(fingerprint({ id: 1, name: 'x', up: 'CREATE  TABLE a (\n id INTEGER )' }), fingerprint({ id: 1, name: 'x', up: 'CREATE TABLE a ( id INTEGER )' }))
})

test('a database migrated by newer code is refused', () => {
  const db = fresh()
  migrate(nodeDb(db), [...v1, { id: 3, name: 'teams', up: 'CREATE TABLE teams (id INTEGER PRIMARY KEY)' }], { name: 'test.db' })
  assert.throws(() => migrate(nodeDb(db), v1, { name: 'test.db' }), /migrated by newer code .* at migration 3/)
})

test('a failing migration leaves nothing behind and is not recorded', () => {
  const db = fresh()
  migrate(nodeDb(db), v1, { name: 'test.db' })
  const bad = [...v1, { id: 3, name: 'half', up: 'CREATE TABLE teams (id INTEGER PRIMARY KEY); INSERT INTO nowhere VALUES (1)' }]
  assert.throws(() => migrate(nodeDb(db), bad, { name: 'test.db' }), /migration 3 \("half"\) failed and was not applied/)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'teams'").get() as any).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as any).n, 2)
})

test('a broken list is refused before anything runs', () => {
  assert.throws(() => migrate(nodeDb(fresh()), [v1[0], { ...v1[1], id: 3 }], { name: 'test.db' }), /numbered 1, 2, 3/)
  assert.throws(() => migrate(nodeDb(fresh()), [{ ...v1[0], name: ' ' }], { name: 'test.db' }), /has no name/)
})

test('a database made before migrations is adopted by a first migration that tolerates what is there', () => {
  const db = fresh()
  db.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')          // the old self-made shape
  db.exec("INSERT INTO people (name) VALUES ('kept')")
  const adopt: Migration[] = [{ id: 1, name: 'baseline', up: (m) => {
    m.exec('CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    addColumnIfMissing(m, 'people', 'email', 'TEXT')
  } }]
  let backups = 0
  assert.deepEqual(migrate(nodeDb(db), adopt, { name: 'test.db', backup: () => { backups++ } }), { applied: [1], current: 1 })
  assert.equal(backups, 1)
  assert.deepEqual(cols(db, 'people'), ['id', 'name', 'email'])
  assert.equal((db.prepare('SELECT name FROM people').get() as any).name, 'kept')
  // the same baseline on a brand-new database makes the whole shape
  const empty = fresh(); migrate(nodeDb(empty), adopt, { name: 'test.db' })
  assert.deepEqual(cols(empty, 'people'), ['id', 'name', 'email'])
})

test('a file database is backed up beside itself before pending migrations, keeping the latest three', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
  const file = join(dir, 'x.sqlite')
  const db = new DatabaseSync(file)
  migrateFile(db, file, v1)
  assert.equal(readdirSync(dir).includes('backups'), false)               // new: nothing to back up
  let list = v1
  for (let i = 3; i <= 7; i++) {
    list = [...list, { id: i, name: `t${i}`, up: `CREATE TABLE t${i} (id INTEGER)` }]
    migrateFile(db, file, list)
  }
  const kept = readdirSync(join(dir, 'backups'))
  assert.equal(kept.length, 3)
  const copy = new DatabaseSync(join(dir, 'backups', kept.sort().at(-1)!))
  assert.equal((copy.prepare('SELECT MAX(id) AS n FROM _migrations').get() as any).n, 6)   // taken just before migration 7
})

test('a Durable Object storage migrates through its own transactions', async () => {
  const { durableObjectDb } = await import('../src/index.ts')
  const db = fresh()
  let inTx = 0
  const storage = {   // the shape of ctx.storage: sql.exec returns a cursor (iterable), transactionSync wraps a function
    sql: { exec: (sql: string, ...params: unknown[]) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) throw new Error('not allowed in a Durable Object')
      if (params.length || /^\s*(SELECT|INSERT[\s\S]*RETURNING)/i.test(sql)) return db.prepare(sql).all(...(params as any[])) as any[]
      db.exec(sql); return [] as any[]
    } },
    transactionSync<T>(fn: () => T): T { inTx++; db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } },
  }
  assert.deepEqual(migrate(durableObjectDb(storage), v1, { name: 'project-do' }), { applied: [1, 2], current: 2 })
  assert.equal(inTx, 2)
  assert.deepEqual(cols(db, 'people'), ['id', 'name', 'email'])
})
