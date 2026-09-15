// ── INTERVENTIONS: do() ON THE DATA, FOR ONE QUESTION (§10) ─────────────────────────────────────────────────
//
// An intervention replaces part of one object's data for one request, and never changes the graph or its memory:
//
//   on a fact     rows left out (`remove` with `match`), measures set or scaled on matching rows, rows added
//   on an entity  where an arrow leads for some elements — from a date, for an arrow that changes over time
//
// The same intervention means the same thing in memory and at the source: applyToInstance() rewrites an instance for
// the reference evaluator, and intervenedSources() wraps each object's statement in SQL, so every path, filter and
// coordinate asked of it sees the changed rows. An answer under any intervention is hypothetical, is said to be, and
// adds nothing to memory's series. A counterfactual asks the same question with and without.

import { periodOf } from './calendar.js'
import { arrow, arrows, timeArrow, type Schema } from './schema.js'
import type { Element, Instance, Key, Row } from './instance.js'
import type { Dialect, Sources } from './sql.js'

export type Intervention =
  | { on: string; match?: Record<string, string | string[]>; remove?: boolean; set?: Record<string, number | null>; scale?: Record<string, number>; add?: Row[] }
  | { on: string; keys: Key[]; arrows: Record<string, Key | null>; from?: string }

const isEntity = (x: Intervention): x is Extract<Intervention, { keys: Key[] }> => 'keys' in x
const list = (v: string | string[]) => (Array.isArray(v) ? v : [v])

/** What is wrong with interventions against a schema; empty when each can apply. */
export function interventionProblems(s: Schema, ivs: Intervention[]): string[] {
  const out: string[] = []
  for (const x of ivs) {
    const o = s.objects[x.on]
    if (!o || o.kind === 'calendar') { out.push(`there is no fact or entity ${x.on} to intervene on`); continue }
    if (isEntity(x)) {
      if (o.kind !== 'entity') { out.push(`${x.on} is a fact; intervene on its rows, not on its elements' arrows`); continue }
      if (!x.keys.length) out.push(`an intervention on ${x.on} names the elements it changes`)
      for (const [role, v] of Object.entries(x.arrows)) {
        const a = arrow(s, x.on, role)
        if (!a) out.push(`${x.on} has no arrow ${role}`)
        else if (v === null && !a.partial) out.push(`every ${x.on} has a ${role}; it cannot be set to nothing`)
        else if (v !== null && s.objects[a.to].members && !s.objects[a.to].members![v]) out.push(`${a.to} has no member ${v}`)
        if (x.from && a && a.kind !== 'as-of') out.push(`${x.on}.${role} does not change over time, so it has no date to change from`)
      }
      continue
    }
    if (o.kind !== 'fact') { out.push(`${x.on} is an entity; intervene on where its arrows lead, with keys and arrows`); continue }
    for (const k of Object.keys(x.match ?? {})) if (!arrow(s, x.on, k) && !o.attributes?.[k]) out.push(`${x.on} has no arrow or attribute ${k} to match on`)
    for (const m of [...Object.keys(x.set ?? {}), ...Object.keys(x.scale ?? {})]) if (!o.measures?.[m]) out.push(`${x.on} has no measure ${m}`)
    if (x.remove && (x.set || x.scale)) out.push(`an intervention on ${x.on} removes rows or changes them, not both`)
    for (const [i, r] of (x.add ?? []).entries()) {
      for (const a of arrows(s, x.on)) if (r.arrows?.[a.role] === undefined) out.push(`added row ${i + 1} of ${x.on} has no ${a.role}`)
      for (const m of Object.keys(r.measures ?? {})) if (!o.measures?.[m]) out.push(`added row ${i + 1} of ${x.on} has ${m}, which is not a measure`)
    }
  }
  return out
}

/** The instance with the interventions applied — for the reference evaluator. */
export function applyToInstance(s: Schema, I: Instance, ivs: Intervention[]): Instance {
  const out: Instance = structuredClone(I)
  for (const x of ivs) {
    if (isEntity(x)) {
      for (const key of x.keys) {
        const el: Element = out.elements[x.on]?.[key] ?? ((out.elements[x.on] ??= {})[key] = {})
        for (const [role, v] of Object.entries(x.arrows)) {
          if (arrow(s, x.on, role)!.kind === 'as-of') {
            const from = x.from ?? '0000-01-01'
            el.history = { ...el.history, [role]: [...(el.history?.[role] ?? []).filter((h) => h.from < from).map((h) => ({ ...h, ...(!h.to || h.to > from ? { to: from } : {}) })), { from, value: v }] }
          } else el.arrows = { ...el.arrows, [role]: v }
        }
      }
      continue
    }
    const matches = (r: Row) => Object.entries(x.match ?? {}).every(([k, v]) => list(v).includes(r.arrows[k] ?? r.attributes?.[k] ?? ''))
    let rows = out.rows[x.on] ?? []
    if (x.remove) rows = rows.filter((r) => !matches(r))
    for (const r of rows.filter(matches)) {
      for (const [m, v] of Object.entries(x.set ?? {})) r.measures[m] = v
      for (const [m, f] of Object.entries(x.scale ?? {})) if (r.measures[m] != null) r.measures[m] = r.measures[m]! * f
    }
    out.rows[x.on] = [...rows, ...structuredClone(x.add ?? [])]
  }
  return out
}

/** The sources with each intervened object's statement wrapped in SQL that applies the interventions, and the
 *  parameters those statements now take. */
