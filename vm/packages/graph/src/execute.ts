// ── RUNNING A PLAN ────────────────────────────────────────────────────────────────────────────────────────
//
// Statements run against the source; their rows become one result that carries its own schema, so whatever
// receives it knows which columns are dimensions, which are measures, and in what unit and kind — the difference
// between a table that can be pivoted and summed correctly and a list of numbers.
//
// Checks happen here because only here are the rows visible.
//
//   A CAPPED RESULT IS REFUSED. The source stops at a row limit; a result cut short and shown as complete is a
//   wrong answer that looks right.
//
//   THE PARTS MUST ACCOUNT FOR THE WHOLE. Each split statement is also asked unsplit, and every measure is held
//   to what its aggregation allows: a sum's parts add to the whole, a distinct count's lie between its largest
//   part and their sum, a minimum is its smallest part. A join that drops rows, or a grouping the source
//   silently truncates, is caught here and nowhere else.

import { DatabaseSync } from 'node:sqlite'
import type { Condition, Plan, ResolvedStatement } from './coordinates.js'
import { additivity, evaluate, isDerived, type MeasureKind, type Shape } from './shape.js'

export interface Column { name: string; role: 'dimension' | 'label' | 'measure' | 'time'; unit?: string; kind?: MeasureKind }
export interface Result {
  columns: Column[]
  rows: Record<string, unknown>[]
  caveats: string[]
  /** The same question at coarser splits, when totals were asked for. */
  totals?: Array<{ by: string[]; columns: Column[]; rows: Record<string, unknown>[] }>
}
export interface QueryRecord { source: string; sql: string; params: Record<string, unknown>; rows: number; ms: number; capped: boolean }

export type RunQuery = (source: string, sql: string, params: Record<string, unknown>) => Promise<any[]>

export class CappedError extends Error {}

/** Rows from a source that is not SQL, queried with the same SQL the engine would send a database. */
export function runLocal(st: ResolvedStatement): any[] {
  const db = new DatabaseSync(':memory:')
  try {
    for (const [table, { columns: declared, rows }] of Object.entries(st.tables ?? {})) {
      const columns = [...new Set([...declared, ...rows.flatMap((r) => Object.keys(r))])]
      if (!columns.length) { db.exec(`CREATE TABLE "${table}" (_empty INTEGER)`); continue }
      db.exec(`CREATE TABLE "${table}" (${columns.map((c) => `"${c}"`).join(', ')})`)
      const insert = db.prepare(`INSERT INTO "${table}" VALUES (${columns.map(() => '?').join(', ')})`)
      db.exec('BEGIN')
      for (const r of rows) insert.run(...columns.map((c) => local(r[c])))
      db.exec('COMMIT')
    }
    // SQLite refuses a named parameter the statement does not use, so only those it names are passed.
    const named = new Set([...st.sql.matchAll(/@(\w+)/g)].map((m) => m[1]))
    const params = Object.fromEntries(Object.entries(st.params).filter(([k]) => named.has(k)).map(([k, v]) => [k, local(v)]))
    return db.prepare(st.sql).all(params as any) as any[]
  } finally { db.close() }
}
const local = (v: unknown): any => v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10)
  : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'object' ? JSON.stringify(v) : v

