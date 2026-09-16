// ── THE QUESTION AS A GRAPH ──────────────────────────────────────────────────────────────────────────────────
//
// A question written as a record says what is wanted; a question written as a PATTERN says it in the same terms as
// the schema — objects as nodes, arrows as edges — so the two can be worked on by the same operations. That is what
// a record cannot do: two records cannot be glued, a half-written record cannot be completed, and a filter inside a
// record cannot be pushed anywhere.
//
//   nodes    an object the question stands at: the fact it measures, and each object reached on the way to a
//            grouping or a filter. A grouping node is SHARED by every fact that reaches it — which is what makes
//            two facts comparable, so "conformed dimension" stops being a rule and becomes one node in a drawing.
//   edges    an arrow walked, carrying what a traversal needs to decide: its kind, and whether it may lead nowhere.
//   measures what is aggregated, carrying its unit, its kind and how it folds.
//
// WHAT TRAVELS ON THE EDGE IS THE POINT. Summarisability is not a table consulted elsewhere: a measure's kind and an
// arrow's kind meet at each step, and `admissible` says whether that step is allowed and why not. A traversal that
// walks the graph answers "may this be added up along here" as it goes.
//
// The coordinates of the ANSWER — order, limit, having, totals, share, compare, along, the span, the reporting
// currency — are not graph structure; they are what is done to the result once the graph has been walked. They ride
// along unchanged (`coords`) rather than being pretended into nodes.

import { check, type Condition, type FactPlan, type Plan, type Question, type Step } from './algebra.js'
import { arrow, arrows, type Aggregate, type ArrowKind, type MeasureKind, type Schema } from './schema.js'

/** An object the question stands at. `attribute` marks a value carried by that object rather than the object. */
export interface PatternNode {
  id: string
  object: string
  kind: 'entity' | 'calendar' | 'fact'
  /** An attribute of the object, when the question groups or filters by a value rather than by a thing. */
  attribute?: string
  /** This node's members are an output coordinate; `order` is where it sits among them. */
  group?: { order: number }
  /** Kept to these members. Several filters on one node are several entries. */
  keep?: Array<Condition & { under?: string }>
  /** The fact this question measures — where every walk begins. */
  root?: true
  /** For a value carried by the fact's own row: the fact node it hangs off, since no arrow leads to it. */
  owner?: string
}

/** An arrow walked. `kind` and `partial` are here so a traversal never has to look them up. */
export interface PatternEdge { from: string; to: string; role: string; kind: ArrowKind; partial: boolean }

/** What is aggregated, with everything needed to know how it folds. */
export interface PatternMeasure {
  id: string
  at: string            // the fact node it is rooted at
  fact: string
  measure: string
  unit: string
  kind: MeasureKind
  aggregate: Aggregate
  weight?: string
  versions?: string
  overTime?: 'last' | 'first' | 'average'
}

/** The whole question. `outputs` name what is reported (a measure, or an expression over measures, as written). */
export interface Pattern {
  nodes: PatternNode[]
  edges: PatternEdge[]
  measures: PatternMeasure[]
  outputs: string[]
  /** What is done to the result after the walk: the answer's coordinates, carried as asked. */
  coords: Omit<Question, 'measures' | 'by' | 'where'>
}

const nodeKey = (object: string, attribute?: string) => `${object}${attribute ? `.@${attribute}` : ''}`

// ── FROM A QUESTION ──────────────────────────────────────────────────────────────────────────────────────────
// Built from the CHECKED plan, never from the question as typed: the plan has already resolved every path to its
// normal form, so two questions that mean the same thing draw the same pattern.

