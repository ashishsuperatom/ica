// ── FROM WHAT WAS SAID TO WHAT CAN BE ASKED ──────────────────────────────────────────────────────────────────
//
// Two steps, and only the second is lazy.
//
//   RESOLVE, eagerly. Words are turned into things before anything else happens: a measure, an object, a named
//   condition, a record at its source. This cannot wait, because nothing can be planned around a word. A word that
//   means more than one thing is not an error and not a guess — it is kept as several meanings.
//
//   COMPLETE, and let the graph decide. A fragment — some measures, some objects, some records, no paths — is
//   finished by walking the schema: which fact can carry these measures, which route reaches each object, which
//   fact a record belongs to. Where there is more than one way, every way is built, and they are RANKED. Going
//   further is what separates them: a route that leads nowhere for this fact drops out, a shorter route through a
//   declared default outranks a long one through an arrow that may be empty.
//
// What comes back is therefore not an answer but a small set of complete questions, each with the reason it was
// built that way and what was uncertain about it — which is the difference between a system that guesses and one
// that offers.

import { check, type Question } from './algebra.js'
import { resolveSpan, type SpanAsked } from './time.js'
import { arrows, type Schema } from './schema.js'
import { paths } from './discovery.js'
import type { Found } from './discovery.js'
/** What a term came to: something of the graph, a span the question stated, or a plain number. */
type Meaning = Found | { kind: 'span'; span: SpanAsked; reads?: string } | { kind: 'number'; value: number }
import { patternOf, type Pattern } from './pattern.js'

/** What the words came to, before any path is known. A value may mean several things; each is kept. */
export interface Fragment {
  /** `Fact.measure`, or a bare measure name to be found among the facts. */
  measures: string[]
  /** Objects to group by, named without a route. */
  by?: string[]
  /** Attributes to group by: of the fact itself, or of an object it reaches. */
  byAttribute?: Array<{ attribute: string; of?: string }>
  /** A record named in the question: what it might be, in the graph's terms. */
  values?: Array<{ text: string; meanings: Array<{ object: string; key: string; label?: string }> }>
  /** Named conditions to keep to. */
  conditions?: string[]
  /** As a question is asked: two days, `through` for the last day, or a relative span ("this Month"). */
  span?: SpanAsked
  currency?: string
  asOf?: string
  /** The words the question used, for saying which of them a reading accounts for. */
  phrases?: string[]
}

export interface Completion {
  question: Question
  pattern: Pattern
  /** Why it was built this way, one line per decision — the route taken, the fact chosen, the record read. */
  why: string[]
  /** What had more than one answer, so a reader knows where to look if this is the wrong one. */
  uncertain: string[]
  /** Lower is better: steps walked, arrows that may be empty, meanings that had to be chosen between. */
  cost: number
}

const MAX_STEPS = 4

/** Every way this fragment could be a question, best first. Empty when the graph holds no way at all. */
export function complete(s: Schema, f: Fragment, limit = 5): Completion[] {
  return completions(s, f, limit).done
}

/** The same, with what was built and refused — so "nothing completed" can say why, which is usually one missing
 *  thing the asker can give (a currency to report in, a version to keep to). */
export function completions(s: Schema, f: Fragment, limit = 5): { done: Completion[]; refused: Array<{ question: Question; rule: string; reason: string }> } {
  const done: Completion[] = []
  const refused: Array<{ question: Question; rule: string; reason: string }> = []
  for (const candidate of candidates(s, f)) {
    const verdict = check(s, candidate.question)
    if (!verdict.ok) { refused.push({ question: candidate.question, rule: verdict.rule, reason: verdict.reason }); continue }
    const p = patternOf(s, candidate.question)
    if (!p.ok) continue
    done.push({ ...candidate, pattern: p.pattern })
  }
  // Cheapest first; among equals, the one that left least uncertain.
  done.sort((a, b) => a.cost - b.cost || a.uncertain.length - b.uncertain.length || a.why.length - b.why.length)
  return { done: done.slice(0, limit), refused }
}

