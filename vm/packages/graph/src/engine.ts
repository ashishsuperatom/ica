// ── THE ENGINE: WHERE EVERY PROGRAM IS RUN ────────────────────────────────────────────────────────────────
//
// Programs never call each other directly. They ask the engine, by name, and the engine resolves the name to
// the exact program it points at right now, runs it, and remembers the call. Going through here every time is
// what makes three things true that could not be true otherwise:
//
//   a correction lands once       a caller names an idea, so repointing the name fixes every caller
//   every answer is traceable     each call records the precise program that produced it
//   the contract is enforced      a program reads only what it declared it reads

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { contractProblem, type Contract } from './contract.js'
import { conditionSql, plan, sqlFor, type Condition, type Coordinates, type Dialect, type ReadBody, type ResolvedStatement, type When } from './coordinates.js'
import { runPlan } from './execute.js'
import { programHash } from './hash.js'
import { isDerived, kindOf, type Shape, type Statement } from './shape.js'
import { AmbiguousRules, facts, isRuled, mostSpecific } from './rules.js'
import type { CallRecord, GraphStore } from './store.js'

/** Runs a statement on a source. `who` travels with it, so the source's access policies apply to the person asking. */
export type Query = (source: string, sql: string, params?: Record<string, unknown>, options?: { who?: Record<string, unknown> }) => Promise<any[]>

export interface EngineOptions {
  store: GraphStore
  /** Where program bodies are written as modules, one file per hash. */
  modulesDir: string
  query: Query
  /** Which SQL dialect each SQL source speaks. A source not listed here is not SQL: its relations return rows. */
  dialects: Record<string, Dialect>
  /** What day it is, YYYY-MM-DD. Defaults to the local date. A replay or a test passes the day it means. */
  today?: () => string
  /** The organisation's own values for assumptions — its working week, its targets. A caller's value wins. */
  assumptions?: Record<string, unknown>
}

/** For one request only, a change to what a program gives — Pearl's do-operator. Applied wherever that name is
 *  reached in the request, however deep, and never saved into the graph.
 *    value   what a program returns, instead of running it
 *    where   rows of a relation left out
 *    add     rows added to a relation; for a stock, members from `from` (inclusive) until `to` (exclusive) */
export type Intervention =
  | { value: unknown }
  | { where?: Record<string, Condition>; add?: Array<{ row: Record<string, unknown>; from?: string; to?: string }> }

export interface DefineResult { hash: string; name: string; created: boolean }
export interface CallResult<T = unknown> { value: T; callId: string; hash: string }
export interface CallOptions {
  today?: string
  /** Assumptions for this request, passed down to everything it calls. */
  assume?: Record<string, unknown>
  /** Changes for this request only, by program name. The answer is hypothetical. */
  intervene?: Record<string, Intervention>
  /** Who is asking — their id, groups, department. Rules and access policies are chosen by it. */
  who?: Record<string, unknown>
}

/** What flows down a request: the day, the assumptions callers have set, and the interventions. */
interface Scope { today: string; context: Record<string, unknown>; interventions: Record<string, Intervention>; who?: Record<string, unknown> }

/** What a program body receives. The same surface for every program; what it may USE is its contract's. */
export interface ProgramContext {
  /** Call a program by name. `assume` sets assumptions for it and everything it calls. */
  call<T = unknown>(name: string, request?: Record<string, unknown>, options?: { assume?: Record<string, unknown> }): Promise<T>
  query(source: string, sql: string, params?: Record<string, unknown>): Promise<any[]>
  decide(label: string, took: boolean, reason: string): boolean
  verify(label: string, holds: () => boolean | Promise<boolean>, detail?: string): Promise<void>
  caveat(text: string): void
  /** The day this call is answered as of. Read this, never the clock, so a replay gives the same answer. */
  today: string
  /** The value of an assumption this program declares. `about` names what is being read — a pillar, a
   *  subsidiary — for an assumption given as rules that differ by it. */
  assume<T = unknown>(name: string, about?: Record<string, unknown>): T
  /** Who is asking, as the request said. */
  who: Record<string, unknown> | undefined
}

