// ── THE SCHEMA (docs/semantic-graph.md §2) ──────────────────────────────────────────────────────────────────
//
// A finitely presented category: objects (entities, calendar levels, facts), arrows between them that are functions,
// and equations between paths. Measures are functions from a fact into a quantity type. Nothing here is Fusion5's:
// a schema is data, and this file only says what a well-formed one is.

import { calendarProblem, nests, type CalendarDef } from './calendar.js'

export type ArrowKind = 'grain' | 'belongs' | 'rollup' | 'as-of' | 'version' | 'self'
export type MeasureKind = 'flow' | 'stock' | 'value-per-unit'
export type Aggregate = 'sum' | 'count' | 'min' | 'max' | 'average' | 'median' | 'count distinct' | 'weighted average'

export interface Arrow { to: string; kind?: ArrowKind; partial?: boolean; synonyms?: string[] }

export interface Measure {
  unit: string
  kind: MeasureKind
  aggregate: Aggregate
  /** money: a path from the fact to Currency, or the name of a currency attribute of the fact. */
  currency?: string[] | { attribute: string }
  /** a stock across time: the level at the last or first instant, or the average level. */
  overTime?: 'last' | 'first' | 'average'
  /** count distinct: the arrow whose values are counted. */
  of?: string
  /** weighted average: the measure of the same fact it is weighted by. */
  weight?: string
  /** the version arrow this measure is never combined across. */
  versions?: string
  synonyms?: string[]
}

export interface ObjectDef {
  kind: 'entity' | 'calendar' | 'fact'
  description?: string
  synonyms?: string[]
  /** calendar objects: a built-in level (day, week, month, quarter, year), or a fiscal calendar, or listed periods. */
  level?: string
  fiscal?: CalendarDef['fiscal']
  periods?: CalendarDef['periods']
  /** arrows out, by role. A string is shorthand for { to }. */
  arrows?: Record<string, string | Arrow>
  /** entities: the members it lists (key → label), and names people use for them (name → key). */
  members?: Record<string, string>
  names?: Record<string, string>
  /** facts */
  measures?: Record<string, Measure>
  /** Values a fact row or an entity element carries that lead nowhere: a status, a flag, a date, a number. Grouped and
   *  filtered by, never added up. `type` says how they compare: dates and numbers by range, text by value. */
  attributes?: Record<string, AttributeDef>
  /** facts: the named conditions its rows are always kept to, unless a question sets one aside. */
  keptTo?: string[]
  /** facts and entities: the source holds only the current state — no earlier state can be read back. */
  history?: 'current'
  /** facts: the path a target means when several reach it. */
  defaults?: Record<string, string[]>
}

export interface AttributeDef { type?: 'text' | 'date' | 'number' | 'flag'; members?: string[]; synonyms?: string[]; description?: string }

/** A condition people name — "a valid project", "the PMO population" — kept as one definition: filters on the object
 *  it is about (`on`), each reached from that object. A question keeps to it by name, from any fact that reaches it. */
export interface ConditionDef {
  on: string
  description?: string
  synonyms?: string[]
  where: Array<Record<string, unknown>>
}

export interface Equation { on: string; paths: [string[], string[]] }

export interface Conversion {
  /** a value-per-unit fact with arrows from and to Currency, a day arrow, and a rate measure: 1 from = rate × to. */
  fact: string; from: string; to: string; day: string; rate: string
  /** converted at each row's date, or at the end of the span asked about. */
  at: 'row' | 'end'
}

export interface Schema {
  name: string
  objects: Record<string, ObjectDef>
  equations?: Equation[]
  conversion?: Conversion
  conditions?: Record<string, ConditionDef>
}


/** The arrow `role` out of `object`, with its kind made explicit. */
export function arrow(s: Schema, object: string, role: string): Required<Pick<Arrow, 'to' | 'kind'>> & Arrow | undefined {
  const o = s.objects[object]
  const raw = o?.arrows?.[role]
  if (raw === undefined) return undefined
  const a: Arrow = typeof raw === 'string' ? { to: raw } : raw
  const kind: ArrowKind = a.kind ?? (o.kind === 'fact' ? 'grain' : o.kind === 'calendar' ? 'rollup' : a.to === object ? 'self' : 'belongs')
  // A calendar's arrows are computed from its keys; an entity's are data.
  return { ...a, kind }
}

