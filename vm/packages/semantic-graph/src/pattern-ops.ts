// ── WHAT YOU CAN DO TO A PATTERN ─────────────────────────────────────────────────────────────────────────────
//
// Three operations, and every interaction with a question is one of them.
//
//   glue    two patterns become one, joined at the nodes they share. This is how two questions are asked side by
//           side — and the shared node IS the conformed dimension, so nothing else has to agree for it to work.
//   refine  a pattern becomes a more specific pattern: a step further out, a filter added, a measure carried. A
//           conversation is a series of refinements, so the state of a conversation is the pattern it has reached.
//   match   a pattern with HOLES is found inside a pattern, giving what each hole stands for. A method — "count
//           the rows meeting a rule, per thing, over a window" — is written once as holes and recognised wherever
//           it fits, which is how a strategy is stored and reused.
//
// Each returns a new value; nothing is edited in place, so a refused refinement leaves the question it came from
// exactly as it was.

import { arrow, arrows, type Schema } from './schema.js'
import { normalise } from './paths.js'
import type { Condition } from './algebra.js'
import type { Pattern, PatternEdge, PatternNode } from './pattern.js'

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string }
const no = (reason: string): Outcome<never> => ({ ok: false, reason })
const yes = <T>(value: T): Outcome<T> => ({ ok: true, value })

const clone = (p: Pattern): Pattern => structuredClone(p)
const nodeAt = (p: Pattern, id: string) => p.nodes.find((n) => n.id === id)
/** What a node is, apart from where it sits: two patterns share a node when these agree. */
const shape = (n: PatternNode) => `${n.object}${n.attribute ? `.@${n.attribute}` : ''}`

// ── GLUE ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The pushout: everything of both, with the nodes they share identified. Shared means the same GROUPING — the
// routes each fact took to get there stay its own, because they are its own.

export function glue(a: Pattern, b: Pattern): Outcome<Pattern> {
  for (const key of ['span', 'asOf', 'currency'] as const) {
    const x = (a.coords as any)[key], y = (b.coords as any)[key]
    if (x && y && JSON.stringify(x) !== JSON.stringify(y)) return no(`the two questions are asked over different ${key === 'span' ? 'spans' : key === 'asOf' ? 'as-of days' : 'currencies'}, so they cannot be put side by side`)
  }
  const out = clone(a)
  const rename = new Map<string, string>()
  for (const n of b.nodes) {
    // A grouping in both is ONE node; anything else keeps its own identity, prefixed so two facts never collide.
    const here = n.group ? out.nodes.find((x) => x.group && shape(x) === shape(n)) : undefined
    if (here) { rename.set(n.id, here.id); continue }
    const id = out.nodes.some((x) => x.id === n.id) ? `b/${n.id}` : n.id
    rename.set(n.id, id)
    out.nodes.push({ ...structuredClone(n), id })
  }
  for (const e of b.edges) {
    const from = rename.get(e.from)!, to = rename.get(e.to)!
    if (!out.edges.some((x) => x.from === from && x.to === to && x.role === e.role)) out.edges.push({ ...e, from, to })
  }
  for (const m of b.measures) if (!out.measures.some((x) => x.id === m.id)) out.measures.push({ ...structuredClone(m), at: rename.get(m.at)! })
  for (const o of b.outputs) if (!out.outputs.includes(o)) out.outputs.push(o)
  // The order of the groupings is a's, then anything b adds.
  out.nodes.filter((n) => n.group).sort((x, y) => x.group!.order - y.group!.order).forEach((n, i) => { n.group = { order: i } })
  out.coords = { ...b.coords, ...a.coords }
  return yes(out)
}

// ── REFINE ───────────────────────────────────────────────────────────────────────────────────────────────────
// The moves, as maps from one pattern to another. Each says what it did in the graph's own words, so a step of a
// conversation can be read back as a sentence.

export type Refinement =
  | { refine: 'group'; node: string }                             // this node's members become a coordinate
  | { refine: 'ungroup'; node: string }
  | { refine: 'keep'; node: string; where: Condition & { under?: string } }
  | { refine: 'unkeep'; node: string }
  | { refine: 'extend'; node: string; along: string }              // one arrow further out; a grouping travels with it
  | { refine: 'contract'; node: string }                           // back one arrow, towards the fact
  | { refine: 'measure'; add: string }                             // "Fact.measure"
  | { refine: 'unmeasure'; remove: string }
  | { refine: 'span'; span: { from: string; to: string } }

