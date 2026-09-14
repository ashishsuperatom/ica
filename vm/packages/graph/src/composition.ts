// ── THE SQL OF A RELATION, WITH EVERY RELATION IT IS BUILT FROM IN PLACE ───────────────────────────────────
//
// A concept's body returns SQL over a source's tables — or, for a source that is not SQL, the rows themselves,
// which become a local table. A program that returns a relation returns SQL over other relations, named in braces
// — `SELECT h.* FROM {{utilised hours}} h WHERE h.billable = 'T'` — and each is replaced by that relation's own
// SQL, resolved by name now. So composition is still SQL, a correction to a relation reaches every relation built
// on it, and only a concept names a table.
//
// The trail's `used` collects what was inlined, so memory can say which programs an answer went through. `path`
// holds the relations being expanded, so one that is built on itself is refused instead of expanding for ever.

import { assume, calendarFor } from './assumptions.js'
import { Grains } from './calendar.js'
import { resolveSpan } from './relative.js'
import { namespaceOf } from './registry.js'
import type { Contract } from './contract.js'
import type { AttributeSource, LocalTable, RatesSource, ResolvedStatement, When } from './coordinates.js'
import { intervened } from './interventions.js'
import { LOCAL, type ProgramContext, type Runtime, type Scope, type Trail } from './runtime.js'
import { declaredColumns, kindOf, type Statement } from './shape.js'

export const compareAt = (value: number, op: '<' | '<=' | '>' | '>=', threshold: number) =>
  op === '<' ? value < threshold : op === '<=' ? value <= threshold : op === '>' ? value > threshold : value >= threshold

/** A context that may only read the sources its contract declares — what a concept's body gets while it produces a
 *  relation, and the base of every program's context. A program that returns a relation can read nothing. */
export function readingContext(rt: Runtime, contract: Contract, scope: Scope, trail: Trail): ProgramContext {
  return {
    call: async () => { throw new Error(`"${contract.name}" is producing a relation; it cannot call programs while doing so`) },
    query: async (source, sql, params) => {
      if (contract.kind !== 'concept') throw new Error(`"${contract.name}" is a program and queried ${source} — only a concept may read a data source`)
      if (!contract.reads.sources.includes(source)) throw new Error(`"${contract.name}" queried ${source}, which its contract does not declare`)
      const t = Date.now()
      const rows = await rt.o.query(source, sql, params, { policies: scope.access?.[source] })
      trail.queries.push({ source, sql, params: params ?? {}, rows: rows.length, ms: Date.now() - t,
                           capped: Array.isArray((rows as any).notes) && (rows as any).notes.length > 0 })
      return rows
    },
    decide: (_l, took) => took, verify: async () => {}, caveat: () => {}, today: scope.today,
    decideAt: (_l, value, op, threshold) => compareAt(value, op, threshold),
    span: (span) => { const r = resolveSpan(span as any, scope.today, new Grains(calendarFor(rt.o.assumptions, scope, trail))); return { from: r.from, to: r.to } },
    expectation: () => { throw new Error(`"${contract.name}" is producing a relation; it reads memory only as a program`) },
    assume: <T>(name: string, about?: Record<string, unknown>) => assume<T>(rt.o.assumptions, contract, scope, name, trail, about),
    who: scope.who,
  }
}

/** The relation's statement for one reading, under the request's interventions. */
export async function statementFor(rt: Runtime, name: string, contract: Contract, hash: string, body: string, when: When,
                                   scope: Scope, trail: Trail, path: string[] = []): Promise<ResolvedStatement> {
  const st = await expand(rt, name, contract, hash, body, when, scope, trail, path)
  const iv = scope.interventions[name]
  return iv ? intervened(rt.dialects, st, contract.shape!, name, iv, when) : st
}

