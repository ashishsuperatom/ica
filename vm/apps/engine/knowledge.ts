// ── Knowledge: what an agent is to know from the start, composed from a project's atomic documents ─────────────
//
// A project may carry, under <projectDir>/knowledge, an index of DOMAINS. A domain names the capabilities it covers,
// the parts that make it up (documents, in order) and the files it brings (scripts the documents refer to). When a
// question is asked from a screen, the screen's capability picks the domain, the parts are composed into one text
// the agent is given beside its role — never read — and the files are placed in its folder. Composition is
// deterministic: the same domain composes the same way for every thread, so a change to one part reaches every
// later thread, which is where referential integrity lives for what is not in the semantic graph.
//
//   knowledge/index.json   { "domains": [ { "name", "capabilities": [focus…], "parts": [file…], "files": [file…], "tools": [name…] } ] }
//   knowledge/<domain-dir>/<part>   the domain's directory is its name with spaces as dashes
import { readFile, copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'

export interface Domain { name: string; capabilities: string[]; parts: string[]; files?: string[]; /** The tools a thread in this domain is left with; every tool when not said. */ tools?: string[] }
export interface Knowledge { domain: string; text: string; files: string[] }

const dirOf = (name: string) => name.trim().toLowerCase().replace(/\s+/g, '-')

/** The domains a project's knowledge index lists; none when there is no index. */
export async function domainsOf(projectDir: string): Promise<Domain[]> {
  const file = join(projectDir, 'knowledge', 'index.json')
  if (!existsSync(file)) return []
  try { const idx = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(idx?.domains) ? idx.domains : [] }
  catch (e: any) { console.warn(`[knowledge] ${file} could not be read: ${e?.message ?? e}`); return [] }
}

/** The domain a capability belongs to, or null. */
export async function domainFor(projectDir: string, focus: string | null | undefined): Promise<Domain | null> {
  if (!focus) return null
  return (await domainsOf(projectDir)).find((d) => d.capabilities.includes(focus)) ?? null
}

/** A domain composed: its parts in order, as one text, and the absolute paths of its files. */
export async function compose(projectDir: string, domain: Domain): Promise<Knowledge> {
  const dir = join(projectDir, 'knowledge', dirOf(domain.name))
  const texts: string[] = []
  for (const part of domain.parts) {
    try { texts.push((await readFile(join(dir, part), 'utf8')).trim()) }
    catch (e: any) { console.warn(`[knowledge] ${domain.name}: part ${part} is missing (${e?.message ?? e})`) }
  }
  const files = (domain.files ?? []).map((f) => join(dir, f)).filter((f) => existsSync(f))
  const named = files.length ? `\n\nIn your folder, from this domain: ${files.map((f) => basename(f)).join(', ')}.` : ''
  // The identity is the first line of what the agent is, and it is the domain's: not a coding assistant with a note
  // about the project, but this organisation's agent for this domain.
  const identity = `You are Superatom's agent for ${domain.name} at this organisation. You answer questions in this domain from its data, as the person who owns it here would.`
  return { domain: domain.name, text: `${identity}\n\n${texts.join('\n\n')}${named}`, files }
}

/** Put a domain's files into an agent's folder. */
export async function place(k: Knowledge, cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  for (const f of k.files) await copyFile(f, join(cwd, basename(f)))
}