/** The facts that can carry every measure named, with each measure resolved to `Fact.measure`. */
function factsFor(s: Schema, measures: string[]): Array<{ fact: string; measures: string[]; why: string[] }> {
  const named = measures.map((m) => {
    if (m.includes('.')) { const [fact, measure] = [m.slice(0, m.indexOf('.')), m.slice(m.indexOf('.') + 1)]; return { asked: m, on: [{ fact, measure }] } }
    const on = Object.entries(s.objects).flatMap(([fact, o]) => Object.entries(o.measures ?? {})
      .filter(([name, d]) => name === m || (d.synonyms ?? []).includes(m)).map(([measure]) => ({ fact, measure })))
    return { asked: m, on }
  })
  if (named.some((n) => !n.on.length)) return []
  // Every combination of facts the measures could sit on; in practice one or two.
  let combos: Array<Array<{ fact: string; measure: string }>> = [[]]
  for (const n of named) combos = combos.flatMap((c) => n.on.map((o) => [...c, o]))
  const byFact = new Map<string, { fact: string; measures: string[]; why: string[] }>()
  for (const combo of combos) {
    const facts = [...new Set(combo.map((c) => c.fact))]
    if (facts.length !== 1) continue   // several facts side by side is a glue, not a completion
    const fact = facts[0]
    if (!s.objects[fact]?.measures) continue
    const why = named.filter((n) => !n.asked.includes('.')).map((n) => `"${n.asked}" is ${fact}.${combo.find((c) => c.measure === n.asked || true)!.measure}`)
    byFact.set(fact, { fact, measures: combo.map((c) => `${fact}.${c.measure}`), why })
  }
  return [...byFact.values()]
}

/** Routes from a fact to an object, best first: the declared default, then the shortest, then the rest. */
function routes(s: Schema, fact: string, to: string): Array<{ path: string[]; why: string; cost: number }> {
  const found = paths(s, fact, to, MAX_STEPS)
  const declared = s.objects[fact].defaults?.[to]
  return found.map((path) => {
    const partial = path.some((role, i) => {
      const at = path.slice(0, i).reduce((o, r) => arrows(s, o).find((a) => a.role === r)!.to, fact)
      return !!arrows(s, at).find((a) => a.role === role)?.partial
    })
    const isDefault = declared && declared.join('.') === path.join('.')
    return {
      path,
      why: `${to} by ${path.join('.')}${isDefault ? ' (the default this fact declares)' : ''}${partial ? ' — an arrow on it may lead nowhere' : ''}`,
      cost: path.length + (isDefault ? -2 : 0) + (partial ? 1 : 0),
    }
  }).sort((a, b) => a.cost - b.cost)
}

/** Build every question the fragment could be, without checking them — `complete` does that. */
function candidates(s: Schema, f: Fragment): Array<{ question: Question; why: string[]; uncertain: string[]; cost: number }> {
  const out: Array<{ question: Question; why: string[]; uncertain: string[]; cost: number }> = []
  // A span as a question says it — two days, a last day, or a relative one — becomes the pair the rules check.
  const today = f.asOf ?? new Date().toISOString().slice(0, 10)
  let span: Question['span'] | undefined
  try { span = f.span ? resolveSpan(s, f.span, today).span : undefined } catch { span = undefined }
  const facts = factsFor(s, f.measures)
  if (facts.length > 1) { /* a word that is a measure of several facts: each is a candidate, ranked below */ }

  for (const on of facts) {
    // Each grouping and each record may have several routes; the question forks once per alternative.
    type Draft = { by: NonNullable<Question['by']>; where: NonNullable<Question['where']>; why: string[]; uncertain: string[]; cost: number }
    let drafts: Draft[] = [{ by: [], where: [], why: [...on.why, ...(facts.length > 1 ? [`measured on ${on.fact}`] : [])], uncertain: facts.length > 1 ? [`the measure is on ${facts.map((x) => x.fact).join(' and ')}`] : [], cost: facts.length > 1 ? 1 : 0 }]

    // A thing the question kept to ONE of is not a thing to group by: "for project X, by employee" asks for
    // employees, and a column holding X in every row says nothing.
    const keptToOne = new Set((f.values ?? []).filter((v) => v.meanings.length && v.meanings.every((m) => m.object === v.meanings[0].object)).map((v) => v.meanings[0].object))
    for (const object of (f.by ?? []).filter((o) => !keptToOne.has(o))) {
      const rs = routes(s, on.fact, object)
      if (!rs.length) { drafts = []; break }
      drafts = drafts.flatMap((d) => rs.map((r) => ({
        ...d, by: [...d.by, r.path.length ? { to: object, via: r.path } : { to: object }],
        why: [...d.why, r.why], uncertain: rs.length > 1 ? [...d.uncertain, `${object} is reached ${rs.length} ways`] : d.uncertain,
        cost: d.cost + r.cost + (rs.length > 1 ? 1 : 0),
      })))
    }
    for (const a of f.byAttribute ?? []) {
      drafts = drafts.map((d) => ({ ...d, by: [...d.by, a.of ? { attribute: a.attribute, of: a.of } : { attribute: a.attribute }], why: [...d.why, `by the value ${a.of ? `${a.of}.` : ''}${a.attribute}`] }))
    }
    for (const v of f.values ?? []) {
      if (!v.meanings.length) continue
      drafts = drafts.flatMap((d) => v.meanings.flatMap((m) => {
        const rs = routes(s, on.fact, m.object)
        return rs.slice(0, 2).map((r) => ({
          ...d,
          where: [...d.where, { to: m.object, ...(r.path.length ? { via: r.path } : {}), in: [m.key] } as NonNullable<Question['where']>[number]],
          why: [...d.why, `"${v.text}" is ${m.label ?? m.key}, a ${m.object}, kept to by ${r.path.join('.') || 'the fact itself'}`],
          uncertain: v.meanings.length > 1 ? [...d.uncertain, `"${v.text}" could be ${v.meanings.map((x) => `${x.label ?? x.key} (a ${x.object})`).join(' or ')}`] : d.uncertain,
          cost: d.cost + r.cost + (v.meanings.length > 1 ? 2 : 0),
        }))
      }))
    }
    for (const c of f.conditions ?? []) {
      drafts = drafts.map((d) => ({ ...d, where: [...d.where, { condition: c }], why: [...d.why, `kept to "${c}"`] }))
    }
    for (const d of drafts) {
      out.push({
        question: { measures: on.measures, ...(d.by.length ? { by: d.by } : {}), ...(d.where.length ? { where: d.where } : {}),
          ...(span ? { span } : {}), ...(f.currency ? { currency: f.currency } : {}), ...(f.asOf ? { asOf: f.asOf } : {}) } as Question,
        why: d.why, uncertain: d.uncertain, cost: d.cost,
      })
    }
  }
  return out
}

