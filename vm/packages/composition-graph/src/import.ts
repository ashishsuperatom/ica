// ── Import: domains as a project writes them, into the graph ───────────────────────────────────────────────────
//
// A project writes its domains as { name, capabilities, concepts, files, tools }. Each concept becomes a node: one with a
// `name` of its own is a single node every domain that lists it shares — a meaning written once — and any other is
// the domain's own, named "<domain>/<title>". Files become nodes "<domain>/<file>". What is unchanged records
// nothing, so importing twice is harmless; what changed is recorded with who, why and from what.

import type { Store, ChangeContext } from './store.js'
import type { DomainBody, ConceptBody } from './compose.js'
import type { Placement } from './store.js'

/** A domain as a project writes it. `parts` is the earlier name for `concepts` and is still read. `scope`/`owner`: who
 *  sees the domain and who may edit it (global with no owner when left out). */
export interface WrittenDomain { name: string; description?: string; intents?: string[]; capabilities: string[]; concepts?: (ConceptBody & { name?: string })[]; parts?: (ConceptBody & { name?: string })[]; files?: string[]; tools?: string[]; settings?: string[]; scope?: string; owner?: string }
export interface WrittenSetting { name: string; value: unknown; description: string; scope?: string; owner?: string }
export interface Imported { name: string; kind: 'concept' | 'file' | 'domain' | 'setting'; hash: string; changed: boolean }

/** Where a written domain or setting is placed: its scope and owner, when it says. */
const placement = (x: { scope?: string; owner?: string }): Placement => ({ ...(x.scope ? { scope: x.scope } : {}), ...(x.owner ? { owner: x.owner } : {}) })

/** Put written domains into the graph. `readFile(domain, file)` gives a file's text: a domain's own by its name, a shared one by its path. */
export function importDomains(store: Store, domains: WrittenDomain[], readFile: (domain: string, file: string) => string, ctx: ChangeContext, settings: WrittenSetting[] = []): Imported[] {
  const out: Imported[] = []
  // Settings first: a domain may name only a setting the graph holds.
  for (const x of settings) {
    if (!x.description?.trim()) throw new Error(`setting "${x.name}" says nothing about what it is`)
    out.push({ name: x.name, kind: 'setting', ...store.put(x.name, 'setting', { value: x.value, description: x.description }, ctx, placement(x)) })
  }
  const seen = new Map<string, string>()   // a shared concept must be the same wherever it is listed
  for (const d of domains) {
    const conceptNames: string[] = []
    for (const p of d.concepts ?? d.parts ?? []) {
      const { name, ...body } = p
      const node = name ?? `${d.name}/${p.title.toLowerCase()}`
      const text = JSON.stringify(body)
      if (seen.has(node) && seen.get(node) !== text) throw new Error(`concept "${node}" is written two ways; a shared concept is one text`)
      seen.set(node, text)
      // A domain's own concept takes the domain's scope; a shared one (named) stays as it is placed.
      const r = store.put(node, 'concept', body as ConceptBody, ctx, name ? {} : placement(d))
      if (!out.some((x) => x.name === node)) out.push({ name: node, kind: 'concept', ...r })
      conceptNames.push(node)
    }
    const fileNames: string[] = []
    for (const f of d.files ?? []) {
      // A file written with a path of its own ("shared/rates.mjs") is one node every domain that lists it shares — a
      // rule written once; any other is the domain's own. Either way it is placed in a folder under its file name.
      const node = f.includes('/') ? f : `${d.name}/${f}`
      const r = store.put(node, 'file', { name: f.slice(f.lastIndexOf('/') + 1), text: readFile(d.name, f) }, ctx, f.includes('/') ? {} : placement(d))
      if (!out.some((x) => x.name === node)) out.push({ name: node, kind: 'file', ...r })
      fileNames.push(node)
    }
    for (const n of d.settings ?? []) if (!store.get(n) || store.get(n)!.kind !== 'setting') throw new Error(`domain "${d.name}" names setting "${n}", which the graph does not hold`)
    const body: DomainBody = { ...(d.description ? { description: d.description } : {}), ...(d.intents?.length ? { intents: d.intents } : {}), capabilities: d.capabilities, concepts: conceptNames, files: fileNames,
      ...(d.tools ? { tools: d.tools } : {}), ...(d.settings?.length ? { settings: d.settings } : {}) }
    out.push({ name: d.name, kind: 'domain', ...store.put(d.name, 'domain', body, ctx, placement(d)) })
  }
  return out
}
