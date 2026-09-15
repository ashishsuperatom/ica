// An instance written into SQLite tables — one per fact, one per entity with arrows, one per as-of arrow's history —
// and the sources that say where each object's rows are. The SQL executor is then asked the same questions as the
// reference evaluator, on the same data.

import { DatabaseSync } from 'node:sqlite'
import { arrows, period, timeArrow, type Instance, type Query, type Schema, type Sources } from '../../src/index.js'

export function toSqlite(s: Schema, I: Instance): { query: Query; sources: Sources } {
  const db = new DatabaseSync(':memory:')
  const q = (id: string) => `"${id.replace(/"/g, '""')}"`
  const table = (name: string, columns: string[], rows: unknown[][]) => {
    db.exec(`CREATE TABLE ${q(name)} (${columns.map(q).join(', ')})`)
    const insert = db.prepare(`INSERT INTO ${q(name)} VALUES (${columns.map(() => '?').join(', ')})`)
    for (const r of rows) insert.run(...(r as any[]))
  }
  const sources: Sources = { facts: {}, entities: {} }
  for (const [name, o] of Object.entries(s.objects)) {
    if (o.kind === 'fact') {
      const t = timeArrow(s, name)
      const grain = arrows(s, name).filter((a) => a.role !== t?.role).map((a) => a.role)
      const attributes = Object.keys(o.attributes ?? {}), measures = Object.keys(o.measures ?? {})
      const columns = [...grain.map((a) => `a:${a}`), ...(t ? ['time'] : []), ...attributes.map((a) => `t:${a}`), ...measures.map((m) => `m:${m}`)]
      table(name, columns, (I.rows[name] ?? []).map((r) => [
        ...grain.map((a) => r.arrows[a]), ...(t ? [period(s, t.to, r.arrows[t.role]).from] : []),
        ...attributes.map((a) => r.attributes?.[a] ?? null), ...measures.map((m) => r.measures[m] ?? null),
      ]))
      sources.facts[name] = { source: 'DB', sql: `SELECT * FROM ${q(name)}`, arrows: Object.fromEntries(grain.map((a) => [a, `a:${a}`])), ...(t ? { time: 'time' } : {}),
        attributes: Object.fromEntries(attributes.map((a) => [a, `t:${a}`])), measures: Object.fromEntries(measures.map((m) => [m, `m:${m}`])) }
    } else if (o.kind === 'entity') {
      const plain = arrows(s, name).filter((a) => a.kind !== 'as-of').map((a) => a.role)
      const attributes = Object.keys(o.attributes ?? {})
      table(name, ['key', 'label', ...plain, ...attributes.map((a) => `t:${a}`)], Object.entries(I.elements[name] ?? {}).map(([k, e]) => [k, e.label ?? o.members?.[k] ?? k, ...plain.map((a) => e.arrows?.[a] ?? null), ...attributes.map((a) => e.attributes?.[a] ?? null)]))
      const history: NonNullable<Sources['entities'][string]['history']> = {}
      for (const a of arrows(s, name).filter((x) => x.kind === 'as-of')) {
        table(`${name}.${a.role}`, ['key', 'value', 'from', 'to'], Object.entries(I.elements[name] ?? {}).flatMap(([k, e]) => (e.history?.[a.role] ?? []).map((h) => [k, h.value, h.from, h.to ?? null])))
        history[a.role] = { sql: `SELECT * FROM ${q(`${name}.${a.role}`)}`, key: 'key', value: 'value', from: 'from', to: 'to' }
      }
      sources.entities[name] = { source: 'DB', sql: `SELECT * FROM ${q(name)}`, key: 'key', label: 'label', arrows: Object.fromEntries(plain.map((a) => [a, a])), history,
        ...(attributes.length ? { attributes: Object.fromEntries(attributes.map((a) => [a, `t:${a}`])) } : {}) }
    }
  }
  const query: Query = async (_source, sql, params) => db.prepare(sql).all(params as any) as Array<Record<string, unknown>>
  return { query, sources }
}
