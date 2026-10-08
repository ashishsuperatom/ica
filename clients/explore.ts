// THE EXPLORER'S READS: a table's rows (searched, filtered, sorted, paged), a column's commonest values, every column
// profiled, a column's spread. The page never sends SQL: it names a table, columns and values, and the SQL is made here
// from names checked against the columns the reader may read — then the backend's own access check reads it again
// before it runs. Nothing here knows the backend: `run` is its checked query. Two use it, one copy: the warehouse (the
// worker; its bridge's query) and a connected source (the engine; the datasource manager's query, which rewrites the
// SQL into the source's dialect and applies the asker's data access).

/** A table as a backend describes it, and a query's result. */
export interface TableInfo { name: string; columns: { name: string; type: string }[]; rows?: number }
export interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }

export interface Filter { column: string; value: string | null }
export interface Narrowing { q?: string; where?: Filter[] }
/** What is explored: a table (by name), or a query's result (its SQL, and its columns once known). */
export interface Source { table?: string; query?: { sql: string; columns?: { name: string; type: string }[] } }
export type ExploreRequest = Source & (
  | ({ op: 'rows'; sort?: string | null; dir?: 'asc' | 'desc'; page?: number; size?: number } & Narrowing)
  | ({ op: 'values'; column: string } & Narrowing)
  | { op: 'profile' }
  | ({ op: 'spread'; column: string } & Narrowing)
  | { op: 'bins'; ranges: Record<string, [number, number]> })

export type Kind = 'number' | 'time' | 'bool' | 'text'
export function kindOf(type: string): Kind {
  if (/^(long|int|integer|double|float|decimal)/.test(type)) return 'number'
  if (/^(date|timestamp|time)/.test(type)) return 'time'
  if (type === 'boolean') return 'bool'
  return 'text'
}

/** A source's own type, as the explorer reads kinds: numbers, times, yes/no, else text. */
export function exploreType(t: string | null): string {
  const x = (t ?? '').toLowerCase().replace(/\(.*\)/, '').trim()
  if (/^(tinyint|smallint|int|integer|bigint|decimal|numeric|number|float\d*|real|double( precision)?|money|smallmoney|currency|serial|bigserial)$/.test(x)) return 'double'
  if (/^(date)$/.test(x)) return 'date'
  if (/^(datetime\w*|timestamp\w*|smalldatetime|time\w*)$/.test(x)) return 'timestamp'
  if (/^(bit|bool|boolean)$/.test(x)) return 'boolean'
  return 'string'
}

/** A table, or a query's result, as the explorer reads it: where its rows come FROM, and its columns. */
export interface Explored { name: string; from: string; columns: { name: string; type: string }[]; rows?: number; order?: string[] }

/** A table as the explorer reads it. */
export const tableSource = (t: TableInfo): Explored => ({ name: t.name, from: t.name, columns: t.columns, rows: t.rows })

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A value's kind, guessed from what a query returned (a query's columns carry no types). */
function typeOfValue(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'bigint') return 'double'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return 'timestamp'
  return 'string'
}

/**
 * A query's result as something to explore: its own SQL in parentheses, its columns (as the caller knows them, or learnt
 * by running it for one row), and its own ORDER BY where that names only its columns — the order its rows are shown in.
 * A column without a plain name (`count(*)`) cannot be searched or profiled: it is left out, and named in `skipped`.
 */
export async function querySource(run: Run, sql: string, known?: { name: string; type: string }[]): Promise<Explored & { skipped: string[] }> {
  const text = sql.trim().replace(/;\s*$/, '')
  if (!text) throw new ExploreRefusal('write a query')
  let columns = known?.filter((c) => IDENT.test(c.name)).map((c) => ({ name: c.name, type: String(c.type) })) ?? null
  let skipped: string[] = []
  if (!columns?.length) {
    const r = await run(text, 1)
    skipped = r.columns.filter((c) => !IDENT.test(c))
    columns = r.columns.filter((c) => IDENT.test(c)).map((c) => ({ name: c, type: typeOfValue(r.rows[0]?.[c]) }))
  }
  if (!columns.length) throw new ExploreRefusal('the query names no column the explorer can read — name each computed column with AS')
  return { name: 'query', from: `(${text}) sa_q`, columns, order: ownOrder(text, columns.map((c) => c.name)), skipped }
}

