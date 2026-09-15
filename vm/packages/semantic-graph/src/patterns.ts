// ── THE GRAPH AS PATTERNS: HOW THINGS CONNECT, READ AT A GLANCE ──────────────────────────────────────────────────
//
// What a node is and how nodes connect, written the way property graphs are written — (:Node)-[role]->(:Other) — so
// an arrow reads as a step to walk, and a path reads as the `via` a question names. Every name is written exactly as a
// question uses it. (The same views as JSON are node, paths and catalog in discovery.ts.)

import { catalog, node, paths } from './discovery.js'
import { arrows, walk, type Schema } from './schema.js'

const KIND_SAID: Record<string, string> = { 'as-of': 'changes over time', version: 'a version, never combined across', rollup: 'rolls up', self: 'to its own kind' }
const notesOf = (a: { kind: string; partial?: boolean }) => [KIND_SAID[a.kind], a.partial ? 'may be none' : ''].filter(Boolean).join(', ')
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Rows as columns: each column as wide as its widest cell, two spaces between, the last column left to run on. */
function table(rows: string[][], indent = '    '): string[] {
  const widths: number[] = []
  for (const r of rows) r.forEach((c, i) => { if (i < r.length - 1) widths[i] = Math.max(widths[i] ?? 0, c.length) })
  return rows.map((r) => (indent + r.map((c, i) => (i < r.length - 1 ? c.padEnd(widths[i]) : c)).join('  ')).trimEnd())
}
const arrowRows = (as: Array<{ role: string; to: string; kind: string; partial?: boolean }>) => as.map((a) => [`-[${a.role}]->`, `(:${a.to})`, notesOf(a)])

/** One node: what it is, its arrows out and in, its defaults, measures, attributes and members. */
export function nodeText(s: Schema, name: string): string {
  const v = node(s, name)
  const out = [`(:${v.name}) ${v.kind}`]
  if (v.description) out.push(`  ${v.description}`)
  if (v.synonyms?.length) out.push(`  also called: ${v.synonyms.join(', ')}`)
  if (v.calendar) out.push(`  cuts time by: ${v.calendar.level ?? (v.calendar.fiscal ? 'a fiscal calendar' : plural(v.calendar.periods ?? 0, 'listed period'))}`)
  if (v.arrows.length) out.push('', v.kind === 'fact' ? '  kept by' : '  belongs to', ...table(arrowRows(v.arrows)))
  if (v.defaults) out.push('', '  path taken when a question does not say', ...table(Object.entries(v.defaults).map(([to, p]) => [`to (:${to})`, `via ${p}`])))
  if (v.measures?.length) out.push('', '  measures', ...table([['name', 'unit', 'aggregate', 'notes'], ...v.measures.map((m) => [m.name, m.unit, m.aggregate,
    [m.currency ? `currency by ${m.currency}` : '', m.overTime ? `over time: ${m.overTime}` : '', m.of ? `counts ${m.of}` : '', m.weight ? `weighted by ${m.weight}` : '', m.versions ? `by version ${m.versions}` : '',
      m.synonyms?.length ? `also: ${m.synonyms.join(', ')}` : ''].filter(Boolean).join('; ')])]))
  if (v.attributes?.length) out.push('', '  attributes', ...table(v.attributes.map((a) => [a.name, a.type ?? 'text', [a.values ? a.values.join(', ') : '', a.description ?? ''].filter(Boolean).join(' — ')])))
  if (v.keptTo?.length) out.push('', `  always kept to: ${v.keptTo.join(', ')} — unless a question sets it aside with "without"`)
  if (v.history) out.push('', '  holds only its current state: earlier states cannot be read back')
  if (v.conditions?.length) out.push('', '  conditions about it', ...table(v.conditions.map((c) => [c.name, [c.description, JSON.stringify(c.where)].filter(Boolean).join(' — ')])))
  if (v.members) {
    out.push('', `  members (${v.members.count}${v.members.count > v.members.sample.length ? `, first ${v.members.sample.length}` : ''})`, ...table(v.members.sample.map((m) => [m.key, m.label])))
    if (v.members.names) out.push('', '  names people use', ...table(Object.entries(v.members.names).map(([n, k]) => [n, `= ${k}`])))
  }
  if (v.pointedAtBy.length) out.push('', '  pointed at by', ...table(v.pointedAtBy.map((p) => [`(:${p.from})`, `-[${p.role}]->`, notesOf(p)])))
  return out.join('\n')
}

/** Every path from one node to another: the default first, then shortest first; each with the via a question names. */
export function pathsText(s: Schema, from: string, to: string): string {
  const all = paths(s, from, to)
  if (!all.length) return `(:${from}) does not reach (:${to})`
  const byDefault = s.objects[from].defaults?.[to]?.join('.')
  const rows = all.map((steps) => {
    const w = walk(s, from, steps)!
    const via = steps.join('.')
    return { via, isDefault: via === byDefault, steps: steps.length,
      row: [via, [via === byDefault ? 'default' : '', w.walked.some((a) => a.partial) ? 'may be none' : ''].filter(Boolean).join(', '), `(:${from})${w.walked.map((a) => `-[${a.role}]->(:${a.to})`).join('')}`] }
  }).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.steps - b.steps || a.via.localeCompare(b.via))
  return [`from (:${from}) to (:${to}), ${plural(rows.length, 'path')}; a question names one as via: ${JSON.stringify(rows[0].via.split('.'))} for ${rows[0].via}`, '',
    ...table([['via', 'notes', 'path'], ...rows.map((r) => r.row)], '  ')].join('\n')
}

/** The whole graph: facts with what keeps them and their measures, dimensions with where they belong, calendars. */
export function catalogText(s: Schema): string {
  const c = catalog(s)
  const out: string[] = ['FACTS: what is measured']
  for (const f of c.facts) {
    const o = s.objects[f.name]
    out.push('', `(:${f.name})${f.description ? `  ${f.description}` : ''}`)
    out.push('  kept by', ...table(arrowRows(arrows(s, f.name))))
    if (o.defaults) out.push('  by default', ...table(Object.entries(o.defaults).map(([to, p]) => [`to (:${to})`, `via ${p.join('.')}`])))
    out.push('  measures', ...table(Object.entries(o.measures ?? {}).map(([m, d]) => [m, d.unit, d.aggregate])))
    if (o.attributes) out.push(`  attributes: ${Object.keys(o.attributes).join(', ')}`)
    if (o.keptTo?.length) out.push(`  always kept to: ${o.keptTo.join(', ')}`)
    if (o.history) out.push('  holds only its current state')
  }
  out.push('', '', 'DIMENSIONS: what measures are grouped by and kept to')
  for (const e of c.entities) {
    const as = arrows(s, e.name)
    out.push('', `(:${e.name})${e.members ? `  ${plural(e.members, 'member')} listed` : ''}${e.description ? `  ${e.description}` : ''}`)
    if (as.length) out.push(...table(arrowRows(as)))
    if (e.attributes?.length) out.push(`    attributes: ${e.attributes.join(', ')}`)
  }
  if (c.conditions.length) out.push('', '', 'CONDITIONS: kept to by name', ...table(c.conditions.map((x) => [x.name, `on (:${x.on})`, x.description ?? '']), '  '))
  out.push('', '', 'CALENDARS', ...table([['calendar', 'cuts by', 'rolls up to'], ...c.calendars.map((k) => [`(:${k.name})`, String(k.cuts ?? ''), k.rollsUpTo.map((x) => `(:${x})`).join(' ')])], '  '))
  return out.join('\n')
}
