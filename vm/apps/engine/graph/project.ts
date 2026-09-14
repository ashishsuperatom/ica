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
import { GraphStore, createEngine, managerDialects, managerInspect, managerQuery, type Engine } from '@superatom/graph'

export interface ProjectGraphPaths {
  /** Engine-private state for the project: the graph file and the program modules live here. */
  dbDir: string
  /** The project's committed configuration: settings.json. */
  projectDir: string
  managerUrl: string
}

export const graphFile = (dbDir: string) => join(dbDir, 'graph.sqlite')

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
    dialects: await managerDialects(p.managerUrl),
    inspect: managerInspect(p.managerUrl),
    assumptions: projectSettings(p.projectDir),
  })
}
