// CONDITIONS ON THE GRAPH'S EDGES (docs/connectors-plan.md 9f): a domain, or an intermediate concept, may say for one of
// the concepts it composes `when: { "<concept>": "<condition>" }` — an expression of the person the domain is composed
// for. Composed for a person, an edge whose condition is false leaves that concept, and all it composes, out. Composed for
// no one (a console showing the graph), every edge is kept.
//
// A condition is a plain expression of `user` — its id, email, role and caps (the capabilities they hold), compared and
// combined: `user.caps.includes('project.connectors')`, `user.role === 'admin' || user.caps.includes('x')`. Checked when
// written, token by token: nothing but these names, literals and operators can be in it, so nothing else can run.

/** What a condition reads of the person. */
export interface ConditionUser { id: string; email?: string | null; role?: string | null; caps: string[] }

const NAMES = new Set(['user', 'id', 'email', 'role', 'caps', 'includes', 'some', 'every', 'startsWith', 'endsWith', 'length', 'true', 'false', 'null'])
const TOKEN = /\s+|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\d+(?:\.\d+)?|[A-Za-z_$][\w$]*|===|!==|&&|\|\||[!().,<>]=?|=>/y   // no brackets: a field is read by name only (user['…'] could reach past the person)

/** Why a condition may not be kept, or null. */
export function checkCondition(expr: unknown): string | null {
  if (typeof expr !== 'string' || !expr.trim()) return 'a condition is an expression of user (its id, email, role, caps)'
  if (expr.length > 400) return 'a condition is at most 400 characters'
  TOKEN.lastIndex = 0
  let depth = 0
  for (let i = 0; i < expr.length;) {
    TOKEN.lastIndex = i
    const m = TOKEN.exec(expr)
    if (!m || m.index !== i) return `a condition may hold only user's fields, text, numbers and comparisons — not "${expr.slice(i, i + 12)}"`
    const t = m[0]
    if (/^[A-Za-z_$]/.test(t) && !NAMES.has(t)) return `a condition reads only user (id, email, role, caps) — not "${t}"`
    if (t === '(') depth++
    if (t === ')' && --depth < 0) return 'a condition\'s brackets do not match'
    if (t === '=>') return 'a condition is one expression, not a function'
    i += t.length
  }
  if (depth) return 'a condition\'s brackets do not match'
  if (!/\buser\b/.test(expr)) return 'a condition reads the person (user)'
  return null
}

/** Whether a condition holds for a person. One that cannot be read or fails is false — it never lets a concept in. */
export function holds(expr: string, user: ConditionUser): boolean {
  if (checkCondition(expr)) return false
  try {
    const u = Object.freeze({ id: String(user.id), email: user.email ?? null, role: user.role ?? null, caps: Object.freeze([...(user.caps ?? [])]) })
    // eslint-disable-next-line no-new-func -- the expression was checked token by token above: only user's fields can be read
    return new Function('user', `"use strict"; return (${expr})`)(u) === true
  } catch { return false }
}
