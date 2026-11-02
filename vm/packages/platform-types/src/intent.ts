// ── The intent graph's shapes (docs/intent-graph.md, the specification docs/intent-graph-spec.md) ──────────────────
// An intent node is one thing people ask for, exactly as they asked it: its canonical form (the question with its values
// made placeholders), the words it was first asked in, and what has been learnt about answering it. Every node lives in
// a Durable Object of its own (IntentDO), independent of every other — any node can be reached from any node.
//
// A node is ONE node for everyone, with VARIANTS inside it: each person's own (`user:<id>`) — the concepts it uses, the
// way it is answered, how it is shown, its sub-paths — and the project's (`global`): every person's variant accumulated
// as a suggestion, and the one approved (by whoever holds `project.curate`); with none approved, the most represented
// one is used, marked unverified. A person with no variant of their own starts from the project's.
//
// Concepts are never copied into a node: a variant names them (the composition graph is the atomic knowledge base), so a
// better version reaches every node that uses it.

export interface IntentLink { kind: 'domain' | 'concept'; name: string }

/** A value in a question that changes from asking to asking: a date, a period, a number, a code, a name. */
export interface IntentParam { kind: string; value: string }

/** What is learnt about answering a node, for one owner (a person, or the project). */
export interface IntentVariantBody {
  /** The concepts the answer stands on, by name (the composition graph's). */
  concepts: string[]
  /** The way to answer it, in words: what to read, the steps, the traps — not a program. */
  process: string
  /** How the answer is shown to the person. */
  show: string
  /** Where the way divides by the situation: the sub-graph inside the node. */
  paths: { when: string; how: string }[]
  /** Whatever else the agent that wrote it noted — its own keys. */
  about?: Record<string, unknown>
}
export interface IntentVariant extends IntentVariantBody {
  /** `global` (the project's) or `user:<id>`. */
  owner: string
  version: number
  by: string
  at: string
  why: string
  /** Kept for ever; a deprecated variant is not used. */
  deprecated?: boolean
}

export interface IntentNodeBody {
  title: string
  /** What is asked for, in words. */
  intent: string
  /** The question as it was first asked. */
  asked: string
  /** Its canonical form (canonicalOf): what an exact text match compares. */
  canonical: string
  /** The values the first asking carried. */
  params: IntentParam[]
  /** The agent that answers at this node when it is not the session's (builder, connector, one the project made). */
  agent?: string | null
  /** The capability a person needs to be answered here; none: everyone in the project. */
  needs?: string | null
  /** Made by the platform (a node for one of its agents), not learnt from a question. */
  system?: boolean
  /** Removed (a badly formed node, a wrong one): never matched, offered or answered at; its history kept, restorable. */
  removed?: { by: string; why: string; at: string } | null
}
export interface IntentNode extends IntentNodeBody {
  id: string
  version: number
  /** Something a variant uses changed since: to be looked at again. */
  stale?: string | null
  by: string
  at: string
  passages?: number
}

/** A way from one node to the next, per owner: asked by a person after the node, or suggested by an agent. Its check, when
 *  it has one, is an option function (docs/program-contract.md, Options) whose move is "go to this intent". */
export interface IntentEdge {
  from: string; to: string; owner: string
  tag: 'asked' | 'suggested'
  count: number
  label: string
  check?: string | null
  last: string
}
/** One question answered at a node: the session's step it was, who answered it and how it got here. */
export interface IntentPassage {
  node: string; session: string; block: string | null
  question: string; params: IntentParam[]; answer: string
  who: string; agent: string; at: string
  how: 'matched' | 'made' | 'same'
  from: string | null
}

