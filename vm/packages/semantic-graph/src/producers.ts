// ── WHERE AN OBJECT'S ROWS COME FROM: STATEMENTS, STATEMENTS ON OTHER OBJECTS, AND PROGRAMS ─────────────────────
//
// An object's source is one of three things.
//
//   a statement            SQL a source runs — `SELECT … FROM job`
//   a statement on others  SQL over other objects, named in braces — `SELECT a.*, a.hours * r.rate AS revenue FROM
//                          {{AllocationDay}} a JOIN {{RateCard}} r ON …` — each replaced by that object's own statement.
//                          A correction to an object reaches everything built on it, and so does an intervention.
//   a program              JavaScript for what SQL cannot say or a source that is not SQL — spreading allocations over
//                          working days, an API. It is a definition by content hash, declares the sources and objects
//                          it reads, and returns rows; its rows are checked against the object's grain and placed in a
//                          table where the statement that asks the question runs.
//
// A statement runs in one place. When an object's rows are computed here, the objects joined to it are read here too —
// and a source that holds rows back cannot be read here, which is said, not worked around.

import type { Sources, FactSource, EntitySource, Query, Dialect } from './sql.js'
import { arrows, timeArrow, type Schema } from './schema.js'

export const LOCAL = '@local'

export interface ProgramDef {
  /** The object whose rows it produces. */
  produces: string
  /** What it may read: data sources, and objects of the schema (through their own sources). */
  reads: { sources: string[]; objects: string[] }
  /** An ES module: `export default async (ctx, { from, to }) => rows` — rows are records of the object's columns. */
  body: string
  description?: string
}

