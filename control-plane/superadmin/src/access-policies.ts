// ── Data access policies — what each person or agent may read ────────────────────────────────────────────────────────
//
// A policy says, for one data source and table, what a principal may read: a ROW filter (a predicate every read of the
// table gets), a DENY (the table cannot be read), or a column MASK (the column reads as null). It applies to everyone,
// to a role (the project's access roles), to a group, to one person (by email) or to one agent key. A predicate may name the
// reader's ATTRIBUTES — `{t}.branch IN {attr.branches}` — so one policy serves everyone it applies to; the values are
// rendered as SQL literals here, never pasted. A policy that names an attribute the reader does not have denies the
// table: access fails closed. The rewrite (datasource manager, sqlrewrite/worker.py) applies the resolved policies to
// every query, on every table read.

export type AppliesTo = 'everyone' | `role:${string}` | `group:${string}` | `email:${string}` | `agent:${string}`
export interface AccessPolicy { id: string; applies_to: AppliesTo; source: string; table: string; kind: 'row' | 'deny' | 'mask'; predicate?: string | null; column?: string | null; note?: string | null }
/** What the rewrite takes (sqlrewrite/worker.py inject_policies). */
export type Resolved = { table: string; predicate: string } | { table: string; deny: true } | { table: string; column: string; mask: 'null' }
export interface Reader { principal: string; email?: string | null; role?: string | null; groups?: string[]; attributes: Record<string, unknown> }

export class PolicyRefusal extends Error {}

const IDENT = /^[A-Za-z_][\w$#]*(\.[A-Za-z_][\w$#]*)*$/
const ATTR = /\{attr\.([\w-]+)\}/g

/** What is wrong with a policy, in sentences. */
export function checkPolicy(p: Partial<AccessPolicy>): string[] {
  const out: string[] = []
  if (!p.applies_to || !/^(everyone|role:[\w-]+|group:[a-z][a-z0-9-]*|email:[^\s@]+@[^\s@]+|agent:key_[\w-]+)$/.test(p.applies_to)) out.push('a policy applies to everyone, role:<role>, group:<group>, email:<address> or agent:<key id>')
  if (!p.source || !/^[\w-]+$/.test(p.source)) out.push('a policy names its data source')
  if (!p.table || !IDENT.test(p.table)) out.push('a policy names its table (an identifier, optionally schema-qualified)')
  if (p.kind === 'row') {
    if (!p.predicate?.trim()) out.push('a row policy has a predicate, written with {t} for the table')
    else if (!p.predicate.includes('{t}')) out.push('a row predicate names the table as {t} (so it applies however the query aliases it)')
    else if (/;|--|\/\*/.test(p.predicate)) out.push('a row predicate is one boolean expression: no ";", no comments')
  } else if (p.kind === 'mask') {
    if (!p.column || !/^[A-Za-z_][\w$#]*$/.test(p.column)) out.push('a mask policy names its column')
  } else if (p.kind !== 'deny') out.push('a policy is a row filter, a deny or a mask')
  return out
}

/** A value as a SQL literal: a number, a quoted string, a list as (a, b, …); anything else is refused. */
export function literal(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
  if (Array.isArray(v)) { if (!v.length) throw new PolicyRefusal('an empty list cannot be read as a set of values'); return `(${v.map(literal).join(', ')})` }
  throw new PolicyRefusal('an attribute is a number, a string, true/false or a list of those')
}

const appliesTo = (p: AccessPolicy, r: Reader) =>
  p.applies_to === 'everyone' ||
  (p.applies_to.startsWith('role:') && r.role === p.applies_to.slice(5)) ||
  (p.applies_to.startsWith('group:') && !!r.groups?.includes(p.applies_to.slice(6))) ||
  (p.applies_to.startsWith('email:') && !!r.email && r.email.toLowerCase() === p.applies_to.slice(6).toLowerCase()) ||
  (p.applies_to.startsWith('agent:') && r.principal === p.applies_to)

/** The policies a reader is under, for one source, ready for the rewrite. An attribute the reader lacks denies the table. */
export function resolve(policies: AccessPolicy[], source: string, r: Reader): Resolved[] {
  const out: Resolved[] = []
  for (const p of policies) {
    if (p.source !== source || !appliesTo(p, r)) continue
    if (p.kind === 'deny') { out.push({ table: p.table, deny: true }); continue }
    if (p.kind === 'mask') { out.push({ table: p.table, column: p.column!, mask: 'null' }); continue }
    try {
      const predicate = p.predicate!.replace(ATTR, (_m, name: string) => {
        if (!(name in r.attributes)) throw new PolicyRefusal(`no attribute ${name}`)
        return literal(r.attributes[name])
      })
      out.push({ table: p.table, predicate })
    } catch { out.push({ table: p.table, deny: true }) }   // fail closed
  }
  return out
}
