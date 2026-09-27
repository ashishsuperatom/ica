// ── Knowledge: what an agent knows from the start, read from the project's composition graph ──────────────────
//
// The graph is @superatom/composition-graph, in the project's own store (<projectDir>/db/composition.sqlite): domains
// composed from named parts, stored by hash, every change recorded. This module only reads it: which domains there
// are, which one a session is, and the composition to give its agent — whose whole system prompt it is, never a file
// to read — with the files placed in its folder and the hashes it was made from noted there.
//
// A project with no store yet may state its domains in knowledge/index.mts, in the same shape the graph imports
// (`composition-graph import knowledge/index.mts`); it is rendered by the same package, so the text is the same.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Store, compose as composeFromGraph, domains as domainsInGraph, render, route, rank, indexOf, type PartBody, type FileBody, type Route } from '@superatom/composition-graph'

export interface Domain { name: string; capabilities: string[]; tools?: string[] }
export interface Knowledge { domain: string; text: string; files: FileBody[]; used: Record<string, string> }

/** The project's graph, when it has one. The caller closes it. */
const storeOf = (projectDir: string) => {
  const file = join(projectDir, 'db', 'composition.sqlite')
  return existsSync(file) ? new Store(file) : null
}

/** A domain as the project's index.mts states it, before the graph holds it. */
interface Stated { name: string; intents?: string[]; capabilities: string[]; parts: PartBody[]; files?: string[]; tools?: string[] }
async function stated(projectDir: string): Promise<Stated[]> {
  for (const name of ['index.mts', 'index.ts']) {
    const file = join(projectDir, 'knowledge', name)
    if (!existsSync(file)) continue
    try { const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`); return Array.isArray(mod.domains) ? mod.domains : [] }
    catch (e: any) { console.warn(`[knowledge] ${file} could not be loaded: ${e?.message ?? e}`) }
  }
  return []
}

/** The domains there are: the graph's, or the stated ones when the project has no graph yet. */
export async function domainsOf(projectDir: string): Promise<Domain[]> {
  const store = storeOf(projectDir)
  if (store) {
    try {
      return domainsInGraph(store).map((d) => { const tools = composeFromGraph(store, d.name).tools; return { name: d.name, capabilities: d.capabilities, ...(tools ? { tools } : {}) } })
    } finally { store.close() }
  }
  return (await stated(projectDir)).map((d) => ({ name: d.name, capabilities: d.capabilities, ...(d.tools ? { tools: d.tools } : {}) }))
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
    try { const c = composeFromGraph(store, domain.name); return { domain: c.domain, text: c.text, files: c.files, used: c.used } }
    finally { store.close() }
  }
  const d = (await stated(projectDir)).find((x) => x.name === domain.name)
  if (!d) throw new Error(`there is no domain "${domain.name}"`)
  const dir = join(projectDir, 'knowledge', d.name.trim().toLowerCase().replace(/\s+/g, '-'))
  const files: FileBody[] = []
  for (const f of d.files ?? []) { try { files.push({ name: f, text: await readFile(join(dir, f), 'utf8') }) } catch { console.warn(`[knowledge] ${d.name}: file ${f} is missing`) } }
  return { domain: d.name, text: render(d.name, d.parts, files), files, used: {} }
}

/** Put a domain's files into an agent's folder. */
export async function place(k: Knowledge, cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  for (const f of k.files) await writeFile(join(cwd, f.name), f.text)
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
  if (store) { try { r = route(store, question) } finally { store.close() } }
  else {
    const docs = await Promise.all((await stated(projectDir)).map(async (d) => ({ name: d.name, text: `${d.name} ${(await compose(projectDir, d)).text}`, intents: d.intents ?? [] })))
    r = rank(indexOf(docs), question)
  }
  // A question no domain's words reach still goes somewhere: the first domain, and the route says it was not chosen.
  const chosen = all.find((d) => d.name === r.domain) ?? all[0]
  return { domain: chosen, route: r }
}

/** Record a question with the agent it went to — routed by its words, or asked in a session that already was a domain. */
export function recordQuestion(projectDir: string, q: { session: string; qid?: string; question: string; domain: string | null; how: 'routed' | 'session'; ranked?: unknown }): void {
  const store = storeOf(projectDir)
  if (!store) return
  try { store.recordQuestion(q) } catch (e: any) { console.warn(`[knowledge] question not recorded: ${e?.message ?? e}`) } finally { store.close() }
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
