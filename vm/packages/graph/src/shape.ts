// ── THE SHAPE OF A CONCEPT'S ROWS ─────────────────────────────────────────────────────────────────────────────
//
// A concept that returns a relation is written as plain SQL (or, for a source that is not SQL, returns rows):
// one row per thing, at its finest grain — one row per employee, one row per time entry. The body is free.
//
// The shape is what the engine needs to ask those rows a question: which output columns are dimensions, which
// are measures and how each one adds up, and which column is time. It is the same idea as a cube in Cube, a
// view in LookML and a semantic model in dbt MetricFlow — a base relation, its dimensions, and measures with
// an aggregation — and the rules below follow those, and the summarizability work behind them.
//
// The engine wraps the body's SQL —
//
//     SELECT <dimensions>, <aggregates> FROM ( <the body's SQL> ) t WHERE <filters> GROUP BY <dimensions>
//
// — so slicing, drilling and filtering never depend on the body having done them.

import { BUILT_IN } from './calendar.js'

/** How a measure behaves over time (Lenz and Shoshani, 1997; Kimball's additive and semi-additive facts).
 *  flow   accumulates over time — hours worked. Additive over every dimension, time included.
 *  stock  true at an instant — headcount. Additive across things, never across time.
 *  ratio  a value per unit — utilisation, average rate. Never added up; recomputed from its parts. */
export type MeasureKind = 'flow' | 'stock' | 'ratio'

/** How a base measure is aggregated. What each allows a split to be checked against is in `additivity`. */
export type Aggregate = 'sum' | 'count' | 'count distinct' | 'min' | 'max' | 'average' | 'median'

export interface Dimension {
  /** The output column that identifies a member. Filters use this, never the label. */
  column: string
  /** The output column a person reads. */
  label?: string
  /** Whether the value is as it is now, as it was at the time, or never changes (an entity's own identity). */
  history: 'current' | 'as-at' | 'stable'
  /** The entity this column identifies — `employee`, `customer`. Declaring it lets a question reach that entity's
   *  attributes through this dimension: `employee.manager`. (MetricFlow: an entity; Cube: a join key.) */
  entity?: string
}

/** A measure aggregated from a column of the rows. */
export interface BaseMeasure {
  aggregate: Aggregate
  /** The output column aggregated. Not needed for count. */
  column?: string
  unit: string
  kind: 'flow' | 'stock'
}

/** A measure computed from other measures after they are aggregated — MetricFlow's ratio and derived metrics.
 *  `expression` uses measure names, numbers, + - * / and parentheses: `billable / hours`. */
export interface DerivedMeasure {
  expression: string
  unit: string
  kind: MeasureKind
}

export type Measure = BaseMeasure | DerivedMeasure

export interface Shape {
  dimensions: Record<string, Dimension>
  measures: Record<string, Measure>
  /** The output date column a flow is bounded and bucketed by. */
  time?: string
  /** The dimension each row is one member of, when a row is one member of an entity — one row per employee. It is
   *  what makes this relation the one that holds that entity's attributes, and it is checked to be unique.
   *  (MetricFlow: the primary entity; Cube and Malloy: the primary key.) */
  grain?: string
}

/** What a concept's body returns for one reading. SQL for a SQL source; rows for any other, which the engine
 *  queries locally with the same wrapping. A stock's body is called with `{ asAt }`, a flow's with
 *  `{ from, to }`, both YYYY-MM-DD, plus `where` — filters the engine applies anyway, for a body that can use
 *  them to read less. */
export interface Statement { source: string; sql?: string; rows?: Record<string, unknown>[]; params?: Record<string, unknown> }

export const AGGREGATES: Aggregate[] = ['sum', 'count', 'count distinct', 'min', 'max', 'average', 'median']

export const isDerived = (m: Measure): m is DerivedMeasure => typeof (m as DerivedMeasure).expression === 'string'

