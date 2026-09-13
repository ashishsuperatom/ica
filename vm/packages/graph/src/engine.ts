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
import { plan, type Coordinates, type Dialect } from './coordinates.js'
import { runPlan } from './execute.js'
import { programHash } from './hash.js'
import { Relation, isRelation, relationProblem } from './relation.js'
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
  /** Start a relation over a source's table. Only a concept may. */
  from(source: string, table: string): Relation
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

  /** A relation is a definition, so it can be checked when it is defined rather than when it is first asked.
   *  The body is evaluated with a context that can build a relation and do nothing else — no data, no calls. */
  async function checkRelation(hash: string, body: string, contract: Contract): Promise<void> {
    const fn = await load(hash, body)
    const dry: ProgramContext = {
      from: (source, table) => fromSource(contract, source, table),
      call: async () => { throw new Error('a relation is a definition; it cannot call programs while being defined') },
      query: async () => { throw new Error('a relation is a definition; it cannot run queries while being defined') },
      decide: (_l, took) => took, verify: async () => {}, caveat: () => {},
    }
    const r = await fn(dry, {})
    if (!isRelation(r)) throw new Error(`not defined — "${contract.name}" declares it returns a relation but returned ${typeof r}`)
    const bad = relationProblem(r)
    if (bad) throw new Error(`not defined — "${contract.name}": ${bad}`)
  }

  function fromSource(contract: Contract, source: string, table: string): Relation {
    if (contract.kind !== 'concept') throw new Error(`"${contract.name}" is a program and read ${source} — only a concept may read a data source`)
    if (!contract.reads.sources.includes(source)) throw new Error(`"${contract.name}" read ${source}, which its contract does not declare`)
    if (!o.dialects[source]) throw new Error(`no dialect is known for ${source}`)
    return Relation.from(source, table)
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
    if (contract.returns === 'relation') await checkRelation(hash, body, contract)
    o.store.putProgram({ hash, contract, body, createdAt: Date.now(), createdBy: meta.by })

    // A NAME IS CHECKED BEFORE IT IS TAKEN. Pointing an existing name somewhere new changes what every caller
    // of that name gets — right for a correction, wrong for an accidental collision. Only an explicit replace
    // may do it.
    const current = o.store.resolve(contract.name)
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

    const ctx: ProgramContext = {
      from: (source, table) => fromSource(contract, source, table),
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
        const relation = await fn(ctx, {})
        if (!isRelation(relation)) throw new Error(`"${name}" declares it returns a relation but returned ${typeof relation}`)
        const p = plan(relation, request as Coordinates, o.dialects[relation.source])
        value = await runPlan(relation, p, (src, sql, params) => o.query(src, sql, params),
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
    if (error) throw Object.assign(new Error(error), { callId: id })
    return { value: value as T, callId: id, hash }
  }

  return { define, call, store: o.store }
}

export type Engine = ReturnType<typeof createEngine>
