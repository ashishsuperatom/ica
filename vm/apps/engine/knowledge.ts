// ── Knowledge: what an agent knows from the start, read from the project's composition graph ──────────────────
//
// The graph is @superatom/composition-graph, held by the platform; this engine reads its replica (<projectDir>/db/composition.sqlite, graph-replica.ts): domains
// composed from named concepts, stored by hash, every change recorded. This module only reads it: which domains there
// are, which one a session is, and the composition to give its agent — whose whole system prompt it is, never a file
// to read — with the files placed in its folder and the hashes it was made from noted there.
//
// What the agents read is the graph's latest PUBLISHED version: edits are a draft until they are published (before the
// first version is published, the graph as it is). A session may be pinned to another — the draft, to try a change
// before publishing it; an earlier version, to compare — and reads only that one (`graph`: "draft" or a version's name).
//
// The project's written knowledge (knowledge/index.mts) reaches the graph only through the platform
// (`sacli graph import knowledge/index.mts`); this engine reads nothing of it from disk.
import { configuration } from './configuration.js'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { dataSeam } from './ica/workspace.js'
import { openStore, compose as composeFromGraph, domains as domainsInGraph, route, graphAt, type FileBody, type Route } from '@superatom/composition-graph/node'
import { renderConcept, isComposed, type ConceptBody } from '@superatom/composition-graph'
import { canonicalOf, termsOf, textSearch } from '@superatom/platform-types'
import { createHash } from 'node:crypto'

export interface Domain { name: string; capabilities: string[]; tools?: string[]; /** Where a question no domain reaches goes. */ fallback?: boolean }
export interface Knowledge { domain: string; /** The version it was composed from: "draft" or a version's name. */ graph: string; text: string; files: FileBody[]; used: Record<string, string>; /** Written into the folder as settings.json. */ settings: Record<string, unknown>
  /** The variables its text was filled with ({{sources}}…), as they were. */ variables?: Record<string, string> }

// ── What a concept's {{variables}} are filled with ─────────────────────────────────────────────────────────────
// A concept is plain text; where it writes {{name}}, the engine puts what it knows now — {{sources}}, the project's data
// sources as they are — so knowledge never names what changes by itself. The engine sets the provider once at start.
let variablesNow: () => Promise<Record<string, string>> = async () => ({})
export function setKnowledgeVariables(fn: () => Promise<Record<string, string>>) { variablesNow = fn }

/** The project's graph, when it has one. The caller closes it. */
const storeOf = (projectDir: string) => {
  const file = join(projectDir, 'db', 'composition.sqlite')
  return existsSync(file) ? openStore(file) : null
}

/** The domains there are: the graph's (none until the platform's graph reaches this engine). */
export async function domainsOf(projectDir: string, graph?: string | null): Promise<Domain[]> {
  const store = storeOf(projectDir)
  if (store) {
    try {
      const { upto } = graphAt(store, graph)
      // The domains of the version read, and those the platform itself made, as they are now (its defaults apply at once).
      const theirs = new Set(domainsInGraph(store, { upto }).map((d) => d.name))
      const all = [...domainsInGraph(store, { upto }), ...domainsInGraph(store, {}).filter((d) => !theirs.has(d.name) && store.platformOwns(d.name))]
      return all.map((d) => { const at = theirs.has(d.name) ? upto : undefined; const tools = composeFromGraph(store, d.name, undefined, { upto: at }).tools; const fallback = store.get<any>(d.name, undefined, at)?.body?.fallback === true
        return { name: d.name, capabilities: d.capabilities, ...(tools ? { tools } : {}), ...(fallback ? { fallback } : {}) } })
    } finally { store.close() }
  }
  return []
}

/** The agents there are, with what each is for — for a person choosing one. */
export async function agentsOf(projectDir: string): Promise<{ name: string; description: string | null }[]> {
  const store = storeOf(projectDir)
  if (!store) return (await domainsOf(projectDir)).map((d) => ({ name: d.name, description: null }))
  try { const { upto } = graphAt(store); return domainsInGraph(store, { upto }).map((d) => ({ name: d.name, description: (store.get<any>(d.name, undefined, upto)?.body?.description as string | undefined) ?? null })) }
  finally { store.close() }
}

/** A domain composed: the text its agent is given, the files it brings, and the hashes it was made from. */
export async function compose(projectDir: string, domain: Domain, graph?: string | null): Promise<Knowledge> {
  const store = storeOf(projectDir)
  if (store) {
    const variables = await variablesNow().catch(() => ({}))
    // A domain the platform itself made (its defaults apply at once) is composed as it is now; any other at the version read.
    try { const at = graphAt(store, graph); const c = composeFromGraph(store, domain.name, undefined, { upto: store.platformOwns(domain.name) ? undefined : at.upto, variables }); return { domain: c.domain, graph: at.name, text: c.text, files: c.files, used: c.used, settings: c.settings, ...(c.variables ? { variables: c.variables } : {}) } }
    finally { store.close() }
  }
  throw new Error(`there is no domain "${domain.name}": this engine has no graph yet`)
}

