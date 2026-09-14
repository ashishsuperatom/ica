// ── UNITS: HOURS IN DAYS, MINUTES IN HOURS ────────────────────────────────────────────────────────────────
//
// A question may ask for a measure in another unit. Some conversions are fixed — sixty minutes to the hour — and
// the rest belong to the organisation: how many hours make a working day, a working week, an FTE. Those come from
// the setting `units`, which may differ by person or group like any other:
//
//   { "h": { "day": 0.125, "week": 0.025 } }        one hour is an eighth of a working day
//
// A conversion is a constant factor, so it applies to a measure after it is computed — and to everything shown
// beside it in the same unit: the compared value, the change, the totals. A ratio has no unit to convert, and money
// is converted by currency, not by factor.

import { CoordinateError } from './errors.js'
import type { Result } from './execute.js'
import type { BaseMeasure, Shape } from './shape.js'
import { isDerived } from './shape.js'

const refuse = (msg: string): never => { throw new CoordinateError(msg) }
const FIXED: Record<string, Record<string, number>> = { min: { h: 1 / 60 }, h: { min: 60 } }

export function factor(from: string, to: string, table: Record<string, Record<string, number>> = {}): number | null {
  if (from === to) return 1
  const direct = table[from]?.[to] ?? FIXED[from]?.[to]
  if (direct != null) return direct
  const inverse = table[to]?.[from] ?? FIXED[to]?.[from]
  return inverse ? 1 / inverse : null
}

export function convertUnits(shape: Shape, result: Result, wanted: Record<string, string>, table: Record<string, Record<string, number>> | undefined,
                             caveats: string[]): Result {
  const scale = new Map<string, { by: number; unit: string }>()
  for (const [m, to] of Object.entries(wanted)) {
    const def = shape.measures[m] ?? refuse(`there is no measure "${m}" to convert`)
    if (def.kind === 'ratio') refuse(`"${m}" is a ratio; it has no unit to convert`)
    if (!isDerived(def) && (def as BaseMeasure).currency) refuse(`"${m}" is money; ask for it in a currency instead`)
    const f = factor(def.unit, to, table) ?? refuse(`no conversion from ${def.unit} to ${to} is known — the setting "units" gives the organisation's conversions`)
    for (const column of [m, `${m}_compare`, `${m}_change`, `${m}_counterfactual`]) scale.set(column, { by: f, unit: to })
    if (f !== 1) caveats.push(`"${m}" is shown in ${to}: 1 ${def.unit} = ${Number(f.toPrecision(6))} ${to}`)
  }
  const rows = (rs: Record<string, unknown>[]) => rs.map((r) => {
    const out = { ...r }
    for (const [column, { by }] of scale) if (typeof out[column] === 'number') out[column] = (out[column] as number) * by
    return out
  })
  const columns = (cs: Result['columns']) => cs.map((c) => (scale.has(c.name) ? { ...c, unit: scale.get(c.name)!.unit } : c))
  return {
    ...result,
    columns: columns(result.columns),
    rows: rows(result.rows),
    ...(result.totals ? { totals: result.totals.map((t) => ({ ...t, columns: columns(t.columns), rows: rows(t.rows) })) } : {}),
  }
}