export function fromPlan(s: Schema, plan: Plan, q: Question): Pattern {
  const nodes: PatternNode[] = []
  const edges: PatternEdge[] = []
  const measures: PatternMeasure[] = []
  const byId = new Map<string, PatternNode>()
  const add = (id: string, object: string, attribute?: string, root?: true): PatternNode => {
    const found = byId.get(id)
    if (found) return found
    const n: PatternNode = { id, object, kind: s.objects[object].kind, ...(attribute ? { attribute } : {}), ...(root ? { root } : {}) }
    byId.set(id, n); nodes.push(n)
    return n
  }
  const edge = (from: string, to: string, at: string, role: string) => {
    if (edges.some((e) => e.from === from && e.to === to && e.role === role)) return
    const a = arrow(s, at, role)!
    edges.push({ from, to, role, kind: a.kind!, partial: !!a.partial })
  }

  // Each fact stands at its own node; the objects it walks through are its own, so two facts never share a route.
  // Only the END of a path is shared — that node IS the conformed dimension.
  for (const fp of plan.facts) {
    const factId = `fact:${fp.fact}`
    add(factId, fp.fact, undefined, true)
    for (const m of fp.measures) {
      const d = s.objects[fp.fact].measures![m]
      measures.push({ id: `${fp.fact}.${m}`, at: factId, fact: fp.fact, measure: m, unit: d.unit, kind: d.kind,
        aggregate: d.aggregate, ...(d.weight ? { weight: d.weight } : {}), ...(d.versions ? { versions: d.versions } : {}),
        ...(d.overTime ? { overTime: d.overTime } : {}) })
    }
    const walkTo = (step: Step, shared: boolean): PatternNode => {
      const path = 'attribute' in step ? (step.at ?? []) : step.path
      let at = fp.fact, id = factId
      path.forEach((role, i) => {
        const to = arrow(s, at, role)!.to
        // Everything before the end belongs to this fact's route; the end is shared when it is a grouping.
        const last = i === path.length - 1
        const next = last && shared ? nodeKey(to, 'attribute' in step ? step.attribute : undefined) : `${factId}/${path.slice(0, i + 1).join('.')}`
        add(next, to, last && 'attribute' in step ? step.attribute : undefined)
        edge(id, next, at, role)
        at = to; id = next
      })
      if (!path.length) {
        // An attribute of the fact's own row, or a grouping by the fact itself.
        if ('attribute' in step) {
          const n = add(shared ? nodeKey(fp.fact, step.attribute) : `${factId}/@${step.attribute}`, fp.fact, step.attribute)
          n.owner = factId
          return n
        }
        return byId.get(factId)!
      }
      return byId.get(id)!
    }
    fp.by.forEach((step, i) => {
      const n = walkTo(step, true)
      n.group = { order: plan.targets.length ? Math.max(0, plan.targets.indexOf(targetName(s, fp, step))) : i }
    })
    for (const w of fp.where) {
      const { path, attribute, at, ...cond } = w as any
      const n = walkTo('attribute' in w ? { attribute: w.attribute, at: w.at } as Step : { path: (w as any).path }, false)
      ;(n.keep ??= []).push(cond as Condition & { under?: string })
    }
  }

  const { measures: _m, by: _b, where: _w, ...coords } = q
  return { nodes, edges, measures, outputs: plan.outputs.map((o) => o.name), coords }
}

/** The name a plan gives a grouping — the column it produces — so a shared node keeps the question's order. */
function targetName(s: Schema, fp: FactPlan, step: Step): string {
  if ('attribute' in step) {
    const owner = step.at?.length ? walkObject(s, fp.fact, step.at) : fp.fact
    return step.at?.length ? `${owner}.${step.attribute}` : step.attribute
  }
  return walkObject(s, fp.fact, step.path)
}
const walkObject = (s: Schema, from: string, path: string[]) => path.reduce((at, role) => arrow(s, at, role)!.to, from)

/** A question's pattern: checked first, so the drawing is of what would actually be answered. */
export function patternOf(s: Schema, q: Question, context?: { today?: string }): { ok: true; pattern: Pattern } | { ok: false; rule: string; reason: string } {
  const verdict = check(s, q, context)
  if (!verdict.ok) return { ok: false, rule: verdict.rule, reason: verdict.reason }
  return { ok: true, pattern: fromPlan(s, verdict.plan, q) }
}

