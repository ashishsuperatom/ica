// ── IS THIS THE QUESTION THAT WAS ASKED? ─────────────────────────────────────────────────────────────────────
//
// Completion gives the questions a fragment COULD be. Nothing so far says which one it IS. Four things do, in
// increasing cost, and each can be shown to a person:
//
//   said back   the question restated from the graph's own names. A reader — or the person who asked — can see at
//               once that "by branch" was read as the person's branch rather than the project's. Costs nothing.
//   covered     every phrase the question used is accounted for by some part of the pattern, and nothing in the
//               pattern came from nowhere. A term left over is the usual sign of a wrong reading. Costs nothing.
//   evidence    the candidate is actually asked, small: does it find rows at all, how many groups, did a filter
//               empty it. A reading that returns nothing where another returns plenty is very likely the wrong
//               reading. This is the graph going further and letting the data separate the paths.
//   revised     when the evidence is bad, the graph says what to change — the filter that emptied it, the path
//               that leads nowhere, the span that cuts through a period — and the question is asked again.
//
// NOTHING HERE GUESSES. Every candidate that survives is reported with what was uncertain about it, and when two
// readings both hold, that is said rather than settled.

import type { Question } from './algebra.js'
import { arrow, type Schema } from './schema.js'
import type { Completion } from './complete.js'

export interface Evidence {
  rows: number
  /** Distinct values of the first grouping — how many things the answer would be about. */
  groups: number
  /** Filters that, on their own, leave nothing: the usual cause of an empty answer. */
  empties: string[]
  refused?: { rule: string; reason: string }
  ms: number
}

export interface Judged {
  completion: Completion
  evidence?: Evidence
  /** What the question says, in the graph's own words. */
  said: string
  /** Phrases of the original question this reading does not account for. */
  leftOver: string[]
  score: number
  why: string[]
}