/** The relation's statement for one reading, with the relations it is built on in place, and no interventions. */
export async function expand(rt: Runtime, self: string, contract: Contract, hash: string, body: string, when: When,
                             scope: Scope, trail: Trail, path: string[]): Promise<ResolvedStatement> {
  if (path.includes(hash)) throw new Error(`"${self}" is built on itself: ${[...path, hash].join(' → ')}`)
  const fn = await rt.load(hash, body)
  const out = (await fn(readingContext(rt, contract, scope, trail), when)) as Statement
  if (!out || (typeof out.sql !== 'string' && !Array.isArray(out.rows))) {
    throw new Error(`"${contract.name}" returns a relation, so its body must return { ${contract.kind === 'concept' ? 'source, ' : ''}sql or rows, params? }`)
  }
  if (contract.kind === 'concept') {
    if (!contract.reads.sources.includes(out.source)) throw new Error(`"${contract.name}" read ${out.source}, which its contract does not declare`)
    if (Array.isArray(out.rows)) {
      const table = `r_${hash.slice(5, 17)}`
      return { source: LOCAL, sql: `SELECT * FROM ${table}`, params: out.params ?? {}, tables: { [table]: { columns: [...declaredColumns(contract.shape!)], rows: out.rows } } }
    }
    if (!rt.o.dialects[out.source]) throw new Error(`"${contract.name}" returned SQL for ${out.source}, which is not a SQL source — return its rows instead`)
    return { source: out.source, sql: out.sql!, params: out.params ?? {} }
  }
  if (typeof out.sql !== 'string') throw new Error(`"${contract.name}" is a program; it returns SQL over the relations it builds on, not rows`)

  const kind = kindOf(contract.shape!)
  let source: string | null = null
  const params: Record<string, unknown> = { ...(out.params ?? {}) }
  const tables: Record<string, LocalTable> = {}
  const parts = new Map<string, string>()
  for (const [, name] of out.sql.matchAll(/\{\{([^}]+)\}\}/g)) {
    if (parts.has(name)) continue
    if (!contract.reads.programs.includes(name)) throw new Error(`"${contract.name}" builds on "${name}", which its contract does not declare it reads`)
    const found = rt.programs.resolve(name, namespaceOf(self))
    const childHash = found?.hash
    const child = childHash && rt.programs.program(childHash)
    if (!child) throw new Error(`"${contract.name}" builds on "${name}", which does not exist`)
    if (child.contract.returns !== 'relation') throw new Error(`"${contract.name}" builds on "${name}", which is not a relation`)
    const childKind = kindOf(child.contract.shape!)
    if (childKind !== kind) throw new Error(`"${contract.name}" holds ${kind}s and builds on "${name}", which holds ${childKind}s — they are read at different times`)
    const st = await statementFor(rt, found!.name, child.contract, childHash, child.body, when, scope, trail, [...path, hash])
    // One statement runs in one place. Relations from two sources are combined by a program, after each is aggregated.
    if (source && st.source !== source) throw new Error(`"${contract.name}" builds on relations from ${source} and ${st.source}; one SQL statement cannot read both`)
    source = st.source
    for (const [k, v] of Object.entries(st.params)) {
      if (k in params && params[k] !== v) throw new Error(`"${contract.name}": parameter @${k} means different things in the relations it builds on`)
      params[k] = v
    }
    Object.assign(tables, st.tables ?? {})
    parts.set(name, st.sql.trim())
    trail.used.set(childHash, found!.name)
  }
  if (!source) throw new Error(`"${contract.name}" is a program returning a relation but names no relation in {{braces}}`)
  const sql = out.sql.replace(/\{\{([^}]+)\}\}/g, (_m, name) => `(\n${parts.get(name)}\n)`)
  return { source, sql, params, ...(Object.keys(tables).length ? { tables } : {}) }
}

/** The exchange rates a request converts with, as the setting `exchange rates` describes them:
 *  `{ relation: '<name>', at: 'end' | 'row' }`. How rates apply is the organisation's convention, so it is stated. */
export function ratesFor(rt: Runtime, scope: Scope, trail: Trail, path: string[], setting: unknown): RatesSource {
  return async () => {
    const { relation: name, at } = (setting ?? {}) as { relation?: string; at?: string }
    if (typeof name !== 'string' || (at !== 'end' && at !== 'row')) {
      throw new Error('the setting "exchange rates" must say which relation holds the rates and how they apply: { relation, at: "end" | "row" }')
    }
    const hash = rt.programs.resolve(name)?.hash
    const program = hash ? rt.programs.program(hash) : null
    if (!program || program.contract.returns !== 'relation') throw new Error(`the exchange rates "${name}" are not a relation`)
    trail.used.set(hash!, name)
    return { name, at, shape: program.contract.shape!, read: (when) => statementFor(rt, name, program.contract, hash!, program.body, when, scope, trail, path) }
  }
}

/** The relation whose grain is an entity — exactly one, or the question is refused rather than a guess made.
 *  Reading it is not a step deeper into the graph: it is read only by instant, never through attributes of its
 *  own, so a relation may reach attributes through its own grain. */
export function attributesFor(rt: Runtime, scope: Scope, trail: Trail, path: string[]): AttributeSource {
  return async (entity) => {
    const found = rt.programs.names().map(({ name, hash }) => ({ name, hash, program: rt.programs.program(hash)! }))
      .filter(({ program: { contract: c } }) => c.returns === 'relation' && c.shape?.grain && c.shape.dimensions[c.shape.grain].entity === entity)
    if (!found.length) throw new Error(`no relation has ${entity} as its grain, so attributes of ${entity} cannot be reached`)
    if (found.length > 1) throw new Error(`${found.map((f) => `"${f.name}"`).join(' and ')} all have ${entity} as their grain — which holds its attributes is a decision, not a lookup`)
    const { name, hash, program } = found[0]
    trail.used.set(hash, name)
    return { name, shape: program.contract.shape!, read: (when) => statementFor(rt, name, program.contract, hash, program.body, when, scope, trail, path) }
  }
}
