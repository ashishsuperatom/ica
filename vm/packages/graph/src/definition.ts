// ── WHAT IS CHECKED WHEN A PROGRAM IS DEFINED ─────────────────────────────────────────────────────────────
//
// The moment of definition is where a mistake is cheapest to catch — not at the first call, in front of someone's
// question. Everything here runs before a program is stored or a name moves.

import { expand, readingContext } from './composition.js'
import type { Contract } from './contract.js'
import type { Dialect, When } from './coordinates.js'
import { runLocal } from './execute.js'
import { newTrail, type Runtime, type SqlAnalysis } from './runtime.js'
import { isDerived, kindOf, type Shape, type Statement } from './shape.js'

/** An inspect function that asks the datasource manager, which parses with the same SQLGlot that rewrites queries. */
export function managerInspect(url = process.env.DATASOURCE_URL ?? 'http://localhost:4000') {
  return async (sql: string, dialect: Dialect): Promise<SqlAnalysis> => {
    const res = await fetch(`${url}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql, dialect }) })
    const body: any = await res.json()
    if (!res.ok) throw new Error(`the SQL does not parse: ${body.error ?? res.status}`)
    return body
  }
}

const declaredColumns = (shape: Shape) => {
  const columns = new Set<string>()
  for (const d of Object.values(shape.dimensions)) { columns.add(d.column); if (d.label) columns.add(d.label) }
  for (const m of Object.values(shape.measures)) if (!isDerived(m) && m.column) columns.add(m.column)
  if (shape.time) columns.add(shape.time)
  return columns
}

/** A relation is read once when it is defined: its SQL parsed if the engine can, every column its shape names
 *  counted, and its grain checked to repeat no member. */
export async function checkRelation(rt: Runtime, hash: string, body: string, contract: Contract): Promise<void> {
  const shape = contract.shape!
  const today = rt.clock()
  const when: When = kindOf(shape) === 'flow' ? { from: today, to: today, where: {} } : { asAt: today, where: {} }
  const scope = { today, context: {}, interventions: {} }
  if (rt.o.inspect) await inspectRelation(rt, hash, body, contract, when, scope)
  const st = await expand(rt, contract.name, contract, hash, body, when, scope, newTrail(), [])
  const columns = declaredColumns(shape)
  const run = async (sql: string) => (st.tables ? runLocal({ ...st, sql }) : rt.o.query(st.source, sql, st.params))

  // A GRAIN IS A PROMISE THAT NO MEMBER REPEATS. Every join to this relation relies on it; checked now, and again
  // whenever it is joined.
  if (shape.grain) {
    const key = shape.dimensions[shape.grain].column
    const [c] = await run(`SELECT COUNT(*) AS n, COUNT(DISTINCT g.${key}) AS d FROM (\n${st.sql.trim()}\n) g`)
    if (Number(c?.n) !== Number(c?.d)) throw new Error(`its grain is ${shape.grain}, but ${c?.n} rows hold only ${c?.d} distinct ${shape.grain} values as at ${today}`)
  }
  if (st.tables) {
    // A local table has exactly the columns its rows have; a missing one is named rather than left to SQLite.
    const have = new Set(Object.values(st.tables).flatMap((rows) => rows.flatMap((r) => Object.keys(r))))
    const rowsAreTheRelation = Object.keys(st.tables).length === 1 && /^SELECT \* FROM r_/.test(st.sql)
    const missing = rowsAreTheRelation && have.size ? [...columns].filter((c) => !have.has(c)) : []
    if (missing.length) throw new Error(`the rows have no ${missing.map((c) => `"${c}"`).join(', ')}`)
  }
  // Aggregated, with no outer filter: NetSuite does not check the columns of a query it can see returns nothing.
  await run(`SELECT ${[...columns].map((c, i) => `COUNT(t.${c}) AS c${i}`).join(', ')}\nFROM (\n${st.sql.trim()}\n) t`)
}

/** The checks only a parser can make, before anything runs. */
async function inspectRelation(rt: Runtime, hash: string, body: string, contract: Contract, when: When,
                               scope: { today: string; context: {}; interventions: {} }): Promise<void> {
  const fn = await rt.load(hash, body)
  const out = (await fn(readingContext(rt, contract, scope, newTrail()), when)) as Statement
  if (typeof out?.sql !== 'string') return
  if (contract.kind === 'program') {
    // ONLY A CONCEPT NAMES A TABLE. A relation program reads data through the relations in its braces; any other
    // table in its SQL is a data read that bypasses the one definition of that data.
    const names: string[] = []
    const marked = out.sql.replace(/\{\{([^}]+)\}\}/g, (_m, n) => { names.push(n); return `__relation_${names.length - 1}` })
    const first = names.length ? rt.o.store.resolve(names[0]) : null
    const dialect = dialectOf(rt, first ? rt.o.store.getProgram(first)!.contract : null) ?? 'oracle'
    const { tables } = await rt.o.inspect!(marked, dialect)
    const direct = tables.filter((t) => !/^__relation_\d+$/.test(t))
    if (direct.length) throw new Error(`it reads ${direct.join(', ')} directly — a program reads data only through the relations named in {{braces}}`)
    return
  }
  const dialect = rt.o.dialects[out.source]
  if (!dialect) return
  const { outputs, star } = await rt.o.inspect!(out.sql, dialect)
  if (star) return
  const have = new Set(outputs.map((c) => c.toLowerCase()))
  const missing = [...declaredColumns(contract.shape!)].filter((c) => !have.has(c.toLowerCase()))
  if (missing.length) throw new Error(`the shape names ${missing.map((c) => `"${c}"`).join(', ')}, which its SQL does not output (it outputs ${outputs.join(', ')})`)
}

/** The dialect a relation's SQL is written in: its concept's source, or, for a program, that of what it builds on. */
function dialectOf(rt: Runtime, c: Contract | null, seen = new Set<string>()): Dialect | null {
  if (!c) return null
  if (c.kind === 'concept') return rt.o.dialects[c.reads.sources[0]] ?? null
  for (const n of c.reads.programs) {
    if (seen.has(n)) continue
    seen.add(n)
    const h = rt.o.store.resolve(n)
    const d = h ? dialectOf(rt, rt.o.store.getProgram(h)!.contract, seen) : null
    if (d) return d
  }
  return null
}

/** The path from these names to `target` through what each program reads, or null if there is none. */
export function reachesName(rt: Runtime, reads: string[], target: string, seen = new Set<string>()): string[] | null {
  for (const read of reads) {
    if (read === target) return [read]
    if (seen.has(read)) continue
    seen.add(read)
    const hash = rt.o.store.resolve(read)
    const next = hash ? rt.o.store.getProgram(hash)?.contract.reads.programs ?? [] : []
    const path = reachesName(rt, next, target, seen)
    if (path) return [read, ...path]
  }
  return null
}

/** Why a named program cannot fill a program parameter, or null if it can. */
export function programParamMisfit(rt: Runtime, named: string, spec: Exclude<Contract['params'][string], string>): string | null {
  const hash = rt.o.store.resolve(named)
  if (!hash) return `no program named "${named}"`
  const c = rt.o.store.getProgram(hash)!.contract
  const want = spec.program
  if (want.returns && c.returns !== want.returns) return `"${named}" returns ${c.returns}, and a ${want.returns} is needed`
  for (const m of want.measures ?? []) if (!c.shape?.measures[m]) return `"${named}" has no measure "${m}"`
  for (const d of want.dimensions ?? []) if (!c.shape?.dimensions[d]) return `"${named}" has no dimension "${d}"`
  return null
}

/** Why a new program cannot take an old one's name without breaking what calls it, or null if it can. */
export function interfaceMisfit(old: Contract, next: Contract): string | null {
  if (old.returns !== next.returns) return `it returns ${next.returns}, and callers expect ${old.returns}`
  for (const p of Object.keys(old.params)) if (!(p in next.params)) return `it drops the parameter "${p}"`
  if (old.returns !== 'relation') return null
  const a = old.shape!, b = next.shape!
  for (const [n, d] of Object.entries(a.dimensions)) {
    const e = b.dimensions[n]
    if (!e) return `it drops the dimension "${n}"`
    if (e.column !== d.column || e.label !== d.label) return `dimension "${n}" moves to other columns`
    if (d.entity && e.entity !== d.entity) return `dimension "${n}" no longer identifies ${d.entity}`
  }
  for (const [n, m] of Object.entries(a.measures)) {
    const e = b.measures[n]
    if (!e) return `it drops the measure "${n}"`
    if (e.unit !== m.unit) return `measure "${n}" changes unit from ${m.unit} to ${e.unit}`
    if (e.kind !== m.kind) return `measure "${n}" changes from a ${m.kind} to a ${e.kind}`
    if (isDerived(m) !== isDerived(e)) return `measure "${n}" changes between computed and aggregated`
    if (!isDerived(m) && !isDerived(e) && (e.column !== m.column || e.aggregate !== m.aggregate)) return `measure "${n}" is aggregated differently`
  }
  if (a.time !== b.time) return `its time column changes from ${a.time} to ${b.time}`
  if (a.grain !== b.grain) return `its grain changes from ${a.grain ?? 'none'} to ${b.grain ?? 'none'}`
  return null
}
