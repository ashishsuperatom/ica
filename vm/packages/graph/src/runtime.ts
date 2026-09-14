// ── WHAT EVERY PART OF THE ENGINE SHARES ──────────────────────────────────────────────────────────────────
//
// The engine's options, what flows down a request (its scope), what a call records as it runs (its trail), and
// the context a program body receives. The parts of the engine — composition, assumptions, interventions,
// definition checks, answering — each take the runtime rather than reaching into one another.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Condition, Dialect } from './coordinates.js'
import type { CallRecord, GraphStore } from './store.js'
import { dayIn } from './timezones.js'

/** Runs a statement on a source. `policies` are the access restrictions of the person asking, applied at the source. */
export type Query = (source: string, sql: string, params?: Record<string, unknown>, options?: { policies?: unknown[] }) => Promise<any[]>

export interface SqlAnalysis { tables: string[]; outputs: string[]; star: boolean }

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
  /** Reads SQL without running it: the base tables it reads and the columns it outputs. With it, definitions are
   *  checked against their SQL — a relation program that names a table, a shape column no statement outputs.
   *  `managerInspect` gives one backed by the datasource manager's SQL parser. */
  inspect?: (sql: string, dialect: Dialect) => Promise<SqlAnalysis>
  /** How much extra reading a check may cost, by default. See Checks. */
  checks?: Checks
}

/** Checks that need extra reads of the source.
 *    thorough  every split is reconciled with its whole (a second statement), every entity joined is checked for
 *              repeated members, and a relation's grain is checked when it is defined
 *    light     none of those: answers cost one statement each, and say that they were not reconciled
 *  Checks that cost nothing — refusals, units, kinds, the parser's — always run. */
export type Checks = 'thorough' | 'light'

/** For one request only, a change to what a program gives — Pearl's do-operator. Applied wherever that name is
 *  reached in the request, however deep, and never saved into the graph.
 *    value   what a program returns, instead of running it
 *    where   rows of a relation left out
 *    add     rows added to a relation; for a stock, members from `from` (inclusive) until `to` (exclusive) */
export type Intervention =
  | { value: unknown }
  | { where?: Record<string, Condition>; add?: Array<{ row: Record<string, unknown>; from?: string; to?: string }> }

export interface CallOptions {
  today?: string
  /** Assumptions for this request, passed down to everything it calls. */
  assume?: Record<string, unknown>
  /** Changes for this request only, by program name. The answer is hypothetical. */
  intervene?: Record<string, Intervention>
  /** Who is asking — their id, groups, department. Rules for assumptions are chosen by it. */
  who?: Record<string, unknown>
  /** What the person asking may read, by source, as decided by the system that authorises them. Every query this
   *  request makes carries its source's policies; the engine only passes them on. */
  access?: Record<string, unknown[]>
  /** How much extra reading checks may cost for this request; the engine's setting otherwise. */
  checks?: Checks
}

/** What flows down a request: the day, the assumptions callers have set, the interventions, who asks and what
 *  they may read. */
export interface Scope {
  today: string
  context: Record<string, unknown>
  interventions: Record<string, Intervention>
  who?: Record<string, unknown>
  access?: Record<string, unknown[]>
  /** The zone the request is asked from, and who said so. */
  zone?: { zone: string; from: 'caller' | 'organisation' }
  checks: Checks
}

/** What one call records while it runs — everything memory keeps about how the answer was reached. */
export interface Trail {
  queries: CallRecord['queries']
  assumed: CallRecord['assumptions']
  decisions: CallRecord['decisions']
  verifications: CallRecord['verifications']
  caveats: string[]
  /** Programs this call went through without calling them: relations inlined, entities joined. hash → name. */
  used: Map<string, string>
}
export const newTrail = (): Trail => ({ queries: [], assumed: [], decisions: [], verifications: [], caveats: [], used: new Map() })

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

export type Body = (ctx: ProgramContext, request: any) => unknown

/** Rows from a non-SQL source are queried locally with SQLite, under this source name. */
export const LOCAL = 'local'

export interface Runtime {
  o: EngineOptions
  /** The engine's dialects, with the local engine's added. */
  dialects: Record<string, Dialect>
  /** Today's date — in a zone when one is given, else where the engine runs — unless the engine was given a clock. */
  clock: (zone?: string) => string
  load(hash: string, body: string): Promise<Body>
}

export function createRuntime(o: EngineOptions): Runtime {
  mkdirSync(o.modulesDir, { recursive: true })
  return {
    o,
    dialects: { ...o.dialects, [LOCAL]: 'sqlite' },
    clock: o.today ? () => o.today!() : (zone) => (zone ? dayIn(zone) : new Date().toLocaleDateString('en-CA')),
    /** A body becomes a module file named by its hash. Because a hash is immutable, the file is written once and a
     *  cached import is always the right one — no cache-busting, which the mutable version needed to avoid
     *  silently running the previous edit. */
    async load(hash, body) {
      const file = join(o.modulesDir, `${hash.replace(':', '-')}.mjs`)
      if (!existsSync(file)) writeFileSync(file, body)
      const mod: any = await import(pathToFileURL(file).href)
      if (typeof mod.default !== 'function') throw new Error(`${hash} does not export a default function`)
      return mod.default
    },
  }
}
