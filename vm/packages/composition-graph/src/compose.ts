// ── Composition: the pieces come together into what an agent knows from the start ──────────────────────────────
//
// A domain names its parts in order, the files it brings and the tools it keeps. Composing it renders each part by
// its form and puts the platform's identity line and "how every answer is given" first. Same pieces, same text,
// byte for byte; the composition says which hash of each piece it used, so a session made from it can be compared
// with the graph at any later moment.

import type { Store } from './store.js'

/** The top of a composition: an agent. What it is for, the phrases it serves (routing reads them), the screens it covers,
 *  its parts in order (its system prompt), the programs it brings and the tools it keeps. */
export interface DomainBody { description?: string; intents?: string[]; capabilities: string[]; parts: string[]; files: string[]; tools?: string[] }
export interface Example { question: string; steps: string[] }
export type PartBody =
  | { title: string; form: 'bullets' | 'numbered'; items: string[] }
  | { title: string; form: 'worked'; items: Example[] }
  | { title: string; form: 'text'; text: string }
export interface FileBody { name: string; text: string }

export interface Composition {
  domain: string
  /** The agent's whole system prompt, before the tools' usage lines the composer adds. */
  text: string
  files: FileBody[]
  tools?: string[]
  capabilities: string[]
  /** Every node the composition read, by name, with the hash it read. */
  used: Record<string, string>
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

/** A part, rendered by its form. */
export function renderPart(p: PartBody): string {
  let body: string
  switch (p.form) {
    case 'bullets': body = p.items.map((l) => `- ${l}`).join('\n'); break
    case 'numbered': body = p.items.map((l, i) => `${i + 1}. ${l}`).join('\n'); break
    case 'worked': body = p.items.map((e) => `## ${e.question}\n${e.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`).join('\n\n'); break
    case 'text': body = p.text; break
  }
  return `# ${p.title}\n${body.trim()}`
}

/** A domain's text from its pieces in memory. */
export function render(domain: string, parts: PartBody[], files: { name: string }[]): string {
  const named = files.length ? `\n\nIn your folder, from this domain: ${files.map((f) => f.name).join(', ')}.` : ''
  return `${identityOf(domain)}\n\n${ANSWERING}\n\n${parts.map(renderPart).join('\n\n')}${named}`
}

/** A domain composed from the store, as it is now or as it was at a moment. */
export function compose(store: Store, domain: string, asOf?: number): Composition {
  const d = store.get<DomainBody>(domain, asOf)
  if (!d || d.kind !== 'domain') throw new Error(`there is no domain "${domain}"${asOf ? ` as of ${new Date(asOf).toISOString()}` : ''}`)
  const used: Record<string, string> = { [domain]: d.hash }
  const read = <B,>(name: string, kind: 'part' | 'file'): B => {
    const n = store.get<B>(name, asOf)
    if (!n || n.kind !== kind) throw new Error(`domain "${domain}" names ${kind} "${name}", which there is not`)
    used[name] = n.hash
    return n.body
  }
  const parts = d.body.parts.map((p) => read<PartBody>(p, 'part'))
  const files = d.body.files.map((f) => read<FileBody>(f, 'file'))
  return { domain, text: render(domain, parts, files), files, ...(d.body.tools ? { tools: d.body.tools } : {}), capabilities: d.body.capabilities, used }
}

/** The domains there are, with what each covers. */
export function domains(store: Store): { name: string; capabilities: string[] }[] {
  return store.names('domain').map((n) => ({ name: n.name, capabilities: store.content<DomainBody>(n.hash).capabilities }))
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
