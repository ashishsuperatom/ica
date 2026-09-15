// ── NAVIGATION AND STATE (§6, §7) ───────────────────────────────────────────────────────────────────────────
//
// A state is a question. A move changes it — drill up along an arrow, drill down, slice, add a measure — and the new
// question is checked before it is kept; a refused move leaves the state as it was and says why. nextMoves() lists
// the moves that are allowed from here, computed from the arrows, never guessed.

import { check, type Filter, type Question, type Target, type Verdict } from './algebra.js'
import { normalise } from './paths.js'
import { arrows, type Schema } from './schema.js'

export type Move =
  | { move: 'drill up'; target: number; along: string }
  | { move: 'drill down'; target: number }
  | { move: 'split'; by: Target }
  | { move: 'unsplit'; target: number }
  | { move: 'slice'; where: Filter }
  | { move: 'unslice'; filter: number }
  | { move: 'add measure'; measure: string }
  | { move: 'remove measure'; measure: string }
  | { move: 'span'; span: { from: string; to: string } }

/** The path each fact takes to a target, as the checked plan resolved it. */
function resolvedVia(s: Schema, q: Question, i: number): Record<string, string[]> | undefined {
  const v = check(s, q)
  if (!v.ok) return undefined
  const out: Record<string, string[]> = {}
  for (const f of v.plan.facts) { const b = f.by[i]; if (b && 'path' in b) out[f.fact] = b.path }
  return out
}
const objectAt = (s: Schema, fact: string, path: string[]) => path.reduce((o, role) => { const raw = s.objects[o].arrows![role]; return typeof raw === 'string' ? raw : raw.to }, fact)

export function applyMove(s: Schema, q: Question, m: Move): { question: Question; verdict: Verdict } {
  const next: Question = structuredClone(q)
  const by = next.by ?? (next.by = [])
  if (m.move === 'drill up' || m.move === 'drill down') {
    const t = by[m.target]
    const via = t && 'to' in t ? resolvedVia(s, q, m.target) : undefined
    if (!via) return { question: q, verdict: check(s, next) }
    const paths = Object.fromEntries(Object.entries(via).map(([f, p]) => [f, m.move === 'drill up' ? normalise(s, f, [...p, m.along]) : p.slice(0, -1)]))
    if (Object.values(paths).some((p) => !p.length)) return { question: q, verdict: { ok: false, rule: 'move', reason: `${(t as any).to} is a fact's own coordinate; there is nothing finer to drill down to` } }
    const [fact, path] = Object.entries(paths)[0]
    by[m.target] = { to: objectAt(s, fact, path), via: paths }
  }
  if (m.move === 'split') by.push(m.by)
  if (m.move === 'unsplit') by.splice(m.target, 1)
  if (m.move === 'slice') (next.where ??= []).push(m.where)
  if (m.move === 'unslice') next.where?.splice(m.filter, 1)
  if (m.move === 'add measure') next.measures.push(m.measure)
  if (m.move === 'remove measure') next.measures = next.measures.filter((x) => x !== m.measure)
  if (m.move === 'span') next.span = m.span
  const verdict = check(s, next)
  return verdict.ok ? { question: next, verdict } : { question: q, verdict }
}

/** Every drill and measure move that is allowed from this question. */
export function nextMoves(s: Schema, q: Question): Array<{ move: Move; reads: string }> {
  const v = check(s, q)
  if (!v.ok) return []
  const out: Array<{ move: Move; reads: string }> = []
  const allowed = (m: Move) => applyMove(s, q, m).verdict.ok
  ;(q.by ?? []).forEach((t, i) => {
    if (!('to' in t)) return
    const fact = v.plan.facts[0], b = fact.by[i]
    if (!('path' in b)) return
    const at = objectAt(s, fact.fact, b.path)
    for (const a of arrows(s, at)) { const m: Move = { move: 'drill up', target: i, along: a.role }; if (allowed(m)) out.push({ move: m, reads: `${t.to} → ${a.to} (${a.role})` }) }
    if (b.path.length > 1) { const m: Move = { move: 'drill down', target: i }; if (allowed(m)) out.push({ move: m, reads: `${t.to} → ${objectAt(s, fact.fact, b.path.slice(0, -1))}` }) }
  })
  for (const [name, o] of Object.entries(s.objects)) {
    if (o.kind !== 'fact') continue
    for (const m of Object.keys(o.measures ?? {})) {
      const ref = `${name}.${m}`
      if (q.measures.includes(ref)) continue
      const move: Move = { move: 'add measure', measure: ref }
      if (allowed(move)) out.push({ move, reads: `add ${ref}` })
    }
  }
  return out
}

/** One text for every question that means the same (§7.1): measures and targets in order of text, paths in normal
 *  form as the plan resolved them, filters sorted, members as keys. */
export function canonical(s: Schema, q: Question): string | undefined {
  const v = check(s, q)
  if (!v.ok) return undefined
  const facts = [...v.plan.facts].sort((a, b) => a.fact.localeCompare(b.fact)).map((f) => ({
    fact: f.fact, measures: [...f.measures].sort(),
    by: f.by.map((b) => ('path' in b ? b.path.join('.') : `${b.at?.length ? b.at.join('.') + '.' : ''}@${b.attribute}`)).sort(),
    where: f.where.map((w) => `${'path' in w ? w.path.join('.') : `${w.at?.length ? w.at.join('.') + '.' : ''}@${w.attribute}`}${w.under ? `^${w.under}` : ''}${'in' in w ? `∈${[...w.in].sort().join('|')}` : 'notIn' in w ? `∉${[...w.notIn].sort().join('|')}` : 'none' in w ? (w.none ? '=∅' : '≠∅') : 'range' in w ? `∈[${w.range.from ?? ''},${w.range.to ?? ''})` : 'contains' in w ? `~*${w.contains.toLowerCase()}*` : `~${(w as { startsWith: string }).startsWith.toLowerCase()}*`}`).sort(),
    convert: f.convert,
  }))
  return JSON.stringify({ outputs: v.plan.outputs.map((o) => o.name).sort(), facts, span: q.span ?? null, asOf: q.asOf ?? null, order: q.order ?? null, limit: q.limit ?? null, having: q.having ?? null, totals: q.totals ?? null, share: q.share ?? null, compare: q.compare ?? null, fill: q.fill ?? null, cumulative: q.cumulative ?? null, rolling: q.rolling ?? null, limitPer: q.limitPer ?? null })
}
