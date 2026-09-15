// The same instance written into a DuckDB database through the duckdb CLI, dates as ISO text the way files landed from
// other systems keep them, and parameters bound the way a bridge binds them: @name replaced by a literal.

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Instance, Query, Schema } from '../../src/index.js'
import { toSqlite } from './sqlite.js'

export const duckdbInstalled = (() => { try { execFileSync('duckdb', ['--version']); return true } catch { return false } })()

const literal = (v: unknown) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)

export function toDuckdb(s: Schema, I: Instance): { query: Query; sources: ReturnType<typeof toSqlite>['sources'] } {
  // The tables SQLite gets, copied row for row.
  const { query: fromSqlite, sources } = toSqlite(s, I)
  const file = join(mkdtempSync(join(tmpdir(), 'sg-duck-')), 'db.duckdb')
  const tables = [...new Set([...Object.values(sources.facts), ...Object.values(sources.entities)].flatMap((x) => [x.sql!, ...Object.values((x as any).history ?? {}).map((h: any) => h.sql)])
    .map((sql) => sql.match(/FROM "([^"]+)"/)![1]))]
  const script: string[] = []
  return {
    sources,
    query: async (_source, sql, params) => {
      if (!script.length) {
        for (const t of tables) {
          const rows = await fromSqlite('DB', `SELECT * FROM "${t}"`, {})
          const cols = rows.length ? Object.keys(rows[0]) : ((await fromSqlite('DB', `SELECT name FROM pragma_table_info('${t}')`, {})) as any[]).map((r) => r.name)
          const type = (c: string) => (c.startsWith('m:') ? 'DOUBLE' : 'VARCHAR')
          script.push(`CREATE TABLE "${t}" (${cols.map((c) => `"${c}" ${type(c)}`).join(', ')});`)
          for (const r of rows) script.push(`INSERT INTO "${t}" VALUES (${cols.map((c) => literal((r as any)[c])).join(', ')});`)
        }
        execFileSync('duckdb', [file, '-c', script.join('\n')])
      }
      const text = sql.replace(/@(\w+)/g, (m, k) => (k in params ? literal(params[k]) : m))
      const out = execFileSync('duckdb', [file, '-json', '-c', text], { encoding: 'utf8' }).trim()
      return out ? JSON.parse(out) : []
    },
  }
}
