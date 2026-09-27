// ── Knowledge: what an agent is to know from the start, composed from a project's atomic documents ─────────────
//
// A project may carry, under <projectDir>/knowledge, an index of DOMAINS. A domain names the capabilities it covers,
// its sections (composed by the project's own TypeScript, the way the platform's prompts are assembled), the files it
// brings (scripts the sections refer to) and the tools its threads keep. When a question is asked from a screen, the
// screen's capability picks the domain, the sections are composed into one text the agent is given as its whole
// system prompt — never read — and the files are placed in its folder. Composition is deterministic: the same domain
// composes the same way for every thread, so a change to one section reaches every later thread, which is where
// referential integrity lives for what is not in the semantic graph.
//
//   knowledge/index.mts    export const domains: Domain[]   — each { name, capabilities, sections: [{ title, text }],
//                          files?, tools? }; the project composes its sections from typed parts however it likes
//   knowledge/index.json   the older shape: { "domains": [ { "name", "capabilities", "parts": [file…], "files", "tools" } ] }
//                          with parts read from knowledge/<domain-dir>/<part>
import { readFile, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface Section { title: string; text: string }
export interface Domain {
  name: string
  capabilities: string[]
  /** The composed sections, in order (the TypeScript index). */
  sections?: Section[]
  /** Or documents to read from the domain's directory, in order (the JSON index). */
  parts?: string[]
  /** Scripts the sections refer to, placed in the agent's folder. */
  files?: string[]
  /** The tools a thread in this domain is left with; every tool when not said. */
  tools?: string[]
}
export interface Knowledge { domain: string; text: string; files: string[] }

/** How every answer is given, whatever the domain. */
const ANSWERING = `# How every answer is given
- The answer starts with a line \`:::answer\`. What you say before it is you working; what follows it is the answer.
- The next line says the time the answer covers: \`:::period <when> · <what kind>\`.
  - A span: \`:::period 7 Sep – 20 Sep 2026 · 2 complete weeks\`
  - A moment, for data that holds only its current state: \`:::period As of 27 Sep 2026 · the state now\`
  - All the data: \`:::period All data · 3 Jan 2022 – 26 Sep 2026\`, earliest to latest.
  - A forecast: \`:::period 5 Oct – 11 Oct 2026 · forecast\`
  - A comparison: one line per period, in the order compared.
  - A period still running ends \`· to date\`.
- Tables and charts are lines naming a file in this folder: \`:::table <name>.json\`, \`:::bar <name>.json\`, \`:::line <name>.json\`.`

const dirOf = (name: string) => name.trim().toLowerCase().replace(/\s+/g, '-')

/** The domains a project's knowledge index lists; none when there is no index. The TypeScript index wins. */
export async function domainsOf(projectDir: string): Promise<Domain[]> {
  const dir = join(projectDir, 'knowledge')
  for (const name of ['index.mts', 'index.ts']) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    try {
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
      const ds = mod.domains ?? mod.default?.domains ?? mod.default
      if (Array.isArray(ds)) return ds as Domain[]
      console.warn(`[knowledge] ${file} exports no domains`)
    } catch (e: any) { console.warn(`[knowledge] ${file} could not be loaded: ${e?.message ?? e}`) }
  }
  const file = join(dir, 'index.json')
  if (!existsSync(file)) return []
  try { const idx = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(idx?.domains) ? idx.domains : [] }
  catch (e: any) { console.warn(`[knowledge] ${file} could not be read: ${e?.message ?? e}`); return [] }
}

/** The domain a capability belongs to, or null. */
export async function domainFor(projectDir: string, focus: string | null | undefined): Promise<Domain | null> {
  if (!focus) return null
  return (await domainsOf(projectDir)).find((d) => d.capabilities.includes(focus)) ?? null
}

/** A domain composed: the identity, then its sections in order, as one text, and the absolute paths of its files. */
export async function compose(projectDir: string, domain: Domain): Promise<Knowledge> {
  const dir = join(projectDir, 'knowledge', dirOf(domain.name))
  const texts: string[] = []
  if (domain.sections?.length) for (const sec of domain.sections) texts.push(`# ${sec.title}\n${sec.text.trim()}`)
  else for (const part of domain.parts ?? []) {
    try { texts.push((await readFile(join(dir, part), 'utf8')).trim()) }
    catch (e: any) { console.warn(`[knowledge] ${domain.name}: part ${part} is missing (${e?.message ?? e})`) }
  }
  const files = (domain.files ?? []).map((f) => join(dir, f)).filter((f) => existsSync(f))
  const named = files.length ? `\n\nIn your folder, from this domain: ${files.map((f) => basename(f)).join(', ')}.` : ''
  // The identity is the first line of what the agent is, and it is the domain's. How every answer is given is the
  // platform's, the same for every domain, and comes right after it.
  const identity = `You are Superatom's agent for ${domain.name} at this organisation.`
  return { domain: domain.name, text: `${identity}\n\n${ANSWERING}\n\n${texts.join('\n\n')}${named}`, files }
}

/** Put a domain's files into an agent's folder. */
export async function place(k: Knowledge, cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  for (const f of k.files) await copyFile(f, join(cwd, basename(f)))
}

// ── A session is a domain ──────────────────────────────────────────────────────────────────────────────────────
// The first question of a chat picks its domain; the session folder is then made self-contained — the reference,
// the domain's files, and a note of which domain and tools — and is the truth from then on: a restart rebuilds the
// composer from the folder, never from a recomposition, so a domain edited later reaches new sessions only.

/** The domain a first question belongs to. One domain: that one. Several: the one whose words the question shares most. */
export async function pick(projectDir: string, question: string): Promise<Domain | null> {
  const domains = await domainsOf(projectDir)
  if (!domains.length) return null
  if (domains.length === 1) return domains[0]
  const words = new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))
  let best: { d: Domain; score: number } | null = null
  for (const d of domains) {
    const text = `${d.name} ${(await compose(projectDir, d)).text}`.toLowerCase()
    const vocab = new Set(text.split(/[^a-z0-9]+/).filter((w) => w.length > 2))
    let score = 0; for (const w of words) if (vocab.has(w)) score++
    if (!best || score > best.score) best = { d, score }
  }
  return best?.d ?? domains[0]
}

const NOTE = '.domain.json', REFERENCE = '.reference.md'

/** Write what a session folder needs to stand on its own: the reference and which domain and tools it has. */
export async function remember(k: Knowledge, domain: Domain, cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, REFERENCE), k.text)
  await writeFile(join(cwd, NOTE), JSON.stringify({ domain: domain.name, tools: domain.tools ?? null, at: new Date().toISOString() }, null, 2))
}

/** What a session folder remembers, or null when it was never given a domain. */
export async function recall(cwd: string): Promise<{ domain: string; tools?: string[]; text: string } | null> {
  try {
    const note = JSON.parse(await readFile(join(cwd, NOTE), 'utf8'))
    const text = await readFile(join(cwd, REFERENCE), 'utf8')
    return { domain: String(note.domain), ...(Array.isArray(note.tools) ? { tools: note.tools } : {}), text }
  } catch { return null }
}