/** What a split of a measure can be checked against — the whole asked unsplit.
 *  additive  the parts sum to the whole
 *  bounded   the largest part ≤ the whole ≤ the sum of the parts (a distinct count: one member can be in two parts)
 *  minimum / maximum   the smallest / largest part is the whole
 *  none      nothing: an average, a median or a ratio of the parts says nothing about the whole's */
export type Additivity = 'additive' | 'bounded' | 'minimum' | 'maximum' | 'none'

export function additivity(shape: Shape, name: string): Additivity {
  const m = shape.measures[name]
  if (isDerived(m)) {
    if (m.kind === 'ratio') return 'none'
    // Only sums and differences of additive measures are additive.
    return referenced(m.expression).every((r) => additivity(shape, r) === 'additive') ? 'additive' : 'none'
  }
  return ({ sum: 'additive', count: 'additive', 'count distinct': 'bounded', min: 'minimum', max: 'maximum',
            average: 'none', median: 'none' } as const)[m.aggregate]
}

/** The kind the shape's rows are read as: every base measure is a flow, or every one is a stock. */
export const kindOf = (s: Shape): 'flow' | 'stock' =>
  (Object.values(s.measures).find((m) => !isDerived(m)) as BaseMeasure).kind

// ── expressions ───────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = /\s*(?:([a-z][a-z0-9_]*)|(\d+(?:\.\d+)?)|([-+*/()]))/y

/** Tokens of a derived measure's expression, or null if it contains anything else. */
export function tokens(expression: string): Array<{ name?: string; number?: string; op?: string }> | null {
  const out: Array<{ name?: string; number?: string; op?: string }> = []
  TOKEN.lastIndex = 0
  let i = 0
  while (i < expression.length) {
    if (!expression.slice(i).trim()) break
    TOKEN.lastIndex = i
    const m = TOKEN.exec(expression)
    if (!m) return null
    out.push(m[1] ? { name: m[1] } : m[2] ? { number: m[2] } : { op: m[3] })
    i = TOKEN.lastIndex
  }
  return out
}

export const referenced = (expression: string) => [...new Set((tokens(expression) ?? []).filter((t) => t.name).map((t) => t.name!))]

/** Every base measure a measure is computed from, itself included when it is one. */
export function componentsOf(shape: Shape, name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return []
  seen.add(name)
  const m = shape.measures[name]
  if (!isDerived(m)) return [name]
  return [...new Set(referenced(m.expression).flatMap((r) => componentsOf(shape, r, seen)))]
}

/** Evaluate a derived measure for one row, from that row's aggregated measures. Division by zero is null. */
export function evaluate(shape: Shape, name: string, row: Record<string, unknown>): number | null {
  const m = shape.measures[name]
  if (!isDerived(m)) return row[name] == null ? null : Number(row[name])
  const ts = tokens(m.expression)!
  let pos = 0
  const primary = (): number | null => {
    const t = ts[pos++]
    if (!t) throw new Error('the expression ends early')
    if (t.op === '(') { const v = sum(); if (ts[pos++]?.op !== ')') throw new Error('unclosed parenthesis'); return v }
    if (t.op === '-') { const v = primary(); return v == null ? null : -v }
    if (t.number) return Number(t.number)
    if (!t.name) throw new Error(`unexpected ${t.op}`)
    return evaluate(shape, t.name!, row)
  }
  const product = (): number | null => {
    let v = primary()
    while (ts[pos]?.op === '*' || ts[pos]?.op === '/') {
      const op = ts[pos++].op
      const r = primary()
      if (v == null || r == null) { v = null; continue }
      v = op === '*' ? v * r : r === 0 ? null : v / r
    }
    return v
  }
  const sum = (): number | null => {
    let v = product()
    while (ts[pos]?.op === '+' || ts[pos]?.op === '-') {
      const op = ts[pos++].op
      const r = product()
      v = v == null || r == null ? null : op === '+' ? v + r : v - r
    }
    return v
  }
  const value = sum()
  if (pos !== ts.length) throw new Error('the expression has something left over')
  return value
}