/** The knowledge an intent node links to, as text for the agent answering at it (intent.ts): each domain composed, each
 *  concept rendered (a composite with its parts) — read from the graph as it is, never a copy kept with the node. */
/** Linked knowledge as text, at the version the session reads. `own`: a person's scopes — a concept of theirs (one an intent
 *  learnt from their answers, docs/intent-graph.md) is read as it is now, theirs to use before anyone publishes it. */
/** The tools an agent's role gives it (the role concept's `tools`), read as roles are read: the platform's own as it is
 *  now, an edited one at the session's version. null: the role names none. */
export function roleTools(projectDir: string, role: string, graph?: string | null): string[] | null {
  const store = storeOf(projectDir)
  if (!store) return null
  try {
    const at = graphAt(store, graph)
    const now = store.get<any>(role)
    const b = (now && store.platformOwns(role) ? now : store.get<any>(role, undefined, at.upto))?.body
    return Array.isArray(b?.tools) ? b.tools.map(String) : null
  } catch { return null } finally { store.close() }
}

export async function composeLinks(projectDir: string, links: { kind: 'domain' | 'concept'; name: string }[], graph?: string | null, own: string[] = []): Promise<string> {
  const store = storeOf(projectDir)
  if (!store || !links.length) { store?.close(); return '' }
  const variables = await variablesNow().catch(() => ({}))
  try {
    const at = graphAt(store, graph)
    const parts: string[] = []
    for (const l of links) {
      if (l.kind === 'domain') { try { parts.push(composeFromGraph(store, l.name, undefined, { upto: at.upto, variables }).text) } catch { /* gone from the graph: nothing to give */ } continue }
      // As it is now when it is the reader's own, or the platform's own (its defaults apply at once — a person's edit of one
      // goes through draft and publish like any other); else as the session's version has it. The same for each of its parts.
      const read = (name: string) => { const now = store.get<any>(name); return (now && (own.includes(now.scope) || store.platformOwns(name)) ? now : store.get<any>(name, undefined, at.upto))?.body }
      const b = read(l.name) as ConceptBody | undefined
      if (!b) continue
      const whole = isComposed(b) ? { ...b, parts: b.concepts.map(read).filter(Boolean) } : b
      parts.push(renderConcept(whole as any))
    }
    return parts.join('\n\n')
  } finally { store.close() }
}

/** THE DOMAIN A SESSION'S AGENTS ARE ON: chosen by this selector — now always the project's default domain (its fallback),
 *  which holds the system's concepts shared by every intent; what answers a question is its intent node and its concepts
 *  (docs/intent-graph.md). Later a selector may choose another. */
export async function domainFor(projectDir: string, graph?: string | null): Promise<Domain | null> {
  const all = await domainsOf(projectDir, graph ?? undefined).catch(() => [] as Domain[])
  return all.find((x) => (x as any).fallback) ?? null
}

/** A concept as text a person can read in a list: its title and what it says. */
const textOfConcept = (b: ConceptBody | undefined) => (b ? renderConcept(b as any).replace(/\s+/g, ' ').trim() : '')

/** The concepts a person can see that read like each proposal (a name, a title, what it says): the project's published ones
 *  and the person's own as they are now (`own`: their scopes) — the same name first, then the best few by their words. For the
 *  learner (intent-learn.ts) to reuse a concept that exists rather than write a second one. */
export function searchConcepts(projectDir: string, proposals: { name: string; title: string; text: string }[], own: string[], graph?: string | null, per = 3): { name: string; title: string; text: string; scope: string }[][] {
  const store = storeOf(projectDir)
  if (!store || !proposals.length) { store?.close(); return proposals.map(() => []) }
  try {
    const at = graphAt(store, graph)
    const published = store.names('concept', { upto: at.upto }).map((n) => n.name)
    const mine = store.names('concept').filter((n) => own.includes(n.scope)).map((n) => n.name)
    const seen = new Set<string>(), all: { name: string; title: string; text: string; scope: string; terms: string[] }[] = []
    for (const name of [...mine, ...published]) {
      if (seen.has(name)) continue
      seen.add(name)
      const node = mine.includes(name) ? store.get<ConceptBody>(name) : store.get<ConceptBody>(name, undefined, at.upto)
      if (!node) continue
      const title = String((node.body as any)?.title ?? name), text = textOfConcept(node.body)
      all.push({ name, title, text: text.slice(0, 600), scope: node.scope, terms: termsOf(canonicalOf(`${name.replace(/[/-]/g, ' ')} ${title} ${text}`).canonical) })
    }
    return proposals.map((p) => {
      const same = all.filter((c) => c.name === p.name)
      const like = textSearch(termsOf(canonicalOf(`${p.name.replace(/[/-]/g, ' ')} ${p.title} ${p.text}`).canonical), all.filter((c) => c.name !== p.name), per).map((x) => x.node)
      return [...same, ...like].slice(0, per).map(({ terms: _t, ...c }) => c)
    })
  } finally { store.close() }
}

