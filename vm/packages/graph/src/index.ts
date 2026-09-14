// @superatom/graph — immutable, named, composable programs with memory. See docs/program-graph.md.

// The engine and its memory
export { createEngine, managerInspect, type Engine, type DefineResult, type CallResult } from './engine.js'
export type { EngineOptions, CallOptions, Checks, Intervention, ProgramContext, Query, SqlAnalysis } from './runtime.js'
export { GraphStore, type CallRecord, type StoredProgram } from './store.js'
export { trace } from './trace.js'

// What a program declares
export { contractProblem, type Contract, type ProgramKind, type Assumption, type ProgramParam } from './contract.js'
export { programHash } from './hash.js'
export { shapeProblem, additivity, type Shape, type Statement, type Dimension, type Measure, type BaseMeasure, type DerivedMeasure, type MeasureKind, type Aggregate, type Additivity } from './shape.js'

// What a relation can be asked, and how it is answered
export { plan, sqlFor, CoordinateError, type Coordinates, type ResolvedCoordinates, type Span, type Condition, type Grain, type Dialect, type Plan } from './coordinates.js'
export { runPlan, runLocal, arrange, CappedError, type Result, type Column } from './execute.js'
export { Grains, periods, BUILT_IN, type Calendar, type CalendarGrain, type Period } from './calendar.js'
export { shift, comparisonCoordinates, mergeComparison, difference, type Comparison, type ResolvedComparison, type Offset } from './compare.js'
export { summaryProblem, atLevel, withShares } from './summaries.js'

// Values that depend on who asks or what is read
export { facts, applies, mostSpecific, allThatApply, isRuled, AmbiguousRules, type When as RuleWhen, type Facts, type RuledValue } from './rules.js'
export { resolveRelative, resolveSpan, resolveInstant, type RelativeSpan, type RelativeInstant } from './relative.js'
export { dayIn, offsetMinutes, stretches, validZone, type Stretch } from './timezones.js'
export { catalog, members, type CatalogEntry, type Members, type MemberMatch } from './discovery.js'