export async function runPlan(shape: Shape, p: Plan, query: RunQuery,
                              log: (q: QueryRecord) => void,
                              verify: (label: string, holds: boolean, detail: string) => void,
                              note: (caveat: string) => void, checks: 'thorough' | 'light' = 'thorough'): Promise<Result> {
  const exec = async (st: ResolvedStatement) => {
    const t = Date.now()
    const rows = st.tables ? runLocal(st) : await query(st.source, st.sql, st.params)
    const capped = Array.isArray((rows as any).notes) && (rows as any).notes.length > 0
    log({ source: st.tables ? `${st.source} (local)` : st.source, sql: st.sql, params: st.params, rows: rows.length, ms: Date.now() - t, capped })
    if (capped) {
      throw new CappedError(`the source stopped at ${rows.length} rows, so this result would be incomplete. ` +
        `Ask for fewer rows: a coarser split, a narrower span, a filter, or a limit`)
    }
    return rows
  }

  if (p.detail) {
    const st = p.statements[0]
    const rows = (await exec(st)).map((row: any) => {
      for (const [name, alias] of Object.entries(p.paths)) {
        if (alias in row) { row[name] = row[alias]; delete row[alias] }
        if (`${alias}_label` in row) { row[`${name}_label`] = row[`${alias}_label`]; delete row[`${alias}_label`] }
      }
      const out: Record<string, unknown> = {}
      for (const col of p.detail!) {
        const v = row[col.name]
        out[col.name] = v == null ? null : col.role === 'measure' ? Number(v) : col.role === 'dimension' ? String(v) : v
      }
      return out
    })
    return { columns: p.detail, rows, caveats: p.caveats }
  }

  const splits = p.by.filter((d) => d !== p.grain)
  // A member's identity is compared as text, so 15 and '15' from two sources are the same member.
  const normal = (row: any) => {
    for (const [name, alias] of Object.entries(p.paths)) {
      if (alias in row) { row[name] = row[alias]; delete row[alias] }
      if (`${alias}_label` in row) { row[`${name}_label`] = row[`${alias}_label`]; delete row[`${alias}_label`] }
    }
    // A source may leave a null column out of a row altogether (NetSuite does); every split and label is present.
    for (const d of p.by) {
      row[d] = row[d] == null ? null : String(row[d])
      if (p.labelled.includes(d) && row[`${d}_label`] === undefined) row[`${d}_label`] = null
    }
    for (const m of p.fetched) row[m] = row[m] == null ? null : Number(row[m])
    return row
  }

  const thorough = checks === 'thorough'
  if (!thorough) note('checks were light: the rows were not reconciled with the whole, and joins to entities were not checked for repeated members')
  else if (p.partial) note('the result is filtered or limited, so its rows are not checked against the whole')
  // Statements run together; their checks are recorded in statement order, so memory is the same every run.
  type Check = [label: string, holds: boolean, detail: string]
  const answered = await Promise.all(p.statements.map(async (st) => {
    const checks: Check[] = []
    const record = (label: string, holds: boolean, detail: string) => { checks.push([label, holds, detail]) }
    // A join to an entity that repeats a member would repeat every row joined to it, and every sum with them.
    for (const g of thorough ? st.guards ?? [] : []) {
      const [c] = await exec(g.statement)
      record(g.label, Number(c?.n ?? 0) === Number(c?.d ?? 0), `${c?.n} rows, ${c?.d} distinct`)
      if (!checks.at(-1)![1]) return { rows: [], checks }
    }
    const rows = (await exec(st)).map(normal)
    if (Object.keys(p.converted).length) {
      const unconverted = rows.reduce((a, r) => a + Number(r.c_unconverted ?? 0), 0)
      record('every amount has a rate to convert it with', unconverted === 0, `${unconverted} row(s) have no rate`)
      for (const r of rows) delete r.c_unconverted
      if (unconverted) return { rows: [], checks }
    }
    if (thorough && st.unsplit && !p.partial) {
      const [whole] = (await exec(st.unsplit)).map(normal)
      checkParts(shape, p, rows, whole ?? {}, st.period, record)
    }
    return { rows: p.grain && st.period ? rows.map((r) => ({ ...r, [p.grain!]: st.period })) : rows, checks }
  }))
  for (const { checks } of answered) for (const [label, holds, detail] of checks) verify(label, holds, detail)
  const results = answered.map((a) => a.rows)

  let rows: Record<string, any>[] = results.flat()
  for (const name of Object.keys(p.paths)) {
    if (p.by.includes(name) && rows.some((r) => r[name] == null)) {
      note(`some rows have no "${name}" — the member has none recorded, or was not there as at the instant read — and are shown together as none`)
    }
  }
  const recompute = (r: Record<string, any>) => { for (const m of p.fetched) if (isDerived(shape.measures[m])) r[m] = evaluate(shape, m, r); return r }

  if (p.combine === 'average-over-periods') {
    const groups = new Map<string, { row: Record<string, any>; sums: Record<string, number> }>()
    for (const r of rows) {
      const k = JSON.stringify(splits.map((d) => r[d]))
      const g = groups.get(k) ?? { row: Object.fromEntries(Object.entries(r).filter(([c]) => !p.fetched.includes(c))), sums: {} }
      for (const m of p.fetched) if (!isDerived(shape.measures[m])) g.sums[m] = (g.sums[m] ?? 0) + Number(r[m] ?? 0)
      groups.set(k, g)
    }
    // A member absent from some readings counts as zero in those readings: a stock that is not there is zero.
    rows = [...groups.values()].map((g) => recompute({ ...g.row, ...Object.fromEntries(Object.entries(g.sums).map(([m, v]) => [m, v / p.statements.length])) }))
  }

  if (p.after.fill && p.grain) {
    const combos = new Map<string, Record<string, any>>()
    for (const r of rows) combos.set(JSON.stringify(splits.map((d) => r[d])),
      Object.fromEntries(Object.entries(r).filter(([c]) => c !== p.grain && !p.fetched.includes(c))))
    if (!combos.size) combos.set('[]', {})
    const present = new Set(rows.map((r) => JSON.stringify([...splits.map((d) => r[d]), r[p.grain!]])))
    for (const [k, base] of combos) for (const period of p.after.fill.periods) {
      if (present.has(JSON.stringify([...JSON.parse(k), period]))) continue
      const empty: Record<string, any> = { ...base, [p.grain]: period }
      for (const m of p.fetched) empty[m] = additivity(shape, m) === 'additive' && !isDerived(shape.measures[m]) ? 0 : null
      rows.push(recompute(empty))
    }
  }

  if (p.after.cumulative && p.grain) {
    const { reset, keep } = p.after.cumulative
    const grain = p.grain
    rows.sort((a, b) => JSON.stringify(splits.map((d) => a[d])).localeCompare(JSON.stringify(splits.map((d) => b[d]))) || String(a[grain]).localeCompare(String(b[grain])))
    const running = new Map<string, Record<string, number>>()
    for (const r of rows) {
      const start = p.grains.startOfLabel(grain, String(r[grain]), keep)
      const k = JSON.stringify([...splits.map((d) => r[d]), reset === 'never' ? '' : p.grains.labelOf(reset, start)])
      const acc = running.get(k) ?? {}
      for (const m of p.fetched) if (!isDerived(shape.measures[m])) { acc[m] = (acc[m] ?? 0) + Number(r[m] ?? 0); r[m] = acc[m] }
      running.set(k, acc)
      recompute(r)
    }
    const kept = new Set(p.grains.periods(grain, keep.from, keep.to).map((x) => x.label))
    rows = rows.filter((r) => kept.has(String(r[grain])))
  }

  if (p.after.rolling && p.grain) {
    const { window, average, keep } = p.after.rolling
    const grain = p.grain
    const combo = (r: Record<string, any>) => JSON.stringify(splits.map((d) => r[d]))
    rows.sort((a, b) => combo(a).localeCompare(combo(b)) || String(a[grain]).localeCompare(String(b[grain])))
    const recent = new Map<string, Record<string, any>[]>()
    const bases = p.fetched.filter((m) => !isDerived(shape.measures[m]))
    rows = rows.map((r) => {
      const seen = [...(recent.get(combo(r)) ?? []), r].slice(-window)
      recent.set(combo(r), seen)
      const out: Record<string, any> = { ...r }
      for (const m of bases) {
        const total = seen.reduce((a, x) => a + Number(x[m] ?? 0), 0)
        out[m] = average ? total / window : total
      }
      return recompute(out)
    })
    const kept = new Set(p.grains.periods(grain, keep.from, keep.to).map((x) => x.label))
    rows = rows.filter((r) => kept.has(String(r[grain])))
  }

  if (!p.orderedAtSource) rows = arrange(rows, p.after, p.by)
  if (p.fetched.length > p.measures.length) {
    const hidden = p.fetched.filter((m) => !p.measures.includes(m))
    rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([c]) => !hidden.includes(c))))
  }

  const columns: Column[] = []
  for (const d of p.by) {
    columns.push({ name: d, role: 'dimension' })
    if (p.labelled.includes(d)) columns.push({ name: `${d}_label`, role: 'label' })
  }
  for (const m of p.measures) columns.push({ name: m, role: 'measure', unit: p.converted[m] ?? shape.measures[m].unit, kind: shape.measures[m].kind })
  return { columns, rows, caveats: p.caveats }
}

