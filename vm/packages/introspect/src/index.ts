// ── Introspection — one module per database dialect ──────────────────────────
// getIntrospect(dialect, query, source) → the introspection helpers for that dialect, bound to the
// source. MSSQL today; add ./snowflake.ts, ./oracle.ts, ./salesforce.ts, … as sources appear. The
// interface is dialect-agnostic; only the SQL/API inside each module differs.

import { mssqlIntrospect } from './mssql.js'

export type QueryFn = (sourceId: string, sql: string, params?: Record<string, unknown>) => Promise<any[]>

export interface ColumnProfile {
  total: number; distinct: number; nulls: number; nullRate: number
  min: any; max: any; mean: number | null
  mode: any; topValues: Array<{ v: any; c: number }>
}
// Join EVIDENCE — never a black-box verdict. Returns the DATA that lets the agent judge: coverage +
// cardinality, PLUS the from-side values that DON'T match (reveals sentinels/orphans) and the from-side
// distribution (reveals a dominant sentinel). `hint` is a soft, secondary suggestion — the data wins.
export interface JoinEvidence {
  coverage: number; matched: number; fromTotal: number
  distinctFrom: number; distinctTo: number; toTotal: number
  cardinality: string
  unmatchedSamples: Array<{ v: any; c: number }>   // fromCol values with NO match, by frequency
  fromTopValues: Array<{ v: any; c: number }>       // the from-side distribution
  hint?: string
}
export interface RelationCheck {
  total: number; violations: number; violationRate: number
  sampleViolations: any[]                           // actual rows that break the relation
}
export interface Introspect {
  tables(): Promise<Array<{ name: string; rows: number }>>
  columns(table: string): Promise<Array<{ name: string; type: string }>>
  sampleRows(table: string, n?: number): Promise<any[]>                                   // SEE real rows
  profile(table: string, column: string): Promise<ColumnProfile>
  verifyJoin(fromTable: string, fromCol: string, toTable: string, toCol: string): Promise<JoinEvidence>
  checkRelation(table: string, expr: string, sampleN?: number): Promise<RelationCheck>    // conservation/arithmetic, with violating rows
}

const REGISTRY: Record<string, (query: QueryFn, source: string) => Introspect> = {
  mssql: mssqlIntrospect,
  // snowflake: snowflakeIntrospect,   // add as needed
  // oracle: oracleIntrospect,
}

export function getIntrospect(dialect: string, query: QueryFn, source: string): Introspect {
  const make = REGISTRY[dialect]
  if (!make) throw new Error(`no introspection module for dialect "${dialect}" yet (have: ${Object.keys(REGISTRY).join(', ')})`)
  return make(query, source)
}
