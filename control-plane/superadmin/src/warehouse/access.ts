// WHAT A PROJECT MAY READ: an organisation's warehouse is one; a project is granted tables, and within a table perhaps
// only some columns. A query is checked before it runs, and the check fails closed: every name in it must be a granted
// table, a granted column of one, an alias the query itself defines, or SQL's own vocabulary. Anything else — a table
// not granted, a column held back, a `*` over a table whose columns are limited, a quoted name it cannot place — and
// the query is refused, with the name. Then the plain table names are put in the organisation's namespace.

import type { TableInfo } from './bridge'

/** Tables a project may read: each with the columns it may read, or null for all of them. */
export type Grant = Record<string, string[] | null>

const KEYWORDS = new Set(`select from where and or not in is null as on join inner left right full outer cross group by order having limit
  asc desc distinct union all intersect except case when then else end with between like ilike exists true false over partition rows range
  preceding following unbounded current row filter within nulls first last interval cast try_cast using natural lateral any some
  date timestamp time year month day hour minute second extract epoch values offset fetch only recursive escape similar to at zone
  int integer bigint smallint double float real decimal numeric varchar char text string boolean bool`.split(/\s+/).filter(Boolean))

export interface Checked { sql: string; tables: string[] }

/** Tokens of a query: words (bare or quoted), strings, numbers, punctuation. Comments are refused (nothing hides). */
function tokens(sql: string): { kind: 'word' | 'quoted' | 'string' | 'other'; text: string; at: number }[] {
  const out: { kind: 'word' | 'quoted' | 'string' | 'other'; text: string; at: number }[] = []
  for (let i = 0; i < sql.length;) {
    const c = sql[i]
    if (/\s/.test(c)) { i++; continue }
    if (sql.startsWith('--', i) || sql.startsWith('/*', i)) throw new Error('comments are not allowed in a warehouse query')
    if (c === "'") { let j = i + 1; while (j < sql.length) { if (sql[j] === "'" && sql[j + 1] === "'") j += 2; else if (sql[j] === "'") break; else j++ } out.push({ kind: 'string', text: sql.slice(i, j + 1), at: i }); i = j + 1; continue }
    if (c === '"' || c === '`') { const j = sql.indexOf(c, i + 1); if (j < 0) throw new Error('a quoted name is not closed'); out.push({ kind: 'quoted', text: sql.slice(i + 1, j), at: i }); i = j + 1; continue }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++; out.push({ kind: 'word', text: sql.slice(i, j), at: i }); i = j; continue }
    if (/[0-9]/.test(c)) { let j = i; while (j < sql.length && /[0-9.eE]/.test(sql[j])) j++; out.push({ kind: 'other', text: sql.slice(i, j), at: i }); i = j; continue }
    out.push({ kind: 'other', text: c, at: i }); i++
  }
  return out
}

/**
 * Check a query against what may be read and place its tables in the namespace. `grant` null means everything in the
 * organisation (an organisation administrator). Throws with the reason; returns the query to run.
 */
