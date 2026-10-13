// sacli agent pull <agent> <folder>: an agent as it is on the platform, written as the folder `sacli agent push` reads —
// agent.json, and programs/<name>/ for each program it runs and each library those use, from the source each was built
// from (kept with every build since 2026-10-07). Its knowledge is the project's graph: `sacli graph export`.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError } from './config.ts'

export interface PulledProgram { name: string; hash: string; version: number; published: boolean; files: Record<string, string> | null }
/** Ask the platform for a program's source by name (its newest published build, else its newest). */
export type SourceOf = (name: string) => Promise<PulledProgram>

export interface Pulled { dir: string; agent: string; programs: { name: string; hash: string; version: number; published: boolean; files: number }[]; compiledOnly: string[] }

/** The libraries a program's source names (manifest.json "uses": names). */
const usesOf = (files: Record<string, string>): string[] => {
  try { const u = JSON.parse(files['manifest.json']).uses; return Array.isArray(u) ? u.filter((x: unknown): x is string => typeof x === 'string') : [] } catch { return [] }
}

export async function pullAgent(dir: string, name: string, body: Record<string, unknown>, sourceOf: SourceOf): Promise<Pulled> {
  if (existsSync(dir) && readdirSync(dir).length) throw new CliError(`${dir} is not empty — pull into a new folder`, 1)
  const write = (rel: string, text: string) => { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text) }
  const { id: _id, owner: _owner, ...spec } = body as Record<string, unknown>
  write('agent.json', JSON.stringify({ name, ...spec }, null, 2) + '\n')
  const queue = [...((spec.programs as string[] | undefined) ?? [])], seen = new Set<string>()
  const programs: Pulled['programs'] = [], compiledOnly: string[] = []
  while (queue.length) {
    const p = queue.shift()!
    if (seen.has(p)) continue
    seen.add(p)
    const got = await sourceOf(p)
    if (!got.files) { compiledOnly.push(p); continue }
    for (const [rel, text] of Object.entries(got.files)) write(join('programs', p, rel), text)
    programs.push({ name: p, hash: got.hash, version: got.version, published: got.published, files: Object.keys(got.files).length })
    queue.push(...usesOf(got.files))
  }
  return { dir, agent: name, programs, compiledOnly }
}
