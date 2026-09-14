// ── TOTALS AND SHARES: THE NUMBERS AROUND A TABLE ─────────────────────────────────────────────────────────
//
// A pivot is rows, columns, and totals along both. Laying it out is the display's work; the totals are not, because
// a total is not always the sum of what it totals. Utilisation for a pillar is its hours over its available hours,
// not the sum of its people's utilisation; people across two months are not the sum of each month's people. So
// every total here is asked of the source at its own level — the same question with a coarser split — and is
// right for every kind of measure by construction. SQL's GROUPING SETS does the same in one statement; asking per
// level works on every source, NetSuite included.
//
// A share is a measure divided by its total within a group — each customer's part of its pillar's revenue. Only
// a measure that adds up has one: a ratio's "share" of a total ratio means nothing.

import { CoordinateError, type Coordinates } from './coordinates.js'
import type { Column, Result } from './execute.js'
import { additivity, type Shape } from './shape.js'

const refuse = (msg: string): never => { throw new CoordinateError(msg) }

export function summaryProblem(shape: Shape, c: Coordinates): void {
  const by = c.by ?? []
  for (const level of c.totals ?? []) {
    if (!Array.isArray(level)) refuse('totals is a list of splits, each a list of names from by')
    for (const d of level) if (!by.includes(d)) refuse(`a total by "${d}" needs "${d}" among the splits: ${by.join(', ')}`)
  }
  if (c.share) {
    const measures = c.measures?.length ? c.measures : Object.keys(shape.measures)
    for (const m of c.share.measures) {
      if (!measures.includes(m)) refuse(`a share of "${m}" needs it among the measures asked for`)
      if (additivity(shape, m) !== 'additive') refuse(`"${m}" does not add up, so it has no share of a total`)
    }
    for (const d of c.share.within) if (!by.includes(d)) refuse(`a share within "${d}" needs "${d}" among the splits`)
  }
}

/** The same question at a coarser split, with nothing that picks rows out of the full set. */
export function atLevel(c: Coordinates, level: string[], measures?: string[]): Coordinates {
  const { totals: _t, share: _s, having: _h, order: _o, limit: _l, limitPer: _p, ...rest } = c
  return { ...rest, by: level, ...(measures ? { measures } : {}) }
}

/** Each row's share of its group's total. */
export function withShares(result: Result, whole: Result, measures: string[], within: string[]): Result {
  const key = (r: Record<string, unknown>) => JSON.stringify(within.map((d) => r[d] ?? null))
  const totals = new Map(whole.rows.map((r) => [key(r), r]))
  const rows = result.rows.map((r) => {
    const t = totals.get(key(r))
    const out = { ...r }
    for (const m of measures) {
      const v = r[m] as number | null, total = t?.[m] as number | null | undefined
      out[`${m}_share`] = v == null || total == null || total === 0 ? null : v / total
    }
    return out
  })
  const columns: Column[] = [...result.columns]
  for (const m of measures) columns.push({ name: `${m}_share`, role: 'measure', unit: 'share', kind: 'ratio' })
  return { ...result, columns, rows }
}
