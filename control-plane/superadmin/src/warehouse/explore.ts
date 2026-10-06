// THE EXPLORER'S READS: a table's rows (searched, filtered, sorted, paged), a column's commonest values, every column
// profiled, a column's spread. The page never sends SQL: it names a table, columns and values, and the SQL is made here
// from names checked against the columns the reader may read — then the warehouse's access check reads it again before
// it runs. Nothing here knows the backend: `run` is the bridge's checked query (the cloud warehouse today; a local one
// could stand behind the same bridge).

import type { QueryResult, TableInfo } from './bridge'

export interface Filter { column: string; value: string | null }
export interface Narrowing { q?: string; where?: Filter[] }
export type ExploreRequest =
  | ({ op: 'rows'; table: string; sort?: string | null; dir?: 'asc' | 'desc'; page?: number; size?: number } & Narrowing)
  | ({ op: 'values'; table: string; column: string } & Narrowing)
  | { op: 'profile'; table: string }
  | ({ op: 'spread'; table: string; column: string } & Narrowing)

export type Kind = 'number' | 'time' | 'bool' | 'text'
export function kindOf(type: string): Kind {
  if (/^(long|int|integer|double|float|decimal)/.test(type)) return 'number'
  if (/^(date|timestamp|time)/.test(type)) return 'time'
  if (type === 'boolean') return 'bool'
  return 'text'
}

export interface ColumnProfile { name: string; type: string; kind: Kind; distinct: number | null; nulls: number; min: string | null; max: string | null; mean: number | null; q1: number | null; median: number | null; q3: number | null; trues: number | null }
export interface Profile { rows: number; columns: ColumnProfile[] }
export type Spread = { kind: 'numbers'; lo: number; hi: number; bins: number[] } | { kind: 'time'; unit: 'day' | 'month'; bins: { at: string; rows: number }[] } | { kind: 'none' }

type Run = (sql: string, limit: number) => Promise<QueryResult>
const SIZES = [50, 100, 250, 500]
const BINS = 20

export class ExploreRefusal extends Error {}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** The SQL pieces, from checked names only. */
function sqlOf(t: TableInfo) {
  const readable = new Map(t.columns.map((c) => [c.name, c]))
  const col = (name: string) => {
    const c = readable.get(String(name))
    if (!c || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name)) throw new ExploreRefusal(`"${name}" is not a column of ${t.name} you may read`)
    return c
  }
  const id = (name: string) => `"${col(name).name}"`
  const lit = (v: string) => {
    if (v.includes('\\')) throw new ExploreRefusal('a value with a backslash cannot be searched for')
    if (v.length > 500) throw new ExploreRefusal('the value is too long to search for')
    return `'${v.replace(/'/g, "''")}'`
  }
  const text = (name: string) => `CAST(${id(name)} AS VARCHAR)`
  const where = (n: Narrowing, extra: string[] = []) => {
    const parts = [...extra]
    const q = (n.q ?? '').trim()
    if (q) parts.push(`(${t.columns.map((c) => `${text(c.name)} ILIKE ${lit(`%${q}%`)}`).join(' OR ')})`)
    for (const f of n.where ?? []) parts.push(f.value === null ? `${id(f.column)} IS NULL` : `${text(f.column)} = ${lit(String(f.value))}`)
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : ''
  }
  return { col, id, text, where, table: t.name }
}

