// WHO IS WHO, for showing: the address of each person who has acted in the project, by the id the graph's change log and
// versions record (`user:<id>`). Learned from the hub's stamp whenever someone acts; read by whatever lists who did what.
// Kept as a small file in the project's db folder — not part of any record, so nothing in the graph depends on it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const fileOf = (projectDir: string) => join(projectDir, 'db', 'people.json')

export const peopleOf = (projectDir: string): Record<string, string> => peopleIn(join(projectDir, 'db'))
/** The same, given the db folder itself. */
export function peopleIn(dbDir: string): Record<string, string> {
  try { const v = JSON.parse(readFileSync(join(dbDir, 'people.json'), 'utf8')); return v && typeof v === 'object' ? v : {} } catch { return {} }
}

/** Note a person's address under their id (once it is known, and only when it changed). */
export function notePerson(projectDir: string, id: string, email: string | undefined): void {
  if (!email || !id.startsWith('user:')) return
  const all = peopleOf(projectDir)
  if (all[id] === email) return
  all[id] = email
  try { mkdirSync(join(projectDir, 'db'), { recursive: true }); writeFileSync(fileOf(projectDir), JSON.stringify(all, null, 2)) } catch { /* showing only */ }
}
