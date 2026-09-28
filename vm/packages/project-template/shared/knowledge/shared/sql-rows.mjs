// A program's rule as one query the source runs. The program names its columns once, each a SQL expression over the
// source's tables; the source then filters, groups, counts, sums and pages on those names. What leaves the source is
// totals and one page of rows — never the whole table.
//
//   node <program> [args] --totals <col,col>  [--where …]         → { rows: [{ <col>…, count, <sum>… }] }
//        --distinct col adds distinct_<col>, how many different values each group holds; --max col adds max_<col>,
//        --min col min_<col>; --ratio rate=amount/tonnes a group's SUM(amount) ÷ SUM(tonnes); --pivot year_code=24,25 every sum
//        and the count per value side by side (amount_24, amount_25), with two values their change (amount_change);
//        --having 'count>=20' keeps the groups whose output meets it; --page n with --order
//        pages the groups themselves → { total, page, size, rows }
//   node <program> [args] --page <n> [--size 100] [--order col,-col] [--where …]   → { total, page, size, rows }
//   node <program> [args] --where …                                → every row, for an export
//   node <program> [args] --columns                                 → { columns: { name: type } }; --help says what it is
//
// --where, repeatable: col=a,b (one of) · col!=a,b (none of) · col= (not recorded) · col!= (recorded) ·
// col>=v · col<=v · col>v · col<v. Values are bound, never pasted; a column that is not the program's is refused.

import { query } from './data/query.mjs'
import { readFileSync } from 'node:fs'

export const PAGE_SIZE = 100

/** Read --totals, --page, --size, --order and --where from the command line, leaving the program's own arguments. */
export function readArgs(argv) {
  const own = [], o = { where: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--totals') o.totals = String(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--max') o.max = String(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--min') o.min = String(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--ratio') (o.ratio ??= []).push(parseRatio(String(argv[++i] ?? '')))
    else if (a === '--pivot') o.pivot = parsePivot(String(argv[++i] ?? ''))
    else if (a === '--having') (o.having ??= []).push(parseWhere(String(argv[++i] ?? '')))
    else if (a === '--help' || a === '-h') o.help = true
    else if (a === '--all') o.all = true
    else if (a === '--columns') o.columns = true
    else if (a === '--distinct') o.distinct = String(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--page') o.page = Number(argv[++i])
    else if (a === '--size') o.size = Number(argv[++i])
    else if (a === '--order') o.order = String(argv[++i] ?? '')
    else if (a === '--where') o.where.push(parseWhere(String(argv[++i] ?? '')))
    else own.push(a)
  }
  return { own, options: o }
}

/** --ratio name=num/den: a group's SUM(num) ÷ SUM(den). */
function parseRatio(text) {
  const m = text.match(/^([a-z_][a-z0-9_]*)\s*=\s*([a-z_][a-z0-9_]*)\s*\/\s*([a-z_][a-z0-9_]*)$/i)
  if (!m) throw new Error(`--ratio "${text}": write name=column/column`)
  return { name: m[1], num: m[2], den: m[3] }
}
/** --pivot col=a,b: every sum and the count once per value of col, side by side (amount_24, amount_25, count_24 …);
 *  with two values, the change from the first to the second (amount_change, count_change). */
function parsePivot(text) {
  const m = text.match(/^([a-z_][a-z0-9_]*)\s*=\s*(.+)$/i)
  if (!m) throw new Error(`--pivot "${text}": write column=value,value`)
  return { column: m[1], values: m[2].split(',').map((x) => x.trim()).filter(Boolean) }
}

function parseWhere(text) {
  const m = text.match(/^([a-z_][a-z0-9_]*)\s*(!=|>=|<=|=|>|<)\s*(.*)$/i)
  if (!m) throw new Error(`--where "${text}": write column=value, column!=value, column>=value …`)
  const [, column, op, rest] = m
  const values = rest === '' ? [] : ['=', '!='].includes(op) ? rest.split(',').map((x) => x.trim()) : [rest.trim()]
  return { column, op, values }
}

/**
 * The rule as rows. `columns`: name → { sql, type: 'text' | 'number' | 'bool' } (a bool's SQL gives 'T' or 'F').
 * `source`: the data source it runs in. `from`: the FROM clause with its joins and fixed WHERE. `sums`: the number
 * columns totals add up.
 */
