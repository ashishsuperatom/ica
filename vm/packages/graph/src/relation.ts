// ── A RELATION: A QUERY THAT HAS NOT RUN YET ──────────────────────────────────────────────────────────────
//
// A concept returns one of these instead of rows. It is the DEFINITION — which table, which rows count, what the
// dimensions and measures are — written once. The question asked of it arrives separately, as coordinates, and
// the engine combines the two into SQL. That split is what lets one concept answer "by pillar", "by employee",
// "by month" and "within CEC" without a program for each.
//
// Immutable: every method returns a new relation, so a definition cannot be changed by whoever extends it.

/** How a measure may be aggregated (Lenz and Shoshani, 1997).
 *  flow   accumulates over time — hours worked. Summable over every dimension, time included.
 *  stock  true at an instant — headcount. Summable across things, never across time. */
export type MeasureKind = 'flow' | 'stock'

export interface Dimension {
  /** The column that identifies a member. Filters and joins use this, never the label. */
  key: string
  /** What a person reads. Defaults to the key. */
  label?: string
  /** Whether the value is read as it is now, as it was at the time, or never changes (an entity's own identity). */
  history: 'current' | 'as-at' | 'stable'
}

export interface Measure {
  /** An aggregate SQL expression. */
  sql: string
  unit: string
  kind: MeasureKind
}

export interface RelationShape {
  source: string
  dimensions: Record<string, Dimension>
  measures: Record<string, Measure>
  /** The date column a FLOW is bucketed and bounded by. */
  time?: string
  /** For a STOCK: the condition that makes a row count as at `@asAt`. */
  asAt?: string
  caveats: string[]
}

export class Relation {
  private constructor(
    readonly source: string,
    readonly from: string,
    readonly joins: readonly string[],
    readonly wheres: readonly string[],
    readonly shape: RelationShape,
  ) {}

  static from(source: string, table: string): Relation {
    return new Relation(source, table, [], [], { source, dimensions: {}, measures: {}, caveats: [] })
  }

  private with(changes: Partial<{ joins: string[]; wheres: string[]; shape: RelationShape }>): Relation {
    return new Relation(this.source, this.from, changes.joins ?? [...this.joins], changes.wheres ?? [...this.wheres],
                        changes.shape ?? { ...this.shape })
  }

  join(sql: string): Relation { return this.with({ joins: [...this.joins, sql] }) }
  where(sql: string): Relation { return this.with({ wheres: [...this.wheres, sql] }) }

  dimension(name: string, d: { key: string; label?: string; history: Dimension['history'] }): Relation {
    return this.with({ shape: { ...this.shape,
      dimensions: { ...this.shape.dimensions, [name]: { key: d.key, label: d.label, history: d.history } } } })
  }

  measure(name: string, m: Measure): Relation {
    return this.with({ shape: { ...this.shape, measures: { ...this.shape.measures, [name]: m } } })
  }

  /** The date a flow is measured over. */
  time(column: string): Relation { return this.with({ shape: { ...this.shape, time: column } }) }

  /** What makes a row count at an instant, written against `@asAt` (a YYYY-MM-DD date). */
  stockAt(condition: string): Relation { return this.with({ shape: { ...this.shape, asAt: condition } }) }

  caveat(text: string): Relation { return this.with({ shape: { ...this.shape, caveats: [...this.shape.caveats, text] } }) }
}

export const isRelation = (x: unknown): x is Relation => x instanceof Relation

/** Everything that must be true of a definition before it can answer anything. Checked when a concept is defined. */
export function relationProblem(r: Relation): string | null {
  const { dimensions, measures, time, asAt } = r.shape
  if (!Object.keys(measures).length) return 'a relation must define at least one measure'
  for (const [name, m] of Object.entries(measures)) {
    if (!m.unit?.trim()) return `measure "${name}" has no unit`
    if (m.kind !== 'flow' && m.kind !== 'stock') return `measure "${name}" must be a flow or a stock`
    if (m.kind === 'flow' && !time) return `measure "${name}" is a flow but the relation says nothing about time — a flow accumulates over a span, so it needs a date to be bounded by`
    if (m.kind === 'stock' && !asAt) return `measure "${name}" is a stock but the relation does not say what counts at an instant`
  }
  // Names become column aliases, and sources fold alias case unpredictably. Lower-case identifiers survive.
  const ident = /^[a-z][a-z0-9_]*$/
  for (const name of [...Object.keys(dimensions), ...Object.keys(measures)]) {
    if (!ident.test(name)) return `"${name}" must be a lower-case identifier (letters, digits, underscores)`
  }
  for (const [name, d] of Object.entries(dimensions)) if (!d.key?.trim()) return `dimension "${name}" has no key`
  if (dimensions.month) return '"month" is derived from time and cannot also be declared'
  return null
}
