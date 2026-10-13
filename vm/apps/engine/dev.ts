// A person's development environment, as the platform stamps it on their messages (docs/dev-mode.md): while they are
// attached, the programs, agents and map it names are read from it first; whatever it does not name falls through to
// what is published. Carried through each request (like the reader), so every read of an agent, the map or a program
// in that request sees it — and no other request ever does.

import { AsyncLocalStorage } from 'node:async_hooks'

export interface DevOverlay {
  /** The environment's id (dv_…). */
  id: string
  /** Program name → the build the environment uses. */
  programs: Record<string, string>
  /** Agent name → its body in the environment. */
  agents: Record<string, Record<string, unknown>>
  /** The map in the environment, when it changes it. */
  map?: unknown
}

const store = new AsyncLocalStorage<DevOverlay | null>()

/** The overlay the platform stamped on a message (`from.dev`), checked; null when there is none. */
export function devOf(from: any): DevOverlay | null {
  const d = from?.dev
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !/^dv_[\w-]{4,40}$/.test(d.id)) return null
  const programs = Object.fromEntries(Object.entries(d.programs ?? {}).filter(([n, h]) => /^[\w-]+$/.test(n) && typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) as Record<string, string>
  const agents = Object.fromEntries(Object.entries(d.agents ?? {}).filter(([n, b]) => /^[\w-]+$/.test(n) && !!b && typeof b === 'object')) as Record<string, Record<string, unknown>>
  return { id: d.id, programs, agents, ...(d.map !== undefined ? { map: d.map } : {}) }
}
export const inDev = <T>(dev: DevOverlay | null, fn: () => T): T => store.run(dev, fn)
export const currentDev = (): DevOverlay | null => store.getStore() ?? null
