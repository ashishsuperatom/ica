// ── Routing a first question to a domain: a reverse index, deterministic and explained ─────────────────────────
//
// Every domain's words go into one index: term → the domains that hold it, and how strongly. A term is a normalised
// word or a pair of neighbouring words, so "red week" counts as itself and not only as "red" and "week". A term many
// domains hold says little about which one is meant, so it weighs less (inverse document frequency, the usual search
// weight); a term only one domain holds decides. A domain's intents — plain phrases of what it serves, with their
// synonyms — weigh more than its document, because they are what a person says rather than what the agent is told.
// The question's terms are looked up, each domain's weights summed, and the highest wins; the result says which terms
// decided it, so a wrong pick can be seen and corrected.

import type { Store } from './store.js'
import { compose, domains as listDomains, type DomainBody } from './compose.js'

export interface Candidate { domain: string; score: number; terms: string[] }
export interface Route { domain: string | null; ranked: Candidate[]; tie: boolean }

const STOP = new Set(('a an and any are as at be been by can could did do does for from had has have how i if in into is it its ' +
  'me my of on or our out over per so than that the their them then there these they this those to up us was we were what when ' +
  'where which while who whom why will with would you your show give list tell find get see all each every many much more most ' +
  'about across between during within without last next').split(' '))
// Words every domain uses ("week", "project") are not stopped: the inverse-frequency weight already makes them count
// for little, and they belong in phrases that decide ("red week").

/** A word as the index keeps it: lower case, and a plural or an ending trimmed so "projects" and "project" meet. */
export function stem(w: string): string {
  let s = w.toLowerCase()
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y'
  else if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3)
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
  return s
}

/** A text's terms: its words (stop words out) and each pair of neighbouring words. */
export function terms(text: string): string[] {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem)
  const out = [...words]
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]} ${words[i + 1]}`)
  return out
}

export interface Indexed { name: string; document: Map<string, number>; intents: Set<string> }

/** The index over a set of domains: each domain's terms with their counts, and its intents' terms. */
export function indexOf(docs: { name: string; text: string; intents: string[] }[]): Indexed[] {
  return docs.map((d) => {
    const document = new Map<string, number>()
    for (const t of terms(d.text)) document.set(t, (document.get(t) ?? 0) + 1)
    return { name: d.name, document, intents: new Set(d.intents.flatMap(terms)) }
  })
}

/** Rank the domains for a question. The intents count three times what the document does. */
export function rank(index: Indexed[], question: string): Route {
  const asked = [...new Set(terms(question))]
  const n = index.length
  const ranked: Candidate[] = index.map((d) => {
    let score = 0
    const hit: string[] = []
    for (const t of asked) {
      const holders = index.filter((x) => x.document.has(t) || x.intents.has(t)).length
      if (!holders) continue
      const idf = Math.log(1 + n / holders)                            // held by one domain: decides; by all: says little
      const pair = t.includes(' ') ? 2 : 1                            // a phrase matched is stronger than its words
      const inDoc = d.document.get(t) ?? 0
      const w = (d.intents.has(t) ? 3 : 0) + (inDoc ? 1 + Math.log(inDoc) / 4 : 0)
      if (w) { score += idf * pair * w; hit.push(t) }
    }
    return { domain: d.name, score: Math.round(score * 1000) / 1000, terms: hit }
  }).sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain))
  const top = ranked[0]
  const tie = ranked.length > 1 && ranked[1].score === top?.score
  return { domain: top && top.score > 0 ? top.domain : null, ranked, tie }
}

/** Route a first question over the graph's domains, as composed now. */
export function route(store: Store, question: string, upto?: number): Route {
  const docs = listDomains(store, { upto }).map((d) => {
    const body = store.get<DomainBody>(d.name, undefined, upto)!.body
    return { name: d.name, text: `${d.name} ${compose(store, d.name, undefined, { upto }).text}`, intents: body.intents ?? [] }
  })
  return rank(indexOf(docs), question)
}
