// THE KERNEL — runs a program and records what happened.
//
// A program is a unit (meta.concept === 'program') that composes units via ctx.use. The kernel injects
// the four-primitive ctx {query, use, decide, log}, executes the root unit, and while it runs it builds
// the DAG for free: every `use` is an edge (with the sub-output's SHAPE + timing captured on the node),
// every `decide` is a recorded branch. The result is the answer PLUS a provenance graph the UI is keyed
// off. Nothing here is domain-specific — it just runs whatever units a program composes.

import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stat } from 'node:fs/promises'
import { query as dsQuery } from './datasource.js'
import { shapeHash, shapeOf } from './shape.js'
import type { UnitCtx, UnitModule, UnitUI } from './unit.js'

export interface GraphNode {
  id: string                 // unique per invocation: `${unit}#${n}`
  unit: string               // the unit name that ran
  kind: 'program' | 'unit'
  label: string
  params: unknown
  ms?: number
  rows?: number              // convenience: row count if the output is (or wraps) an array
  shape?: unknown            // readable structural signature of the output
  shapeHash?: string         // stable key: same structure → same hash (drives UI reuse)
}
export interface GraphEdge { from: string; to: string }
export interface Branch { node: string; label: string; took: boolean; reason: string }
/** An invariant that was actually checked, with the answer. `ok:false` is only ever seen by a caller that
 *  caught the throw — the run itself stops, because the number it would return does not mean what it says. */
export interface Verification { node: string; label: string; ok: boolean; detail?: string; ms: number }
/** A limitation of the result, attached to the node that knew about it. */
export interface Caveat { node: string; text: string }

export interface RunResult {
  output: unknown
  ui?: UnitUI
  root: string
  finalShapeHash: string
  nodes: GraphNode[]
  verifications: Verification[]
  caveats: Caveat[]
  edges: GraphEdge[]
  branches: Branch[]
  ms: number
}

const EXTS = ['.ts', '.mts', '.mjs', '.js']

async function findUnit(name: string, dirs: string[]): Promise<string | null> {
  for (const dir of dirs) for (const ext of EXTS) {
    const p = join(dir, name + ext)
    try { await stat(p); return p } catch { /* keep looking */ }
  }
  return null
}

/**
 * Run a program. `entry` is the path to its program.ts (a unit module). Names passed to ctx.use are
 * resolved from `unitDirs` (defaults: <entryDir>/units then <entryDir>) — so a program's own units win,
 * and a shared library dir can be appended. `emit` receives one human progress line per step.
 */
/** What a running program is DOING, as it does it. The human line (`emit`) reads well in a terminal; this is
 *  the same moment in a shape a UI can render — a timer against a step, a query you can expand.
 *
 *  It exists because a program that takes three minutes is indistinguishable from a stuck one. Every emit here
 *  was already being produced and thrown away: `run.mjs` wrote it to stderr, and the engine buffered stderr and
 *  never read it. */
export type ProgramEvent =
  | { t: 'unit:start'; id: string; unit: string }
  | { t: 'unit:end'; id: string; unit: string; ms: number; rows?: number }
  | { t: 'decide'; label: string; took: boolean; reason: string }
  // An invariant checked against real data, and a limitation attached to the result. Both are LIVE events as
  // well as records, because the interesting moment for a reader is when a check fails — waiting for the run
  // to end to learn that would be learning it too late.
  | { t: 'verify'; label: string; ok: boolean }
  | { t: 'caveat'; text: string }
  | { t: 'log'; text: string }
  | { t: 'query:start'; id: string; source: string; sql: string }
  | { t: 'query:end'; id: string; source: string; ms: number; rows?: number; error?: string }

// Every start carries an `id` its end repeats, so a reader can pair them — that is what lets a UI show a row
// the moment work begins and resolve it when the work finishes. A counter, not a hash of the SQL: a program
// that runs the same query twice (a loop over departments, say) would collide on a hash and the second start
// would resolve the first end.

