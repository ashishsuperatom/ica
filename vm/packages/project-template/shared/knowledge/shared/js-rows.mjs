// A program's rows when its rule is computed here rather than in the source — a rule over dated histories that a
// query cannot hold. It answers the same way as a rule the source runs (sql-rows.mjs): totals, or one page of at most
// 100 rows in an order, under the same conditions. What leaves the program is never the whole row set.
//
//   --totals col,col · --page n [--size 100] [--order col,-col] · --where 'col=a,b' … — as in sql-rows.mjs

import { PAGE_SIZE } from './sql-rows.mjs'

/** `columns`: name → 'text' | 'number' | 'bool'. `sums`: the number columns totals add up. `key`: breaks order ties. */
export function jsRows(rows, { columns, sums = [], key = 'id' }) {
  // A yes/no column may hold true/false or 'T'/'F' as the source spells it: both read the same.
  const truthy = (x) => x === true || /^(t|true|yes|1)$/i.test(String(x ?? ''))
  const known = (c) => { if (!(c in columns)) throw new Error(`there is no column "${c}"; the columns are ${Object.keys(columns).join(', ')}`); return c }
  const value = (c, v) => (columns[c] === 'number' ? Number(v) : columns[c] === 'bool' ? /^(t|true|yes|1)$/i.test(v) : String(v))
  const test = (w) => {
    const c = known(w.column), vals = w.values.map((v) => value(c, v))
    const is = (x) => x != null && (Array.isArray(x) ? x.some((y) => vals.includes(columns[c] === 'number' ? Number(y) : String(y))) : columns[c] === 'bool' ? vals.includes(truthy(x)) : vals.includes(columns[c] === 'number' ? Number(x) : String(x)))
    if (w.op === '=' && !vals.length) return (r) => r[c] == null
    if (w.op === '!=' && !vals.length) return (r) => r[c] != null
    if (w.op === '=') return (r) => is(r[c])
    if (w.op === '!=') return (r) => !is(r[c])
    const v = vals[0]
    return { '>': (r) => r[c] != null && r[c] > v, '<': (r) => r[c] != null && r[c] < v, '>=': (r) => r[c] != null && r[c] >= v, '<=': (r) => r[c] != null && r[c] <= v }[w.op]
  }
  const kept = (where) => { const ts = where.map(test); return rows.filter((r) => ts.every((t) => t(r))) }
  const compare = (o) => {
    const parts = [...String(o).split(',').filter(Boolean).map((x) => ({ desc: x.startsWith('-'), c: known(x.replace(/^-/, '')) })), { desc: false, c: key }]
    return (a, b) => { for (const { desc, c } of parts) { const x = a[c], y = b[c]; if (x === y) continue; if (x == null) return 1; if (y == null) return -1; const d = x < y ? -1 : 1; return desc ? -d : d } return 0 }
  }
  return {
    /** The columns a row has, by name and type. */
    columns,
    async totals(by, where = [], { distinct = [], max = [], page, order, size = PAGE_SIZE } = {}) {
      by.forEach(known); distinct.forEach(known); max.forEach(known)
      const groups = new Map(), seen = new Map()
      for (const r of kept(where)) {
        const k = JSON.stringify(by.map((c) => r[c] ?? null))
        const g = groups.get(k) ?? groups.set(k, { ...Object.fromEntries(by.map((c) => [c, r[c] ?? null])), count: 0, ...Object.fromEntries(sums.map((s) => [s, null])), ...Object.fromEntries(distinct.map((d) => [`distinct_${d}`, 0])), ...Object.fromEntries(max.map((m) => [`max_${m}`, null])) }).get(k)
        g.count++
        for (const s of sums) if (r[s] != null) g[s] = (g[s] ?? 0) + r[s]
        for (const m of max) if (r[m] != null && (g[`max_${m}`] == null || r[m] > g[`max_${m}`])) g[`max_${m}`] = r[m]
        for (const d of distinct) { if (r[d] == null) continue; const sk = `${k}|${d}`; const set = seen.get(sk) ?? seen.set(sk, new Set()).get(sk); if (!set.has(r[d])) { set.add(r[d]); g[`distinct_${d}`]++ } }
      }
      const all = [...groups.values()]
      if (!page) return all
      const outs = new Set([...by, 'count', ...sums, ...distinct.map((d) => `distinct_${d}`), ...max.map((m) => `max_${m}`)])
      const parts = String(order ?? '-count').split(',').filter(Boolean).map((x) => { const desc = x.startsWith('-'); const c = desc ? x.slice(1) : x; if (!outs.has(c)) throw new Error(`groups are ordered by ${[...outs].join(', ')}`); return { desc, c } })
      all.sort((a, b) => { for (const { desc, c } of parts) { const x = a[c], y = b[c]; if (x === y) continue; if (x == null) return 1; if (y == null) return -1; const d = x < y ? -1 : 1; return desc ? -d : d } return 0 })
      const p = Math.max(1, page)
      return { total: all.length, page: p, size, rows: all.slice((p - 1) * size, p * size) }
    },
    async page(n = 1, { where = [], order = key, size = PAGE_SIZE } = {}) {
      const all = kept(where).sort(compare(order))
      const p = Math.max(1, n)
      return { total: all.length, page: p, size, rows: all.slice((p - 1) * size, p * size) }
    },
    async all(where = []) { return kept(where).sort(compare(key)) },
  }
}
