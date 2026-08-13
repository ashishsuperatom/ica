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

export interface RunResult {
  output: unknown
  ui?: UnitUI
  root: string
  finalShapeHash: string
  nodes: GraphNode[]
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
export async function runProgram(opts: {
  entry: string
  params?: any
  unitDirs?: string[]
  emit?: (text: string) => void
}): Promise<RunResult> {
  const entry = resolve(opts.entry)
  const dirs = [join(dirname(entry), 'units'), dirname(entry), ...(opts.unitDirs ?? [])]
  const emit = opts.emit ?? (() => {})

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const branches: Branch[] = []
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
    query: (ds, sql, p) => dsQuery(ds, sql, p),
    use: async (name, p) => {
      const mod = await load(name)
      return invoke(mod, p, selfId, name, 'unit')
    },
    decide: (label, condition, reason) => {
      branches.push({ node: selfId, label, took: !!condition, reason })
      emit(`◆ ${label} → ${condition ? 'yes' : 'no'} — ${reason}`)
      return condition
    },
    log: (msg) => emit(msg),
  })

  async function invoke(mod: UnitModule, params: any, parentId: string | null, name: string, kind: GraphNode['kind']) {
    const id = `${name}#${++counter}`
    const node: GraphNode = { id, unit: name, kind, label: mod.meta?.description ?? name, params: params ?? {} }
    nodes.push(node)
    if (parentId) edges.push({ from: parentId, to: id })
    emit(`▶ ${name}`)
    const t = Date.now()
    const out = await mod.default(makeCtx(id), params ?? {})
    node.ms = Date.now() - t
    node.rows = rowsOf(out)
    node.shape = shapeOf(out)
    node.shapeHash = shapeHash(out)
    emit(`✓ ${name} (${node.ms}ms${node.rows != null ? `, ${node.rows} rows` : ''})`)
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
    nodes, edges, branches,
    ms: Date.now() - t0,
  }
}