export function refine(s: Schema, p: Pattern, r: Refinement): Outcome<Pattern> {
  const out = clone(p)
  const node = 'node' in r ? nodeAt(out, r.node) : undefined
  if ('node' in r && !node) return no(`this question has no node "${r.node}"`)

  switch (r.refine) {
    case 'group': {
      if (node!.group) return yes(out)
      node!.group = { order: out.nodes.filter((n) => n.group).length }
      return yes(out)
    }
    case 'ungroup': { delete node!.group; reorder(out); return yes(out) }
    case 'keep': { (node!.keep ??= []).push(r.where); return yes(out) }
    case 'unkeep': { delete node!.keep; return yes(out) }
    case 'measure': {
      const [fact, measure] = split(r.add)
      const d = s.objects[fact]?.measures?.[measure]
      if (!d) return no(`there is no measure ${r.add}`)
      const at = out.nodes.find((n) => n.root && n.object === fact)
      if (!at) {
        // A measure of a fact this question does not stand on yet: the fact joins the drawing on its own root.
        const id = `fact:${fact}`
        out.nodes.push({ id, object: fact, kind: 'fact', root: true })
        out.measures.push(measureNode(s, id, fact, measure))
      } else out.measures.push(measureNode(s, at.id, fact, measure))
      if (!out.outputs.includes(r.add)) out.outputs.push(r.add)
      return yes(out)
    }
    case 'unmeasure': {
      out.measures = out.measures.filter((m) => m.id !== r.remove)
      out.outputs = out.outputs.filter((o) => o !== r.remove)
      if (!out.measures.length) return no('a question asks for at least one measure')
      return yes(out)
    }
    case 'span': { out.coords = { ...out.coords, span: r.span }; return yes(out) }
    case 'extend': {
      const a = arrow(s, node!.object, r.along)
      if (!a) return no(`${node!.object} has no link "${r.along}" — its links are ${arrows(s, node!.object).map((x) => x.role).join(', ') || 'none'}`)
      const id = `${node!.id}.${r.along}`
      const next: PatternNode = { id, object: a.to, kind: s.objects[a.to].kind, ...(node!.group ? { group: node!.group } : {}) }
      delete node!.group
      out.nodes.push(next)
      out.edges.push({ from: node!.id, to: id, role: r.along, kind: a.kind!, partial: !!a.partial })
      return yes(out)
    }
    case 'contract': {
      const inbound = out.edges.find((e) => e.to === node!.id)
      if (!inbound) return no(`${node!.object} is where this question begins; there is nothing nearer to the fact`)
      const back = nodeAt(out, inbound.from)!
      if (back.root && node!.group) return no(`${node!.object} is a fact's own coordinate; there is nothing finer to drill down to`)
      if (node!.group) back.group = node!.group
      out.nodes = out.nodes.filter((n) => n.id !== node!.id)
      out.edges = out.edges.filter((e) => e !== inbound)
      return yes(out)
    }
  }
}

const split = (ref: string): [string, string] => { const i = ref.indexOf('.'); return [ref.slice(0, i), ref.slice(i + 1)] }
const reorder = (p: Pattern) => p.nodes.filter((n) => n.group).sort((a, b) => a.group!.order - b.group!.order).forEach((n, i) => { n.group = { order: i } })
function measureNode(s: Schema, at: string, fact: string, measure: string) {
  const d = s.objects[fact].measures![measure]
  return { id: `${fact}.${measure}`, at, fact, measure, unit: d.unit, kind: d.kind, aggregate: d.aggregate,
    ...(d.weight ? { weight: d.weight } : {}), ...(d.versions ? { versions: d.versions } : {}), ...(d.overTime ? { overTime: d.overTime } : {}) }
}

// ── MATCH ────────────────────────────────────────────────────────────────────────────────────────────────────
// A SHAPE is a pattern whose objects may be holes: `?thing` stands for any object, `?fact` for any fact. Finding
// a shape inside a pattern gives what each hole stands for — which is how a method recognises the questions it
// answers, without knowing anything about this organisation.

