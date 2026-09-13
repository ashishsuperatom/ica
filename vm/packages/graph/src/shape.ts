// ── THE SHAPE OF A CONCEPT'S ROWS ─────────────────────────────────────────────────────────────────────────────
//
// A concept that returns a relation is written as plain SQL: one row per thing, at its finest grain — one row
// per employee, one row per time entry. The body is free; it can be whatever SQL the source runs best.
//
// The shape is what the engine needs to ask that SQL a question: which output columns are dimensions, which are
// measures and how each one adds up, and which column is time. The engine wraps the body's SQL —
//
//     SELECT <dimensions>, <aggregates> FROM ( <the body's SQL> ) t WHERE <filters> GROUP BY <dimensions>
//
// — so slicing, drilling and filtering never depend on the body having done them. The shape lives in the
// contract because it is the concept's interface: what callers rely on, and what the engine checks.

/** How a measure may be aggregated (Lenz and Shoshani, 1997).
 *  flow   accumulates over time — hours worked. Summable over every dimension, time included.
 *  stock  true at an instant — headcount. Summable across things, never across time. */
export type MeasureKind = 'flow' | 'stock'

export type Aggregate = 'sum' | 'count' | 'count distinct' | 'min' | 'max'

export interface Dimension {
  /** The output column that identifies a member. Filters use this, never the label. */
  column: string
  /** The output column a person reads. */
  label?: string
  /** Whether the value is as it is now, as it was at the time, or never changes (an entity's own identity). */
  history: 'current' | 'as-at' | 'stable'
}

export interface Measure {
  aggregate: Aggregate
  /** The output column aggregated. Not needed for count. */
  column?: string
  unit: string
  kind: MeasureKind
}

export interface Shape {
  dimensions: Record<string, Dimension>
  measures: Record<string, Measure>
  /** The output date column a flow is bounded and bucketed by. */
  time?: string
}

/** What a concept's body returns for one reading: the SQL, and the source it runs on. A stock's body is called
 *  with `{ asAt }`, a flow's with `{ from, to }`, both as YYYY-MM-DD, and `where` — the filters the engine will
 *  apply anyway, there for a body that can use them to read less. */
export interface Statement { source: string; sql: string; params?: Record<string, unknown> }

export const AGGREGATES: Aggregate[] = ['sum', 'count', 'count distinct', 'min', 'max']
const ident = /^[a-z][a-z0-9_]*$/

/** Everything that must be true of a shape before the concept can answer anything. */
export function shapeProblem(s: any): string | null {
  if (!s || typeof s !== 'object') return 'a concept that returns a relation must declare its shape'
  const dimensions = s.dimensions ?? {}
  const measures = s.measures ?? {}
  if (!Object.keys(measures).length) return 'the shape must declare at least one measure'
  const kinds = new Set<string>()
  for (const [name, m] of Object.entries<any>(measures)) {
    if (!m.unit?.trim()) return `measure "${name}" has no unit`
    if (m.kind !== 'flow' && m.kind !== 'stock') return `measure "${name}" must be a flow or a stock`
    if (!AGGREGATES.includes(m.aggregate)) return `measure "${name}" aggregate must be one of ${AGGREGATES.join(', ')}`
    if (m.aggregate !== 'count' && !m.column) return `measure "${name}" says ${m.aggregate} but not of which column`
    kinds.add(m.kind)
  }
  // One relation is read at instants or over spans, not both: its body is called one way or the other.
  if (kinds.size > 1) return 'a relation holds stocks or flows, not both — they are read differently, so define them as two concepts'
  if (kinds.has('flow') && !s.time) return 'a flow accumulates over a span, so the shape must name its time column'
  for (const name of [...Object.keys(dimensions), ...Object.keys(measures)]) {
    if (!ident.test(name)) return `"${name}" must be a lower-case identifier (letters, digits, underscores)`
  }
  for (const [name, d] of Object.entries<any>(dimensions)) {
    if (!d.column) return `dimension "${name}" has no column`
    if (!['current', 'as-at', 'stable'].includes(d.history)) return `dimension "${name}" history must be current, as-at or stable`
  }
  if (dimensions.month) return '"month" is derived from time and cannot also be declared'
  return null
}

export const kindOf = (s: Shape): MeasureKind => Object.values(s.measures)[0].kind