export function sqlRows({ source, columns, from, sums = [], order = 'id' }) {
  if (!source) throw new Error('sqlRows needs the source it runs in')
  const SOURCE = source
  const names = new Set(Object.keys(columns))
  const known = (c) => { if (!names.has(c)) throw new Error(`there is no column "${c}"; the columns are ${[...names].join(', ')}`); return c }
  const inner = `SELECT ${Object.entries(columns).map(([n, c]) => `${c.sql} AS ${n}`).join(', ')} ${from}`
  const clause = (where) => {
    const params = {}, parts = []
    where.forEach((w, i) => {
      const c = known(w.column)
      const bind = (v, j) => { const k = `w${i}_${j}`; params[k] = columns[c].type === 'number' ? Number(v) : columns[c].type === 'bool' ? (/^(t|true|yes|1)$/i.test(v) ? 'T' : 'F') : v; return `@${k}` }
      if (w.op === '=' && !w.values.length) parts.push(`r.${c} IS NULL`)
      else if (w.op === '!=' && !w.values.length) parts.push(`r.${c} IS NOT NULL`)
      else if (w.op === '=') parts.push(`r.${c} IN (${w.values.map(bind).join(', ')})`)
      else if (w.op === '!=') parts.push(`(r.${c} IS NULL OR r.${c} NOT IN (${w.values.map(bind).join(', ')}))`)
      else parts.push(`r.${c} ${w.op} ${bind(w.values[0], 0)}`)
    })
    return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params }
  }
  const typed = (row) => {
    const out = {}
    for (const [n, c] of Object.entries(columns)) {
      const v = row[n]
      out[n] = v == null ? null : c.type === 'number' ? Number(v) : c.type === 'bool' ? v === 'T' : v
    }
    return out
  }
  // One column or several, comma-separated, each with "-" for largest first; the key breaks ties, so a page is stable.
  // A column is named once: some sources refuse the same column twice in an ORDER BY.
  const orderBy = (o) => { const cols = String(o).split(',').filter(Boolean).map((x) => ({ desc: x.startsWith('-'), c: known(x.replace(/^-/, '')) })); return [...cols.map(({ c, desc }) => `r.${c} ${desc ? 'DESC' : 'ASC'} NULLS LAST`), ...(cols.some((x) => x.c === order) ? [] : [`r.${order}`])].join(', ') }
  return {
    /** The columns a row has, by name and type. */
    columns: Object.fromEntries(Object.entries(columns).map(([n, c]) => [n, c.type])),
    /** Counts and sums by the columns named, computed by the source. */
    async totals(by, where = [], { distinct = [], max = [], min = [], ratio = [], pivot, having = [], page, order: o, size = PAGE_SIZE } = {}) {
      by.forEach(known); distinct.forEach(known); max.forEach(known); min.forEach(known)
      for (const x of ratio) { known(x.num); known(x.den) }
      if (pivot) known(pivot.column)
      const w = clause(where)
      // Every output of a group: its columns, count, sums, distinct counts, largest and smallest, ratios, and a pivot's.
      const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      const pv = (pivot?.values ?? []).map((v, i) => ({ v, key: slug(v), param: `pv${i}` }))
      const pivotParams = Object.fromEntries(pv.map((x) => [x.param, columns[pivot.column].type === 'number' ? Number(x.v) : x.v]))
      const out = [
        ...by.map((c) => [c, `r.${c}`, c]), ['count', 'COUNT(*)', 'number'], ...sums.map((s) => [s, `SUM(r.${s})`, 'number']),
        ...distinct.map((d) => [`distinct_${d}`, `COUNT(DISTINCT r.${d})`, 'number']), ...max.map((m) => [`max_${m}`, `MAX(r.${m})`, m]), ...min.map((m) => [`min_${m}`, `MIN(r.${m})`, m]),
        ...ratio.map((x) => [x.name, `CAST(SUM(r.${x.num}) AS float) / NULLIF(SUM(r.${x.den}), 0)`, 'number']),
        ...pv.flatMap((x) => [[`count_${x.key}`, `SUM(CASE WHEN r.${pivot.column} = @${x.param} THEN 1 ELSE 0 END)`, 'number'], ...sums.map((s) => [`${s}_${x.key}`, `SUM(CASE WHEN r.${pivot.column} = @${x.param} THEN r.${s} END)`, 'number'])]),
        ...(pv.length === 2 ? [['count_change', `SUM(CASE WHEN r.${pivot.column} = @${pv[1].param} THEN 1 ELSE 0 END) - SUM(CASE WHEN r.${pivot.column} = @${pv[0].param} THEN 1 ELSE 0 END)`, 'number'],
          ...sums.map((s) => [`${s}_change`, `COALESCE(SUM(CASE WHEN r.${pivot.column} = @${pv[1].param} THEN r.${s} END), 0) - COALESCE(SUM(CASE WHEN r.${pivot.column} = @${pv[0].param} THEN r.${s} END), 0)`, 'number'])] : []),
      ]
      const outs = new Map(out.map(([n, , t]) => [n, t]))
      const grouped = `SELECT ${out.map(([n, sql]) => `${sql} AS ${n}`).join(', ')} FROM (${inner}) r${w.sql}${by.length ? ` GROUP BY ${by.map((c) => `r.${c}`).join(', ')}` : ''}`
      // Conditions on a group's outputs (--having), as --where is on rows.
      const params = { ...w.params, ...pivotParams }
      const hv = having.map((h, i) => {
        if (!outs.has(h.column)) throw new Error(`--having takes a group's outputs: ${[...outs.keys()].join(', ')}`)
        const bind = (v, j) => { const k = `h${i}_${j}`; params[k] = outs.get(h.column) === 'number' || columns[outs.get(h.column)]?.type === 'number' ? Number(v) : v; return `@${k}` }
        if (h.op === '=' && !h.values.length) return `g.${h.column} IS NULL`
        if (h.op === '!=' && !h.values.length) return `g.${h.column} IS NOT NULL`
        if (h.op === '=') return `g.${h.column} IN (${h.values.map(bind).join(', ')})`
        if (h.op === '!=') return `(g.${h.column} IS NULL OR g.${h.column} NOT IN (${h.values.map(bind).join(', ')}))`
        return `g.${h.column} ${h.op} ${bind(h.values[0], 0)}`
      })
      const kept = `SELECT g.* FROM (${grouped}) g${hv.length ? ` WHERE ${hv.join(' AND ')}` : ''}`
      const shape = (r) => Object.fromEntries(out.map(([n, , t]) => [n, r[n] == null ? null : t === 'number' ? Number(r[n]) : columns[t] ? typed({ [t]: r[n] })[t] : r[n]]))
      if (page) {
        const ord = String(o ?? '-count').split(',').filter(Boolean).map((x) => { const desc = x.startsWith('-'); const c = desc ? x.slice(1) : x; if (!outs.has(c)) throw new Error(`groups are ordered by ${[...outs.keys()].join(', ')}`); return `k.${c} ${desc ? 'DESC' : 'ASC'} NULLS LAST` })
        const [n] = await query(SOURCE, `SELECT COUNT(*) AS n FROM (${kept}) k`, params)
        const rows = await query(SOURCE, `SELECT k.* FROM (${kept}) k ORDER BY ${[...ord, ...by.filter((c) => !ord.some((x) => x.startsWith(`k.${c} `))).map((c) => `k.${c}`)].join(', ')} OFFSET ${(Math.max(1, page) - 1) * size} ROWS FETCH NEXT ${size} ROWS ONLY`, params)
        return { total: Number(n.n), page: Math.max(1, page), size, rows: rows.map(shape) }
      }
      const rows = await query(SOURCE, kept, params)
      if (rows.cappedTo) throw new Error('there are more groups than one read can hold: group by fewer columns, or ask for a page of them')
      return rows.map(shape)
    },
    /** One page of rows, in the order asked, with how many rows there are in all. */
    async page(n = 1, { where = [], order: o = order, size = PAGE_SIZE, total } = {}) {
      const w = clause(where)
      const [count] = total != null ? [{ n: total }] : await query(SOURCE, `SELECT COUNT(*) AS n FROM (${inner}) r${w.sql}`, w.params)
      const rows = await query(SOURCE, `SELECT r.* FROM (${inner}) r${w.sql} ORDER BY ${orderBy(o)} OFFSET ${(Math.max(1, n) - 1) * size} ROWS FETCH NEXT ${size} ROWS ONLY`, w.params)
      return { total: Number(count.n), page: Math.max(1, n), size, rows: rows.map(typed) }
    },
    /** Every row, for an export: read by the key column in steps of 4,000 (a key step never rescans the rows before it). */
    async all(where = []) {
      const w = clause(where)
      const out = []
      for (let after = null; ;) {
        const step = await query(SOURCE, `SELECT r.* FROM (${inner}) r${w.sql ? `${w.sql} AND` : ' WHERE'} ${after == null ? '1 = 1' : `r.${order} > @after__`} ORDER BY r.${order} FETCH FIRST 4000 ROWS ONLY`, { ...w.params, ...(after == null ? {} : { after__: after }) })
        out.push(...step.map(typed))
        if (step.length < 4000) return out
        after = step.at(-1)[order]   // a number or a text key: compared as the source compares it
      }
    },
  }
}

