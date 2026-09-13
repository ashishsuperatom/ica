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
import { programHash } from './hash.js'
import type { CallRecord, GraphStore } from './store.js'

export type Query = (source: string, sql: string, params?: Record<string, unknown>) => Promise<any[]>

export interface EngineOptions {
  store: GraphStore
  /** Where program bodies are written as modules, one file per hash. */
  modulesDir: string
  query: Query
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

  function define(input: { body: string; contract: Contract },
                  meta: { by: string; reason?: string; replace?: boolean }): DefineResult {
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
        return o.query(source, sql, params)
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
      value = await fn(ctx, request)
      if (contract.returns === 'rows' && !Array.isArray(value)) {
        throw new Error(`"${name}" declares it returns rows but returned ${value === null ? 'null' : typeof value}`)
      }
      if (value === undefined) throw new Error(`"${name}" returned nothing`)
    } catch (e: any) {
      error = String(e?.message ?? e)
    }

    o.store.recordCall({ id, parentId, name, hash, request, output: error ? null : value, error,
                         decisions, verifications, caveats, ms: Date.now() - started, at: started })
    if (error) throw Object.assign(new Error(error), { callId: id })
    return { value: value as T, callId: id, hash }
  }

  return { define, call, store: o.store }
}

export type Engine = ReturnType<typeof createEngine>