// ── BACK TO A QUESTION ───────────────────────────────────────────────────────────────────────────────────────
// The pattern is the truth; a question is one serialisation of it. Going back is what lets every existing tool —
// the checker, the compiler, the tools an agent runs — keep working while the pattern becomes the thing we hold.

export function toQuestion(s: Schema, p: Pattern): Question {
  // Every route to every node, from each fact that reaches it. A node reached by two facts by different arrows is
  // exactly the case a question writes as a per-fact `via` — and it is the shape that makes two facts comparable.
  const routes = new Map<string, Array<{ fact: string; path: string[] }>>()
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  for (const root of p.nodes.filter((n) => n.root)) {
    const seen = new Set<string>([root.id])
    let edge: Array<{ id: string; path: string[] }> = [{ id: root.id, path: [] }]
    routes.set(root.id, [...(routes.get(root.id) ?? []), { fact: root.object, path: [] }])
    while (edge.length) {
      const next: typeof edge = []
      for (const at of edge) {
        for (const e of p.edges.filter((x) => x.from === at.id)) {
          if (seen.has(e.to)) continue
          seen.add(e.to)
          const path = [...at.path, e.role]
          routes.set(e.to, [...(routes.get(e.to) ?? []), { fact: root.object, path }])
          next.push({ id: e.to, path })
        }
      }
      edge = next
    }
  }
  // A value carried by a fact's own row has no arrow leading to it; it belongs to the fact it hangs off.
  for (const n of p.nodes) if (n.owner && !routes.has(n.id)) routes.set(n.id, [{ fact: byId.get(n.owner)!.object, path: [] }])

  /** How a question names the way to this node: nothing when there is one route of no steps, a path when every
   *  fact walks the same one, and a path per fact when they differ. */
  const allFacts = p.nodes.filter((n) => n.root).map((n) => n.object)
  const viaOf = (id: string) => {
    const rs = routes.get(id) ?? []
    if (!rs.length || rs.every((r) => !r.path.length)) return undefined
    const distinct = new Set(rs.map((r) => r.path.join('.')))
    // One path every fact walks is written once; otherwise each fact says its own — including when a node is
    // reached by only some of them, which is how a filter stays about the fact it belongs to.
    const reaches = new Set(rs.map((r) => r.fact))
    if (distinct.size === 1 && allFacts.every((f) => reaches.has(f))) return rs[0].path
    return Object.fromEntries(rs.map((r) => [r.fact, r.path]))
  }
  const ofOwner = (n: PatternNode) => {
    const rs = routes.get(n.id) ?? []
    return rs.length && rs.every((r) => !r.path.length && r.fact === n.object) ? undefined : n.object
  }

  const by = p.nodes.filter((n) => n.group).sort((a, b) => a.group!.order - b.group!.order).map((n) => {
    const via = viaOf(n.id)
    const target = n.attribute ? { attribute: n.attribute, ...(ofOwner(n) ? { of: n.object } : {}) } : { to: n.object }
    return via ? { ...target, via } : target
  })

  const where: NonNullable<Question['where']> = []
  for (const n of p.nodes) for (const k of n.keep ?? []) {
    const via = viaOf(n.id)
    const target = n.attribute ? { attribute: n.attribute, ...(ofOwner(n) ? { of: n.object } : {}) } : { to: n.object }
    where.push({ ...target, ...(via ? { via } : {}), ...k } as NonNullable<Question['where']>[number])
  }
  return { measures: p.outputs, ...(by.length ? { by } : {}), ...(where.length ? { where } : {}), ...p.coords } as Question
}

// ── WHAT A TRAVERSAL IS ALLOWED TO DO ────────────────────────────────────────────────────────────────────────
// The local law, carried by the nodes and edges themselves. Walking one step with a measure in hand, this says
// whether the step keeps the measure meaningful — and when it does not, why, in the schema's own words.