export async function runProgram(opts: {
  entry: string
  params?: any
  unitDirs?: string[]
  emit?: (text: string) => void
  onEvent?: (ev: ProgramEvent) => void
}): Promise<RunResult> {
  const entry = resolve(opts.entry)
  const dirs = [join(dirname(entry), 'units'), dirname(entry), ...(opts.unitDirs ?? [])]
  const emit = opts.emit ?? (() => {})
  const ev = opts.onEvent ?? (() => {})
  let queries = 0

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const branches: Branch[] = []
  // Both travel with the RESULT rather than with the code that produced it: an assertion nobody can see the
  // outcome of is a comment, and a caveat left in the source is one the reader never gets.
  const verifications: Verification[] = []
  const caveats: Caveat[] = []
  const cache = new Map<string, UnitModule>()
  let counter = 0

  const load = async (name: string): Promise<UnitModule> => {
    if (cache.has(name)) return cache.get(name)!
    const file = await findUnit(name, dirs)
    if (!file) throw new Error(`ctx.use('${name}'): no unit file found in ${dirs.join(', ')}`)
    // Cache-busted: units get edited in place (an analyst refining a program), and the engine process
    // that runs them is long-lived — a plain import() would return Node's cached module forever, silently
    // ignoring the edit until a restart. Same fix as the datasource-manager's bridge loader.
    const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as UnitModule
    if (typeof mod.default !== 'function') throw new Error(`unit '${name}' has no default compute export`)
    cache.set(name, mod)
    return mod
  }

  const rowsOf = (out: any): number | undefined =>
    Array.isArray(out) ? out.length : Array.isArray(out?.rows) ? out.rows.length : undefined

  const makeCtx = (selfId: string): UnitCtx => ({
    // TIMED AND ANNOUNCED. This was a bare pass-through, so the single slowest thing a program does — waiting
    // on a data source — produced no trace at all: no query, no duration, no row count. A three-minute query
    // and a hung process looked exactly alike from outside.
    query: async (ds, sql, p) => {
      const qid = `q${++queries}`
      // Capped: each event is one appended line from a separate process, and an append is atomic only while it
      // is small. An unbounded query could tear across a write boundary and be lost as unparseable.
      ev({ t: 'query:start', id: qid, source: ds, sql: String(sql).slice(0, 2000) })
      const t = Date.now()
      try {
        const rows = await dsQuery(ds, sql, p)
        ev({ t: 'query:end', id: qid, source: ds, ms: Date.now() - t, rows: Array.isArray(rows) ? rows.length : undefined })
        return rows
      } catch (e: any) {
        ev({ t: 'query:end', id: qid, source: ds, ms: Date.now() - t, error: String(e?.message ?? e).slice(0, 300) })
        throw e
      }
    },
    use: async (name, p) => {
      const mod = await load(name)
      return invoke(mod, p, selfId, name, 'unit')
    },
    decide: (label, condition, reason) => {
      branches.push({ node: selfId, label, took: !!condition, reason })
      emit(`◆ ${label} → ${condition ? 'yes' : 'no'} — ${reason}`)
      ev({ t: 'decide', label, took: !!condition, reason })
      return condition
    },
    verify: async (label, holds, detail) => {
      const started = Date.now()
      let ok = false
      try { ok = !!(await holds()) }
      catch (e: any) {
        // A check that could not run has not passed. Reporting it as a failure with its own error keeps the
        // two cases distinguishable without letting a broken check read as a satisfied one.
        verifications.push({ node: selfId, label, ok: false, detail: `check threw: ${e?.message ?? e}`, ms: Date.now() - started })
        emit(`✗ ${label} — check could not run: ${e?.message ?? e}`)
        ev({ t: 'verify', label, ok: false })
        throw new Error(`verification "${label}" could not run: ${e?.message ?? e}`)
      }
      verifications.push({ node: selfId, label, ok, detail, ms: Date.now() - started })
      emit(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
      ev({ t: 'verify', label, ok })
      if (!ok) throw new Error(`verification failed: ${label}${detail ? ` — ${detail}` : ''}`)
    },
    caveat: (text) => {
      const t = String(text).slice(0, 500)
      caveats.push({ node: selfId, text: t })
      emit(`⚠ ${t}`)
      ev({ t: 'caveat', text: t })
    },
    log: (msg) => { emit(msg); ev({ t: 'log', text: String(msg).slice(0, 1000) }) },
  })

  async function invoke(mod: UnitModule, params: any, parentId: string | null, name: string, kind: GraphNode['kind']) {
    const id = `${name}#${++counter}`
    const node: GraphNode = { id, unit: name, kind, label: mod.meta?.description ?? name, params: params ?? {} }
    nodes.push(node)
    if (parentId) edges.push({ from: parentId, to: id })
    emit(`▶ ${name}`)
    ev({ t: 'unit:start', id, unit: name })
    const t = Date.now()
    const out = await mod.default(makeCtx(id), params ?? {})
    node.ms = Date.now() - t
    node.rows = rowsOf(out)
    node.shape = shapeOf(out)
    node.shapeHash = shapeHash(out)
    emit(`✓ ${name} (${node.ms}ms${node.rows != null ? `, ${node.rows} rows` : ''})`)
    ev({ t: 'unit:end', id, unit: name, ms: node.ms!, rows: node.rows })
    return out
  }

  // Same cache-busting as unit loads above — program.ts is edited in place just as often.
  const program = (await import(`${pathToFileURL(entry).href}?t=${Date.now()}`)) as UnitModule
  if (typeof program.default !== 'function') throw new Error(`program ${entry} has no default export`)
  const rootName = program.meta?.name ?? 'program'
  const t0 = Date.now()
  const output = await invoke(program, opts.params ?? {}, null, rootName, 'program')

  return {
    output,
    ui: program.ui,
    root: `${rootName}#1`,
    finalShapeHash: shapeHash(output),
    nodes, edges, branches, verifications, caveats,
    ms: Date.now() - t0,
  }
}
