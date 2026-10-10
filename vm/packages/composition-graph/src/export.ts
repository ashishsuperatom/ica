// ── Export: the graph written back as knowledge, to edit and import again ───────────────────────────────────────
//
// The graph is the only source of a project's knowledge. To change much of it at once, it is exported as a knowledge
// file (index.mts, and the domains' files beside it), edited, checked (`composition-graph check`), imported to the
// draft, tried (`sacli ask --graph draft`) and published — the file is a working copy, never kept as a second source.
// Importing an export unchanged changes nothing: every node comes back with the same hash.

import type { Store } from './store.js'
import { conceptsOf, isComposed, type ConceptBody, type DomainBody, type FileBody, type SettingBody } from './compose.js'
import type { WrittenDomain, WrittenSetting } from './import.js'

export interface Exported {
  /** "draft" or the version's name. */
  graph: string
  settings: WrittenSetting[]
  /** Every concept the domains compose, named, the parts of intermediate concepts first. */
  concepts: (ConceptBody & { name: string })[]
  /** Each domain as it is written, its concepts by name (the file writes them as references to `concepts`). */
  domains: (Omit<WrittenDomain, 'concepts' | 'parts'> & { concepts: string[]; files: string[] })[]
  /** The domains' files by their node name, which is also their path beside index.mts. */
  files: Record<string, string>
}

/** The graph's knowledge at a change (`upto`; undefined: as it is now). */
export function exportKnowledge(store: Store, upto: number | undefined, graph: string): Exported {
  const at = <B,>(name: string) => store.get<B>(name, undefined, upto)
  const placed = (n: { scope: string; owner: string | null }) => ({ ...(n.scope && n.scope !== 'global' ? { scope: n.scope } : {}), ...(n.owner ? { owner: n.owner } : {}) })
  const concepts = new Map<string, ConceptBody & { name: string }>()
  const addConcept = (name: string) => {
    if (concepts.has(name)) return
    const n = at<ConceptBody>(name); if (!n) return
    if (isComposed(n.body)) for (const c of n.body.concepts) addConcept(c)
    concepts.set(name, { name, ...n.body })
  }
  const files: Record<string, string> = {}
  const settingNames = new Set<string>()
  const domains = store.names('domain', upto === undefined ? {} : { upto }).map((d) => {
    const n = at<DomainBody>(d.name)!
    const b = n.body
    for (const c of conceptsOf(b)) addConcept(c)
    for (const f of b.files) { const fb = at<FileBody>(f); if (fb) files[f] = fb.body.text }
    for (const s of b.settings ?? []) settingNames.add(s)
    return { name: d.name, ...(b.title ? { title: b.title } : {}), ...(b.description ? { description: b.description } : {}), ...(b.intents?.length ? { intents: b.intents } : {}),
      capabilities: b.capabilities, concepts: conceptsOf(b), files: b.files, ...(b.tools ? { tools: b.tools } : {}), ...(b.settings?.length ? { settings: b.settings } : {}),
      ...(b.fallback ? { fallback: true } : {}), ...placed(n) }
  })
  const settings = [...settingNames].map((name) => { const n = at<SettingBody>(name)!; return { name, value: n.body.value, description: n.body.description, ...placed(n) } })
  return { graph, settings, concepts: [...concepts.values()], domains, files }
}

/** An export as a knowledge file: its concepts written once, by name, and the domains listing them. */
export function knowledgeSource(x: Exported, when: string): string {
  const j = (v: unknown, indent = 2) => JSON.stringify(v, null, indent)
  const key = (name: string) => JSON.stringify(name)
  const lines = [
    `// The project's knowledge, exported from its composition graph at ${x.graph} (${when}).`,
    '// The graph is the source: this file is a working copy. Edit it, check it (composition-graph check index.mts),',
    '// import it to the draft (sacli graph import index.mts), try it (sacli ask --graph draft "…"), then publish.',
    '// How concepts are written: composition-graph guide.',
    '',
    `export const settings = ${j(x.settings)}`,
    '',
    '/** Every concept, by name: a concept is said once, and the domains (and intermediate concepts) name it. */',
    'export const concepts = {',
    ...x.concepts.map((c) => `  ${key(c.name)}: ${j(c).split('\n').join('\n  ')},`),
    '}',
    '',
    'export const domains = [',
    ...x.domains.map((d) => {
      const { concepts: names, ...rest } = d
      const body = j(rest).replace(/\n}$/, `,\n  "concepts": [\n${names.map((n) => `    concepts[${key(n)}],`).join('\n')}\n  ]\n}`)
      return `  ${body.split('\n').join('\n  ')},`
    }),
    ']',
    '',
  ]
  return lines.join('\n')
}