/** The concept that holds what a person wants of every answer (how amounts are written, how long an answer is…), made of
 *  atomic concepts of theirs: learnt from their answers, given with every one of their questions. */
export const personConcept = (owner: string) => `person/${owner.replace(/^user:/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60)}/answering`
/** Its parts now (the person's own, as they are now). */
export function personParts(projectDir: string, owner: string): string[] {
  const store = storeOf(projectDir); if (!store) return []
  try { const b = store.get<any>(personConcept(owner))?.body; return Array.isArray(b?.concepts) ? b.concepts.map(String) : [] } finally { store.close() }
}

/** Put a domain's files and settings into an agent's folder. */
export async function place(k: Knowledge, cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  for (const f of k.files) await writeFile(join(cwd, f.name), f.text)
  // The organisation's settings the agent's programs read — the values it was composed with, like its prompt.
  await writeFile(join(cwd, 'settings.json'), JSON.stringify(k.settings ?? {}, null, 2))
  // and the organisation's configuration (how it reads time, money and words), for the domain's programs as for the platform's
  await writeFile(join(cwd, 'configuration.json'), JSON.stringify(configuration(), null, 2))
}

// ── A session is a domain ──────────────────────────────────────────────────────────────────────────────────────
// The first question of a chat picks its domain; the session folder is then made self-contained — the composition,
// the domain's files, which domain and tools, and the hashes it was made from — and is the truth from then on: a
// restart rebuilds the composer from the folder, never from a recomposition, so a domain edited later reaches new
// sessions only, and the graph can say what changed since any session was made.

/** The domain a first question belongs to, by the graph's reverse index over every domain's words and intents
 *  (@superatom/composition-graph route): deterministic, instant, and explained — the ranking says which terms decided. */
export async function pick(projectDir: string, question: string, graph?: string | null): Promise<{ domain: Domain | null; route: Route | null }> {
  const all = await domainsOf(projectDir, graph)
  if (!all.length) return { domain: null, route: null }
  const store = storeOf(projectDir)
  let r: Route
  if (!store) return { domain: null, route: null }
  try { r = route(store, question, graphAt(store, graph).upto) } finally { store.close() }
  // A question no domain's words reach goes to the fallback domain (one marked so: a general one, for any question), else
  // the first; the route says it was not chosen.
  const chosen = all.find((d) => d.name === r.domain) ?? all.find((d) => d.fallback) ?? all[0]
  return { domain: chosen, route: r }
}


/** A domain's programs, ready to run in a folder of their own — for a caller that runs them without an agent (a
 *  project's application). The folder gets what a chat's folder gets: the files, settings.json and the data seam. It
 *  follows the graph: placed again when the composition's hashes change, so it is always the domain as it is now. */
export async function placeForRunning(projectDir: string, name: string, dir: string, managerUrl: string): Promise<{ dir: string; used: Record<string, string> }> {
  const domain = (await domainsOf(projectDir)).find((d) => d.name === name)
  if (!domain) throw new Error(`there is no domain "${name}"`)
  const k = await compose(projectDir, domain)
  // The seam's own version is part of the stamp, so a changed seam is placed again even when the knowledge is not.
  const stamp = JSON.stringify({ used: k.used, variables: k.variables ?? null, seam: createHash('sha256').update(dataSeam(managerUrl)).digest('hex').slice(0, 12) })
  const noted = await readFile(join(dir, '.used.json'), 'utf8').catch(() => null)
  if (noted !== stamp) {
    await place(k, dir)
    await mkdir(join(dir, 'data'), { recursive: true })
    await writeFile(join(dir, 'data', 'query.mjs'), dataSeam(managerUrl))
    await writeFile(join(dir, '.used.json'), stamp)
  }
  return { dir, used: k.used }
}

const NOTE = '.domain.json', REFERENCE = '.reference.md'

/** Write what a session folder needs to stand on its own: the composition, which domain and tools, and what it was made from. */
export async function remember(k: Knowledge, domain: Domain, cwd: string, routed?: Route | null): Promise<void> {
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, REFERENCE), k.text)
  await writeFile(join(cwd, NOTE), JSON.stringify({ domain: domain.name, graph: k.graph, tools: domain.tools ?? null, used: k.used, ...(routed ? { routed } : {}), at: new Date().toISOString() }, null, 2))
}

/** What a session folder remembers, or null when it was never given a domain. */
export async function recall(cwd: string): Promise<{ domain: string; tools?: string[]; text: string; used: Record<string, string> } | null> {
  try {
    const note = JSON.parse(await readFile(join(cwd, NOTE), 'utf8'))
    const text = await readFile(join(cwd, REFERENCE), 'utf8')
    return { domain: String(note.domain), ...(Array.isArray(note.tools) ? { tools: note.tools } : {}), text, used: note.used ?? {} }
  } catch { return null }
}