export function arrows(s: Schema, object: string) {
  return Object.keys(s.objects[object]?.arrows ?? {}).map((role) => ({ role, ...arrow(s, object, role)! }))
}

/** A fact's time arrow: its one grain arrow into a calendar level. */
export function timeArrow(s: Schema, fact: string) {
  return arrows(s, fact).find((a) => s.objects[a.to]?.kind === 'calendar')
}

/** Every rule of §2.5 the schema breaks; empty when it is well formed. */
export function schemaProblems(s: Schema): string[] {
  const out: string[] = []
  for (const [name, o] of Object.entries(s.objects)) {
    for (const a of arrows(s, name)) {
      if (!s.objects[a.to]) { out.push(`${name}.${a.role} points to ${a.to}, which is not an object`); continue }
      if (s.objects[a.to].kind === 'fact') out.push(`${name}.${a.role} points to the fact ${a.to}; arrows land on entities and calendar levels`)
      if (a.kind === 'grain' && o.kind !== 'fact') out.push(`${name}.${a.role}: only facts have grain arrows`)
      if ((a.kind === 'grain' || a.kind === 'version') && a.partial) out.push(`${name}.${a.role}: a fact's grain arrows are total`)
      if (a.kind === 'self' && a.to !== name) out.push(`${name}.${a.role}: a self arrow lands on ${name}`)
      // A rollup is a level of a hierarchy — a branch into its state, a day into its month: total, one parent. Between
      // calendar levels it must also go to a coarser level; in every other respect it is the same arrow.
      if (a.kind === 'rollup') {
        if (a.partial) out.push(`${name}.${a.role}: a rollup is total — every ${name} is in exactly one ${a.to}`)
        if (o.kind === 'calendar' && s.objects[a.to].kind === 'calendar' && !calendarProblem(o) && !calendarProblem(s.objects[a.to]) && !nests(o, s.objects[a.to])) {
          out.push(`${name}.${a.role}: not every ${name} lies inside one ${a.to}, so there is no rollup from one to the other`)
        }
      }
    }
    for (const [n, key] of Object.entries(o.names ?? {})) if (!o.members?.[key]) out.push(`${name}: the name "${n}" means member ${key}, which ${name} does not list`)
    if (o.kind === 'calendar') { const p = calendarProblem(o); if (p) out.push(`${name}: ${p}`) }
    if (o.kind !== 'fact') { if (o.measures) out.push(`${name}: measures belong to facts`); continue }

    const time = arrows(s, name).filter((a) => s.objects[a.to]?.kind === 'calendar')
    if (time.length > 1) out.push(`${name} has ${time.length} time arrows; a fact has one time grain`)
    for (const [m, d] of Object.entries(o.measures ?? {})) {
      const at = `${name}.${m}`
      if (d.kind === 'value-per-unit' && !['min', 'max', 'median', 'weighted average'].includes(d.aggregate)) out.push(`${at} is a value per unit; it is combined by min, max, median or a weighted average, never by ${d.aggregate}`)
      if (d.kind === 'stock' && d.aggregate === 'count distinct') out.push(`${at}: a stock is a level, not a count of distinct things`)
      if (d.aggregate === 'weighted average' && (!d.weight || !o.measures?.[d.weight])) out.push(`${at}: a weighted average names the measure of ${name} it is weighted by`)
      if (d.aggregate === 'count distinct' && (!d.of || !arrow(s, name, d.of))) out.push(`${at}: count distinct names an arrow of ${name}`)
      if (d.overTime && d.kind !== 'stock') out.push(`${at}: only a stock says how it goes over time`)
      if (d.versions && arrow(s, name, d.versions)?.kind !== 'version') out.push(`${at}: "${d.versions}" is not a version arrow of ${name}`)
      if (baseUnits(d.unit).money) {
        if (!d.currency) out.push(`${at} is money and does not say where its currency comes from`)
        else if (Array.isArray(d.currency)) { if (walk(s, name, d.currency)?.object !== 'Currency') out.push(`${at}: ${d.currency.join('.')} is not a path to Currency`) }
        else if (!o.attributes?.[d.currency.attribute]) out.push(`${at}: its currency attribute "${d.currency.attribute}" is not an attribute of ${name}`)
      }
    }
    for (const [target, p] of Object.entries(o.defaults ?? {})) if (walk(s, name, p)?.object !== target) out.push(`${name}: the default ${p.join('.')} does not lead to ${target}`)
    for (const c of o.keptTo ?? []) if (!s.conditions?.[c]) out.push(`${name} is kept to "${c}", which is not a condition of the schema`)
  }
  for (const [n, c] of Object.entries(s.conditions ?? {})) {
    if (!s.objects[c.on]) out.push(`the condition "${n}" is about ${c.on}, which is not an object of the schema`)
    if (!c.where?.length) out.push(`the condition "${n}" keeps to nothing`)
  }
  for (const e of s.equations ?? []) {
    const [a, b] = e.paths.map((p) => walk(s, e.on, p))
    if (!a || !b) out.push(`equation on ${e.on}: ${e.paths.map((p) => p.join('.')).join(' = ')} is not two paths`)
    else if (a.object !== b.object) out.push(`equation on ${e.on}: ${e.paths[0].join('.')} ends at ${a.object}, ${e.paths[1].join('.')} at ${b.object}`)
  }
  // No object belongs to what belongs to it, except through a self arrow.
  const reachable = (from: string, seen = new Set<string>()): Set<string> => {
    for (const a of arrows(s, from)) if (a.kind !== 'self' && s.objects[a.to]?.kind !== 'fact' && !seen.has(a.to)) { seen.add(a.to); reachable(a.to, seen) }
    return seen
  }
  for (const [name, o] of Object.entries(s.objects)) if (o.kind !== 'fact' && reachable(name).has(name)) out.push(`${name} belongs, through its arrows, to itself`)
  if (s.conversion) {
    const c = s.conversion, f = s.objects[c.fact]
    if (f?.kind !== 'fact') out.push(`conversion: ${c.fact} is not a fact`)
    else {
      if (arrow(s, c.fact, c.from)?.to !== 'Currency' || arrow(s, c.fact, c.to)?.to !== 'Currency') out.push(`conversion: ${c.fact}.${c.from} and .${c.to} lead to Currency`)
      if (s.objects[arrow(s, c.fact, c.day)?.to ?? '']?.level !== 'day' || s.objects[arrow(s, c.fact, c.day)!.to].fiscal || s.objects[arrow(s, c.fact, c.day)!.to].periods) out.push(`conversion: ${c.fact}.${c.day} leads to a day`)
      if (f.measures?.[c.rate]?.kind !== 'value-per-unit') out.push(`conversion: ${c.fact}.${c.rate} is a value per unit`)
    }
  }
  return out
}

