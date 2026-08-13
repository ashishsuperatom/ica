// THE KERNEL — the one execution model. A program is a unit that composes units via ctx.use; runProgram
// executes it and returns the answer + a provenance graph (DAG + branches + per-node shape).
export { runProgram }    from './kernel.js'
export type { RunResult, GraphNode, GraphEdge, Branch } from './kernel.js'
export { shapeHash, shapeOf } from './shape.js'
export { query }         from './datasource.js'
export type { UnitCtx, Unit, UnitMeta, UnitModule, UnitUI, RunLog, UnitEffect } from './unit.js'