export interface Shape {
  nodes: Array<{ id: string; object: string; group?: true; keep?: true; root?: true }>
  edges: Array<{ from: string; to: string; role?: string; kind?: PatternEdge['kind'] }>
  measures?: Array<{ at: string; kind?: PatternNode['kind'] extends never ? never : string; aggregate?: string }>
}
export type Binding = Record<string, string>   // hole → the node id it stands for

const hole = (object: string) => object.startsWith('?')

export function match(p: Pattern, shape: Shape): Binding[] {
  const out: Binding[] = []
  const nodes = shape.nodes
  const fits = (sn: Shape['nodes'][number], n: PatternNode) =>
    (hole(sn.object) || sn.object === n.object) && (!sn.group || !!n.group) && (!sn.keep || !!n.keep?.length) && (!sn.root || !!n.root)

  const walk = (i: number, bound: Binding) => {
    if (i === nodes.length) {
      // Every edge of the shape must be an edge of the pattern, between the nodes the holes landed on.
      for (const e of shape.edges) {
        const from = bound[e.from], to = bound[e.to]
        const found = p.edges.find((x) => x.from === from && x.to === to && (!e.role || x.role === e.role) && (!e.kind || x.kind === e.kind))
        if (!found) return
      }
      for (const m of shape.measures ?? []) {
        const at = bound[m.at]
        if (!p.measures.some((x) => x.at === at && (!m.aggregate || x.aggregate === m.aggregate))) return
      }
      out.push({ ...bound })
      return
    }
    const sn = nodes[i]
    for (const n of p.nodes) {
      if (!fits(sn, n)) continue
      if (Object.values(bound).includes(n.id)) continue   // one node per hole
      walk(i + 1, { ...bound, [sn.id]: n.id })
    }
  }
  walk(0, {})
  return out
}

/** Fill a shape's holes with real objects — the other direction, for turning a stored method into a question. */
export function instantiate(s: Schema, shape: Shape, binding: Record<string, string>): Outcome<Pattern> {
  const nodes: PatternNode[] = []
  const edges: PatternEdge[] = []
  for (const sn of shape.nodes) {
    const object = hole(sn.object) ? binding[sn.id] ?? binding[sn.object] : sn.object
    if (!object) return no(`the method leaves ${sn.object} open, and nothing was given for it`)
    if (!s.objects[object]) return no(`there is no ${object}`)
    nodes.push({ id: sn.id, object, kind: s.objects[object].kind, ...(sn.group ? { group: { order: nodes.filter((n) => n.group).length } } : {}), ...(sn.root ? { root: true } : {}) })
  }
  for (const e of shape.edges) {
    const from = nodes.find((n) => n.id === e.from), to = nodes.find((n) => n.id === e.to)
    if (!from || !to) return no('the method links a node it does not have')
    const role = e.role ?? arrows(s, from.object).find((a) => a.to === to.object)?.role
    if (!role) return no(`${from.object} has no link to ${to.object}`)
    const a = arrow(s, from.object, role)!
    edges.push({ from: from.id, to: to.id, role, kind: a.kind!, partial: !!a.partial })
  }
  return yes({ nodes, edges, measures: [], outputs: [], coords: {} })
}

// ── PATHS, FOR THE OPERATIONS ABOVE ──────────────────────────────────────────────────────────────────────────

/** The route a node was reached by, in normal form — what a question would write as `via`. */
export function routeTo(s: Schema, p: Pattern, id: string): { fact: string; path: string[] } | undefined {
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const back = (at: string, path: string[]): { fact: string; path: string[] } | undefined => {
    if (seen.has(at)) return undefined
    seen.add(at)
    const n = byId.get(at)
    if (!n) return undefined
    if (n.root) return { fact: n.object, path: normalise(s, n.object, path) }
    if (n.owner) return { fact: byId.get(n.owner)!.object, path }
    const inbound = p.edges.find((e) => e.to === at)
    return inbound ? back(inbound.from, [inbound.role, ...path]) : undefined
  }
  return back(id, [])
}
