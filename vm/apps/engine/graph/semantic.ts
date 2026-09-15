// ── A PROJECT'S SEMANTIC GRAPH ──────────────────────────────────────────────────────────────────────────────
//
// A project's model lives in its graph store — <project home>/db/semantic-graph.sqlite, beside its memory — built and
// changed only through the semantic-graph tool (packages/semantic-graph/MODELING.md). Opening it derives the schema, the
// bindings, the programs and the settings from the store and defines each by content hash under the model name "model":
// what is unchanged is a no-op, what changed moves the name and keeps what it meant before. The organisation's own
// settings (the home's settings.json: its time zone) sit under the model's.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGraph, managerDialects, managerQuery, ModelStore, Store } from '@superatom/semantic-graph'

export const MODEL = 'model'
export const semanticFile = (dbDir: string) => join(dbDir, 'semantic-graph.sqlite')
/** The latest change to the project's model: a reader holding an older one opens it again. */
export const modelVersion = (dbDir: string) => { const m = new ModelStore(semanticFile(dbDir)); try { return m.has(MODEL) ? m.lastChange(MODEL) : 0 } finally { m.db.close() } }

/** The organisation's settings (settings.json: its time zone, currency), or none. */
export function projectSettings(projectDir: string): Record<string, unknown> {
  const file = join(projectDir, 'settings.json')
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { throw new Error(`${file} is not valid JSON: ${e.message}`) }
}

const read = (file: string) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { throw new Error(`${file}: ${e.message}`) } }

export async function openSemanticGraph(p: { dbDir: string; projectDir: string; managerUrl: string; now?: () => Date }) {
  const models = new ModelStore(semanticFile(p.dbDir))
  if (!models.has(MODEL)) {
    const files = join(p.projectDir, 'semantic', 'schema.json')
    throw new Error(`the project has no model in its graph store (${semanticFile(p.dbDir)})${existsSync(files) ? ` — its files can be imported once: semantic-graph --db ${semanticFile(p.dbDir)} import ${join(p.projectDir, 'semantic')}` : ' — build one with semantic-graph'}`)
  }
  const st = models.state(MODEL)
  const graph = createGraph({ store: new Store(semanticFile(p.dbDir)), query: managerQuery(p.managerUrl), dialects: await managerDialects(p.managerUrl), ...(p.now ? { now: p.now } : {}) })
  const by = `the graph store, change ${models.lastChange(MODEL)}`
  graph.defineSchema(MODEL, st.schema, by, 'the model as the graph store holds it', { breaking: true })
  for (const [name, def] of Object.entries(st.programs)) graph.defineProgram(name, def, by)
  const organisation = existsSync(join(p.projectDir, 'settings.json')) ? read(join(p.projectDir, 'settings.json')) : {}
  if (Object.keys(organisation).length || Object.keys(st.settings).length) graph.defineSettings(MODEL, { ...organisation, ...st.settings }, by)
  if (Object.keys(st.sources.facts).length || Object.keys(st.sources.entities).length) await graph.defineSources(MODEL, st.sources, by)
  return graph
}