export async function explore(run: Run, t: TableInfo, r: ExploreRequest): Promise<unknown> {
  if (!t.columns.length) throw new ExploreRefusal(`you may read no column of ${t.name}`)
  const s = sqlOf(t)
  const all = t.columns.map((c) => s.id(c.name))

  if (r.op === 'rows') {
    const size = SIZES.includes(Number(r.size)) ? Number(r.size) : 100
    const page = Math.max(1, Math.floor(Number(r.page) || 1))
    const w = s.where(r)
    // No OFFSET in the warehouse: rows are numbered in their order, and a page is a range of those numbers. The order is
    // the chosen column, then every column — so a page is the same page each time it is asked.
    const order = [...(r.sort ? [`${s.id(r.sort)} ${r.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`] : []), ...all.filter((c) => !r.sort || c !== s.id(r.sort))].join(', ')
    const from = (page - 1) * size
    // Unnarrowed, the table's own snapshot counts its rows (when it does): one query fewer.
    const counted = !w && t.rows !== undefined ? { columns: [], rows: [{ sa_total: t.rows }], truncated: false } : null
    const [total, rows] = await Promise.all([
      counted ?? run(`SELECT COUNT(*) AS sa_total FROM ${s.table}${w}`, 1),
      run(`SELECT ${all.join(', ')} FROM (SELECT ${all.join(', ')}, ROW_NUMBER() OVER (ORDER BY ${order}) AS sa_rn FROM ${s.table}${w}) sa_page WHERE sa_rn > ${from} AND sa_rn <= ${from + size} ORDER BY sa_rn`, size),
    ])
    return { total: num(total.rows[0]?.sa_total) ?? 0, page, size, rows: rows.rows }
  }

  if (r.op === 'values') {
    const c = s.text(r.column)
    const got = await run(`SELECT ${c} AS sa_value, COUNT(*) AS sa_rows FROM ${s.table}${s.where(r)} GROUP BY ${c} ORDER BY sa_rows DESC, sa_value LIMIT 50`, 50)
    return { values: got.rows.map((x) => ({ value: str(x.sa_value), rows: num(x.sa_rows) ?? 0 })) }
  }

  if (r.op === 'profile') {
    const parts = ['COUNT(*) AS sa_rows']
    t.columns.forEach((c, i) => {
      const k = kindOf(c.type), q = s.id(c.name)
      parts.push(`COUNT(DISTINCT ${q}) AS sa_d${i}`, `COUNT(${q}) AS sa_c${i}`)
      if (k === 'number') parts.push(`MIN(${q}) AS sa_lo${i}`, `MAX(${q}) AS sa_hi${i}`, `AVG(CAST(${q} AS DOUBLE)) AS sa_mean${i}`,
        `approx_percentile_cont(${q}, 0.25) AS sa_qa${i}`, `approx_percentile_cont(${q}, 0.5) AS sa_qb${i}`, `approx_percentile_cont(${q}, 0.75) AS sa_qc${i}`)
      else if (k === 'bool') parts.push(`SUM(CASE WHEN ${q} THEN 1 ELSE 0 END) AS sa_t${i}`)
      else parts.push(`CAST(MIN(${q}) AS VARCHAR) AS sa_lo${i}`, `CAST(MAX(${q}) AS VARCHAR) AS sa_hi${i}`)
    })
    const x = (await run(`SELECT ${parts.join(', ')} FROM ${s.table}`, 1)).rows[0] ?? {}
    const rows = num(x.sa_rows) ?? 0
    return { rows, columns: t.columns.map((c, i): ColumnProfile => ({
      name: c.name, type: c.type, kind: kindOf(c.type), distinct: num(x[`sa_d${i}`]), nulls: rows - (num(x[`sa_c${i}`]) ?? 0),
      min: str(x[`sa_lo${i}`]), max: str(x[`sa_hi${i}`]), mean: num(x[`sa_mean${i}`]), q1: num(x[`sa_qa${i}`]), median: num(x[`sa_qb${i}`]), q3: num(x[`sa_qc${i}`]), trues: num(x[`sa_t${i}`]),
    })) } satisfies Profile
  }

  if (r.op === 'spread') {
    const c = s.col(r.column), k = kindOf(c.type), q = s.id(c.name)
    const nonNull = s.where(r, [`${q} IS NOT NULL`])
    if (k === 'number') {
      const b = (await run(`SELECT MIN(${q}) AS sa_lo, MAX(${q}) AS sa_hi FROM ${s.table}${nonNull}`, 1)).rows[0] ?? {}
      const lo = num(b.sa_lo), hi = num(b.sa_hi)
      if (lo === null || hi === null) return { kind: 'none' } satisfies Spread
      if (lo === hi) { const n = await run(`SELECT COUNT(*) AS sa_n FROM ${s.table}${nonNull}`, 1); return { kind: 'numbers', lo, hi, bins: [num(n.rows[0]?.sa_n) ?? 0] } satisfies Spread }
      const width = (hi - lo) / BINS
      const got = await run(`SELECT floor((CAST(${q} AS DOUBLE) - (${lo})) / ${width}) AS sa_b, COUNT(*) AS sa_n FROM ${s.table}${nonNull} GROUP BY 1`, BINS + 1)
      const bins = Array.from({ length: BINS }, () => 0)
      for (const g of got.rows) { const i = Math.min(BINS - 1, Math.max(0, num(g.sa_b) ?? 0)); bins[i] += num(g.sa_n) ?? 0 }
      return { kind: 'numbers', lo, hi, bins } satisfies Spread
    }
    if (k === 'time') {
      const b = (await run(`SELECT CAST(MIN(${q}) AS VARCHAR) AS sa_lo, CAST(MAX(${q}) AS VARCHAR) AS sa_hi FROM ${s.table}${nonNull}`, 1)).rows[0] ?? {}
      const lo = Date.parse(String(b.sa_lo ?? '')), hi = Date.parse(String(b.sa_hi ?? ''))
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { kind: 'none' } satisfies Spread
      const unit = hi - lo > 92 * 86_400_000 ? 'month' : 'day'
      const got = await run(`SELECT CAST(date_trunc('${unit}', ${q}) AS VARCHAR) AS sa_at, COUNT(*) AS sa_n FROM ${s.table}${nonNull} GROUP BY 1 ORDER BY 1`, 1000)
      return { kind: 'time', unit, bins: got.rows.map((g) => ({ at: String(g.sa_at ?? '').slice(0, unit === 'month' ? 7 : 10), rows: num(g.sa_n) ?? 0 })) } satisfies Spread
    }
    return { kind: 'none' } satisfies Spread
  }
  throw new ExploreRefusal('the explorer reads rows, values, a profile or a spread')
}