export function admissible(m: PatternMeasure, e: PatternEdge, to: PatternNode): { ok: true } | { ok: false; reason: string } {
  // A version arrow separates values that are never added together.
  if (e.kind === 'version' && !m.versions) return { ok: false, reason: `${m.fact}.${m.measure} is not kept in versions, so ${e.role} is not a way to group it` }
  if (m.versions && e.kind !== 'version' && e.role === m.versions) return { ok: false, reason: `${m.fact}.${m.measure} is kept in ${e.role} versions, which are never added together` }
  // A level at an instant adds across things, never over time, unless it says which instant stands for the period.
  if (m.kind === 'stock' && (e.kind === 'rollup' || to.kind === 'calendar') && !m.overTime) {
    return { ok: false, reason: `${m.fact}.${m.measure} is a level at an instant; over ${to.object}s it needs to say whether it is the last, the first or the average level` }
  }
  // A rate is never summed; it is combined only as its own definition says.
  if (m.kind === 'value-per-unit' && !['min', 'max', 'median', 'weighted average'].includes(m.aggregate)) {
    return { ok: false, reason: `${m.fact}.${m.measure} is a value per unit; it is combined by min, max, median or a weighted average, never by ${m.aggregate}` }
  }
  return { ok: true }
}

/** Every step out of a node, with whether a measure may be carried along it — the traversal's own answer. */
export function stepsFrom(s: Schema, p: Pattern, nodeId: string, m?: PatternMeasure) {
  const n = p.nodes.find((x) => x.id === nodeId)
  if (!n) return []
  return arrows(s, n.object).map((a) => {
    const e: PatternEdge = { from: nodeId, to: nodeKey(a.to), role: a.role, kind: a.kind!, partial: !!a.partial }
    const to: PatternNode = { id: nodeKey(a.to), object: a.to, kind: s.objects[a.to].kind }
    return { role: a.role, to: a.to, kind: a.kind!, partial: !!a.partial, ...(m ? { allowed: admissible(m, e, to) } : {}) }
  })
}

// ── READING AND IDENTITY ─────────────────────────────────────────────────────────────────────────────────────

/** The pattern as a drawing, in the graph's own notation. */
export function patternText(p: Pattern): string {
  const lines: string[] = []
  const label = (id: string) => {
    const n = p.nodes.find((x) => x.id === id)!
    return `(:${n.object}${n.attribute ? `.@${n.attribute}` : ''}${n.group ? ' *group*' : ''})`
  }
  for (const e of p.edges) lines.push(`${label(e.from)} -[${e.role}${e.kind === 'as-of' ? ' as-of' : ''}]-> ${label(e.to)}${e.partial ? '   may be none' : ''}`)
  for (const n of p.nodes) for (const k of n.keep ?? []) lines.push(`${label(n.id)} keep ${JSON.stringify(k)}`)
  for (const m of p.measures) lines.push(`${m.aggregate} ${m.fact}.${m.measure} (${m.unit}, ${m.kind})`)
  if (p.outputs.length) lines.push(`outputs ${p.outputs.join(', ')}`)
  if (p.coords.span) lines.push(`span ${JSON.stringify(p.coords.span)}`)
  return lines.join('\n')
}

/** Structural identity: the same drawing, however it was written. Node ids are not part of it — their shape is. */
export function patternKey(p: Pattern): string {
  const name = new Map(p.nodes.map((n) => [n.id, nodeKey(n.object, n.attribute)]))
  const parts = [
    ...p.edges.map((e) => `${name.get(e.from)}-[${e.role}]->${name.get(e.to)}`).sort(),
    ...p.nodes.filter((n) => n.group).sort((a, b) => a.group!.order - b.group!.order).map((n) => `group ${name.get(n.id)}`),
    ...p.nodes.flatMap((n) => (n.keep ?? []).map((k) => `keep ${name.get(n.id)} ${JSON.stringify(k)}`)).sort(),
    ...p.measures.map((m) => `${m.aggregate}(${m.fact}.${m.measure})`).sort(),
    `outputs ${p.outputs.join('|')}`,
    `coords ${JSON.stringify(p.coords)}`,
  ]
  return parts.join('\n')
}
