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
  for both leading trailing placing quarter week dow doy
  int integer bigint smallint double float real decimal numeric varchar char text string boolean bool`.split(/\s+/).filter(Boolean))

export interface Checked { sql: string; tables: string[] }

/** Tokens of a query: words (bare or quoted), strings, numbers, punctuation. Comments are refused (nothing hides). */
function tokens(sql: string): { kind: 'word' | 'quoted' | 'string' | 'other'; text: string; at: number }[] {
  const out: { kind: 'word' | 'quoted' | 'string' | 'other'; text: string; at: number }[] = []
  for (let i = 0; i < sql.length;) {
    const c = sql[i]
    if (/\s/.test(c)) { i++; continue }
    if (sql.startsWith('--', i) || sql.startsWith('/*', i)) throw new Error('comments are not allowed in a warehouse query')
    if (c === "'" && /[eEbBxXuU]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? '')) throw new Error('escaped string literals (E\'…\') are not allowed in a warehouse query')
    if (c === "'") { let j = i + 1; while (j < sql.length) { if (sql[j] === "'" && sql[j + 1] === "'") j += 2; else if (sql[j] === "'") break; else j++ } const lit = sql.slice(i, j + 1); if (lit.includes('\\')) throw new Error('a backslash in a string is not allowed in a warehouse query'); out.push({ kind: 'string', text: lit, at: i }); i = j + 1; continue }
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

  const allColumns = new Set(schemas.flatMap((t) => t.columns.map((c) => c.name.toLowerCase())))
  const isName = (t?: { kind: string }) => !!t && (t.kind === 'word' || t.kind === 'quoted')
  const lower = (t: { text: string }) => t.text.toLowerCase()
  const ENDS_FROM = ['where', 'group', 'order', 'having', 'limit', 'on', 'union', 'intersect', 'except', 'select', 'using', 'window', 'qualify']

  // Each kind of name, kept apart — none excuses another:
  //   ctes         `WITH name AS (` and `, name AS (`; never the name of a real table
  //   tableAliases the name after a table (or a subquery) in FROM, with or without AS; never a column's or a table's name
  //   outAliases   `expr AS name` in a select list; never a column's or a table's name (so WHERE cannot mean the column)
  //   definitions  the token that defines a name (skipped when checking references)
  const ctes = new Set<string>(), tableAliases = new Set<string>(), outAliases = new Set<string>(), definitions = new Set<number>()
  const refuseName = (n: string, what: string) => {
    if (tables.has(n)) throw new Error(`${what} "${n}" is the name of a table; call it something else`)
    if (allColumns.has(n)) throw new Error(`${what} "${n}" is the name of a column; call it something else`)
  }
  toks.forEach((t, k) => {
    const prev = toks[k - 1], next = toks[k + 1]
    if (isName(t) && next && lower(next) === 'as' && toks[k + 2]?.text === '(' && prev && (lower(prev) === 'with' || lower(prev) === 'recursive' || prev.text === ',')) {
      const n = lower(t); if (tables.has(n)) throw new Error(`the query names a CTE "${n}" like a table; call it something else`)
      ctes.add(n); definitions.add(k)
    }
  })
  const used: string[] = []
  // Whether we are in a FROM is kept per parenthesis: a subquery has its own, and after its `)` the outer one goes on
  // (so `FROM (SELECT … WHERE …) s` knows `s` is the subquery's alias).
  let inFrom = false
  // …and whether a parenthesis is a query at all: only one that opens with SELECT or WITH has a FROM of tables. The FROM
  // of a function's own grammar — extract(year FROM d), substring(s FROM 2), trim(x FROM s) — names no table.
  let outer: { inFrom: boolean; query: boolean }[] = []
  let query = true
  const paren = (t: { text: string }, k: number) => {
    if (t.text === '(') { outer.push({ inFrom, query }); inFrom = false; query = ['select', 'with'].includes(toks[k + 1]?.text.toLowerCase() ?? ''); return true }
    if (t.text === ')') { const o = outer.pop(); inFrom = o?.inFrom ?? false; query = o?.query ?? true }
    return false
  }
  toks.forEach((t, k) => {
    const w = lower(t)
    if (paren(t, k)) return
    if (t.kind === 'word' && (w === 'from' || w === 'join') && query) { inFrom = true; return }
    if (t.kind === 'word' && ENDS_FROM.includes(w)) inFrom = false
    if (!isName(t)) return
    const prev = toks[k - 1]
    if (definitions.has(k)) return
    if (inFrom) {
      const slot = prev && (prev.text === ',' || (prev.kind === 'word' && ['from', 'join'].includes(lower(prev))))
      if (slot) {
        if (toks[k + 1]?.text === '.') throw new Error(`name tables plainly ("${toks[k + 2]?.text ?? ''}"), not with a namespace`)
        if (ctes.has(w)) return
        if (!tables.has(w)) throw new Error(`there is no table "${t.text}" in this warehouse`)
        if (!allowedTable(w)) throw new Error(`this project may not read the table "${t.text}"`)
        used.push(w); return
      }
      // the alias of the table (or subquery) just named: `orders o`, `orders AS o`, `(…) AS sub`
      const before = prev && lower(prev) === 'as' ? toks[k - 2] : prev
      if (before && (isName(before) || before.text === ')') && !(t.kind === 'word' && KEYWORDS.has(w))) { refuseName(w, 'the alias'); tableAliases.add(w); definitions.add(k); return }
    }
    if (prev && lower(prev) === 'as' && !inFrom) { refuseName(w, 'the alias'); outAliases.add(w); definitions.add(k) }
  })
  if (!used.length && !ctes.size) throw new Error('the query reads no table')

  // Every other name is a reference: a column this query may read, a table / alias / CTE used as a qualifier (`o.`), an
  // output alias, a function, or SQL's own word. A qualified column (`o.secret`) is a column like any other.
  const readable = new Set<string>(); for (const u of used) for (const c of columnsOf(u)) readable.add(c)
  const limited = used.some((u) => grant !== null && grant[u] !== null)
  toks.forEach((t, k) => {
    if (t.text === '*' && limited) {
      const prev = toks[k - 1]
      const isCount = prev?.text === '(' && lower(toks[k - 2] ?? { text: '' }) === 'count'
      if (!isCount) throw new Error('select the columns by name: this project may read only some columns of a table it uses')
    }
  })
  toks.forEach((t, k) => {
    if (!isName(t) || definitions.has(k)) return
    const w = lower(t)
    const prev = toks[k - 1], next = toks[k + 1]
    if (prev?.text === '.') { if (readable.has(w)) return; throw new Error(allColumns.has(w) ? `this project may not read the column "${t.text}"` : `"${t.text}" is not a column this query may read`) }
    // A column of the warehouse held back from this project is refused whatever else its name could be (a word of SQL's,
    // a function's name): `date`, `year`, `text` are names of columns too.
    if (allColumns.has(w) && !readable.has(w)) throw new Error(`this project may not read the column "${t.text}"`)
    if (t.kind === 'word' && KEYWORDS.has(w)) return
    if (t.kind === 'word' && next?.text === '(') return                                  // a function
    if (next?.text === '.' && (used.includes(w) || tableAliases.has(w) || ctes.has(w))) return   // a qualifier
    if (used.includes(w) || ctes.has(w)) return                                         // a table or CTE in its slot (already checked)
    if (readable.has(w) || outAliases.has(w)) return
    throw new Error(allColumns.has(w) ? `this project may not read the column "${t.text}"` : `"${t.text}" is not a table or column this query may read`)
  })

  // Place the tables: each table slot gets the organisation's namespace.
  let out = '', last = 0
  inFrom = false; outer = []; query = true
  toks.forEach((t, k) => {
    const w = t.text.toLowerCase()
    if (paren(t, k)) return
    if (t.kind === 'word' && (w === 'from' || w === 'join') && query) { inFrom = true; return }
    if (t.kind === 'word' && ENDS_FROM.includes(w)) inFrom = false
    const prev = toks[k - 1]
    if (inFrom && (t.kind === 'word' || t.kind === 'quoted') && used.includes(w) && !ctes.has(w) && prev && (prev.text === ',' || ['from', 'join'].includes(prev.text.toLowerCase()))) {
      const len = t.kind === 'quoted' ? t.text.length + 2 : t.text.length
      out += text.slice(last, t.at) + `${namespace}.${w}`; last = t.at + len
    }
  })
  out += text.slice(last)
  return { sql: out, tables: [...new Set(used)] }
}

/**
 * The query with at most `n` rows: its own top-level LIMIT lowered to n, or a LIMIT n added. Never wrapped in an outer
 * SELECT — that would lose the query's ORDER BY.
 */
export function capRows(sql: string, n: number): string {
  const toks = tokens(sql)
  let depth = 0, at = -1
  toks.forEach((t, k) => { if (t.text === '(') depth++; else if (t.text === ')') depth--; else if (depth === 0 && t.kind === 'word' && t.text.toLowerCase() === 'limit') at = k })
  const num = at >= 0 ? toks[at + 1] : undefined
  if (num && /^\d+$/.test(num.text) && at + 2 === toks.length) {
    return sql.slice(0, num.at) + String(Math.min(Number(num.text), n)) + sql.slice(num.at + num.text.length)
  }
  if (at >= 0) throw new Error('end the query with LIMIT and a number, or leave the limit to the warehouse')
  return `${sql} LIMIT ${n}`
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