function checkParts(shape: Shape, p: Plan, rows: Record<string, any>[], whole: Record<string, any>, period: string | undefined,
                    verify: (label: string, holds: boolean, detail: string) => void) {
  const splitBy = p.by.filter((d) => d !== p.grain || !period).join(', ')
  const at = period ? ` (${period})` : ''
  for (const m of p.fetched) {
    const kind = additivity(shape, m)
    if (kind === 'none') continue
    const values = rows.map((r) => r[m]).filter((v) => v != null) as number[]
    const all = whole[m] == null ? 0 : Number(whole[m])
    const sum = values.reduce((a, v) => a + v, 0)
    const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9)
    if (kind === 'additive') verify(`${m}: the split by ${splitBy} sums to the whole${at}`, close(sum, all), `parts ${round(sum)} · whole ${round(all)}`)
    if (kind === 'bounded') {
      const max = values.length ? Math.max(...values) : 0
      verify(`${m}: the whole lies between the largest part and the sum of the parts${at}`, max <= all + 1e-9 && all <= sum + 1e-9,
             `largest ${round(max)} · whole ${round(all)} · sum ${round(sum)}`)
    }
    if (kind === 'minimum' || kind === 'maximum') {
      const edge = values.length ? (kind === 'minimum' ? Math.min(...values) : Math.max(...values)) : null
      verify(`${m}: the ${kind} of the parts is the whole${at}`, edge == null ? whole[m] == null : close(edge, all), `parts ${edge} · whole ${whole[m]}`)
    }
  }
}