export const INTENT_ID = /^in-[a-z0-9]{6,24}$/
export const newIntentId = (): string => `in-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
export const ownerOf = (userId: string) => `user:${String(userId).replace(/^user:/, '')}`

/** What is wrong with a node's body, or null. */
export function checkIntentBody(b: unknown): string | null {
  const x = b as IntentNodeBody
  if (!x || typeof x !== 'object') return 'an intent node is an object'
  if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 160) return 'an intent node has a title (at most 160 characters)'
  if (typeof x.intent !== 'string' || !x.intent.trim() || x.intent.length > 4000) return 'an intent node says its intent in words (at most 4000 characters)'
  if (typeof x.asked !== 'string' || !x.asked.trim()) return 'an intent node keeps the question it was first asked in'
  if (typeof x.canonical !== 'string' || !x.canonical.trim()) return 'an intent node has its canonical form'
  if (!Array.isArray(x.params) || x.params.some((p) => !p || typeof p.kind !== 'string' || typeof p.value !== 'string')) return 'params is a list of { kind, value }'
  if (x.agent != null && (typeof x.agent !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(x.agent))) return 'an agent is named in lower case (letters, digits, -)'
  if (x.needs != null && (typeof x.needs !== 'string' || !/^[a-z]+\.[a-z.-]+$/.test(x.needs))) return 'needs names a capability'
  if (x.removed != null && (typeof x.removed !== 'object' || typeof x.removed.why !== 'string' || !x.removed.why.trim())) return 'a removal says why'
  return null
}
/** What is wrong with a variant's body, or null. */
export function checkVariantBody(b: unknown): string | null {
  const x = b as IntentVariantBody
  if (!x || typeof x !== 'object') return 'a variant is an object'
  if (!Array.isArray(x.concepts) || x.concepts.some((c) => typeof c !== 'string' || !c.trim())) return 'concepts is a list of concept names'
  if (typeof x.process !== 'string') return 'process is words'
  if (typeof x.show !== 'string') return 'show is words'
  if (!Array.isArray(x.paths) || x.paths.some((p) => !p || typeof p.when !== 'string' || typeof p.how !== 'string')) return 'paths is a list of { when, how }'
  if (x.about != null && (typeof x.about !== 'object' || Array.isArray(x.about))) return 'about is an object of the agent\'s own keys'
  return null
}

/** What a variant says, for comparing two: the same concepts and the same way, whoever wrote them. */
export const variantSignature = (v: IntentVariantBody) => JSON.stringify([[...v.concepts].sort(), v.process.replace(/\s+/g, ' ').trim().toLowerCase()])

/** The project's view of a node from every person's variant: the approved one, else the most represented (unverified). */
export function currentGlobal(variants: IntentVariant[], approved: { owner: string; version: number } | null): { variant: IntentVariant | null; verified: boolean; agreeing: number; kinds: number } {
  const live = variants.filter((v) => !v.deprecated && v.owner !== 'global')
  const groups = new Map<string, IntentVariant[]>()
  for (const v of live) { const k = variantSignature(v); groups.set(k, [...(groups.get(k) ?? []), v]) }
  if (approved) {
    const a = variants.find((v) => v.owner === approved.owner && v.version === approved.version) ?? null
    if (a) return { variant: a, verified: true, agreeing: groups.get(variantSignature(a))?.length ?? 1, kinds: groups.size }
  }
  // Everyone says the same: no disagreement, it is the current view by itself.
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length || b.at(-1)!.at.localeCompare(a.at(-1)!.at))
  const top = ranked[0]
  return { variant: top ? top[top.length - 1] : null, verified: groups.size === 1 && live.length > 1, agreeing: top?.length ?? 0, kinds: groups.size }
}

// ── The canonical form, and text search ─────────────────────────────────────────────────────────────────────────────
// A question is matched as it is asked — never turned into an "intent" first. Its values (dates, periods, numbers, codes,
// the names the project knows) become placeholders; what is left, lower-cased, is its canonical form. Two questions with
// the same canonical form are an exact text match. Otherwise the words of the canonical form are searched (no semantic
// search) and the best few go to the composer, which decides by meaning.

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec'
const RELATIVE = '(?:this|last|next|previous|past|current|coming)\\s+(?:\\d+\\s+)?(?:day|days|week|weeks|month|months|quarter|quarters|year|years|fy|financial year|fortnight)|today|yesterday|tomorrow|ytd|mtd|qtd|year to date|month to date'
const RULES: [RegExp, string][] = [
  [/\b\d{4}-\d{2}-\d{2}(?:[t ][\d:.]+z?)?\b/g, '{date}'],
  [/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, '{date}'],
  [new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b(?:,?\\s+\\d{4})?`, 'g'), '{date}'],
  [new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?,\\s+\\d{4}\\b`, 'g'), '{date}'],
  [new RegExp(`\\b(?:${MONTHS})\\b(?:\\s*,?\\s*'?\\d{2,4})?`, 'g'), '{period}'],
  [/\b(?:q[1-4]|h[12])\s*(?:fy\s*)?'?\d{2,4}\b|\bfy\s*'?\d{2,4}(?:[-/]\d{2,4})?\b|\b(?:q[1-4]|h[12])\b/g, '{period}'],
  [new RegExp(`\\b(?:${RELATIVE})\\b`, 'g'), '{period}'],
  [/\b(?:19|20)\d{2}\b/g, '{year}'],
  [/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]+(?:[-_/][a-z0-9]+)*\b|\b[a-z]+[-_/]\d[\w-]*\b/g, '{code}'],
  [/[$€£₹]?\b\d+(?:[.,]\d+)*(?:\s?(?:%|(?:k|m|bn|cr|lakh|crore|million|billion)\b))?/g, '{number}'],
]

/** The question's canonical form and the values taken out of it. `known`: the project's names (customers, sites, …),
 *  each with its kind — found first, the longest first. */
