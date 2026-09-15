// ── A QUESTION'S TERMS IN THE GRAPH ─────────────────────────────────────────────────────────────────────────────
//
// A person asks in their own words; a question of the graph is in the graph's. Reading the question whole finds what
// each of its terms is, all at once:
//
//   the longest phrase wins     "base budget" is one term when the graph has it, not "base" and "budget"
//   dates become spans          "September and October 2026", "last quarter", "the last 30 days", "Q3 2026"
//   records are looked up       names at the entity sources, one lookup per entity for every phrase of the question
//   near misses are repaired    "revenu" reads as revenue, and says it was repaired
//   plurals read as singulars   "branches" is Branch
//
// A term with several meanings is said to be ambiguous; content words the graph does not hold are listed, so what the
// question needs and the graph lacks is plain before anything is asked of it.

import { addDays, addMonths } from './calendar.js'
import { find, mistakes, type Found } from './discovery.js'
import { arrows, type Schema } from './schema.js'
import { resolveSpan, type SpanAsked } from './time.js'

export type Meaning = Found | { kind: 'span'; span: SpanAsked; reads: string } | { kind: 'number'; value: number }
export interface Term { phrase: string; means: Meaning[]; ambiguous?: true; repaired?: { typed: string; mistakes: number } }
export interface TermsResolved { terms: Term[]; unmatched: string[]; notes?: string[] }

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}&+]+/gu, ' ').trim()
const words = (t: string) => t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
const STOP = new Set(('a an the of for in on at to by from with and or vs versus per each every all any is are was were be been what which who whom ' +
  'how many much show me give list tell do does did has have had my our their its this that these those than then as into over ' +
  'across between during about against compare compared break down broken up split we i you it there where when why can could would should please').split(' '))
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const month = (w: string) => { const i = MONTHS.findIndex((m) => w.length >= 3 && m.startsWith(w)); return i < 0 ? -1 : i }
const pad = (n: number) => String(n).padStart(2, '0')

/** Phrases of a question that name records: every run of up to four words that is not only small words. */
export function recordPhrases(text: string): string[] {
  const ws = norm(text).split(' ').filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i < ws.length; i++) for (let n = 1; n <= 4 && i + n <= ws.length; n++) {
    const p = ws.slice(i, i + n)
    if (p.every((w) => STOP.has(w) || /^\d+$/.test(w))) continue
    out.add(p.join(' '))
  }
  return [...out]
}

