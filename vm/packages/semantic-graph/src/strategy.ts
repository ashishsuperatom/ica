// ── A METHOD, KEPT ───────────────────────────────────────────────────────────────────────────────────────────
//
// A strategy is not a question and not a program: it is HOW a kind of question is answered, written in the graph's
// own terms with the parts left open. "Count the rows meeting a rule, per thing, over a window" is one method,
// whether the rows are utilisation weeks in one business or safety incidents in another.
//
//   shape        a pattern with holes: `?fact`, `?thing`. Finding it inside a question says this method applies,
//                and what each hole stands for here.
//   refinements  what to do once it applies — the steps that turn the question into the one worth asking.
//   says         what the answer should carry, in words, so the method also shapes the reading.
//
// WHY IT IS THE SAME MACHINERY. A method is stored, matched and instantiated by the operations patterns already
// have (`match`, `instantiate`, `refine`). Nothing here knows anything about a business, which is why a method
// written once travels to the next one.

import type { Schema } from './schema.js'
import type { Pattern } from './pattern.js'
import { instantiate, match, refine, type Binding, type Outcome, type Refinement, type Shape } from './pattern-ops.js'

export interface Strategy {
  name: string
  /** What kind of question this is a method for, in one line. */
  about: string
  shape: Shape
  /** Applied in order once the shape is found, each named so a person can read what the method did. */
  refinements?: Array<{ step: Refinement; why: string }>
  /** What the answer is expected to carry — for the program that shapes the reading, not for the graph. */
  says?: string[]
  /** Where it came from: a conversation, a document, a person. Kept so a method can be argued with. */
  from?: string
}

/** A method applied to a question: what its holes stood for, the question it became, and what it did. */
export interface MethodApplied {
  strategy: string
  binding: Binding
  /** What each hole stood for, in the graph's names, for reading. */
  stands: Record<string, string>
  pattern: Pattern
  did: string[]
}

/** The methods that apply to this question, each with what its holes stood for. */
export function applicable(p: Pattern, strategies: Strategy[]): Array<{ strategy: Strategy; binding: Binding; stands: Record<string, string> }> {
  const out: Array<{ strategy: Strategy; binding: Binding; stands: Record<string, string> }> = []
  const objectOf = new Map(p.nodes.map((n) => [n.id, n.object]))
  for (const strategy of strategies) {
    for (const binding of match(p, strategy.shape)) {
      out.push({ strategy, binding, stands: Object.fromEntries(Object.entries(binding).map(([hole, id]) => [hole, objectOf.get(id) ?? id])) })
    }
  }
  return out
}

/** Apply a method to the question it was found in: its refinements, in order, each said out loud. */
export function apply(s: Schema, p: Pattern, strategy: Strategy, binding: Binding): Outcome<MethodApplied> {
  let at = p
  const did: string[] = []
  for (const r of strategy.refinements ?? []) {
    const step = bind(r.step, binding)
    const next = refine(s, at, step)
    if (!next.ok) return { ok: false, reason: `${strategy.name}: ${r.why} — ${next.reason}` }
    at = next.value
    did.push(r.why)
  }
  const objectOf = new Map(p.nodes.map((n) => [n.id, n.object]))
  return { ok: true, value: { strategy: strategy.name, binding, stands: Object.fromEntries(Object.entries(binding).map(([h, id]) => [h, objectOf.get(id) ?? id])), pattern: at, did } }
}

/** A refinement written against holes, with the holes filled in for this question. */
function bind(step: Refinement, binding: Binding): Refinement {
  const swap = (v: string) => (v.startsWith('?') ? binding[v.slice(1)] ?? binding[v] ?? v : binding[v] ?? v)
  return 'node' in step ? { ...step, node: swap(step.node) } : step
}

/** A method as a question of its own, when nothing is there to match it against: the holes are given outright. */
export function fromMethod(s: Schema, strategy: Strategy, stands: Record<string, string>): Outcome<Pattern> {
  return instantiate(s, strategy.shape, stands)
}

/** A method, as a person reads it. */
export function strategyText(x: Strategy): string {
  const holes = x.shape.nodes.filter((n) => n.object.startsWith('?')).map((n) => `${n.object}${n.group ? ' (grouped by)' : ''}${n.root ? ' (the fact)' : ''}`)
  return [
    `${x.name} — ${x.about}`,
    holes.length ? `  open: ${holes.join(', ')}` : '',
    ...(x.shape.edges.length ? [`  shape: ${x.shape.edges.map((e) => `${e.from} -[${e.role ?? 'any'}]-> ${e.to}`).join(', ')}`] : []),
    ...(x.refinements ?? []).map((r) => `  then: ${r.why}`),
    ...(x.says ?? []).map((t) => `  says: ${t}`),
    x.from ? `  from: ${x.from}` : '',
  ].filter(Boolean).join('\n')
}
