// ── THE DATASOURCE MANAGER, AS THE SEMANTIC GRAPH REACHES IT ────────────────────────────────────────────────────
//
// The graph takes its query function and dialects from outside, so it runs anywhere. These reach the datasource
// manager over HTTP — the one door to data, where access policies are applied and every statement is logged.

import { DIALECTS, type Dialect } from './dialects.js'
import type { Query } from './sql.js'

/** A statement run through the manager, with the person's access policies. A result the manager cut short says so on
 *  the rows, as `notes`. */
export function managerQuery(url = process.env.DATASOURCE_URL ?? 'http://localhost:4000'): Query {
  return async (source, sql, params = {}, options = {}) => {
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

/** The dialect written for how the manager names a source's dialect; null for one not written. */
export function dialectFor(name: string | undefined): Dialect | null {
  const d = String(name ?? '').toLowerCase()
  if (['suiteql', 'oracle', 'netsuite'].includes(d)) return DIALECTS.oracle
  if (['mssql', 'tsql', 'sqlserver'].includes(d)) return DIALECTS.mssql
  if (d === 'duckdb') return DIALECTS.duckdb
  if (d === 'sqlite') return DIALECTS.sqlite
  return null
}

/** Each SQL source the manager serves, with the dialect written for it. */
export async function managerDialects(url = process.env.DATASOURCE_URL ?? 'http://localhost:4000'): Promise<Record<string, Dialect>> {
  const res = await fetch(`${url}/sources`)
  if (!res.ok) throw new Error(`the datasource manager at ${url} did not list its sources (${res.status})`)
  const { sources } = (await res.json()) as { sources: Array<{ id: string; kind: string; dialect?: string }> }
  return Object.fromEntries(sources.flatMap((s) => { const d = s.kind === 'sql' ? dialectFor(s.dialect) : null; return d ? [[s.id, d]] : [] }))
}

/** SQL read without running it — the tables it reads and the columns it gives — by the SQLGlot the manager rewrites with. */
export function managerInspect(url = process.env.DATASOURCE_URL ?? 'http://localhost:4000') {
  return async (sql: string, dialect: string): Promise<{ tables: string[]; outputs: string[]; star: boolean }> => {
    const res = await fetch(`${url}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql, dialect }) })
    const body: any = await res.json()
    if (!res.ok) throw new Error(`the SQL does not parse: ${body.error ?? res.status}`)
    return body
  }
}