/** What each term of a question is in the graph. `records` are the names found at the sources, by phrase. */
export function resolveTerms(s: Schema, text: string, today: string, records: Map<string, Found[]> = new Map()): TermsResolved {
  const notes: string[] = []
  const terms: Array<Term & { at: number }> = []
  const calendars = Object.entries(s.objects).filter(([, o]) => o.kind === 'calendar').map(([n]) => n)
  const calendarNamed = (w: string) => calendars.find((c) => [norm(c), norm(c) + 's'].includes(w.replace(/ly$/, '')) || (w === 'daily' && c === 'Day'))
  const spanTerm = (phrase: string, span: SpanAsked, at: number) => {
    try { terms.push({ phrase, means: [{ kind: 'span', span, reads: resolveSpan(s, span, today).said ?? `${(span as any).from} to ${(span as any).through}` }], at }) }
    catch (e: any) { notes.push(`"${phrase}": ${e.message}`) }
  }

  // Dates first, so their words are not read as anything else.
  let rest = ` ${text.toLowerCase().replace(/[–—]/g, '-')} `
  const take = (re: RegExp, read: (m: RegExpExecArray) => SpanAsked | undefined) => {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray
      const at = args[args.length - 2] as number
      const span = read(m)
      if (!span) return m[0]
      spanTerm(m[0].trim(), span, at)
      return ' | '.padEnd(m[0].length, ' ')
    })
  }
  const monthWord = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
  take(/\b(\d{4}-\d{2}-\d{2})\s*(?:to|-|until|through|and)\s*(\d{4}-\d{2}-\d{2})\b/g, (m) => ({ from: m[1], through: m[2] }))
  take(/\b(\d{4}-\d{2}-\d{2})\b/g, (m) => ({ from: m[1], through: m[1] }))
  take(new RegExp(`\\b${monthWord}(?:\\s+(\\d{4}))?\\s*(?:to|-|until|through|and)\\s*${monthWord}(?:\\s+(\\d{4}))?\\b`, 'g'), (m) => {
    const y2 = m[4] ?? m[2] ?? today.slice(0, 4), y1 = m[2] ?? (month(m[1]) > month(m[3]) ? String(Number(y2) - 1) : y2)
    if (!m[2] && !m[4]) notes.push(`"${m[0].trim()}" has no year; it is read as ${y1 === y2 ? y2 : `${y1} to ${y2}`}`)
    const from = `${y1}-${pad(month(m[1]) + 1)}-01`
    return { from, through: addDays(addMonths(`${y2}-${pad(month(m[3]) + 1)}-01`, 1), -1) }
  })
  take(new RegExp(`\\b${monthWord}(?:\\s+(\\d{4}))?\\b`, 'g'), (m) => {
    if (m[1] === 'may' && !m[2]) return undefined // "may" is more often a word than a month
    const y = m[2] ?? today.slice(0, 4)
    if (!m[2]) notes.push(`"${m[0].trim()}" has no year; it is read as ${y}`)
    const from = `${y}-${pad(month(m[1]) + 1)}-01`
    return { from, through: addDays(addMonths(from, 1), -1) }
  })
  take(/\bq([1-4])\s*(?:of\s+)?(\d{4})\b/g, (m) => {
    notes.push(`"${m[0].trim()}" is read as the calendar quarter`)
    const from = `${m[2]}-${pad((Number(m[1]) - 1) * 3 + 1)}-01`
    return { from, through: addDays(addMonths(from, 3), -1) }
  })
  take(/\b(?:the\s+)?(?:last|past|previous|trailing)\s+(\d+)\s+([a-z]+)\b/g, (m) => {
    const c = calendarNamed(m[2])
    return c ? (/previous/.test(m[0]) ? { previous: c, count: Number(m[1]) } : { last: Number(m[1]), unit: c }) : undefined
  })
  take(/\b(this|current|last|previous|prior)\s+([a-z]+)(\s+to\s+date)?\b/g, (m) => {
    const c = calendarNamed(m[2])
    if (!c || c === 'Day') return undefined
    return m[1] === 'this' || m[1] === 'current' ? { this: c, ...(m[3] ? { toDate: true } : {}) } : { previous: c }
  })
  take(/\b([a-z])td\b/g, (m) => { const c = calendars.find((x) => norm(x)[0] === m[1]); return c ? { this: c, toDate: true } : undefined })
  take(/\btoday\b/g, () => ({ from: today, through: today }))
  take(/\byesterday\b/g, () => ({ from: addDays(today, -1), through: addDays(today, -1) }))
  take(/\b((?:19|20)\d{2})\b/g, (m) => ({ from: `${m[1]}-01-01`, through: `${m[1]}-12-31` }))

  // Then the words. A date left a bar, so no phrase runs across it.
  const tokens: Array<{ w: string; at: number; typed?: string; mistakes?: number }> = []
  for (const m of rest.matchAll(/[\p{L}\p{N}&+'.-]+|\|/gu)) tokens.push({ w: norm(m[0]) || m[0], at: m.index! })
  const exact = (phrase: string): Found[] => {
    const hits = [...find(s, phrase), ...(records.get(phrase) ?? [])]
    // Names written as one word in the graph ("AllocationDay") read as the words people use.
    for (const [name, o] of Object.entries(s.objects)) {
      if (words(name) === phrase && norm(name) !== phrase) hits.push({ kind: 'object', node: name, as: 'its name' })
      for (const m of Object.keys(o.measures ?? {})) if (words(m) === phrase && norm(m) !== phrase) hits.push({ kind: 'measure', node: name, measure: m, as: 'its name' })
    }
    return oneIdeaEach(dedupe(hits))
  }
  const singular = (p: string) => p.replace(/ies$/, 'y').replace(/(ss|x|ch|sh)es$/, '$1').replace(/([^s])s$/, '$1')

  // Near misses first, word by word, so a repaired word still joins its phrase: "projected revenu" is "projected revenue".
  // A word is repaired only to the one word of the graph's names within a typing mistake or two of it.
  const vocabulary = new Set<string>()
  const addWords = (x: string) => { for (const w of norm(words(x)).split(' ')) if (w) vocabulary.add(w) }
  for (const [name, o] of Object.entries(s.objects)) {
    for (const x of [name, ...(o.synonyms ?? []), ...Object.values(o.members ?? {}), ...Object.keys(o.names ?? {})]) addWords(x)
    for (const [m, d] of Object.entries(o.measures ?? {})) for (const x of [m, ...(d.synonyms ?? [])]) addWords(x)
    for (const [a, d] of Object.entries(o.attributes ?? {})) for (const x of [a, ...(d.synonyms ?? []), ...(d.members ?? [])]) addWords(x)
    for (const a of arrows(s, name)) addWords(a.role)
  }
  for (const phrase of records.keys()) addWords(phrase)
  // A capitalised word inside the question is a name more often than a typing mistake: it is left for the records.
  // (`rest` is the text with a space before it, so a word's place in it is one past its place in the text.)
  const named = new Set([...text.matchAll(/(?<=\S\s+)[A-Z][\p{L}\p{N}&+'.-]*/gu)].map((m) => m.index! + 1))
  for (const t of tokens) {
    if (t.w === '|' || STOP.has(t.w) || /^\d/.test(t.w) || named.has(t.at) || vocabulary.has(t.w) || vocabulary.has(singular(t.w)) || calendarNamed(t.w)) continue
    const allowed = t.w.length >= 8 ? 2 : t.w.length >= 5 ? 1 : 0
    if (!allowed) continue
    const close = [...vocabulary].map((v) => ({ v, d: mistakes(v, t.w) })).filter((x) => x.d <= allowed)
    const best = Math.min(...close.map((x) => x.d))
    const top = close.filter((x) => x.d === best)
    if (top.length === 1) Object.assign(t, { typed: t.w, w: top[0].v, mistakes: best })
  }

  // The longest phrase that names something wins.
  const unmatched: typeof tokens = []
  for (let i = 0; i < tokens.length;) {
    if (tokens[i].w === '|') { i++; continue }
    let matched = false
    for (let n = Math.min(5, tokens.length - i); n >= 1 && !matched; n--) {
      const span = tokens.slice(i, i + n)
      if (span.some((t) => t.w === '|')) continue
      const phrase = span.map((t) => t.w).join(' ')
      if (n === 1 && STOP.has(phrase)) break
      let hits = exact(phrase)
      if (!hits.length && singular(phrase) !== phrase) hits = exact(singular(phrase))
      if (!hits.length && n === 1 && calendarNamed(phrase)) hits = [{ kind: 'object', node: calendarNamed(phrase)!, as: 'a calendar' }]
      if (!hits.length) continue
      const fixed = span.filter((t) => t.typed)
      terms.push({ phrase, means: hits, at: span[0].at, ...(fixed.length ? { repaired: { typed: span.map((t) => t.typed ?? t.w).join(' '), mistakes: fixed.reduce((n, t) => n + t.mistakes!, 0) } } : {}) })
      i += n
      matched = true
    }
    if (matched) continue
    const t = tokens[i++]
    if (/^\d+(\.\d+)?$/.test(t.w)) terms.push({ phrase: t.w, means: [{ kind: 'number', value: Number(t.w) }], at: t.at })
    else if (!STOP.has(t.w)) unmatched.push(t)
  }
  const still: string[] = []
  for (const t of unmatched) {
    still.push(t.typed ?? t.w)
    if (named.has(t.at)) notes.push(`"${t.w}" may name a record not found by its whole name — ./find-record <Entity> ${t.w}`)
  }

  const out = terms.sort((a, b) => a.at - b.at).map(({ at: _at, ...t }) => {
    const nodes = new Set(t.means.map((x) => JSON.stringify({ ...x, as: undefined })))
    return nodes.size > 1 ? { ...t, ambiguous: true as const } : t
  })
  return { terms: out, unmatched: still, ...(notes.length ? { notes } : {}) }
}

/** A term means an idea once: an arrow to an object the term also names is that object (which path is a later choice),
 *  and a fact named like its own measure is that measure. */
function oneIdeaEach(hits: Found[]): Found[] {
  const objects = new Set(hits.filter((h) => h.kind === 'object').map((h) => h.node))
  const measured = new Set(hits.filter((h) => h.kind === 'measure').map((h) => h.node))
  return hits.filter((h) => !(h.kind === 'role' && objects.has(h.to)) && !(h.kind === 'object' && measured.has(h.node)))
}

function dedupe(hits: Found[]): Found[] {
  const seen = new Map<string, Found>()
  for (const f of hits) {
    const k = JSON.stringify({ ...f, as: undefined, label: undefined })
    const had = seen.get(k)
    if (had) { if (!had.as.includes(f.as)) had.as = `${had.as}; ${f.as}` } else seen.set(k, { ...f })
  }
  return [...seen.values()]
}

/** The terms as a table a reader scans: each phrase in the order asked, what it is, and how a question names it —
 *  the last column exact JSON, to be copied into the question. */
export function termsText(s: Schema, read: TermsResolved, question?: string): string {
  const rows: string[][] = []
  const j = (x: unknown) => JSON.stringify(x).replace(/":/g, '": ').replace(/,"/g, ', "')
  const said = (m: Meaning): [string, string, string] => {
    switch (m.kind) {
      case 'measure': return ['measure', `(:${m.node}).${m.measure}`, j(`${m.node}.${m.measure}`)]
      case 'object': {
        const kind = s.objects[m.node]?.kind
        if (kind === 'fact') return ['fact', `(:${m.node})`, `./describe ${m.node} for its measures`]
        return [kind === 'calendar' ? 'calendar' : 'dimension', `(:${m.node})`, j({ to: m.node })]
      }
      case 'attribute': {
        const of = s.objects[m.node]?.kind === 'fact' ? {} : { of: m.node }
        return m.value !== undefined
          ? ['value', `(:${m.node}).${m.attribute} = ${m.value}`, j({ attribute: m.attribute, ...of, in: [m.value] })]
          : ['attribute', `(:${m.node}).${m.attribute}`, j({ attribute: m.attribute, ...of })]
      }
      case 'condition': return ['condition', `${m.condition} on (:${m.node})`, j({ condition: m.condition })]
      case 'role': return ['arrow', `(:${m.node})-[${m.role}]->(:${m.to})`, `${j({ to: m.to })}, via ending in ${j(m.role)}`]
      case 'member': return ['record', `(:${m.node}) ${m.key === m.label ? m.key : `${m.key} ${m.label}`}`, j({ to: m.node, in: [m.key] })]
      case 'span': return ['span', m.reads, j({ span: m.span })]
      case 'number': return ['number', String(m.value), String(m.value)]
    }
  }
  for (const t of read.terms) {
    const phrase = t.repaired ? `${t.phrase}  (typed "${t.repaired.typed}")` : t.phrase
    if (t.means.length === 1) { rows.push([phrase, ...said(t.means[0])]); continue }
    rows.push([phrase, t.ambiguous ? 'ambiguous, one of:' : '', '', ''])
    for (const m of t.means) rows.push(['', ...said(m).map((c, i) => (i === 0 ? `  ${c}` : c)) as [string, string, string]])
  }
  const widths: number[] = []
  const all = [['phrase', 'kind', 'is', 'in a question'], ...rows]
  // A heading row ("ambiguous, one of:") runs across the columns after it rather than widening its own.
  const heading = new Set(rows.filter((r) => r[1].startsWith('ambiguous')).map((r) => r))
  for (const r of all) if (!heading.has(r)) r.forEach((c, i) => { if (i < r.length - 1) widths[i] = Math.max(widths[i] ?? 0, c.length) })
  const line = (r: string[]) => (heading.has(r) ? `${r[0].padEnd(widths[0])}  ${r[1]}` : r.map((c, i) => (i < r.length - 1 ? c.padEnd(widths[i]) : c)).join('  ')).trimEnd()
  const out = [...(question ? [question, ''] : []), ...(read.terms.length ? all.map(line) : ['no term of the question names anything in the graph'])]
  if (read.unmatched.length) out.push('', `not in the graph: ${read.unmatched.join(', ')}`)
  if (read.notes?.length) out.push('', ...read.notes.map((n) => `note: ${n}`))
  return out.join('\n')
}
