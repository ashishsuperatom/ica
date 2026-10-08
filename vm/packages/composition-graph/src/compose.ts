// ── Composition: the pieces come together into what an agent knows from the start ──────────────────────────────
//
// A domain names its concepts in order, the files it brings and the tools it keeps. Composing it renders each concept by
// its form and puts the platform's identity line and "how every answer is given" first. Same pieces, same text,
// byte for byte; the composition says which hash of each piece it used, so a session made from it can be compared
// with the graph at any later moment.

import type { Store, ChangeContext, Scope } from './store.js'
import { visibleTo } from './store.js'

/** The top of a composition: an agent. What it is for, the phrases it serves (routing reads them), the screens it covers,
 *  its concepts in order (its system prompt), the programs it brings and the tools it keeps. A domain written before
 *  concepts were named so lists them as `parts`; reading it still works, so the graph can be read as it was. */
export interface DomainBody { /** How it is called on screens (its name, when absent). */ title?: string; description?: string; intents?: string[]; capabilities: string[]; concepts: string[]; parts?: string[]; files: string[]; tools?: string[]; /** Settings its programs read, by name. */ settings?: string[] }
/** A domain's concepts, in order — from `concepts`, or `parts` in a domain written before the rename. */
export const conceptsOf = (d: Pick<DomainBody, 'concepts' | 'parts'>): string[] => d.concepts ?? d.parts ?? []
/** A value the organisation decides — a threshold, a list, a currency — named once, read by name. */
export interface SettingBody { value: unknown; description: string }
export interface Example { question: string; steps: string[] }
/** A concept, composed into an agent's context: ATOMIC — text in one of a few forms — or INTERMEDIATE ('composed'): a
 *  combination of atomic concepts, in order, perhaps with a line of its own. A domain composes intermediate concepts
 *  (and, as written before intermediates existed, atomic ones directly); an intermediate composes atomic ones only. */
export type ConceptBody =
  | { title: string; form: 'bullets' | 'numbered'; items: string[] }
  | { title: string; form: 'worked'; items: Example[] }
  | { title: string; form: 'text'; text: string }
  | { title: string; form: 'composed'; text?: string; concepts: string[] }
export type AtomicBody = Exclude<ConceptBody, { form: 'composed' }>
export const isComposed = (b: unknown): b is Extract<ConceptBody, { form: 'composed' }> => !!b && (b as any).form === 'composed'
export interface FileBody { name: string; text: string }

export interface Composition {
  domain: string
  /** The agent's whole system prompt, before the tools' usage lines the composer adds. */
  text: string
  files: FileBody[]
  tools?: string[]
  capabilities: string[]
  /** The variables the text was filled with ({{sources}}…), as they were — what the agent was told, kept with it. */
  variables?: Record<string, string>
  /** Every node the composition read, by name, with the hash it read. */
  used: Record<string, string>
  /** The settings the agent's programs read, by name: written into its folder as settings.json. */
  settings: Record<string, unknown>
}

/** How every answer is given, whatever the domain: the platform's, first after the identity. */
export const ANSWERING = `# How every answer is given
- The answer starts with a line \`:::answer\`.
- The next line says the time the answer covers: \`:::period <when> · <what kind>\`.
  - A span: \`:::period 7 Sep – 20 Sep 2026 · 2 complete weeks\`
  - A moment, for data that holds only its current state: \`:::period As of 27 Sep 2026 · the state now\`
  - All the data: \`:::period All data · 3 Jan 2022 – 26 Sep 2026\`, earliest to latest.
  - A forecast: \`:::period 5 Oct – 11 Oct 2026 · forecast\`
  - A comparison: one line per period, in the order compared.
  - A period still running ends \`· to date\`.
- Tables and charts are lines naming a file in this folder: \`:::table <name>.json\`, \`:::bar <name>.json\`, \`:::line <name>.json\`.`

export const identityOf = (domain: string) => `You are Superatom's agent for ${domain} at this organisation.`

/** A concept as it is composed: an atomic one alone, or an intermediate one with its atomic concepts read. */
export type ComposedConcept = AtomicBody | (Extract<ConceptBody, { form: 'composed' }> & { parts: AtomicBody[] })

/** A concept, rendered by its form; an intermediate one is its title (and line), then its atomic concepts beneath it. */
export function renderConcept(p: ComposedConcept | ConceptBody, level = 1): string {
  const h = '#'.repeat(level)
  let body: string
  switch (p.form) {
    case 'bullets': body = p.items.map((l) => `- ${l}`).join('\n'); break
    case 'numbered': body = p.items.map((l, i) => `${i + 1}. ${l}`).join('\n'); break
    case 'worked': body = p.items.map((e) => `${h}# ${e.question}\n${e.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`).join('\n\n'); break
    case 'text': body = p.text; break
    case 'composed': {
      const parts = 'parts' in p ? p.parts.map((x) => renderConcept(x, level + 1)).join('\n\n') : ''
      return `${h} ${p.title}${p.text?.trim() ? `\n${p.text.trim()}` : ''}${parts ? `\n\n${parts}` : ''}`
    }
  }
  return `${h} ${p.title}\n${body.trim()}`
}

/** A domain's text from its pieces in memory. */
export function render(domain: string, concepts: (ComposedConcept | ConceptBody)[], files: { name: string }[], settings: { name: string; value: unknown; description: string }[] = []): string {
  const named = files.length ? `\n\nIn your folder, from this domain: ${files.map((f) => f.name).join(', ')}.` : ''
  // The organisation's settings, with their values: the text names them, the programs read them from settings.json.
  const set = settings.length ? `\n\n# Settings (in settings.json; the programs read them there)\n${settings.map((x) => `- ${x.name}: ${JSON.stringify(x.value)} — ${x.description}`).join('\n')}` : ''
  return `${identityOf(domain)}\n\n${ANSWERING}\n\n${concepts.map((c) => renderConcept(c)).join('\n\n')}${set}${named}`
}