/** The program's own description: the comment it opens with, as its --help. */
function usage() {
  try {
    const lines = readFileSync(process.argv[1], 'utf8').split('\n')
    const head = []
    for (const l of lines) { if (!l.startsWith('//')) break; head.push(l.replace(/^\/\/ ?/, '')) }
    return head.join('\n').trim()
  } catch { return '' }
}

/** Run a program's rows from the command line: totals, a page, or every row. `--help` prints what the program is and
 *  how to ask it. A program whose rows are many (`{ exportAll: false }`) answers a call with neither totals nor a page
 *  with that help instead of every row: its export is asked for by name, with --all. */
export async function serve(rows, options, { exportAll = true } = {}) {
  if (options.help) { console.log(usage()); return }
  if (options.columns) { console.log(JSON.stringify({ columns: rows.columns })); return }
  if (!options.totals && !options.page && !exportAll && !options.all) { console.error(`${usage()}\n\nAsk for --totals or --page (every row only with --all).`); process.exitCode = 2; return }
  if (options.totals) {
    const got = await rows.totals(options.totals, options.where, { distinct: options.distinct ?? [], max: options.max ?? [], min: options.min ?? [], ratio: options.ratio ?? [], pivot: options.pivot, having: options.having ?? [], ...(options.page ? { page: options.page, order: options.order, ...(options.size ? { size: options.size } : {}) } : {}) })
    return console.log(JSON.stringify(Array.isArray(got) ? { rows: got } : got))
  }
  if (options.page) return console.log(JSON.stringify(await rows.page(options.page, { where: options.where, ...(options.order ? { order: options.order } : {}), ...(options.size ? { size: options.size } : {}) })))
  console.log(JSON.stringify(await rows.all(options.where)))
}
