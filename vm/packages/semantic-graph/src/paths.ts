// ── PATHS (§2.3, §5 A) ──────────────────────────────────────────────────────────────────────────────────────
//
// A path is a composite of arrows, so it is itself a function: following it from a row never gives more than one
// thing. Paths equal under the schema's equations are the same function; each is rewritten to a normal form — the
// shortest, then alphabetically first — by orienting every equation that way and rewriting until nothing applies.
// Each rewrite makes the path smaller in that order, so rewriting ends.

import { arrows, walk, type Schema } from './schema.js'

export interface Path { steps: string[]; object: string }

const smaller = (a: string[], b: string[]) => a.length !== b.length ? a.length < b.length : a.join('.') < b.join('.')

/** The normal form of a path from `from` under the schema's equations. */
export function normalise(s: Schema, from: string, steps: string[]): string[] {
  const rules = (s.equations ?? []).map((e) => { const [a, b] = e.paths; return smaller(a, b) ? { on: e.on, lhs: b, rhs: a } : { on: e.on, lhs: a, rhs: b } })
  let path = [...steps]
  for (let changed = true; changed;) {
    changed = false
    let object = from
    for (let i = 0; i < path.length && !changed; i++) {
      for (const r of rules) {
        if (r.on === object && r.lhs.every((x, j) => path[i + j] === x)) { path = [...path.slice(0, i), ...r.rhs, ...path.slice(i + r.lhs.length)]; changed = true; break }
      }
      if (!changed) object = walk(s, object, [path[i]])!.object
    }
  }
  return calendarPart(s, from, path)
}

/** Calendar arrows are computed from keys, so the calendar part of the graph commutes: every path between two calendars
 *  is the same function. A path's calendar part is written as the shortest such path (alphabetically first of those). */
function calendarPart(s: Schema, from: string, path: string[]): string[] {
  let object = from
  for (let i = 0; i < path.length; i++) {
    if (s.objects[object]?.kind === 'calendar') {
      const end = walk(s, object, path.slice(i))!.object
      const shortest = shortestCalendarPath(s, object, end)
      return shortest && smaller(shortest, path.slice(i)) ? [...path.slice(0, i), ...shortest] : path
    }
    object = walk(s, object, [path[i]])!.object
  }
  return path
}
function shortestCalendarPath(s: Schema, from: string, to: string): string[] | undefined {
  let frontier: Array<{ at: string; steps: string[] }> = [{ at: from, steps: [] }]
  const seen = new Set([from])
  while (frontier.length) {
    const found = frontier.filter((f) => f.at === to).map((f) => f.steps).sort((a, b) => a.join('.').localeCompare(b.join('.')))
    if (found.length) return found[0]
    const next: typeof frontier = []
    for (const f of frontier) for (const a of arrows(s, f.at)) if (!seen.has(a.to)) next.push({ at: a.to, steps: [...f.steps, a.role] })
    for (const n of next) seen.add(n.at)
    frontier = next
  }
  return undefined
}

/** Every path from an object along arrows, up to `maxSteps` arrows, in normal form and without repeats. A path may
 *  visit an object twice (a person's manager's manager); only its length bounds it. */
export function pathsFrom(s: Schema, from: string, maxSteps = 4): Path[] {
  const seen = new Map<string, Path>()
  const go = (object: string, steps: string[]) => {
    if (steps.length) {
      const n = normalise(s, from, steps)
      const key = n.join('.')
      if (!seen.has(key)) seen.set(key, { steps: n, object })
    }
    if (steps.length >= maxSteps) return
    for (const a of arrows(s, object)) go(a.to, [...steps, a.role])
  }
  go(from, [])
  return [...seen.values()]
}

export const pathText = (p: string[]) => p.join('.')
