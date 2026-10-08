// The platform's model list, as this engine holds it: the only models its pi agents run. It comes from the project — the
// engine's hello names the hash it holds, and the welcome carries the list when the platform's is a different one — and is
// kept in the project's home (models.json), so a restart starts on it before the platform is reached. Nothing is fetched
// online, and pi's own catalog is not read: a model is what the platform's list says it is.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ModelList { hash: string; providers: Record<string, any[]> }

let file = ''
let list: ModelList | null = null
const waiting: (() => void)[] = []

/** Where the list is kept; read now if a previous run left one. */
export function initPlatformModels(path: string) {
  file = path
  try { if (existsSync(path)) list = JSON.parse(readFileSync(path, 'utf8')) } catch { list = null }
}

/** The hash this engine holds ('' when it holds none) — what its hello tells the project. */
export const platformModelsHash = () => list?.hash ?? ''

/** A list from the welcome: kept, and every agent waiting for it is let go. A welcome naming only the hash changes nothing. */
export function receivePlatformModels(m: { hash?: string; providers?: Record<string, any[]> } | undefined) {
  if (!m?.hash || !m.providers) return
  list = { hash: m.hash, providers: m.providers }
  if (file) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(list)); renameSync(tmp, file)
  }
  console.log(`[models] the platform's list ${m.hash.slice(0, 12)}: ${Object.entries(m.providers).map(([p, ms]) => `${p} ${ms.map((x) => x.id).join(', ')}`).join(' · ')}`)
  for (const w of waiting.splice(0)) w()
}

/** The platform's description of a model, waiting (up to `ms`) for the list on a first start; why not, when it has none. */
export async function platformModel(provider: string, id: string, ms = 60_000): Promise<any> {
  if (!list) await new Promise<void>((resolve) => { waiting.push(resolve); setTimeout(resolve, ms) })
  if (!list) throw new Error(`the platform's model list has not arrived (it comes with the project's welcome) — ${provider}/${id} cannot be run yet`)
  const m = (list.providers[provider] ?? []).find((x) => x?.id === id)
  if (!m) throw new Error(`${provider}/${id} is not in the platform's model list (it has: ${(list.providers[provider] ?? []).map((x) => x.id).join(', ') || `nothing from ${provider}`}) — add it with \`pnpm models add ${provider}/${id}\` and deploy`)
  return structuredClone(m)
}
