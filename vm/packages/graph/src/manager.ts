// ── THE DATASOURCE MANAGER, AS THE ENGINE REACHES IT ──────────────────────────────────────────────────────────
//
// The engine takes its query function, its dialects and its SQL inspection from outside (runtime.ts), so it can run
// anywhere. These are the ones that reach the datasource manager over HTTP — used by the ICA engine, the examples and
// the live tests alike.

import type { Dialect } from './dialects.js'
import type { SqlAnalysis } from './runtime.js'

/** A statement run through the manager, with the person's access policies. A result the manager cut short says so
 *  on the rows, as `notes`. */
export function managerQuery(url = process.env.DATASOURCE_URL ?? 'http://localhost:4000') {
  return async (source: string, sql: string, params: Record<string, unknown> = {}, options: { policies?: unknown[] } = {}) => {
    const res = await fetch(`${url}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: source, sql, params, ...(options.policies?.length ? { policies: options.policies } : {}) }),
    })
    const body: any = await res.json().catch(() => ({}))
    if (!res.ok || body.error) throw new Error(`${source}: ${body.error ?? `the manager answered ${res.status}`}`)
    const rows: any[] = body.rows ?? []
    if (Array.isArray(body.notes) && body.notes.length) Object.defineProperty(rows, 'notes', { value: body.notes, enumerable: false })
    return rows
  }
}

/** How the manager names a dialect, as the engine names it; null for one the engine cannot write. */
export function engineDialect(dialect: string | undefined): Dialect | null {
  const d = String(dialect ?? '').toLowerCase()
  if (['suiteql', 'oracle', 'netsuite'].includes(d)) return 'oracle'
  if (['mssql', 'tsql', 'sqlserver'].includes(d)) return 'mssql'
  if (d === 'sqlite') return 'sqlite'
  return null
}

/** Each SQL source the manager serves, with the dialect the engine writes for it. */
export async function managerDialects(url = process.env.DATASOURCE_URL ?? 'http://localhost:4000'): Promise<Record<string, Dialect>> {
  const res = await fetch(`${url}/sources`)
  if (!res.ok) throw new Error(`the datasource manager at ${url} did not list its sources (${res.status})`)
  const { sources } = (await res.json()) as { sources: Array<{ id: string; kind: string; dialect?: string }> }
  return Object.fromEntries(sources.flatMap((s) => { const d = s.kind === 'sql' ? engineDialect(s.dialect) : null; return d ? [[s.id, d]] : [] }))
}

/** SQL read without running it, by the same SQLGlot the manager rewrites queries with. */
export function managerInspect(url = process.env.DATASOURCE_URL ?? 'http://localhost:4000') {
  return async (sql: string, dialect: Dialect): Promise<SqlAnalysis> => {
    const res = await fetch(`${url}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql, dialect }) })
    const body: any = await res.json()
    if (!res.ok) throw new Error(`the SQL does not parse: ${body.error ?? res.status}`)
    return body
  }
}
