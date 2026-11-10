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
