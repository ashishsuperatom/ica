// ── RUNNING A PLAN ────────────────────────────────────────────────────────────────────────────────────────
//
// Statements run against the source; their rows become one result that carries its own schema, so whatever
// receives it knows which columns are dimensions, which are measures, and in what unit — the difference between
// a table that can be pivoted and summed correctly and a list of numbers.
//
// Two checks happen here because only here are the rows visible.
//
//   A CAPPED RESULT IS REFUSED. The source stops at a row limit; a result cut short and shown as complete is a
//   wrong answer that looks right. Asking for fewer rows is the fix, and the refusal says how.
//
//   THE PARTS MUST SUM TO THE WHOLE. For a split, the same measure is taken unsplit and compared. A join that
//   drops rows, or a grouping the source silently truncates, is caught here and nowhere else.

import type { Plan } from './coordinates.js'
import type { MeasureKind, Relation } from './relation.js'

export interface Column { name: string; role: 'dimension' | 'label' | 'measure'; unit?: string; kind?: MeasureKind }
export interface Result { columns: Column[]; rows: Record<string, unknown>[]; caveats: string[] }
export interface QueryRecord { source: string; sql: string; params: Record<string, unknown>; rows: number; ms: number; capped: boolean }

export type RunQuery = (source: string, sql: string, params: Record<string, unknown>) => Promise<any[]>

export class CappedError extends Error {}

export async function runPlan(r: Relation, p: Plan, query: RunQuery,
                              log: (q: QueryRecord) => void,
                              verify: (label: string, holds: boolean, detail: string) => void): Promise<Result> {
  const exec = async (sql: string, params: Record<string, unknown>) => {
    const t = Date.now()
    const rows = await query(r.source, sql, params)
    const capped = Array.isArray((rows as any).notes) && (rows as any).notes.length > 0
    log({ source: r.source, sql, params, rows: rows.length, ms: Date.now() - t, capped })
    if (capped) {
      throw new CappedError(`the source stopped at ${rows.length} rows, so this result would be incomplete. ` +
        `Ask for fewer rows: a coarser split, a narrower span, or a filter`)
    }
    return rows
  }

  const numeric = (row: any) => { for (const m of p.measures) row[m] = row[m] == null ? null : Number(row[m]); return row }
  const results = await Promise.all(p.statements.map(async (s) =>
    (await exec(s.sql, s.params)).map((row) => numeric(s.month ? { month: s.month, ...row } : row))))

  let rows: Record<string, unknown>[]
  if (p.combine === 'average-over-months') {
    const keys = p.by
    const groups = new Map<string, { row: Record<string, unknown>; sums: Record<string, number>; n: number }>()
    for (const row of results.flat()) {
      const k = JSON.stringify(keys.map((d) => row[d]))
      const g = groups.get(k) ?? { row: Object.fromEntries(Object.entries(row).filter(([c]) => !p.measures.includes(c) && c !== 'month')), sums: {}, n: 0 }
      for (const m of p.measures) g.sums[m] = (g.sums[m] ?? 0) + Number(row[m] ?? 0)
      g.n++
      groups.set(k, g)
    }
    // A member absent from some months counts as zero in those months, since a stock that is not there is zero.
    rows = [...groups.values()].map((g) => ({ ...g.row, ...Object.fromEntries(p.measures.map((m) => [m, g.sums[m] / p.statements.length])) }))
  } else {
    rows = results.flat()
  }

  // The parts sum to the whole — the same question asked unsplit, compared.
  if (p.unsplit) {
    const [total] = (await exec(p.unsplit.sql, p.unsplit.params)).map(numeric)
    const splitBy = p.by.join(', ')
    for (const m of p.measures) {
      const parts = rows.reduce((a, row) => a + Number(row[m] ?? 0), 0)
      const all = Number(total?.[m] ?? 0)
      const holds = Math.abs(parts - all) <= Math.max(1e-6, Math.abs(all) * 1e-9)
      verify(`${m}: the split by ${splitBy} sums to the whole`, holds, `parts ${round(parts)} · whole ${round(all)}`)
    }
  }

  const columns: Column[] = []
  for (const d of p.by) {
    columns.push({ name: d, role: 'dimension' })
    const dim = r.shape.dimensions[d]
    if (dim?.label && dim.label !== dim.key) columns.push({ name: `${d}_label`, role: 'label' })
  }
  for (const m of p.measures) columns.push({ name: m, role: 'measure', unit: r.shape.measures[m].unit, kind: r.shape.measures[m].kind })
  return { columns, rows, caveats: p.caveats }
}

const round = (n: number) => Math.round(n * 1000) / 1000
