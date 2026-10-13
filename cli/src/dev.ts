// sacli dev — inside a clone, a development environment (docs/dev-mode.md): what this folder changes since it was
// cloned (or pulled) is built on the project's engine into the person's environment and seen only by them; everything
// else stays what is published. This module decides WHAT the environment overrides; cli.ts talks to the platform.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { localChanges, type CloneRecord } from './clone.ts'

export interface DevPlan {
  /** Programs (and libraries) to build into the environment, libraries first. */
  programs: string[]
  /** Agents whose agents/<name>.json changed: their bodies. */
  agents: Record<string, Record<string, unknown>>
  /** The map, when map.json changed. */
  map?: unknown
}

/** What a clone overrides now: every program, agent and the map whose files differ from what was cloned. */
export function devPlan(dir: string, record: CloneRecord): DevPlan {
  const ch = localChanges(dir, record)
  const touched = [...ch.edited, ...ch.added]
  const programs = [...new Set(touched.filter((f) => f.startsWith('programs/')).map((f) => f.split('/')[1]))].filter((p) => existsSync(join(dir, 'programs', p, 'manifest.json')))
  const isLib = (p: string) => { try { return JSON.parse(readFileSync(join(dir, 'programs', p, 'manifest.json'), 'utf8')).kind === 'library' } catch { return false } }
  // A changed library: the programs using it are built again against it.
  const users = (lib: string) => Object.keys(record.programs).concat(programs).filter((p) => { try { return (JSON.parse(readFileSync(join(dir, 'programs', p, 'manifest.json'), 'utf8')).uses ?? []).some((u: string) => String(u).split('@')[0] === lib) } catch { return false } })
  const all = new Set(programs)
  for (const p of programs) if (isLib(p)) for (const u of users(p)) all.add(u)
  const agents: Record<string, Record<string, unknown>> = {}
  for (const f of touched.filter((f) => /^agents\/[\w-]+\.json$/.test(f))) {
    const { name, ...body } = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    agents[String(name ?? f.slice(7, -5))] = body
  }
  const map = touched.includes('map.json') ? JSON.parse(readFileSync(join(dir, 'map.json'), 'utf8')) : undefined
  return { programs: [...all].sort((a, b) => Number(!isLib(a)) - Number(!isLib(b)) || a.localeCompare(b)), agents, ...(map !== undefined ? { map } : {}) }
}

/** An environment's default name: the clone folder's, made a name. */
export const envNameOf = (dir: string) => dir.split('/').filter(Boolean).at(-1)!.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dev'