// ── THE EAGER HALF: WORDS TO THINGS ──────────────────────────────────────────────────────────────────────────

/** What `resolve-terms` found, as a fragment to complete. A term with several meanings stays several; nothing is
 *  chosen here, because choosing is what completion does with the graph in hand. */
export function fragmentOf(terms: Array<{ phrase: string; means: Meaning[] }>, span?: SpanAsked, currency?: string): Fragment {
  const f: Fragment = { measures: [], by: [], byAttribute: [], values: [], conditions: [], ...(span ? { span } : {}), ...(currency ? { currency } : {}) }
  for (const t of terms) {
    const kinds = new Set(t.means.map((m) => m.kind))
    // A date the question stated is the span it is asked over: "this year", "last 3 months", a month by name.
    const dated = t.means.find((m) => m.kind === 'span') as { kind: 'span'; span: SpanAsked } | undefined
    if (dated && !f.span) f.span = dated.span
    // A word that names a measure on SEVERAL facts is one idea asked for, not several to be added together: it is
    // kept as the bare name, and completion makes a candidate per fact that has it — which is what "ambiguous"
    // means here. Named on one fact only, it is that measure.
    const measures = t.means.filter((x) => x.kind === 'measure') as Array<Extract<Found, { kind: 'measure' }>>
    if (measures.length > 1) { if (!f.measures.includes(t.phrase)) f.measures.push(t.phrase) }
    for (const m of t.means) {
      if (m.kind === 'measure') { if (measures.length > 1) continue; const ref = `${m.node}.${m.measure}`; if (!f.measures.includes(ref)) f.measures.push(ref) }
      else if (m.kind === 'object' && !kinds.has('measure')) { if (!f.by!.includes(m.node)) f.by!.push(m.node) }
      else if (m.kind === 'condition') { if (!f.conditions!.includes(m.condition)) f.conditions!.push(m.condition) }
      else if (m.kind === 'attribute' && m.value === undefined) f.byAttribute!.push({ attribute: m.attribute, of: m.node })
    }
    // Records are what the question is KEPT to — unless the same word is also a measure or an object, in which
    // case that is what it is. A record whose name happens to contain a measure's word must not turn that word into a
    // filter: a word means an idea once, and the idea nearest the question wins.
    const members = t.means.filter((m) => m.kind === 'member') as Array<Extract<Found, { kind: 'member' }>>
    if (members.length && !kinds.has('measure') && !kinds.has('object')) {
      f.values!.push({ text: t.phrase, meanings: members.map((m) => ({ object: m.node, key: m.key, label: m.label })) })
    }
  }
  for (const k of ['by', 'byAttribute', 'values', 'conditions'] as const) if (!f[k]!.length) delete f[k]
  return f
}
