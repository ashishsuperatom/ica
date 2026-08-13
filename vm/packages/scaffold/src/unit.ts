// THE UNIT CONTRACT — the one execution model (the kernel runs this; see kernel.ts).
//
// A unit is a plain function (ctx, params) => result with three facets in its file:
//   • MEANING  — the `meta` export (what it is; its input surface; its output).
//   • COMPUTE  — the default export (ctx, params) => result. Mostly effect-less; a function of its input.
//   • UI       — the `ui` export (how its output renders). Minimal/templated for intermediate units;
//                the program's FINAL unit is the real UI unit (simple | dashboard).
// A PROGRAM is just a unit (meta.concept === 'program') that composes other units via ctx.use — so a
// calculation is defined ONCE in its own unit and reused, and the run records the DAG + timing + shape.
//
// The kernel injects `ctx` — the ONLY capabilities a unit has. Four primitives, nothing more:
//   query  — data access (the sole I/O; provenance-complete)
//   use    — compose another unit (records the edge + captures the sub-output's shape)
//   decide — mark a branch: records which path was taken + why (the decision-maker; returns the cond)
//   log    — an optional human progress note (the runner also auto-narrates each step)
// Units import ONLY these types from the package, so a unit file is fully relocatable into a workspace.

export type UnitCtx = {
  query: (dataSourceId: string, sql: string, params?: Record<string, unknown>) => Promise<any[]>
  use: <R = any>(unitName: string, params?: any) => Promise<R>
  decide: (label: string, condition: boolean, reason: string) => boolean
  log: (message: string) => void
}

export type Unit<P = any, R = any> = (ctx: UnitCtx, params: P) => Promise<R> | R

// UI facet: the LLM picks a category. `simple` covers most answers; `dashboard` is a set of components
// answering a complex question from several angles. Intermediate units stay `simple`/templated; only the
// final unit gets rich. `template` is an optional named layout; `props` maps output fields → display roles.
export type UnitUI = {
  category: 'simple' | 'dashboard'
  template?: string
  props?: Record<string, unknown>
}

export type UnitMeta = {
  name: string
  description: string
  inputs: Record<string, string>
  outputs: string
  logic: string
  dataSources: string[]
  concept?: string  // groups units in the coverage map; 'program' marks a composing (root) unit
  // SCAFFOLD (not enforced yet): a unit's effect class for the propose/commit gate. Read units run
  // freely; effectful ones will emit a ProposedAction and require explicit commit. Absent = 'read'.
  // See action.ts. The gate itself is unbuilt — design later.
  effect?: UnitEffect
}

// A unit file's exports, as the kernel loads them.
export type UnitModule<P = any, R = any> = {
  meta: UnitMeta
  default: Unit<P, R>
  ui?: UnitUI
}

export type UnitEffect = 'read' | 'write'

export type RunLog = {
  runId: string
  unit: string
  params: unknown
  startedAt: string
  finishedAt: string
  trace: Array<Record<string, unknown>>
  result: unknown
}
