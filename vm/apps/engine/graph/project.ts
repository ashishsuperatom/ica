// ── A PROJECT'S GRAPH ─────────────────────────────────────────────────────────────────────────────────────────
//
// One graph per project: its programs, its memory, its data sessions — one SQLite file in the project's engine-private
// state, beside the agents' workspace and never inside it. The engine process and the agents' tools open the same
// file; SQLite serialises their writes.
//
// Data is read through the datasource manager, as everything is. Each source's SQL dialect comes from the manager's
// own description of it; the person's access policies travel with every query. The organisation's settings — its
// calendar, time zone, exchange rates, reporting currency, and assumption values — are read from the project's
// settings.json when there is one.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GraphStore, createEngine, managerInspect, type Dialect, type Engine } from '@superatom/graph'

export interface ProjectGraphPaths {
  /** Engine-private state for the project: the graph file and the program modules live here. */
  dbDir: string
  /** The project's committed configuration: settings.json. */
  projectDir: string
  managerUrl: string
}

export const graphFile = (dbDir: string) => join(dbDir, 'graph.sqlite')

/** How the manager names a dialect, as the graph names it. A source whose dialect the graph cannot write is left out. */
function graphDialect(dialect: string | undefined): Dialect | null {
  const d = String(dialect ?? '').toLowerCase()
  if (['suiteql', 'oracle', 'netsuite'].includes(d)) return 'oracle'
  if (['mssql', 'tsql', 'sqlserver'].includes(d)) return 'mssql'
  if (d === 'sqlite') return 'sqlite'
  return null
}

export async function sourceDialects(managerUrl: string): Promise<Record<string, Dialect>> {
  const res = await fetch(`${managerUrl}/sources`)
  if (!res.ok) throw new Error(`the datasource manager at ${managerUrl} did not list its sources (${res.status})`)
  const { sources } = (await res.json()) as { sources: Array<{ id: string; kind: string; dialect?: string }> }
  const out: Record<string, Dialect> = {}
  for (const s of sources) {
    const d = s.kind === 'sql' ? graphDialect(s.dialect) : null
    if (d) out[s.id] = d
  }
  return out
}

/** A statement run through the manager, with the person's policies. A result the manager cut short says so on the rows. */
export function managerQuery(managerUrl: string) {
  return async (source: string, sql: string, params: Record<string, unknown> = {}, options: { policies?: unknown[] } = {}) => {
    const res = await fetch(`${managerUrl}/query`, {
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

export function projectSettings(projectDir: string): Record<string, unknown> {
  const file = join(projectDir, 'settings.json')
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { throw new Error(`${file} is not valid JSON: ${e.message}`) }
}

export async function openProjectGraph(p: ProjectGraphPaths): Promise<Engine> {
  return createEngine({
    store: new GraphStore(graphFile(p.dbDir)),
    modulesDir: join(p.dbDir, 'graph-modules'),
    query: managerQuery(p.managerUrl),
    dialects: await sourceDialects(p.managerUrl),
    inspect: managerInspect(p.managerUrl),
    assumptions: projectSettings(p.projectDir),
  })
}
