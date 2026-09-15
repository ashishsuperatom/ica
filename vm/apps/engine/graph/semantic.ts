// ── A PROJECT'S SEMANTIC GRAPH ──────────────────────────────────────────────────────────────────────────────
//
// The semantic model a project commits — projects/<id>/semantic/ — loaded into the engine-private store
// (db/semantic-graph.sqlite), and run through the datasource manager:
//
//   semantic/schema.json                     the schema: entities, calendars, facts, arrows, measures
//   semantic/sources.json                    where each object's rows are
//   semantic/settings.json                   the organisation's settings (optional)
//   semantic/programs/<name>/program.json    a program that produces an object: { produces, reads, description }
//   semantic/programs/<name>/program.mjs     its body
//
// Loading defines each file by content hash under the model name "model": an unchanged file is a no-op, a changed one
// moves the name and keeps what it meant before.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGraph, managerDialects, managerQuery, Store, type Schema, type Sources } from '@superatom/semantic-graph'

export const MODEL = 'model'
export const semanticDir = (projectDir: string) => join(projectDir, 'semantic')
export const hasSemanticModel = (projectDir?: string) => !!projectDir && existsSync(join(semanticDir(projectDir), 'schema.json'))
export const semanticFile = (dbDir: string) => join(dbDir, 'semantic-graph.sqlite')

/** The organisation's settings (settings.json: its time zone, currency), or none. */
export function projectSettings(projectDir: string): Record<string, unknown> {
  const file = join(projectDir, 'settings.json')
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { throw new Error(`${file} is not valid JSON: ${e.message}`) }
}

const read = (file: string) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { throw new Error(`${file}: ${e.message}`) } }

export async function openSemanticGraph(p: { dbDir: string; projectDir: string; managerUrl: string; now?: () => Date }) {
  const dir = semanticDir(p.projectDir)
  const graph = createGraph({ store: new Store(semanticFile(p.dbDir)), query: managerQuery(p.managerUrl), dialects: await managerDialects(p.managerUrl), ...(p.now ? { now: p.now } : {}) })
  const by = 'project files'
  graph.defineSchema(MODEL, read(join(dir, 'schema.json')) as Schema, by, 'loaded from semantic/schema.json', { breaking: true })
  if (existsSync(join(dir, 'programs'))) {
    for (const name of readdirSync(join(dir, 'programs'))) {
      const def = read(join(dir, 'programs', name, 'program.json'))
      graph.defineProgram(name, { ...def, body: readFileSync(join(dir, 'programs', name, 'program.mjs'), 'utf8') }, by)
    }
  }
  // The organisation's settings (settings.json: its time zone, currency) under the model's own.
  const organisation = existsSync(join(p.projectDir, 'settings.json')) ? read(join(p.projectDir, 'settings.json')) : {}
  const own = existsSync(join(dir, 'settings.json')) ? read(join(dir, 'settings.json')) : {}
  if (Object.keys(organisation).length || Object.keys(own).length) graph.defineSettings(MODEL, { ...organisation, ...own }, by)
  if (existsSync(join(dir, 'sources.json'))) await graph.defineSources(MODEL, read(join(dir, 'sources.json')) as Sources, by)
  return graph
}
