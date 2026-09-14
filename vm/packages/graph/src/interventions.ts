// ── INTERVENTIONS ON A RELATION'S ROWS ────────────────────────────────────────────────────────────────────
//
// Rows left out, rows added — as SQL around the relation's own SQL, so every relation built on it and every
// coordinate asked of it sees the changed rows. A program's value is replaced where it is called (engine.ts).

import { conditionSql, sqlFor, type Dialect, type ResolvedStatement, type When } from './coordinates.js'
import { LOCAL, type Intervention } from './runtime.js'
import { isDerived, type Shape } from './shape.js'

export function intervened(dialects: Record<string, Dialect>, st: ResolvedStatement, shape: Shape, name: string,
                           iv: Intervention, when: When): ResolvedStatement {
  if ('value' in iv) throw new Error(`"${name}" is a relation; intervene on its rows with where or add, not value`)
  const dialect = dialects[st.source] ?? (st.source === LOCAL ? 'sqlite' : 'oracle')
  const s = sqlFor(dialect)
  const params = { ...st.params }
  let n = 0
  const bindName = (v: unknown) => {
    const p = `i_${n++}`
    if (p in st.params) throw new Error(`the relation's parameter "${p}" uses the prefix interventions use`)
    params[p] = v
    return p
  }
  const bind = (v: unknown) => `@${bindName(v)}`
  // A member of a dimension is compared as text everywhere in the engine, so identities and labels are text here
  // too — an added person's id need not be the same type as the source's ids, which SQL would refuse.
  const textual = new Set(Object.values(shape.dimensions).flatMap((d) => [d.column, ...(d.label ? [d.label] : [])]))
  const numeric = new Set(Object.values(shape.measures).flatMap((m) => (!isDerived(m) && m.column ? [m.column] : [])))
  const columns = [...new Set([...textual, ...numeric, ...(shape.time ? [shape.time] : [])])]
  const select = columns.map((c) => textual.has(c) && !numeric.has(c) ? `${s.text(`i.${c}`)} AS ${c}` : `i.${c}`)
  let sql = `SELECT ${select.join(', ')}\nFROM (\n${st.sql.trim()}\n) i`
  if (iv.where) {
    const conds = Object.entries(iv.where).flatMap(([d, cond]) => {
      const dim = shape.dimensions[d]
      if (!dim) throw new Error(`cannot intervene on "${d}" in "${name}" — it is not one of its dimensions`)
      return conditionSql(`i.${dim.column}`, cond, d, bind)
    })
    sql += `\nWHERE ${conds.map((c) => `NOT (${c})`).join('\n  AND ')}`
  }
  const asAt = 'asAt' in when ? when.asAt : null
  const added = (iv.add ?? []).filter((a) => asAt == null || ((a.from ?? '') <= asAt && (!a.to || asAt < a.to)))
  for (const a of added) {
    for (const k of Object.keys(a.row)) if (!columns.includes(k)) throw new Error(`an added row of "${name}" has "${k}", which is not a column its shape names`)
    const literal = columns.map((c) => {
      const v = a.row[c]
      if (v == null) return `NULL AS ${c}`
      if (c === shape.time) return `${s.date(bindName(v))} AS ${c}`
      if (numeric.has(c)) return `${bind(Number(v))} AS ${c}`
      return `${s.text(bind(String(v)))} AS ${c}`
    })
    sql += `\nUNION ALL\nSELECT ${literal.join(', ')}${dialect === 'oracle' ? ' FROM dual' : ''}`
  }
  return { ...st, sql, params }
}