/** The query's own top-level ORDER BY, when it is only its columns (by name or position) with ASC/DESC. */
function ownOrder(sql: string, names: string[]): string[] | undefined {
  const toks = sql.match(/"[^"]*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_]*|\d+|\S/g) ?? []
  let depth = 0, at = -1
  toks.forEach((t, i) => { if (t === '(') depth++; else if (t === ')') depth--; else if (depth === 0 && t.toLowerCase() === 'order' && toks[i + 1]?.toLowerCase() === 'by') at = i + 2 })
  if (at < 0) return undefined
  const out: string[] = []
  let cur: string | null = null
  for (let i = at; i < toks.length; i++) {
    const t = toks[i], w = t.toLowerCase()
    if (w === 'limit') break
    if (t === ',') { if (!cur) return undefined; out.push(cur); cur = null; continue }
    if (w === 'asc' || w === 'nulls' || w === 'first' || w === 'last') continue
    if (w === 'desc') { if (!cur) return undefined; cur += ' DESC'; continue }
    if (cur) return undefined
    const name = /^\d+$/.test(t) ? names[Number(t) - 1] : t.replace(/^"|"$/g, '')
    if (!name || !names.includes(name)) return undefined
    cur = `"${name}"`
  }
  if (cur) out.push(cur)
  return out.length ? out : undefined
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
function sqlOf(t: Explored) {
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
  return { col, id, text, where, table: t.from }
}

export async function explore(run: Run, t: Explored, r: ExploreRequest): Promise<unknown> {
  if (!t.columns.length) throw new ExploreRefusal(`you may read no column of ${t.name}`)
  const s = sqlOf(t)
  const all = t.columns.map((c) => s.id(c.name))

  if (r.op === 'rows') {
    const size = SIZES.includes(Number(r.size)) ? Number(r.size) : 100
    const page = Math.max(1, Math.floor(Number(r.page) || 1))
    const w = s.where(r)
    // No OFFSET in the warehouse: rows are numbered in their order, and a page is a range of those numbers. The order is
    // the chosen column, then every column — so a page is the same page each time it is asked.
    const first = r.sort ? [`${s.id(r.sort)} ${r.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`] : t.order ?? []
    const order = [...first, ...all.filter((c) => !first.some((f) => f.startsWith(`${c} `) || f === c))].join(', ')
    const from = (page - 1) * size
    // Unnarrowed, the table's own snapshot counts its rows (when it does): one query fewer.
    const counted = !w && t.rows !== undefined ? { columns: [], rows: [{ sa_total: t.rows }], truncated: false } : null
    const [total, rows] = await Promise.all([
      counted ?? run(`SELECT COUNT(*) AS sa_total FROM ${s.table}${w}`, 1),
      run(`SELECT ${all.join(', ')} FROM (SELECT ${all.join(', ')}, ROW_NUMBER() OVER (ORDER BY ${order}) AS sa_rn FROM ${s.table}${w}) sa_page WHERE sa_rn > ${from} AND sa_rn <= ${from + size} ORDER BY sa_rn`, size),
    ])
    return { total: num(total.rows[0]?.sa_total) ?? 0, page, size, rows: rows.rows, columns: t.columns }
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
  if (r.op === 'bins') {
    // Every column's small histogram in one read: twenty bins between the low and high the profile found, counted by
    // conditional sums (numbers as they are; dates and times by their epoch seconds).
    const parts: string[] = [], plan: { name: string; lo: number; w: number; at: number }[] = []
    for (const [name, range] of Object.entries(r.ranges ?? {})) {
      const c = s.col(name), k = kindOf(c.type)
      const lo = Number(range?.[0]), hi = Number(range?.[1])
      if ((k !== 'number' && k !== 'time') || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) continue
      const v = k === 'time' ? `date_part('epoch', ${s.id(name)})` : `CAST(${s.id(name)} AS DOUBLE)`
      const w = (hi - lo) / BINS
      plan.push({ name, lo, w, at: parts.length })
      for (let b = 0; b < BINS; b++) parts.push(`SUM(CASE WHEN ${b === BINS - 1 ? `${v} >= ${lo + b * w}` : `${v} >= ${lo + b * w} AND ${v} < ${lo + (b + 1) * w}`} THEN 1 ELSE 0 END) AS sa_b${parts.length}`)
    }
    if (!parts.length) return { bins: {} }
    const x = (await run(`SELECT ${parts.join(', ')} FROM ${s.table}`, 1)).rows[0] ?? {}
    return { bins: Object.fromEntries(plan.map((p) => [p.name, Array.from({ length: BINS }, (_, b) => num(x[`sa_b${p.at + b}`]) ?? 0)])) }
  }
  throw new ExploreRefusal('the explorer reads rows, values, a profile, a spread or bins')
}
