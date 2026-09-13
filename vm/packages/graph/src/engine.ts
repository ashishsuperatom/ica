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
import { plan, type Coordinates, type Dialect, type ReadBody, type When } from './coordinates.js'
import { runPlan } from './execute.js'
import { programHash } from './hash.js'
import type { Statement } from './shape.js'
import type { CallRecord, GraphStore } from './store.js'

export type Query = (source: string, sql: string, params?: Record<string, unknown>) => Promise<any[]>

export interface EngineOptions {
  store: GraphStore
  /** Where program bodies are written as modules, one file per hash. */
  modulesDir: string
  query: Query
  /** Which SQL dialect each source speaks, for the few things coordinates compile to: dates and months. */
  dialects: Record<string, Dialect>
}

export interface DefineResult { hash: string; name: string; created: boolean }
export interface CallResult<T = unknown> { value: T; callId: string; hash: string }

/** What a program body receives. The same surface for every program; what it may USE is its contract's. */
export interface ProgramContext {
  call<T = unknown>(name: string, request?: Record<string, unknown>): Promise<T>
  query(source: string, sql: string, params?: Record<string, unknown>): Promise<any[]>
  decide(label: string, took: boolean, reason: string): boolean
  verify(label: string, holds: () => boolean | Promise<boolean>, detail?: string): Promise<void>
  caveat(text: string): void
}