export interface ProgramContext {
  /** A statement on a source the program declares. Rows a source cut short are refused. */
  query(source: string, sql: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>
  /** The rows of an object the program declares, over the span. */
  rows(object: string): Promise<Array<Record<string, unknown>>>
  /** A setting, from the nearest layer. */
  assume(name: string, fallback?: unknown): unknown
  today: string
}

/** The objects a statement names in braces. */
export const namedIn = (sql: string) => [...new Set([...sql.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim()))]

/** What is wrong with sources against a schema before anything runs: objects that do not exist, braces that name an
 *  unknown object or go round in a circle, declared columns missing from what a program says it produces. */
export function sourcesProblems(s: Schema, src: Sources): string[] {
  const out: string[] = []
  const statementOf = (o: string) => src.facts[o]?.sql ?? src.entities[o]?.sql
  for (const [o, x] of [...Object.entries(src.facts), ...Object.entries(src.entities)] as Array<[string, FactSource | EntitySource]>) {
    if (!s.objects[o]) { out.push(`the sources name ${o}, which the schema does not have`); continue }
    if (s.objects[o].kind === 'fact' !== o in src.facts) out.push(`${o} is ${s.objects[o].kind === 'fact' ? 'a fact' : 'an entity'} and its source is given as ${o in src.facts ? 'a fact' : 'an entity'}'s`)
    if (!x.sql && !x.program) out.push(`${o}: a source is a statement or a program`)
    if (x.sql && x.program) out.push(`${o}: a source is a statement or a program, not both`)
    for (const n of namedIn(x.sql ?? '')) {
      if (!statementOf(n) && !src.facts[n]?.program && !src.entities[n]?.program) out.push(`${o} is built on {{${n}}}, which has no source`)
    }
  }
  for (const [f, fs] of Object.entries(src.facts)) {
    if (!s.objects[f] || s.objects[f].kind !== 'fact') continue
    const t = timeArrow(s, f)
    for (const a of arrows(s, f)) if (a.role !== t?.role && !fs.arrows[a.role]) out.push(`${f}.${a.role} has no column in its source`)
    if (t && !fs.time) out.push(`${f} is kept by ${t.to} and its source names no time column`)
    for (const m of Object.keys(s.objects[f].measures ?? {})) if (!fs.measures[m]) out.push(`${f}.${m} has no column in its source`)
    for (const a of Object.keys(s.objects[f].attributes ?? {})) if (!fs.attributes?.[a]) out.push(`${f}.@${a} has no column in its source`)
  }
  for (const [e, es] of Object.entries(src.entities)) {
    if (!s.objects[e] || s.objects[e].kind !== 'entity') continue
    for (const a of arrows(s, e)) {
      if (a.kind === 'as-of' ? !es.history?.[a.role] : !es.arrows[a.role]) out.push(`${e}.${a.role} has no ${a.kind === 'as-of' ? 'history' : 'column'} in its source`)
    }
  }
  // Braces never go round in a circle.
  const visit = (o: string, trail: string[]) => {
    if (trail.includes(o)) { out.push(`the sources are built on each other in a circle: ${[...trail, o].join(' → ')}`); return }
    for (const n of namedIn(src.facts[o]?.sql ?? src.entities[o]?.sql ?? '')) visit(n, [...trail, o])
  }
  for (const o of [...Object.keys(src.facts), ...Object.keys(src.entities)]) visit(o, [])
  return [...new Set(out)]
}

/** Every object's statement with the objects it names in braces put in place, and their parameters with it. Run after
 *  interventions are applied, so what an object is built on is the changed data. */
export function expandSources(src: Sources): Sources {
  const out: Sources = structuredClone(src)
  const done = new Map<string, { sql: string; source: string; params: Record<string, unknown> }>()
  const expand = (o: string, trail: string[]): { sql: string; source: string; params: Record<string, unknown> } => {
    if (done.has(o)) return done.get(o)!
    if (trail.includes(o)) throw new Error(`the sources are built on each other in a circle: ${[...trail, o].join(' → ')}`)
    const x: FactSource | EntitySource = out.facts[o] ?? out.entities[o] ?? (() => { throw new Error(`{{${o}}} has no source`) })()
    if (!x.sql) throw new Error(`{{${o}}} is produced by a program, so a statement cannot be built on it`)
    let source = x.source
    const params: Record<string, unknown> = { ...x.params }
    const sql = x.sql.replace(/\{\{([^}]+)\}\}/g, (_m, name: string) => {
      const inner = expand(name.trim(), [...trail, o])
      if (inner.source !== source) throw new Error(`${o} is built on ${name.trim()}, which is in ${inner.source} while ${o} is in ${source}; one statement cannot read both`)
      for (const [k, v] of Object.entries(inner.params)) { if (k in params && params[k] !== v) throw new Error(`parameter @${k} means two things in ${o}`); params[k] = v }
      return `(${inner.sql})`
    })
    const r = { sql, source, params }
    done.set(o, r)
    return r
  }
  for (const [o, x] of [...Object.entries(out.facts), ...Object.entries(out.entities)] as Array<[string, FactSource | EntitySource]>) {
    if (!x.sql) continue
    const r = expand(o, [])
    x.sql = r.sql
    x.params = r.params
  }
  return out
}

/** A module body loaded once per hash. */
export async function loadModule(hash: string, body: string, cache: Map<string, Function>): Promise<Function> {
  if (cache.has(hash)) return cache.get(hash)!
  const mod = await import(`data:text/javascript;base64,${Buffer.from(body).toString('base64')}`)
  if (typeof mod.default !== 'function') throw new Error('a program is a module whose default export is a function')
  cache.set(hash, mod.default)
  return mod.default
}

/** The declared columns of an object's source — what a program's rows must carry. */
export function declaredColumns(x: FactSource | EntitySource): string[] {
  if ('measures' in x) return [...new Set([...Object.values(x.arrows), ...(x.time ? [x.time] : []), ...Object.values(x.attributes ?? {}), ...Object.values(x.measures)])]
  return [...new Set([x.key, ...Object.values(x.arrows)])]
}

export type { Query, Dialect }