// ── checks ────────────────────────────────────────────────────────────────────────────────────────────────

const ident = /^[a-z][a-z0-9_]*$/

/** Everything that must be true of a shape before the concept can answer anything. */
export function shapeProblem(s: any): string | null {
  if (!s || typeof s !== 'object') return 'a relation must declare its shape'
  const dimensions = s.dimensions ?? {}
  const measures = s.measures ?? {}
  const base = Object.entries<any>(measures).filter(([, m]) => typeof m?.expression !== 'string')
  if (!base.length) return 'the shape must declare at least one measure aggregated from a column'
  const kinds = new Set<string>()
  for (const [name, m] of base) {
    if (!m.unit?.trim()) return `measure "${name}" has no unit`
    if (m.kind !== 'flow' && m.kind !== 'stock') return `measure "${name}" aggregates a column, so it is a flow or a stock`
    if (!AGGREGATES.includes(m.aggregate)) return `measure "${name}" aggregate must be one of ${AGGREGATES.join(', ')}`
    if (m.aggregate !== 'count' && !m.column) return `measure "${name}" says ${m.aggregate} but not of which column`
    kinds.add(m.kind)
  }
  // One relation is read at instants or over spans, not both: its body is called one way or the other.
  if (kinds.size > 1) return 'a relation holds stocks or flows, not both — they are read differently, so define them as two relations'
  const baseKind = [...kinds][0]
  for (const [name, m] of Object.entries<any>(measures)) {
    if (typeof m?.expression !== 'string') continue
    if (!m.unit?.trim()) return `measure "${name}" has no unit`
    const ts = tokens(m.expression)
    if (!ts || !ts.length) return `measure "${name}": an expression may use only measure names, numbers, + - * / and parentheses`
    for (const r of referenced(m.expression)) if (!measures[r]) return `measure "${name}" uses "${r}", which is not a measure`
    if (m.kind !== 'ratio' && m.kind !== baseKind) return `measure "${name}" must be a ratio or a ${baseKind}, like the measures it is computed from`
    // A product or quotient of two quantities does not add up across a split; calling it additive would let it be summed.
    if (m.kind !== 'ratio' && ts.some((t) => t.op === '*' || t.op === '/')) {
      return `measure "${name}" multiplies or divides, so it does not add up — declare it a ratio`
    }
    const shape = { dimensions, measures } as Shape
    if (referenced(m.expression).some((r) => componentsOf(shape, r, new Set([name])).length === 0)) {
      return `measure "${name}" is computed from itself`
    }
    try { evaluate(shape, name, {}) } catch { return `measure "${name}": the expression is not well formed` }
  }
  if (kinds.has('flow') && !s.time) return 'a flow accumulates over a span, so the shape must name its time column'
  for (const name of [...Object.keys(dimensions), ...Object.keys(measures)]) {
    if (!ident.test(name)) return `"${name}" must be a lower-case identifier (letters, digits, underscores)`
    if ((BUILT_IN as readonly string[]).includes(name)) return `"${name}" is a time grain and cannot also be declared`
  }
  if (s.grain !== undefined) {
    const g = dimensions[s.grain]
    if (!g) return `grain "${s.grain}" is not a dimension`
    if (!g.entity) return `grain "${s.grain}" must declare the entity it identifies`
    if (baseKind !== 'stock') return 'a relation with a grain lists members as at an instant, so its measures are stocks'
  }
  for (const [name, d] of Object.entries<any>(dimensions)) {
    if (d.entity !== undefined && !ident.test(d.entity)) return `dimension "${name}": entity must be a lower-case identifier`
    if (name.includes('.')) return `"${name}": a dot reaches an attribute through an entity and cannot be part of a name`
    if (!d.column) return `dimension "${name}" has no column`
    if (!['current', 'as-at', 'stable'].includes(d.history)) return `dimension "${name}" history must be current, as-at or stable`
  }
  return null
}