/** Rows from a non-SQL source are queried locally with SQLite, under this source name. */
const LOCAL = 'local'
const localDate = () => new Date().toLocaleDateString('en-CA')

export function createEngine(o: EngineOptions) {
  mkdirSync(o.modulesDir, { recursive: true })
  const dialects: Record<string, Dialect> = { ...o.dialects, [LOCAL]: 'sqlite' }
  const clock = o.today ?? localDate

  /** A body becomes a module file named by its hash. Because a hash is immutable, the file is written once
   *  and a cached import is always the right one — no cache-busting, which the mutable version needed to
   *  avoid silently running the previous edit. */
  async function load(hash: string, body: string): Promise<(ctx: ProgramContext, request: any) => unknown> {
    const file = join(o.modulesDir, `${hash.replace(':', '-')}.mjs`)
    if (!existsSync(file)) writeFileSync(file, body)
    const mod: any = await import(pathToFileURL(file).href)
    if (typeof mod.default !== 'function') throw new Error(`${hash} does not export a default function`)
    return mod.default
  }

  type QueryLog = CallRecord['queries']

  /** A context that may only read the sources its contract declares — what a concept's body gets while it
   *  produces a relation. A program that returns a relation gets one that cannot read anything. */
  type AssumedLog = CallRecord['assumptions']

  function readingContext(contract: Contract, scope: Scope, queries: QueryLog, assumed: AssumedLog): ProgramContext {
    return {
      call: async () => { throw new Error(`"${contract.name}" is producing a relation; it cannot call programs while doing so`) },
      query: async (source, sql, params) => {
        if (contract.kind !== 'concept') throw new Error(`"${contract.name}" is a program and queried ${source} — only a concept may read a data source`)
        if (!contract.reads.sources.includes(source)) throw new Error(`"${contract.name}" queried ${source}, which its contract does not declare`)
        const t = Date.now()
        const rows = await o.query(source, sql, params, { who: scope.who })
        queries.push({ source, sql, params: params ?? {}, rows: rows.length, ms: Date.now() - t,
                       capped: Array.isArray((rows as any).notes) && (rows as any).notes.length > 0 })
        return rows
      },
      decide: (_l, took) => took, verify: async () => {}, caveat: () => {}, today: scope.today,
      assume: <T>(name: string, about?: Record<string, unknown>) => assume<T>(contract, scope, name, assumed, about),
      who: scope.who,
    }
  }

  // ── ASSUMPTIONS: LOOKED UP BY NAME, NEVER PASSED POSITION BY POSITION ─────────────────────────────────────
  //
  // A program declares the assumptions it reads. The value comes from the nearest caller that set it, else the
  // organisation, else the program's own default. A program that needs a new assumption declares it; every
  // caller keeps passing the same context, and programs that do not read it never see it.
  //
  // A value may be given as rules — `{ rules: [{ when: { "who.department": "finance" }, value: 0.7 }, ...] }` —
  // and then the most specific rule that applies to who is asking and what is being read gives it. A layer whose
  // rules do not apply passes to the next layer.
  function assume<T>(contract: Contract, scope: Scope, name: string, assumed: AssumedLog, about?: Record<string, unknown>): T {
    const declared = contract.assumes?.[name]
    if (!declared) throw new Error(`"${contract.name}" read the assumption "${name}", which its contract does not declare`)
    const known = facts(scope.who, about)
    const layers: Array<[CallRecord['assumptions'][number]['from'], boolean, unknown]> = [
      ['caller', name in scope.context, scope.context[name]],
      ['organisation', !!o.assumptions && name in o.assumptions, o.assumptions?.[name]],
      ['default', 'default' in declared, declared.default],
    ]
    for (const [from, present, given] of layers) {
      if (!present) continue
      if (!isRuled(given)) return record(given, from)
      try {
        const rule = mostSpecific(given.rules, known, (a, b) => JSON.stringify(a.value) === JSON.stringify(b.value))
        if (rule) return record(rule.value, from, rule.when ?? {})
      } catch (e) {
        if (e instanceof AmbiguousRules) throw new Error(`"${name}" for ${JSON.stringify(known)}: ${e.message}`)
        throw e
      }
    }
    throw new Error(`"${contract.name}" needs the assumption "${name}" (${declared.description}) and nobody gave it${about ? ` for ${JSON.stringify(about)}` : ''}`)

    function record(value: unknown, from: CallRecord['assumptions'][number]['from'], rule?: Record<string, unknown>): T {
      const entry = { name, value, from, ...(about ? { about } : {}), ...(rule ? { rule } : {}) }
      if (!assumed.some((a) => JSON.stringify(a) === JSON.stringify(entry))) assumed.push(entry)
      return value as T
    }
  }

  /** A relation's rows under an intervention: some left out, some added — as SQL around its own SQL, so every
   *  relation built on it and every coordinate asked of it sees the changed rows. */
  function intervened(st: ResolvedStatement, shape: Shape, name: string, iv: Intervention, when: When): ResolvedStatement {
    if ('value' in iv) throw new Error(`"${name}" is a relation; intervene on its rows with where or add, not value`)
    const s = sqlFor(o.dialects[st.source] ?? (st.source === LOCAL ? 'sqlite' : 'oracle'))
    const params = { ...st.params }
    let n = 0
    const bindName = (v: unknown) => {
      const p = `i_${n++}`
      if (p in st.params) throw new Error(`the relation's parameter "${p}" uses the prefix interventions use`)
      params[p] = v
      return p
    }
    const bind = (v: unknown) => `@${bindName(v)}`
    // A member of a dimension is compared as text everywhere in the engine, so identities and labels are text
    // here too — an added person's id need not be the same type as the source's ids, which SQL would refuse.
    const textual = new Set(Object.values(shape.dimensions).flatMap((d) => [d.column, ...(d.label ? [d.label] : [])]))
    const numeric = new Set(Object.values(shape.measures).flatMap((m) => (!isDerived(m) && m.column ? [m.column] : [])))
    const columns = [...new Set([...textual, ...numeric, ...(shape.time ? [shape.time] : [])])]
    const select = columns.map((c) => textual.has(c) && !numeric.has(c) ? `${s.text(`i.${c}`)} AS ${c}` : `i.${c}`)
    let sql = `SELECT ${select.join(', ')}\nFROM (\n${st.sql.trim()}\n) i`
    if (iv.where) {
      const conds = Object.entries(iv.where).flatMap(([d, cond]) => {
        const dim = shape.dimensions[d]
        if (!dim) throw new Error(`cannot intervene on "${d}" in "${name}" — it is not one of its dimensions`)
        return conditionSql(`i.${dim.column}`, cond, d, bind)
      })
      sql += `\nWHERE ${conds.map((c) => `NOT (${c})`).join('\n  AND ')}`
    }
    const asAt = 'asAt' in when ? when.asAt : null
    const added = (iv.add ?? []).filter((a) => asAt == null || ((a.from ?? '') <= asAt && (!a.to || asAt < a.to)))
    for (const a of added) {
      for (const k of Object.keys(a.row)) if (!columns.includes(k)) throw new Error(`an added row of "${name}" has "${k}", which is not a column its shape names`)
      const literal = columns.map((c) => {
        const v = a.row[c]
        if (v == null) return `NULL AS ${c}`
        if (c === shape.time) return `${s.date(bindName(v))} AS ${c}`
        if (numeric.has(c)) return `${bind(Number(v))} AS ${c}`
        return `${s.text(bind(String(v)))} AS ${c}`
      })
      sql += `\nUNION ALL\nSELECT ${literal.join(', ')}${o.dialects[st.source] === 'oracle' ? ' FROM dual' : ''}`
    }
    return { ...st, sql, params }
  }

  // ── THE SQL OF A RELATION, WITH EVERY RELATION IT IS BUILT FROM IN PLACE ───────────────────────────────────
  //
  // A concept's body returns SQL over a source's tables — or, for a source that is not SQL, the rows themselves,
  // which become a local table. A program that returns a relation returns SQL over other relations, named in
  // braces — `SELECT h.* FROM {{utilised hours}} h WHERE h.billable = 'T'` — and each is replaced by that
  // relation's own SQL, resolved by name now. So composition is still SQL, a correction to a relation reaches
  // every relation built on it, and only a concept names a table.
  //
  // `used` collects what was inlined, so memory can say which programs an answer went through. `path` holds
  // the relations being expanded, so one that is built on itself is refused instead of expanding for ever.
  async function statementFor(name: string, contract: Contract, hash: string, body: string, when: When, scope: Scope,
                              used: Map<string, string>, queries: QueryLog, assumed: AssumedLog, path: string[] = []): Promise<ResolvedStatement> {
    const st = await expand(name, contract, hash, body, when, scope, used, queries, assumed, path)
    const iv = scope.interventions[name]
    return iv ? intervened(st, contract.shape!, name, iv, when) : st
  }

  async function expand(self: string, contract: Contract, hash: string, body: string, when: When, scope: Scope,
                        used: Map<string, string>, queries: QueryLog, assumed: AssumedLog, path: string[]): Promise<ResolvedStatement> {
    if (path.includes(hash)) throw new Error(`"${self}" is built on itself: ${[...path, hash].join(' → ')}`)
    const fn = await load(hash, body)
    const out = (await fn(readingContext(contract, scope, queries, assumed), when)) as Statement
    if (!out || (typeof out.sql !== 'string' && !Array.isArray(out.rows))) {
      throw new Error(`"${contract.name}" returns a relation, so its body must return { ${contract.kind === 'concept' ? 'source, ' : ''}sql or rows, params? }`)
    }
    if (contract.kind === 'concept') {
      if (!contract.reads.sources.includes(out.source)) throw new Error(`"${contract.name}" read ${out.source}, which its contract does not declare`)
      if (Array.isArray(out.rows)) {
        const table = `r_${hash.slice(5, 17)}`
        return { source: LOCAL, sql: `SELECT * FROM ${table}`, params: out.params ?? {}, tables: { [table]: out.rows } }
      }
      if (!o.dialects[out.source]) throw new Error(`"${contract.name}" returned SQL for ${out.source}, which is not a SQL source — return its rows instead`)
      return { source: out.source, sql: out.sql!, params: out.params ?? {} }
    }
    if (typeof out.sql !== 'string') throw new Error(`"${contract.name}" is a program; it returns SQL over the relations it builds on, not rows`)

    const kind = kindOf(contract.shape!)
    let source: string | null = null
    const params: Record<string, unknown> = { ...(out.params ?? {}) }
    const tables: Record<string, Record<string, unknown>[]> = {}
    const parts = new Map<string, string>()
    for (const [, name] of out.sql.matchAll(/\{\{([^}]+)\}\}/g)) {
      if (parts.has(name)) continue
      if (!contract.reads.programs.includes(name)) throw new Error(`"${contract.name}" builds on "${name}", which its contract does not declare it reads`)
      const childHash = o.store.resolve(name)
      const child = childHash && o.store.getProgram(childHash)
      if (!child) throw new Error(`"${contract.name}" builds on "${name}", which does not exist`)
      if (child.contract.returns !== 'relation') throw new Error(`"${contract.name}" builds on "${name}", which is not a relation`)
      const childKind = kindOf(child.contract.shape!)
      if (childKind !== kind) throw new Error(`"${contract.name}" holds ${kind}s and builds on "${name}", which holds ${childKind}s — they are read at different times`)
      const st = await statementFor(name, child.contract, childHash, child.body, when, scope, used, queries, assumed, [...path, hash])
      // One statement runs in one place. Relations from two sources are combined by a program, after each is aggregated.
      if (source && st.source !== source) throw new Error(`"${contract.name}" builds on relations from ${source} and ${st.source}; one SQL statement cannot read both`)
      source = st.source
      for (const [k, v] of Object.entries(st.params)) {
        if (k in params && params[k] !== v) throw new Error(`"${contract.name}": parameter @${k} means different things in the relations it builds on`)
        params[k] = v
      }
      Object.assign(tables, st.tables ?? {})
      parts.set(name, st.sql.trim())
      used.set(childHash, name)
    }
    if (!source) throw new Error(`"${contract.name}" is a program returning a relation but names no relation in {{braces}}`)
    const sql = out.sql.replace(/\{\{([^}]+)\}\}/g, (_m, name) => `(\n${parts.get(name)}\n)`)
    return { source, sql, params, ...(Object.keys(tables).length ? { tables } : {}) }
  }

  /** A relation's SQL is run once when it is defined, counting every column its shape names. A
   *  column the shape declares but the SQL does not produce is found now, not when someone first asks. */
  async function probeRelation(hash: string, body: string, contract: Contract): Promise<void> {
    const shape = contract.shape!
    const today = clock()
    const when: When = kindOf(shape) === 'flow' ? { from: today, to: today, where: {} } : { asAt: today, where: {} }
    const st = await expand(contract.name, contract, hash, body, when, { today, context: {}, interventions: {} }, new Map(), [], [], [])
    const columns = new Set<string>()
    for (const d of Object.values(shape.dimensions)) { columns.add(d.column); if (d.label) columns.add(d.label) }
    for (const m of Object.values(shape.measures)) if (!isDerived(m) && m.column) columns.add(m.column)
    if (shape.time) columns.add(shape.time)
    // Aggregated, with no outer filter: NetSuite does not check the columns of a query it can see returns nothing.
    const probe = { ...st, sql: `SELECT ${[...columns].map((c, i) => `COUNT(t.${c}) AS c${i}`).join(', ')}\nFROM (\n${st.sql.trim()}\n) t` }
    if (st.tables) {
      // A local table has exactly the columns its rows have; a missing one is named rather than left to SQLite.
      const have = new Set(Object.values(st.tables).flatMap((rows) => rows.flatMap((r) => Object.keys(r))))
      const rowsAreTheRelation = Object.keys(st.tables).length === 1 && /^SELECT \* FROM r_/.test(st.sql)
      const missing = rowsAreTheRelation && have.size ? [...columns].filter((c) => !have.has(c)) : []
      if (missing.length) throw new Error(`the rows have no ${missing.map((c) => `"${c}"`).join(', ')}`)
      const { runLocal } = await import('./execute.js')
      runLocal(probe)
    } else {
      await o.query(st.source, probe.sql, st.params)
    }
  }

  async function define(input: { body: string; contract: Contract },
                        meta: { by: string; reason?: string; replace?: boolean }): Promise<DefineResult> {
    const bad = contractProblem(input.contract)
    if (bad) throw new Error(`not defined — ${bad}`)
    const { contract, body } = input

    // EVERY PROGRAM IT READS MUST ALREADY EXIST. A missing one is a hole in the graph, and the moment of
    // definition is where it is cheapest to say so — not at the first call, in front of someone's question.
    for (const read of contract.reads.programs) {
      if (!o.store.resolve(read)) throw new Error(`not defined — "${contract.name}" reads "${read}", which does not exist`)
    }

    const hash = programHash(body, contract)
    const created = !o.store.getProgram(hash)

    // A REPLACEMENT MUST STILL FIT ITS CALLERS. Every caller was written against the old program's interface;
    // a correction that drops a column, changes a unit or turns a stock into a flow would fix one thing and
    // break every program above it — at their next run, in front of someone else's question.
    const current = o.store.resolve(contract.name)
    if (current && current !== hash && meta.replace) {
      const misfit = interfaceMisfit(o.store.getProgram(current)!.contract, contract)
      if (misfit) throw new Error(`not defined — "${contract.name}" cannot replace ${current}: ${misfit}`)
    }
    if (contract.returns === 'relation') {
      try { await probeRelation(hash, body, contract) }
      catch (e: any) { throw new Error(`not defined — "${contract.name}": ${e?.message ?? e}`) }
    }
    o.store.putProgram({ hash, contract, body, createdAt: Date.now(), createdBy: meta.by })

    // A NAME IS CHECKED BEFORE IT IS TAKEN. Pointing an existing name somewhere new changes what every caller
    // of that name gets — right for a correction, wrong for an accidental collision. Only an explicit replace
    // may do it.
    if (current && current !== hash && !meta.replace) {
      throw new Error(`not defined — "${contract.name}" already names ${current}. Give this program a name of ` +
        `its own, or replace that one deliberately.`)
    }
    if (current !== hash) o.store.point(contract.name, hash, meta.by, meta.reason)
    return { hash, name: contract.name, created }
  }

  async function run<T>(name: string, request: Record<string, unknown>, parentId: string | null,
                        scope: Scope, path: string[]): Promise<CallResult<T>> {
    const today = scope.today
    const hash = o.store.resolve(name)
    if (!hash) throw new Error(`no program named "${name}"`)
    const program = o.store.getProgram(hash)!
    const { contract } = program

    const id = randomUUID()
    const started = Date.now()
    const decisions: CallRecord['decisions'] = []
    const verifications: CallRecord['verifications'] = []
    const caveats: string[] = []
    const queries: QueryLog = []
    const used = new Map<string, string>()
    const assumed: AssumedLog = []

    const ctx: ProgramContext = {
      ...readingContext(contract, scope, queries, assumed),
      async call<U>(child: string, childRequest: Record<string, unknown> = {}, options: { assume?: Record<string, unknown> } = {}) {
        if (!contract.reads.programs.includes(child)) {
          throw new Error(`"${name}" called "${child}", which its contract does not declare it reads`)
        }
        const childScope = options.assume ? { ...scope, context: { ...scope.context, ...options.assume } } : scope
        return (await run<U>(child, childRequest, id, childScope, [...path, hash])).value
      },
      decide(label, took, reason) { decisions.push({ label, took, reason }); return took },
      async verify(label, holds, detail) {
        const held = Boolean(await holds())
        verifications.push({ label, held, detail })
        if (!held) throw new Error(`invariant failed: ${label}${detail ? ` — ${detail}` : ''}`)
      },
      caveat(text) { caveats.push(text) },
    }

    let value: unknown
    let error: string | null = null
    try {
      // A program that reaches itself again through its calls would never finish.
      if (path.includes(hash)) throw new Error(`"${name}" calls itself: ${[...path, hash].map((h) => o.store.getProgram(h)?.contract.name ?? h).join(' → ')}`)
      const iv = scope.interventions[name]
      if (iv && 'value' in iv) {
        if (contract.returns === 'relation') throw new Error(`"${name}" is a relation; intervene on its rows with where or add, not value`)
        decisions.push({ label: 'intervened', took: true, reason: 'this request gives the program\'s value instead of running it' })
        value = iv.value
      } else if (contract.returns === 'relation') {
        // THE DEFINITION AND THE QUESTION ARRIVE SEPARATELY. The body says what the relation is; the request
        // says which part of it is wanted. Nothing in the body changes when someone drills down.
        const read: ReadBody = (when) => statementFor(name, contract, hash, program.body, when, scope, used, queries, assumed, path)
        const shape = contract.shape!
        const p = await plan(shape, read, request as Coordinates, dialects, today)
        value = await runPlan(shape, p, (src, sql, params) => o.query(src, sql, params, { who: scope.who }),
          (q) => queries.push(q),
          (label, held, detail) => { verifications.push({ label, held, detail }); if (!held) throw new Error(`invariant failed: ${label} — ${detail}`) },
          (text) => caveats.push(text))
        caveats.push(...(value as any).caveats)
      } else {
        const fn = await load(hash, program.body)
        value = await fn(ctx, request)
      }
      if (contract.returns === 'rows' && !Array.isArray(value)) {
        throw new Error(`"${name}" declares it returns rows but returned ${value === null ? 'null' : typeof value}`)
      }
      if (value === undefined) throw new Error(`"${name}" returned nothing`)
    } catch (e: any) {
      error = String(e?.message ?? e)
    }

    const interventions = Object.keys(scope.interventions).length ? scope.interventions : null
    if (interventions && !parentId) caveats.push(`hypothetical: this answer changes ${Object.keys(interventions).map((k) => `"${k}"`).join(', ')} for this request only`)
    o.store.recordCall({ id, parentId, name, hash, request, output: error ? null : value, error,
                         decisions, verifications, caveats: [...new Set(caveats)], queries, ms: Date.now() - started, at: started, today,
                         assumptions: assumed, interventions, context: parentId ? null : scope.context, who: scope.who ?? null })
    // Relations inlined into this one ran inside its SQL. They are remembered as calls with no queries of their
    // own, so lineage still finds every answer that went through them.
    for (const [usedHash, usedName] of used) {
      o.store.recordCall({ id: randomUUID(), parentId: id, name: usedName, hash: usedHash, request: { inlinedInto: name },
                           output: null, error: null, decisions: [], verifications: [], caveats: [], queries: [], ms: 0, at: started, today,
                           assumptions: [], interventions, context: null, who: scope.who ?? null })
    }
    if (error) throw Object.assign(new Error(error), { callId: id })
    return { value: value as T, callId: id, hash }
  }

  /** Ask a program, by name. `today` fixes the day it is answered as of; by default, the engine's clock. */
  function call<T = unknown>(name: string, request: Record<string, unknown> = {}, options: CallOptions = {}): Promise<CallResult<T>> {
    return run<T>(name, request, null, { today: options.today ?? clock(), context: options.assume ?? {}, interventions: options.intervene ?? {}, who: options.who }, [])
  }

  /** Ask a past call's question again, as of the same day, through whatever its names point at now. */
  function replay<T = unknown>(callId: string): Promise<CallResult<T>> {
    const c = o.store.getCall(callId)
    if (!c) throw new Error(`no call ${callId}`)
    return call<T>(c.name, c.request as Record<string, unknown>,
      { today: c.today ?? undefined, assume: c.context ?? undefined, intervene: (c.interventions as Record<string, Intervention>) ?? undefined, who: c.who ?? undefined })
  }

  return { define, call, replay, store: o.store }
}