export function checkQuery(sql: string, schemas: TableInfo[], grant: Grant | null, namespace: string): Checked {
  const text = sql.trim().replace(/;\s*$/, '')
  if (text.includes(';')) throw new Error('one statement at a time')
  const toks = tokens(text)
  const first = toks.find((t) => t.kind === 'word')?.text.toLowerCase()
  if (first !== 'select' && first !== 'with') throw new Error('the warehouse answers SELECT queries only')
  const tables = new Map(schemas.map((t) => [t.name.toLowerCase(), t]))
  const allowedTable = (n: string) => tables.has(n) && (grant === null || n in grant)
  const columnsOf = (n: string): Set<string> => { const t = tables.get(n)!; const g = grant?.[n]; return new Set((g ?? t.columns.map((c) => c.name)).map((c) => c.toLowerCase())) }
  const words = toks.filter((t) => t.kind === 'word' || t.kind === 'quoted')

  // Aliases and CTE names the query defines: `AS x`, `x AS (` (a CTE), and a bare name after a table or a closing paren.
  const defined = new Set<string>()
  toks.forEach((t, k) => {
    const prev = toks[k - 1], next = toks[k + 1]
    if ((t.kind === 'word' || t.kind === 'quoted') && prev?.kind === 'word' && prev.text.toLowerCase() === 'as') defined.add(t.text.toLowerCase())
    if (t.kind === 'word' && next?.kind === 'word' && next.text.toLowerCase() === 'as' && toks[k + 2]?.text === '(') defined.add(t.text.toLowerCase())
  })
  const used: string[] = []
  // Table positions: the name after FROM or JOIN (and after a comma in a FROM list).
  let inFrom = false
  toks.forEach((t, k) => {
    const w = t.text.toLowerCase()
    if (t.kind === 'word' && (w === 'from' || w === 'join')) { inFrom = true; return }
    if (t.kind === 'word' && ['where', 'group', 'order', 'having', 'limit', 'on', 'union', 'intersect', 'except', 'select', 'using'].includes(w)) inFrom = false
    if (!inFrom || (t.kind !== 'word' && t.kind !== 'quoted')) return
    const prev = toks[k - 1]
    const afterTableSlot = prev && (prev.text === ',' || (prev.kind === 'word' && ['from', 'join'].includes(prev.text.toLowerCase())))
    if (!afterTableSlot) { if (prev && (prev.kind === 'word' || prev.kind === 'quoted' || prev.text === ')')) defined.add(w); return }
    if (toks[k + 1]?.text === '.') throw new Error(`name tables plainly ("${toks[k + 2]?.text ?? ''}"), not with a namespace`)
    if (defined.has(w)) return   // a CTE
    if (!tables.has(w)) throw new Error(`there is no table "${t.text}" in this warehouse`)
    if (!allowedTable(w)) throw new Error(`this project may not read the table "${t.text}"`)
    used.push(w)
  })
  if (!used.length && !defined.size) throw new Error('the query reads no table')

  // Every other name must be a column this query may read, an alias it made, a function call, or SQL's own word.
  const readable = new Set<string>(); for (const u of used) for (const c of columnsOf(u)) readable.add(c)
  const limited = used.some((u) => grant !== null && grant[u] !== null)
  toks.forEach((t, k) => {
    if (t.text === '*' && limited) {
      const prev = toks[k - 1]
      const isCount = prev?.text === '(' && toks[k - 2]?.text.toLowerCase() === 'count'
      if (!isCount) throw new Error('select the columns by name: this project may read only some columns of a table it uses')
    }
  })
  for (const t of words) {
    const w = t.text.toLowerCase()
    const k = toks.indexOf(t)
    if (t.kind === 'word' && KEYWORDS.has(w)) continue
    if (t.kind === 'word' && toks[k + 1]?.text === '(') continue          // a function
    if (used.includes(w) || defined.has(w)) continue                      // a table, a CTE, an alias
    if (readable.has(w)) continue
    if (toks[k - 1]?.text === '.' && readable.has(w)) continue
    const isColumnSomewhere = schemas.some((s) => s.columns.some((c) => c.name.toLowerCase() === w))
    throw new Error(isColumnSomewhere ? `this project may not read the column "${t.text}"` : `"${t.text}" is not a table or column this query may read`)
  }

  // Place the tables: each table slot gets the organisation's namespace.
  let out = '', last = 0
  inFrom = false
  toks.forEach((t, k) => {
    const w = t.text.toLowerCase()
    if (t.kind === 'word' && (w === 'from' || w === 'join')) { inFrom = true; return }
    if (t.kind === 'word' && ['where', 'group', 'order', 'having', 'limit', 'on', 'union', 'intersect', 'except', 'select', 'using'].includes(w)) inFrom = false
    const prev = toks[k - 1]
    if (inFrom && (t.kind === 'word' || t.kind === 'quoted') && used.includes(w) && !defined.has(w) && prev && (prev.text === ',' || ['from', 'join'].includes(prev.text.toLowerCase()))) {
      const len = t.kind === 'quoted' ? t.text.length + 2 : t.text.length
      out += text.slice(last, t.at) + `${namespace}.${w}`; last = t.at + len
    }
  })
  out += text.slice(last)
  return { sql: out, tables: [...new Set(used)] }
}

/** A grant as it is kept and shown: only tables that exist, only columns the table has. */
export function cleanGrant(grant: Grant, schemas: TableInfo[]): Grant {
  const out: Grant = {}
  for (const [t, cols] of Object.entries(grant)) {
    const s = schemas.find((x) => x.name === t); if (!s) continue
    out[t] = cols === null ? null : cols.filter((c) => s.columns.some((x) => x.name === c))
  }
  return out
}
