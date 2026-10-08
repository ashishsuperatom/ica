// ── Knowledge: what an agent knows from the start, read from the project's composition graph ──────────────────
//
// The graph is @superatom/composition-graph, held by the platform; this engine reads its replica (<projectDir>/db/composition.sqlite, graph-replica.ts): domains
// composed from named concepts, stored by hash, every change recorded. This module only reads it: which domains there
// are, which one a session is, and the composition to give its agent — whose whole system prompt it is, never a file
// to read — with the files placed in its folder and the hashes it was made from noted there.
//
// What the agents read is the graph's latest PUBLISHED version: edits are a draft until they are published (before the
// first version is published, the graph as it is).
//
// The project's written knowledge (knowledge/index.mts) reaches the graph only through the platform
// (`sacli graph import knowledge/index.mts`); this engine reads nothing of it from disk.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { dataSeam } from './ica/workspace.js'
import { openStore, compose as composeFromGraph, domains as domainsInGraph, route, publishedUpto, type FileBody, type Route } from '@superatom/composition-graph/node'
import { createHash } from 'node:crypto'

export interface Domain { name: string; capabilities: string[]; tools?: string[]; /** Where a question no domain reaches goes. */ fallback?: boolean }
export interface Knowledge { domain: string; text: string; files: FileBody[]; used: Record<string, string>; /** Written into the folder as settings.json. */ settings: Record<string, unknown>
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
export async function domainsOf(projectDir: string): Promise<Domain[]> {
  const store = storeOf(projectDir)
  if (store) {
    try {
      const upto = publishedUpto(store)
      return domainsInGraph(store, { upto }).map((d) => { const tools = composeFromGraph(store, d.name, undefined, { upto }).tools; const fallback = store.get<any>(d.name, undefined, upto)?.body?.fallback === true
        return { name: d.name, capabilities: d.capabilities, ...(tools ? { tools } : {}), ...(fallback ? { fallback } : {}) } })
    } finally { store.close() }
  }
  return []
}

/** The agents there are, with what each is for — for a person choosing one. */
export async function agentsOf(projectDir: string): Promise<{ name: string; description: string | null }[]> {
  const store = storeOf(projectDir)
  if (!store) return (await domainsOf(projectDir)).map((d) => ({ name: d.name, description: null }))
  try { const upto = publishedUpto(store); return domainsInGraph(store, { upto }).map((d) => ({ name: d.name, description: (store.get<any>(d.name, undefined, upto)?.body?.description as string | undefined) ?? null })) }
  finally { store.close() }
}

/** The domain a capability belongs to, or null. */
export async function domainFor(projectDir: string, focus: string | null | undefined): Promise<Domain | null> {
  if (!focus) return null
  return (await domainsOf(projectDir)).find((d) => d.capabilities.includes(focus)) ?? null
}

/** A domain composed: the text its agent is given, the files it brings, and the hashes it was made from. */
export async function compose(projectDir: string, domain: Domain): Promise<Knowledge> {
  const store = storeOf(projectDir)
  if (store) {
    const variables = await variablesNow().catch(() => ({}))
    try { const c = composeFromGraph(store, domain.name, undefined, { upto: publishedUpto(store), variables }); return { domain: c.domain, text: c.text, files: c.files, used: c.used, settings: c.settings, ...(c.variables ? { variables: c.variables } : {}) } }
    finally { store.close() }
  }
  throw new Error(`there is no domain "${domain.name}": this engine has no graph yet`)
}

/** Put a domain's files and settings into an agent's folder. */
export async function place(k: Knowledge, cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  for (const f of k.files) await writeFile(join(cwd, f.name), f.text)
  // The organisation's settings the agent's programs read — the values it was composed with, like its prompt.
  await writeFile(join(cwd, 'settings.json'), JSON.stringify(k.settings ?? {}, null, 2))
}

// ── A session is a domain ──────────────────────────────────────────────────────────────────────────────────────
// The first question of a chat picks its domain; the session folder is then made self-contained — the composition,
// the domain's files, which domain and tools, and the hashes it was made from — and is the truth from then on: a
// restart rebuilds the composer from the folder, never from a recomposition, so a domain edited later reaches new
// sessions only, and the graph can say what changed since any session was made.

/** The domain a first question belongs to, by the graph's reverse index over every domain's words and intents
 *  (@superatom/composition-graph route): deterministic, instant, and explained — the ranking says which terms decided. */
export async function pick(projectDir: string, question: string): Promise<{ domain: Domain | null; route: Route | null }> {
  const all = await domainsOf(projectDir)
  if (!all.length) return { domain: null, route: null }
  const store = storeOf(projectDir)
  let r: Route
  if (!store) return { domain: null, route: null }
  try { r = route(store, question, publishedUpto(store)) } finally { store.close() }
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
  await writeFile(join(cwd, NOTE), JSON.stringify({ domain: domain.name, tools: domain.tools ?? null, used: k.used, ...(routed ? { routed } : {}), at: new Date().toISOString() }, null, 2))
}

/** What a session folder remembers, or null when it was never given a domain. */
export async function recall(cwd: string): Promise<{ domain: string; tools?: string[]; text: string; used: Record<string, string> } | null> {
  try {
    const note = JSON.parse(await readFile(join(cwd, NOTE), 'utf8'))
    const text = await readFile(join(cwd, REFERENCE), 'utf8')
    return { domain: String(note.domain), ...(Array.isArray(note.tools) ? { tools: note.tools } : {}), text, used: note.used ?? {} }
  } catch { return null }
}
