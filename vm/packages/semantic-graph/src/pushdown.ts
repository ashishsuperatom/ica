// ── MOVING WORK TOWARDS THE SOURCE ───────────────────────────────────────────────────────────────────────────
//
// A filter written at the end of a question is work done at the end: everything is read, then almost all of it is
// thrown away. Moving it towards the source is the difference between reading one project's allocations and
// reading nine months of every project's — the same answer, a hundredth of the work.
//
// THE RULE IS LOCAL, AND THAT IS WHY IT IS SAFE. A filter may cross a step when the step cannot change whether the
// filter holds:
//
//   • a filter on the fact's own arrow or attribute crosses everything — it is about the row itself;
//   • a filter on an object reached along a TOTAL path crosses a join towards the source, because every row has
//     exactly one of those, so keeping the row early keeps exactly the same rows;
//   • a filter on a PARTIAL path does not cross, because a row with nothing there must survive long enough to be
//     counted as "none";
//   • a filter on an AS-OF path does not cross, because which element it reaches depends on the row's own date.
//
// A PROGRAM DECLARES WHAT IT ACCEPTS. A program that makes a fact's rows is not a black box: it says which of the
// fact's arrows it can be given ahead of time (`accepts`). A filter that lands on one of those is handed to the
// program as a parameter instead of being applied to its output — so the code reads less, without the planner
// having to understand the code.

import { arrow, type Schema } from './schema.js'
import type { Condition, FactPlan, Plan, Step } from './algebra.js'

/** What a program will take ahead of time: the span it is already given, plus arrows of the fact it produces. */
export interface Ports {
  /** Arrow roles of the produced fact whose members the program can be given: `{ project: true }`. */
  accepts?: Record<string, true>
}

export type Pushed = { role: string; keys: string[] }

/** A filter that may be handed to whoever reads the rows: a filter on one of the fact's own arrows, by members. */
export function pushable(s: Schema, fp: FactPlan, ports: Ports | undefined): { pushed: Pushed[]; kept: FactPlan['where'] } {
  const pushed: Pushed[] = []
  const kept: FactPlan['where'] = []
  for (const w of fp.where) {
    const role = firstStep(w)
    const crosses = role && !('attribute' in w) && (w as { path?: string[] }).path?.length === 1 && 'in' in w && Array.isArray((w as any).in)
    const accepted = crosses && ports?.accepts?.[role!]
    const total = role ? isTotal(s, fp.fact, [role]) : false
    if (accepted && total) pushed.push({ role: role!, keys: (w as any).in.map(String) })
    else kept.push(w)
  }
  return { pushed, kept }
}

const firstStep = (w: Step & Condition): string | undefined => ('attribute' in w ? w.at?.[0] : w.path[0])

/** Every arrow on this path leads somewhere, always, and does not depend on the row's date. */
export function isTotal(s: Schema, from: string, path: string[]): boolean {
  let at = from
  for (const role of path) {
    const a = arrow(s, at, role)
    if (!a || a.partial || a.kind === 'as-of') return false
    at = a.to
  }
  return true
}

/** How far a filter can travel: to the source, to the join, or nowhere. Said in the schema's own words. */
export function travel(s: Schema, fact: string, w: Step & Condition): { to: 'source' | 'join' | 'here'; why: string } {
  if ('attribute' in w && !w.at?.length) return { to: 'source', why: 'it is about the row itself' }
  const path = 'attribute' in w ? w.at ?? [] : w.path
  if (!path.length) return { to: 'source', why: 'it is about the row itself' }
  if (path.length === 1 && isTotal(s, fact, path)) return { to: 'source', why: `every ${fact} row has exactly one ${arrow(s, fact, path[0])!.to}` }
  if (isTotal(s, fact, path)) return { to: 'join', why: 'every step of it leads somewhere, so keeping the row early keeps the same rows' }
  const at = path.findIndex((role, i) => {
    const on = path.slice(0, i).reduce((o, r) => arrow(s, o, r)!.to, fact)
    const a = arrow(s, on, role)!
    return a.partial || a.kind === 'as-of'
  })
  const on = path.slice(0, at).reduce((o, r) => arrow(s, o, r)!.to, fact)
  const a = arrow(s, on, path[at])!
  return { to: 'here', why: a.kind === 'as-of' ? `${on}.${path[at]} changes over time, so which one a row reaches depends on its own date` : `${on}.${path[at]} may lead nowhere, and those rows are kept as "none"` }
}

/** The plan with each fact's filters split into what its reader is given and what is applied after. */
export function pushedPlan(s: Schema, plan: Plan, portsOf: (fact: string) => Ports | undefined): Array<{ fact: string; pushed: Pushed[]; kept: FactPlan['where']; why: string[] }> {
  return plan.facts.map((fp) => {
    const { pushed, kept } = pushable(s, fp, portsOf(fp.fact))
    return {
      fact: fp.fact, pushed, kept,
      why: [
        ...pushed.map((p) => `${fp.fact}.${p.role} is given to the reader: ${p.keys.length} of them`),
        ...kept.map((w) => { const t = travel(s, fp.fact, w); return `a filter stays ${t.to === 'here' ? 'where it is' : `at the ${t.to}`} — ${t.why}` }),
      ],
    }
  })
}
