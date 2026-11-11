// WHAT THIS ENGINE IS (docs: the cell): the same engine in one of two modes, chosen by one value in its .env.
//   project — the project's engine: it links to the ProjectDO as the project's code-engine (as it always has).
//   cell    — one person's engine in a project: it links to that person's UserDO, which relays what concerns the
//             project. Everything else is the same code: what a cell may hold and do is what the platform sends it.

export type EngineMode = 'project' | 'cell'
export interface Mode { mode: EngineMode; /** A cell's person (their email): whose work it does. */ person: string | null }

/** The mode from the engine's settings; refuses one it does not know, and a cell that names no person. */
export function modeOf(env: Record<string, string | undefined>): Mode {
  const raw = (env.SA_ENGINE_MODE ?? '').trim().toLowerCase() || 'project'
  if (raw !== 'project' && raw !== 'cell') throw new Error(`SA_ENGINE_MODE is "${raw}": an engine is a project's (project) or one person's (cell)`)
  if (raw === 'project') return { mode: 'project', person: null }
  const person = (env.SA_CELL_PERSON ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+$/.test(person)) throw new Error('a cell is one person\'s engine: set SA_CELL_PERSON to their email')
  return { mode: 'cell', person }
}

/** WHAT EACH MODE DOES WITH THE PROJECT — only the parts that differ (everything else is the same code). A cell keeps the
 *  replicas and its person's connections (the platform's cell-door.ts answers it only those); the project's reports, its
 *  index and its release are its engine's. */
const DOES = {
  /** how the engine, its workloads, agents and configuration stand — reported to the project */
  report: ['project'],
  /** sessions, programs and usage pushed up (a cell's come with the work sent to it) */
  push: ['project'],
  /** building each source's index for the project (a cell replicates it) */
  'index-build': ['project'],
  /** the release this box runs, and the proof for its updater */
  release: ['project'],
  /** the default concepts it carries, given to the project when they are not the ones it was last given */
  defaults: ['project'],
} as const satisfies Record<string, readonly EngineMode[]>
export type Capability = keyof typeof DOES
export const does = (m: Mode, what: Capability): boolean => (DOES[what] as readonly EngineMode[]).includes(m.mode)
