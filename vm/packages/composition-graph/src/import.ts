// ── Import: domains as a project writes them, into the graph ───────────────────────────────────────────────────
//
// A project writes its domains as { name, capabilities, parts, files, tools }. Each part becomes a node: one with a
// `name` of its own is a single node every domain that lists it shares — a meaning written once — and any other is
// the domain's own, named "<domain>/<title>". Files become nodes "<domain>/<file>". What is unchanged records
// nothing, so importing twice is harmless; what changed is recorded with who, why and from what.

import type { Store, ChangeContext } from './store.js'
import type { DomainBody, PartBody } from './compose.js'

export interface WrittenDomain { name: string; capabilities: string[]; parts: (PartBody & { name?: string })[]; files?: string[]; tools?: string[] }
export interface Imported { name: string; kind: 'part' | 'file' | 'domain'; hash: string; changed: boolean }

/** Put written domains into the graph. `readFile(domain, file)` gives a domain file's text. */
export function importDomains(store: Store, domains: WrittenDomain[], readFile: (domain: string, file: string) => string, ctx: ChangeContext): Imported[] {
  const out: Imported[] = []
  const seen = new Map<string, string>()   // a shared part must be the same wherever it is listed
  for (const d of domains) {
    const partNames: string[] = []
    for (const p of d.parts) {
      const { name, ...body } = p
      const node = name ?? `${d.name}/${p.title.toLowerCase()}`
      const text = JSON.stringify(body)
      if (seen.has(node) && seen.get(node) !== text) throw new Error(`part "${node}" is written two ways; a shared part is one text`)
      seen.set(node, text)
      const r = store.put(node, 'part', body as PartBody, ctx)
      if (!out.some((x) => x.name === node)) out.push({ name: node, kind: 'part', ...r })
      partNames.push(node)
    }
    const fileNames: string[] = []
    for (const f of d.files ?? []) {
      const node = `${d.name}/${f}`
      out.push({ name: node, kind: 'file', ...store.put(node, 'file', { name: f, text: readFile(d.name, f) }, ctx) })
      fileNames.push(node)
    }
    const body: DomainBody = { capabilities: d.capabilities, parts: partNames, files: fileNames, ...(d.tools ? { tools: d.tools } : {}) }
    out.push({ name: d.name, kind: 'domain', ...store.put(d.name, 'domain', body, ctx) })
  }
  return out
}