/** The question restated from the graph's names: what the system believes it was asked. */
export function saidBack(s: Schema, q: Question): string {
  const measures = q.measures.join(' and ')
  const by = (q.by ?? []).map((t) => ('attribute' in t ? `${t.of ? `${t.of}'s ` : ''}${t.attribute}` : `${t.to}${Array.isArray(t.via) && t.via.length ? ` (by ${t.via.join('.')})` : ''}`))
  const where = (q.where ?? []).map((w) => {
    if ('condition' in w) return `kept to "${w.condition}"`
    const what = 'attribute' in w ? `${w.of ? `${w.of}'s ` : ''}${w.attribute}` : w.to
    const how = 'in' in w ? `is ${(w.in as string[]).join(' or ')}` : 'notIn' in w ? `is not ${(w.notIn as string[]).join(' or ')}`
      : 'none' in w ? (w.none ? 'has none' : 'has one') : 'range' in w ? `is between ${JSON.stringify(w.range)}`
      : 'contains' in w ? `contains "${w.contains}"` : 'startsWith' in w ? `starts with "${w.startsWith}"` : ''
    const via = Array.isArray((w as any).via) && (w as any).via.length ? ` (by ${(w as any).via.join('.')})` : ''
    return `${what}${via} ${how}`
  })
  const span = q.span ? ` over ${q.span.from} to ${q.span.to}` : ''
  return [measures, by.length ? `by ${by.join(', ')}` : '', where.length ? `where ${where.join(', ')}` : '', span.trim(), q.currency ? `in ${q.currency}` : '']
    .filter(Boolean).join(', ')
}

/** Phrases the question used that this reading does not account for. Names and numbers are matched loosely. */
export function leftOver(q: Question, phrases: string[]): string[] {
  const text = JSON.stringify(q).toLowerCase()
  return phrases.filter((p) => {
    const w = p.toLowerCase().trim()
    if (!w || w.length < 3) return false
    return !text.includes(w)
  })
}

/** Ask a candidate, small, to see whether the data agrees with the reading. */
export async function probe(q: Question, ask: (q: Question) => Promise<{ ok: true; result: { rows: unknown[][] } } | { ok: false; rule: string; reason: string }>): Promise<Evidence> {
  const started = Date.now()
  const small: Question = { ...q, limit: Math.min(q.limit ?? 50, 50) }
  const a = await ask(small)
  if (!a.ok) return { rows: 0, groups: 0, empties: [], refused: { rule: a.rule, reason: a.reason }, ms: Date.now() - started }
  const rows = a.result.rows
  const groups = new Set(rows.map((r) => JSON.stringify(r[0]))).size
  // Nothing came back: which filter is responsible? Each is dropped in turn, and the one that brings rows back is
  // named. This is what turns "no rows" into something a person can act on.
  const empties: string[] = []
  if (!rows.length && (q.where ?? []).length) {
    for (let i = 0; i < q.where!.length; i++) {
      const without: Question = { ...small, where: q.where!.filter((_, j) => j !== i) }
      const b = await ask(without)
      if (b.ok && b.result.rows.length) empties.push(describeFilter(q.where![i]))
    }
  }
  return { rows: rows.length, groups, empties, ms: Date.now() - started }
}

const describeFilter = (w: NonNullable<Question['where']>[number]): string =>
  'condition' in w ? `the condition "${w.condition}"` : 'attribute' in w ? `the filter on ${w.of ? `${w.of}.` : ''}${w.attribute}` : `the filter on ${(w as any).to}`

/** Judge the candidates: what they say, what they leave out, and what the data says about each. */
export async function judge(s: Schema, candidates: Completion[], phrases: string[],
  ask?: (q: Question) => Promise<{ ok: true; result: { rows: unknown[][] } } | { ok: false; rule: string; reason: string }>,
  o: { probeAtMost?: number } = {}): Promise<Judged[]> {
  const out: Judged[] = []
  const limit = o.probeAtMost ?? 3
  for (const [i, c] of candidates.entries()) {
    const said = saidBack(s, c.question)
    const over = leftOver(c.question, phrases)
    const evidence = ask && i < limit ? await probe(c.question, ask) : undefined
    const why: string[] = []
    // A reading nobody looked at is not evidence of anything: it sits below one the data agreed with, and above
    // one the data contradicted. Saying "not checked" is the honest score.
    let score = -c.cost - over.length * 2 - c.uncertain.length
    if (ask && !evidence) { score -= 4; why.push('not checked against the data') }
    if (evidence) {
      if (evidence.refused) { score -= 10; why.push(`refused: ${evidence.refused.reason}`) }
      else if (!evidence.rows) {
        score -= 5
        why.push(evidence.empties.length ? `nothing matches, and it is ${evidence.empties.join(' and ')} that empties it` : 'nothing matches this reading')
      } else {
        score += Math.min(3, Math.log10(evidence.rows + 1) * 2)
        why.push(`${evidence.rows} rows${evidence.groups > 1 ? ` across ${evidence.groups} of them` : ''}`)
      }
    }
    if (over.length) why.push(`says nothing about ${over.join(', ')}`)
    out.push({ completion: c, evidence, said, leftOver: over, score, why })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** Two readings that both hold, and what actually differs between them — for asking rather than choosing. */
export function tied(judged: Judged[], within = 0.5): Array<{ a: Judged; b: Judged; differ: string }> {
  const out: Array<{ a: Judged; b: Judged; differ: string }> = []
  for (let i = 0; i < judged.length; i++) for (let j = i + 1; j < judged.length; j++) {
    const a = judged[i], b = judged[j]
    if (Math.abs(a.score - b.score) > within) continue
    if (!a.evidence?.rows || !b.evidence?.rows) continue
    out.push({ a, b, differ: difference(a.completion.question, b.completion.question) })
  }
  return out
}

const difference = (a: Question, b: Question): string => {
  const va = (a.by ?? []).map((t) => JSON.stringify(t)).join(' ')
  const vb = (b.by ?? []).map((t) => JSON.stringify(t)).join(' ')
  if (va !== vb) return `grouped by ${va} against ${vb}`
  const wa = JSON.stringify(a.where ?? []), wb = JSON.stringify(b.where ?? [])
  if (wa !== wb) return `kept to ${wa} against ${wb}`
  return `${JSON.stringify(a)} against ${JSON.stringify(b)}`
}

/** When a reading does not hold, what to change — in the graph's terms, ready to ask again. */
export function revisions(s: Schema, q: Question, e: Evidence): Array<{ why: string; question: Question }> {
  const out: Array<{ why: string; question: Question }> = []
  if (e.refused) {
    // A refusal says what is wrong; these are the changes that follow from it mechanically. A refusal about a
    // member or an object names it, so the filter that carries it is the one to drop.
    const named = e.refused.reason.match(/has no member (.+)$/)?.[1]?.split(', ') ?? []
    for (const [i, w] of (q.where ?? []).entries()) {
      const carries = named.length ? named.some((m) => JSON.stringify(w).includes(m)) : true
      if (carries) out.push({ why: `without ${describeFilter(w)} — ${e.refused.reason}`, question: { ...q, where: q.where!.filter((_, j) => j !== i) } })
    }
    if (/cuts through a/.test(e.refused.reason) && q.span) out.push({ why: 'the span is snapped to whole periods', question: q })
    return out
  }
  if (!e.rows) {
    for (const [i, w] of (q.where ?? []).entries()) {
      out.push({ why: `without ${describeFilter(w)}`, question: { ...q, where: q.where!.filter((_, j) => j !== i) } })
    }
    if (q.span) out.push({ why: 'over a wider span', question: { ...q, span: { from: earlier(q.span.from), to: q.span.to } } })
    // A path that may lead nowhere often explains an empty answer: the rows are there, under "none".
    for (const t of q.by ?? []) {
      if (!('to' in t) || !Array.isArray(t.via)) continue
      const path: string[] = t.via
      const partial = path.some((role, i) => {
        const at = path.slice(0, i).reduce((o: string, r: string) => arrow(s, o, r)?.to ?? o, factOf(q))
        return !!arrow(s, at, role)?.partial
      })
      if (partial) out.push({ why: `grouped by ${t.to} another way, since ${path.join('.')} may lead nowhere`, question: q })
    }
  }
  return out
}

const factOf = (q: Question) => (q.measures[0]?.includes('.') ? q.measures[0].slice(0, q.measures[0].indexOf('.')) : '')
const earlier = (day: string) => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`

/** The whole loop, as a person reads it: what each reading says, what the data said, and what is still open. */
export function judgedText(judged: Judged[], ties: ReturnType<typeof tied> = []): string {
  const lines = judged.map((j, i) => [
    `${i + 1}. ${j.said}`,
    ...j.why.map((w) => `     ${w}`),
    ...(j.completion.uncertain.length ? [`     uncertain: ${j.completion.uncertain.join('; ')}`] : []),
    `     ${JSON.stringify(j.completion.question)}`,
  ].join('\n'))
  for (const t of ties) lines.push(`both hold: ${t.differ} — ask which is meant`)
  return lines.join('\n\n')
}
