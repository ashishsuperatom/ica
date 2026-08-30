// ⚠️  TEST-ONLY local SQLite data source — never production. A throwaway employees table so a real question has
// real data to compute over, entirely on the laptop. Loaded by the datasource-manager exactly like any bridge
// (createBridge → {kind, dialect, query, introspect}); the manager still rewrites the agent's SQL through SQLGlot
// (dialect 'sqlite') before calling query() here.
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const DB_PATH = process.env.E2E_DB || join(dirname(fileURLToPath(import.meta.url)), 'employees.db')

// A tiny, obvious dataset: 11 people across 4 departments (so "headcount by department" has a checkable answer).
const SEED = [
  ['Ada',   'Engineering'], ['Grace', 'Engineering'], ['Linus', 'Engineering'], ['Dennis', 'Engineering'],
  ['Kay',   'Sales'],       ['Alan',  'Sales'],        ['Edsger', 'Sales'],
  ['Barbara', 'Finance'],   ['John',  'Finance'],
  ['Margaret', 'Support'],  ['Hedy',  'Support'],
]

export function createBridge() {
  const db = new DatabaseSync(DB_PATH)
  db.exec(`CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, department TEXT NOT NULL)`)
  const [{ n }] = db.prepare('SELECT COUNT(*) AS n FROM employees').all()
  if (!n) { const ins = db.prepare('INSERT INTO employees (name, department) VALUES (?, ?)'); for (const [name, dept] of SEED) ins.run(name, dept) }

  return {
    id: 'EMPLOYEES',
    kind: 'sql',
    dialect: 'sqlite',
    description: 'A single table `employees(id, name, department)` in local SQLite. Standard SQLite SQL.',
    ready: () => true,
    async query(sql, params) {
      const stmt = db.prepare(sql)
      try { return params && Object.keys(params).length ? stmt.all(params) : stmt.all() }
      catch { return stmt.all() }   // inline-value queries take no params; ignore a stray params object
    },
    async introspect() {
      const cols = db.prepare(`PRAGMA table_info(employees)`).all().map((c) => ({ name: c.name, type: c.type }))
      return { kind: 'sql', dialect: 'sqlite', tables: [{ name: 'employees', columns: cols }] }
    },
    close() { try { db.close() } catch {} },
  }
}
