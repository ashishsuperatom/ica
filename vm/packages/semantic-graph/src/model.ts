// ── PROGRAMS, INTERVENTIONS, COUNTERFACTUALS (§9, §10) ──────────────────────────────────────────────────────
//
// A model is a schema and the programs that produce its data. Each program produces one object — an entity's
// elements or a fact's rows — from what it reads, which is either outside data or other objects: the dependency
// graph, acyclic. Programs are plain functions; their output is checked against the schema.
//
// An intervention replaces part of one object's data right after its program runs, and everything downstream is
// produced again from the replaced data — Pearl's do(): the mechanism of the intervened variable is cut, every other
// mechanism is kept. A counterfactual asks the same question of the model with and without the intervention.

import { check, type Question } from './algebra.js'
import { evaluate, type Result } from './evaluate.js'
import { conformance, type Element, type Instance, type Key, type Row } from './instance.js'
import { applyToInstance, interventionProblems, type Intervention } from './interventions.js'
import type { Schema } from './schema.js'

export interface Program {
  produces: string
  reads: string[]
  run: (inputs: Instance) => Row[] | Record<Key, Element>
}
export interface Model { schema: Schema; programs: Program[] }

/** The programs in an order where each runs after what it reads; refuses a cycle. */
export function order(model: Model): Program[] {
  const byName = new Map(model.programs.map((p) => [p.produces, p]))
  const out: Program[] = [], state = new Map<string, 'visiting' | 'done'>()
  const visit = (p: Program, trail: string[]) => {
    if (state.get(p.produces) === 'done') return
    if (state.get(p.produces) === 'visiting') throw new Error(`the programs read each other in a circle: ${[...trail, p.produces].join(' → ')}`)
    state.set(p.produces, 'visiting')
    for (const r of p.reads) { const q = byName.get(r); if (q) visit(q, [...trail, p.produces]) }
    state.set(p.produces, 'done'); out.push(p)
  }
  for (const p of model.programs) visit(p, [])
  return out
}

/** Everything downstream of an object: what must be produced again when it changes. */
export function downstream(model: Model, object: string): string[] {
  const out = new Set<string>()
  const go = (o: string) => { for (const p of model.programs) if (p.reads.includes(o) && !out.has(p.produces)) { out.add(p.produces); go(p.produces) } }
  go(object)
  return [...out]
}

export function materialise(model: Model, interventions: Intervention[] = []): Instance {
  const problems = interventionProblems(model.schema, interventions)
  if (problems.length) throw new Error(problems.join('; '))
  const I: Instance = { elements: {}, rows: {} }
  for (const p of order(model)) {
    const produced = p.run(I)
    const isFact = model.schema.objects[p.produces]?.kind === 'fact'
    if (isFact) I.rows[p.produces] = structuredClone(produced as Row[])
    else I.elements[p.produces] = structuredClone(produced as Record<Key, Element>)
    const mine = interventions.filter((i) => i.on === p.produces)
    if (mine.length) { const changed = applyToInstance(model.schema, I, mine); I.rows = changed.rows; I.elements = changed.elements }
  }
  const broken = conformance(model.schema, I)
  if (broken.length) throw new Error(`the data does not conform to ${model.schema.name}:\n  ${broken.join('\n  ')}`)
  return I
}

export interface Comparison { columns: Result['columns']; rows: Array<{ key: Array<Key | null>; actual: Array<number | null>; intervened: Array<number | null>; difference: Array<number | null> }>; notes: string[] }

/** The same question with and without the interventions, side by side. */
export function counterfactual(model: Model, q: Question, interventions: Intervention[]): Comparison {
  const v = check(model.schema, q)
  if (!v.ok) throw new Error(`${v.rule}: ${v.reason}`)
  const n = v.plan.targets.length
  const a = evaluate(model.schema, materialise(model), v.plan)
  const b = evaluate(model.schema, materialise(model, interventions), v.plan)
  const index = (r: Result) => new Map(r.rows.map((row) => [JSON.stringify(row.slice(0, n)), row]))
  const ai = index(a), bi = index(b)
  const keys = [...new Set([...ai.keys(), ...bi.keys()])].sort()
  return {
    columns: v.plan.columns,
    rows: keys.map((k) => {
      const x = (ai.get(k)?.slice(n) ?? v.plan.outputs.map(() => null)) as Array<number | null>
      const y = (bi.get(k)?.slice(n) ?? v.plan.outputs.map(() => null)) as Array<number | null>
      return { key: JSON.parse(k), actual: x, intervened: y, difference: x.map((xv, i) => (xv === null || y[i] === null ? null : y[i]! - xv)) }
    }),
    notes: [...v.plan.notes, `changed: ${interventions.map((i) => i.on).join(', ')}; produced again: ${[...new Set(interventions.flatMap((i) => downstream(model, i.on)))].join(', ') || 'nothing'}`],
  }
}