/** Why a new program cannot take an old one's name without breaking what calls it, or null if it can. */
function interfaceMisfit(old: Contract, next: Contract): string | null {
  if (old.returns !== next.returns) return `it returns ${next.returns}, and callers expect ${old.returns}`
  for (const p of Object.keys(old.params)) if (!(p in next.params)) return `it drops the parameter "${p}"`
  if (old.returns !== 'relation') return null
  const a = old.shape!, b = next.shape!
  for (const [n, d] of Object.entries(a.dimensions)) {
    const e = b.dimensions[n]
    if (!e) return `it drops the dimension "${n}"`
    if (e.column !== d.column || e.label !== d.label) return `dimension "${n}" moves to other columns`
  }
  for (const [n, m] of Object.entries(a.measures)) {
    const e = b.measures[n]
    if (!e) return `it drops the measure "${n}"`
    if (e.unit !== m.unit) return `measure "${n}" changes unit from ${m.unit} to ${e.unit}`
    if (e.kind !== m.kind) return `measure "${n}" changes from a ${m.kind} to a ${e.kind}`
    if (!isDerived(m) && !isDerived(e) && (e.column !== m.column || e.aggregate !== m.aggregate)) return `measure "${n}" is aggregated differently`
    if (isDerived(m) !== isDerived(e)) return `measure "${n}" changes between computed and aggregated`
  }
  if (a.time !== b.time) return `its time column changes from ${a.time} to ${b.time}`
  return null
}

export type Engine = ReturnType<typeof createEngine>