export function createEngine(o: EngineOptions) {
  mkdirSync(o.modulesDir, { recursive: true })

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

  const definitionOnly: ProgramContext = {
    call: async () => { throw new Error('a relation is SQL; it cannot call programs') },
    query: async () => { throw new Error('a relation returns its SQL; the engine runs it') },
    decide: (_l, took) => took, verify: async () => {}, caveat: () => {},
  }

  // ── THE SQL OF A RELATION, WITH EVERY RELATION IT IS BUILT FROM IN PLACE ───────────────────────────────────
  //
  // A concept's body returns SQL over the source's tables. A program that returns a relation returns SQL over
  // other relations, named in braces — `SELECT h.* FROM {{utilised hours}} h WHERE h.billable = 'T'` — and
  // each is replaced by that relation's own SQL, resolved by name now. So composition is still SQL, a
  // correction to a relation reaches every relation built on it, and only a concept names a table.
  //
  // `used` collects what was inlined, so memory can say which programs an answer went through.
  async function statementFor(contract: Contract, hash: string, body: string, when: When,
                              used: Map<string, string>): Promise<Statement> {
    const fn = await load(hash, body)
    const out = (await fn(definitionOnly, when)) as Statement
    if (!out || typeof out.sql !== 'string') {
      throw new Error(`"${contract.name}" returns a relation, so its body must return { ${contract.kind === 'concept' ? 'source, ' : ''}sql, params? }`)
    }
    if (contract.kind === 'concept') {
      if (!contract.reads.sources.includes(out.source)) throw new Error(`"${contract.name}" read ${out.source}, which its contract does not declare`)
      if (!o.dialects[out.source]) throw new Error(`no dialect is known for ${out.source}`)
      return out
    }

    const kind = Object.values(contract.shape!.measures)[0].kind
    let source: string | null = null
    const params: Record<string, unknown> = { ...(out.params ?? {}) }
    const parts = new Map<string, string>()
    for (const [, name] of out.sql.matchAll(/\{\{([^}]+)\}\}/g)) {
      if (parts.has(name)) continue
      if (!contract.reads.programs.includes(name)) throw new Error(`"${contract.name}" builds on "${name}", which its contract does not declare it reads`)
      const childHash = o.store.resolve(name)
      const child = childHash && o.store.getProgram(childHash)
      if (!child) throw new Error(`"${contract.name}" builds on "${name}", which does not exist`)
      if (child.contract.returns !== 'relation') throw new Error(`"${contract.name}" builds on "${name}", which is not a relation`)
      const childKind = Object.values(child.contract.shape!.measures)[0].kind
      if (childKind !== kind) throw new Error(`"${contract.name}" holds ${kind}s and builds on "${name}", which holds ${childKind}s — they are read at different times`)
      const st = await statementFor(child.contract, childHash, child.body, when, used)
      // One statement runs on one source. Relations on two sources are combined by a program, after each is aggregated.
      if (source && st.source !== source) throw new Error(`"${contract.name}" builds on relations from ${source} and ${st.source}; one SQL statement cannot read both`)
      source = st.source
      for (const [k, v] of Object.entries(st.params ?? {})) {
        if (k in params && params[k] !== v) throw new Error(`"${contract.name}": parameter @${k} means different things in the relations it builds on`)
        params[k] = v
      }
      parts.set(name, st.sql.trim())
      used.set(childHash, name)
    }
    if (!source) throw new Error(`"${contract.name}" is a program returning a relation but names no relation in {{braces}}`)
    const sql = out.sql.replace(/\{\{([^}]+)\}\}/g, (_m, name) => `(\n${parts.get(name)}\n)`)
    return { source, sql, params }
  }

  /** A relation's SQL is run once when it is defined, counting every column its shape names. A
   *  column the shape declares but the SQL does not produce is found now, not when someone first asks. */
  async function probeRelation(hash: string, body: string, contract: Contract): Promise<void> {
    const shape = contract.shape!
    const today = new Date().toISOString().slice(0, 10)
    const when = Object.values(shape.measures)[0].kind === 'flow' ? { from: today, to: today, where: {} } : { asAt: today, where: {} }
    const st = await statementFor(contract, hash, body, when, new Map())
    const columns = new Set<string>()
    for (const d of Object.values(shape.dimensions)) { columns.add(d.column); if (d.label) columns.add(d.label) }
    for (const m of Object.values(shape.measures)) if (m.column) columns.add(m.column)
    if (shape.time) columns.add(shape.time)
    // Aggregated, with no outer filter: NetSuite does not check the columns of a query it can see returns nothing.
    await o.query(st.source, `SELECT ${[...columns].map((c, i) => `COUNT(t.${c}) AS c${i}`).join(', ')}\nFROM (\n${st.sql.trim()}\n) t`, st.params ?? {})
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

  async function call<T = unknown>(name: string, request: Record<string, unknown> = {},
                                   parentId: string | null = null): Promise<CallResult<T>> {
    const hash = o.store.resolve(name)
    if (!hash) throw new Error(`no program named "${name}"`)
    const program = o.store.getProgram(hash)!
    const { contract } = program

    const id = randomUUID()
    const started = Date.now()
    const decisions: CallRecord['decisions'] = []
    const verifications: CallRecord['verifications'] = []
    const caveats: string[] = []
    const queries: CallRecord['queries'] = []
    const used = new Map<string, string>()

    const ctx: ProgramContext = {
      async call<U>(child: string, childRequest: Record<string, unknown> = {}) {
        if (!contract.reads.programs.includes(child)) {
          throw new Error(`"${name}" called "${child}", which its contract does not declare it reads`)
        }
        return (await call<U>(child, childRequest, id)).value
      },
      async query(source, sql, params) {
        // THE ONE RULE THAT KEEPS A DEFINITION SINGLE. Only a concept touches data.
        if (contract.kind !== 'concept') {
          throw new Error(`"${name}" is a program and queried ${source} — only a concept may read a data source`)
        }
        if (!contract.reads.sources.includes(source)) {
          throw new Error(`"${name}" queried ${source}, which its contract does not declare it reads`)
        }
        const t = Date.now()
        const rows = await o.query(source, sql, params)
        queries.push({ source, sql, params: params ?? {}, rows: rows.length, ms: Date.now() - t,
                       capped: Array.isArray((rows as any).notes) && (rows as any).notes.length > 0 })
        return rows
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
      const fn = await load(hash, program.body)
      if (contract.returns === 'relation') {
        // THE DEFINITION AND THE QUESTION ARRIVE SEPARATELY. The body says what the relation is; the request
        // says which part of it is wanted. Nothing in the body changes when someone drills down.
        const read: ReadBody = (when) => statementFor(contract, hash, program.body, when, used)
        const shape = contract.shape!
        const p = await plan(shape, read, request as Coordinates, o.dialects)
        value = await runPlan(shape, p, (src, sql, params) => o.query(src, sql, params),
          (q) => queries.push(q),
          (label, held, detail) => { verifications.push({ label, held, detail }); if (!held) throw new Error(`invariant failed: ${label} — ${detail}`) })
        caveats.push(...(value as any).caveats)
      } else {
        value = await fn(ctx, request)
      }
      if (contract.returns === 'rows' && !Array.isArray(value)) {
        throw new Error(`"${name}" declares it returns rows but returned ${value === null ? 'null' : typeof value}`)
      }
      if (value === undefined) throw new Error(`"${name}" returned nothing`)
    } catch (e: any) {
      error = String(e?.message ?? e)
    }

    o.store.recordCall({ id, parentId, name, hash, request, output: error ? null : value, error,
                         decisions, verifications, caveats, queries, ms: Date.now() - started, at: started })
    // Relations inlined into this one ran inside its SQL. They are remembered as calls with no queries of their
    // own, so lineage still finds every answer that went through them.
    for (const [usedHash, usedName] of used) {
      o.store.recordCall({ id: randomUUID(), parentId: id, name: usedName, hash: usedHash, request: { inlinedInto: name },
                           output: null, error: null, decisions: [], verifications: [], caveats: [], queries: [], ms: 0, at: started })
    }
    if (error) throw Object.assign(new Error(error), { callId: id })
    return { value: value as T, callId: id, hash }
  }

  return { define, call, store: o.store }
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
    if (e.column !== m.column) return `measure "${n}" moves from column ${m.column} to ${e.column}`
  }
  if (a.time !== b.time) return `its time column changes from ${a.time} to ${b.time}`
  return null
}

export type Engine = ReturnType<typeof createEngine>