/** Having, then order, then limit — on rows already in hand. Ties are broken by the split, so the order is stable,
 *  and rows with no order asked for come in the order of the split. */
export function arrange(rows: Record<string, any>[], after: { having?: Record<string, Condition>; order?: Array<{ by: string; desc?: boolean }>; limit?: number; limitPer?: string[] },
                        by: string[]): Record<string, any>[] {
  let out = rows
  if (after.having) out = out.filter((r) => Object.entries(after.having!).every(([m, c]) => holds(r[m], c)))
  // With no order asked for, rows come in the order of the split — never in whatever order they were assembled.
  {
    const order = after.order ?? []
    out = [...out].sort((a, b) => {
      for (const o of order) { const d = compare(a[o.by], b[o.by]); if (d) return o.desc ? -d : d }
      for (const d of by) { const x = compare(a[d], b[d]); if (x) return x }
      return 0
    })
  }
  if (after.limit != null && after.limitPer?.length) {
    const kept = new Map<string, number>()
    out = out.filter((r) => {
      const k = JSON.stringify(after.limitPer!.map((d) => r[d] ?? null))
      const n = kept.get(k) ?? 0
      kept.set(k, n + 1)
      return n < after.limit!
    })
  } else if (after.limit != null) out = out.slice(0, after.limit)
  return out
}

function holds(v: any, c: Condition): boolean {
  if (c === null) return v == null
  if (Array.isArray(c)) return c.some((x) => compare(v, x) === 0)
  if (typeof c !== 'object') return compare(v, c) === 0
  return Object.entries(c).every(([op, x]: [string, any]) => {
    if (op === 'isNull') return (v == null) === Boolean(x)
    if (v == null) return false
    if (op === 'contains') return String(v).toLowerCase().includes(String(x).toLowerCase())
    if (op === 'startsWith') return String(v).toLowerCase().startsWith(String(x).toLowerCase())
    const d = compare(v, x)
    return ({ eq: d === 0, ne: d !== 0, gt: d > 0, gte: d >= 0, lt: d < 0, lte: d <= 0,
              in: (x as any[]).some((y) => compare(v, y) === 0), notIn: !(x as any[]).some((y) => compare(v, y) === 0) } as Record<string, boolean>)[op]
  })
}

function compare(a: any, b: any): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' || typeof b === 'number') {
    const x = Number(a), y = Number(b)
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y
  }
  return String(a).localeCompare(String(b))
}

const round = (n: number) => Math.round(n * 1000) / 1000