export function intervenedSources(s: Schema, src: Sources, ivs: Intervention[], dialects: Dialect | ((source: string) => Dialect)): Sources {
  const out: Sources = structuredClone(src)
  let n = 0
  for (const x of ivs) {
    const d = typeof dialects === 'function' ? dialects((out.facts[x.on] ?? out.entities[x.on])?.source ?? '') : dialects
    const q = d.quote
    const params: Record<string, unknown> = {}
    const bind = (v: unknown) => { const p = `iv${n++}`; params[p] = v; return `@${p}` }
    if (isEntity(x)) {
      const es = out.entities[x.on] ?? (() => { throw new Error(`${x.on} has no source to intervene on`) })()
      const keys = x.keys.map(bind).join(', ')
      const plain = Object.entries(x.arrows).filter(([role]) => arrow(s, x.on, role)!.kind !== 'as-of')
      if (plain.length) {
        const cols = [es.key, ...new Set(Object.values(es.arrows))]
        const changed = new Map(plain.map(([role, v]) => [es.arrows[role], v]))
        es.sql = `SELECT ${cols.map((c) => changed.has(c) ? `CASE WHEN e.${q(es.key)} IN (${keys}) THEN ${changed.get(c) === null ? 'NULL' : bind(changed.get(c))} ELSE e.${q(c)} END AS ${q(c)}` : `e.${q(c)}`).join(', ')} FROM (${es.sql}) e`
        es.params = { ...es.params, ...params }
      }
      for (const [role, v] of Object.entries(x.arrows).filter(([r]) => arrow(s, x.on, r)!.kind === 'as-of')) {
        const h = es.history?.[role] ?? (() => { throw new Error(`${x.on}.${role} has no history to intervene on`) })()
        const hp: Record<string, unknown> = {}
        const hb = (val: unknown) => { const p = `iv${n++}`; hp[p] = val; return `@${p}` }
        const hkeys = x.keys.map(hb).join(', ')
        const hfrom = hb(x.from ?? '0000-01-01')
        const cols = (value: string, fromExpr: string, toExpr: string) => `${value} AS ${q(h.value)}, ${fromExpr} AS ${q(h.from)}, ${toExpr} AS ${q(h.to)}`
        h.sql = [
          `SELECT g.${q(h.key)} AS ${q(h.key)}, ${cols(`g.${q(h.value)}`, `g.${q(h.from)}`, `g.${q(h.to)}`)} FROM (${h.sql}) g WHERE g.${q(h.key)} NOT IN (${hkeys})`,
          `SELECT g.${q(h.key)} AS ${q(h.key)}, ${cols(`g.${q(h.value)}`, `g.${q(h.from)}`, `CASE WHEN g.${q(h.to)} IS NULL OR g.${q(h.to)} > ${hfrom} THEN ${hfrom} ELSE g.${q(h.to)} END`)} FROM (${h.sql}) g WHERE g.${q(h.key)} IN (${hkeys}) AND g.${q(h.from)} < ${hfrom}`,
          ...x.keys.map((k) => d.row(`${hb(k)} AS ${q(h.key)}, ${cols(v === null ? 'NULL' : hb(v), hfrom, 'NULL')}`)),
        ].join('\nUNION ALL\n')
        h.params = { ...h.params, ...hp }
      }
      continue
    }
    const fs = out.facts[x.on] ?? (() => { throw new Error(`${x.on} has no source to intervene on`) })()
    const matchSql = Object.entries(x.match ?? {}).map(([k, v]) => `r.${q(fs.arrows[k] ?? fs.attributes?.[k] ?? k)} IN (${list(v).map(bind).join(', ')})`).join(' AND ') || '1 = 1'
    const cols = [...new Set([...Object.values(fs.arrows), ...(fs.time ? [fs.time] : []), ...Object.values(fs.attributes ?? {}), ...Object.values(fs.measures)])]
    const byColumn = new Map<string, string>()
    for (const [m, v] of Object.entries(x.set ?? {})) byColumn.set(fs.measures[m], `CASE WHEN ${matchSql} THEN ${v === null ? 'NULL' : bind(v)} ELSE r.${q(fs.measures[m])} END`)
    for (const [m, f] of Object.entries(x.scale ?? {})) byColumn.set(fs.measures[m], `CASE WHEN ${matchSql} THEN r.${q(fs.measures[m])} * ${bind(f)} ELSE r.${q(fs.measures[m])} END`)
    let sql = `SELECT ${cols.map((c) => `${byColumn.get(c) ?? `r.${q(c)}`} AS ${q(c)}`).join(', ')} FROM (${fs.sql}) r${x.remove ? ` WHERE NOT (${matchSql})` : ''}`
    const column = (name: string, value: unknown) => `${value === null || value === undefined ? 'NULL' : bind(value)} AS ${q(name)}`
    for (const r of x.add ?? []) {
      const time = timeArrow(s, x.on)
      const values = new Map<string, unknown>()
      for (const [role, c] of Object.entries(fs.arrows)) values.set(c, r.arrows[role])
      // The time column holds the first day of the row's period.
      if (fs.time && time) values.set(fs.time, periodOf(s.objects[time.to], r.arrows[time.role]).from)
      for (const [a, c] of Object.entries(fs.attributes ?? {})) values.set(c, r.attributes?.[a] ?? null)
      for (const [m, c] of Object.entries(fs.measures)) values.set(c, r.measures[m] ?? null)
      sql += `\nUNION ALL\n${d.row(cols.map((c) => column(c, values.get(c))).join(', '))}`
    }
    fs.sql = sql
    fs.params = { ...fs.params, ...params }
  }
  return out
}