/** Follow a path of roles from an object; the object it ends at and the arrows it walked, or undefined. */
export function walk(s: Schema, from: string, path: string[]) {
  let object = from
  const walked: Array<ReturnType<typeof arrows>[number]> = []
  for (const role of path) {
    const a = arrow(s, object, role)
    if (!a) return undefined
    walked.push({ role, ...a })
    object = a.to
  }
  return { object, walked }
}

// ── Units (§2.4, §5 E): a unit is a product of base units with integer powers. money is one base per currency. ──

export type Units = Record<string, number>

export function baseUnits(unit: string): Units {
  const out: Units = {}
  const [num, ...den] = unit.split('/')
  const add = (part: string, sign: number) => { for (const u of part.split('*').map((x) => x.trim()).filter((x) => x && x !== '1')) out[u] = (out[u] ?? 0) + sign }
  add(num, 1); for (const d of den) add(d, -1)
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k]
  return out
}
export const unitText = (u: Units) => {
  const up = Object.entries(u).filter(([, n]) => n > 0).flatMap(([k, n]) => Array(n).fill(k)), down = Object.entries(u).filter(([, n]) => n < 0).flatMap(([k, n]) => Array(-n).fill(k))
  return (up.join('*') || (down.length ? '1' : 'ratio')) + (down.length ? '/' + down.join('/') : '')
}
export const sameUnits = (a: Units, b: Units) => { const k = new Set([...Object.keys(a), ...Object.keys(b)]); return [...k].every((x) => (a[x] ?? 0) === (b[x] ?? 0)) }
export const timesUnits = (a: Units, b: Units, sign = 1) => { const o: Units = { ...a }; for (const [k, n] of Object.entries(b)) { o[k] = (o[k] ?? 0) + sign * n; if (!o[k]) delete o[k] } return o }