export function canonicalOf(text: string, known: IntentParam[] = []): { canonical: string; params: IntentParam[] } {
  let s = ` ${String(text ?? '').toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'")} `
  const params: IntentParam[] = []
  const take = (re: RegExp, kind: string) => { s = s.replace(re, (m) => { const v = m.trim(); if (!v) return m; params.push({ kind, value: v }); return ` {${kind}} ` }) }
  take(/"[^"]{1,80}"/g, 'name')
  const names = known.filter((k) => k.value.trim().length > 1).sort((a, b) => b.value.length - a.value.length)
  for (const k of names) take(new RegExp(`(?<![\\p{L}\\p{N}])${k.value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu'), k.kind)
  // The rules see only what is outside a placeholder.
  for (const [re, ph] of RULES) {
    s = s.split(/(\{[a-z-]+\})/).map((part) => /^\{[a-z-]+\}$/.test(part) ? part : part.replace(re, (m) => { const v = m.trim(); if (!v) return m; params.push({ kind: ph.slice(1, -1), value: v }); return ` ${ph} ` })).join('')
  }
  const canonical = s.replace(/[^\p{L}\p{N}{}\s-]/gu, ' ').replace(/\s+/g, ' ').trim()
  return { canonical, params }
}

const STOP = new Set('a an the of to in on for by with at from and or is are was were be been do does did me my our we us you your i it its this that these those what which who whom how why when where show give tell list get find can could would should please all any some each per vs versus about into than then them they there their have has had will just also more most much many'.split(' '))
/** The words a canonical form is searched by: no placeholders, no small words, a plural's s dropped. */
export function termsOf(canonical: string): string[] {
  return [...new Set(canonical.split(/\s+/).filter((w) => w && !/^\{.*\}$/.test(w) && !STOP.has(w) && w.length > 2).map((w) => w.replace(/(?<=[a-z]{3})s$/, '')))]
}

/** The nodes whose words the question shares most (idf-weighted, normalised by both sides), best first; only those that
 *  share any. */
export function textSearch<T extends { terms: string[] }>(question: string[], nodes: T[], limit = 5): { node: T; score: number }[] {
  if (!question.length) return []
  const df = new Map<string, number>()
  for (const n of nodes) for (const t of new Set(n.terms)) df.set(t, (df.get(t) ?? 0) + 1)
  const idf = (t: string) => Math.log(1 + nodes.length / (1 + (df.get(t) ?? 0)))
  const q = new Set(question)
  const weight = (ts: Iterable<string>) => { let w = 0; for (const t of ts) w += idf(t); return w }
  const qw = weight(q)
  return nodes.map((node) => {
    const own = new Set(node.terms)
    const shared = [...q].filter((t) => own.has(t))
    const sw = weight(shared)
    return { node, score: shared.length ? sw / Math.sqrt(qw * Math.max(weight(own), 1e-9)) : 0 }
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
}

// ── Specialised agents (docs/intent-graph.md) ───────────────────────────────────────────────────────────────────────
// Every session has the composer (the entry point: every message goes to it first) and the analyst (made when a new
// intent needs it). Other agents belong to intent nodes: a node names its agent, and who may be answered there.
export interface SessionAgentSpec {
  name: string
  title: string
  /** What it is for. */
  description: string
  /** Its role, given to it as its instructions. */
  instructions: string
  /** The capability a person needs to use it. */
  needs: string
  harness: 'claude-code' | 'codex'
  /** Made by Superatom (every project has it) or by the project. */
  builtin?: boolean
}
export const SESSION_AGENT_NAME = /^[a-z][a-z0-9-]{1,39}$/

/** The node agents Superatom gives every project (their instructions live with the engine). */
export const BUILTIN_SESSION_AGENTS: Omit<SessionAgentSpec, 'instructions'>[] = [
  { name: 'builder', title: 'Builder', description: 'Builds a program — a calculation, a report, a view or a dashboard — when the person asks for one to be made; never to answer a question.', needs: 'project.develop', harness: 'claude-code', builtin: true },
  { name: 'connector', title: 'Connector', description: 'Connects a new data source, or fixes or changes how one is connected, when the person asks for it.', needs: 'project.connectors', harness: 'claude-code', builtin: true },
]

/** The nodes the platform makes in every project, one for each of its agents: reached like any other node. */
export const SYSTEM_INTENT_NODES: (Omit<IntentNodeBody, 'canonical' | 'params'> & { key: string })[] = [
  { key: 'builder', title: 'Build a program', intent: 'The person asks for a program to be built or changed — a calculation, a report, a view or a dashboard made for them.', asked: 'build a program', agent: 'builder', needs: 'project.develop', system: true },
  { key: 'connector', title: 'Connect a data source', intent: 'The person asks for a data source to be connected, or for how one is connected to be fixed or changed.', asked: 'connect a data source', agent: 'connector', needs: 'project.connectors', system: true },
]