/** Fill a concept's variables: each {{name}} the caller has a value for becomes that value; one it has not stays as
 *  written, so it shows where it was not filled. Returns the text and which variables it used. */
export function fill(text: string, variables: Record<string, string>): { text: string; used: string[] } {
  const used = new Set<string>()
  const out = text.replace(/\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g, (all, name: string) => (name in variables ? (used.add(name), variables[name]!) : all))
  return { text: out, used: [...used] }
}

/** A domain composed from the store, as it is now or as it was at a moment. With a viewer's scopes, it holds only what
 *  they see: a concept in a group or user scope they are not in is left out; a domain they do not see is refused.
 *  `variables`: what the caller knows now ({{sources}}…) — a concept names one as {{name}} and it is filled with it. */
export function compose(store: Store, domain: string, asOf?: number, opts: { viewer?: Scope[]; upto?: number; variables?: Record<string, string> } = {}): Composition {
  const d = store.get<DomainBody>(domain, asOf, opts.upto)
  if (!d || d.kind !== 'domain') throw new Error(`there is no domain "${domain}"${asOf ? ` as of ${new Date(asOf).toISOString()}` : ''}`)
  if (opts.viewer && !visibleTo(d.scope, opts.viewer)) throw new Error(`there is no domain "${domain}" for this viewer`)
  const used: Record<string, string> = { [domain]: d.hash }
  const read = <B,>(name: string, kind: 'concept' | 'file' | 'setting', by = `domain "${domain}"`): B | null => {
    const n = store.get<B>(name, asOf, opts.upto)
    if (!n || n.kind !== kind) throw new Error(`${by} names ${kind} "${name}", which there is not`)
    if (opts.viewer && !visibleTo(n.scope, opts.viewer)) return null
    used[name] = n.hash
    return n.body
  }
  // An intermediate concept brings its atomic concepts, in its order (those the viewer sees).
  const concept = (name: string): ComposedConcept | null => {
    const b = read<ConceptBody>(name, 'concept')
    if (!b || !isComposed(b)) return b
    return { ...b, parts: b.concepts.map((x) => read<ConceptBody>(x, 'concept', `concept "${name}"`)).filter((x): x is AtomicBody => x !== null && !isComposed(x)) }
  }
  const parts = conceptsOf(d.body).map(concept).filter((x): x is ComposedConcept => x !== null)
  const files = d.body.files.map((f) => read<FileBody>(f, 'file')).filter((x): x is FileBody => x !== null)
  const settings = (d.body.settings ?? []).map((n) => ({ name: n, ...read<SettingBody>(n, 'setting')! }))
  const filled = fill(render(domain, parts, files, settings), opts.variables ?? {})
  return { domain, text: filled.text, ...(filled.used.length ? { variables: Object.fromEntries(filled.used.map((n) => [n, opts.variables![n]!])) } : {}), files, settings: Object.fromEntries(settings.map((x) => [x.name, x.value])),
    ...(d.body.tools ? { tools: d.body.tools } : {}), capabilities: d.body.capabilities, used }
}

/** The domains there are (or were at a moment), with what each covers — those a viewer's scopes see. */
export function domains(store: Store, opts: { asOf?: number; viewer?: Scope[]; upto?: number } = {}): { name: string; capabilities: string[] }[] {
  return store.names('domain', opts).map((n) => ({ name: n.name, capabilities: store.content<DomainBody>(n.hash).capabilities }))
}

/** Put a concept into a domain's composition, at a position (end by default). A concept already there is moved. */
export function join(store: Store, domain: string, concept: string, ctx: ChangeContext, at?: number): { hash: string; changed: boolean } {
  const d = store.get<DomainBody>(domain)
  if (!d || d.kind !== 'domain') throw new Error(`there is no domain "${domain}"`)
  const c = store.get(concept)
  if (!c || c.kind !== 'concept') throw new Error(`there is no concept "${concept}" — add it first`)
  const list = conceptsOf(d.body).filter((x) => x !== concept)
  const pos = at === undefined ? list.length : Math.max(0, Math.min(list.length, Math.trunc(at)))
  list.splice(pos, 0, concept)
  const { parts: _old, ...rest } = d.body
  return store.put(domain, 'domain', { ...rest, concepts: list }, ctx)
}

/** Take a concept out of a domain's composition. The concept itself stays in the graph. */
export function leave(store: Store, domain: string, concept: string, ctx: ChangeContext): { hash: string; changed: boolean } {
  const d = store.get<DomainBody>(domain)
  if (!d || d.kind !== 'domain') throw new Error(`there is no domain "${domain}"`)
  const list = conceptsOf(d.body)
  if (!list.includes(concept)) throw new Error(`domain "${domain}" does not compose "${concept}"`)
  const { parts: _old, ...rest } = d.body
  return store.put(domain, 'domain', { ...rest, concepts: list.filter((x) => x !== concept) }, ctx)
}

/** What changed between a composition a session was made with and the graph now: the names whose hash moved. */
export function drift(store: Store, used: Record<string, string>): { name: string; was: string; now: string | null }[] {
  const out: { name: string; was: string; now: string | null }[] = []
  for (const [name, was] of Object.entries(used)) {
    const now = store.get(name)?.hash ?? null
    if (now !== was) out.push({ name, was, now })
  }
  return out
}
