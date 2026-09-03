// PROGRAM — show the source of the program behind the answer on screen.
//
// Deterministic: it reads files. No agent, no model, nothing persisted. The point is to stop the program being
// a black box you have to go to the admin console to read — you ask for it in the same chat you asked the
// question in, and it is there.
//
// RELATIVE PATHS ONLY. What travels is `program.ts`, `units/total-sales.ts` — never the workspace root, never
// the machine's directory layout. The reader does not need it and it should not be on someone's screen.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { VERBS } from './index.js'

export interface ProgramFile { path: string; text: string; bytes: number; truncated?: boolean }

const PER_FILE = 60_000     // one unreadably long file should not push the others off the message
const TOTAL    = 400_000    // a whole program is a handful of small files; this is a guard, not a target

/** Every source file under a program directory, as relative paths, depth-first and stably ordered. */
export async function collectProgramFiles(workspace: string, programDir: string): Promise<ProgramFile[]> {
  const root = join(workspace, programDir)
  const out: ProgramFile[] = []
  let budget = TOTAL

  const walk = async (dir: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof readdir>>
    try { entries = await readdir(dir, { withFileTypes: true } as any) as any } catch { return }
    // Directories after files, each alphabetical: program.ts sits above units/, which is how it reads.
    const items = [...entries].sort((a: any, b: any) =>
      (a.isDirectory() === b.isDirectory()) ? String(a.name).localeCompare(String(b.name)) : (a.isDirectory() ? 1 : -1))
    for (const e of items as any[]) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        await walk(full)
        continue
      }
      if (!/\.(ts|tsx|mts|js|mjs|json|sql|md)$/i.test(e.name)) continue
      if (budget <= 0) return
      try {
        const s = await stat(full)
        let text = await readFile(full, 'utf8')
        const truncated = text.length > PER_FILE
        if (truncated) text = text.slice(0, PER_FILE) + '\n\n… truncated …\n'
        budget -= text.length
        out.push({ path: relative(root, full).split(sep).join('/'), text, bytes: s.size, ...(truncated ? { truncated } : {}) })
      } catch { /* a file we cannot read is not worth failing the whole view for */ }
    }
  }
  await walk(root)
  return out
}

/** The answer card for a program view: a `files` section the UI renders as a picker plus a source pane. */
export function programAnswer(programDir: string, files: ProgramFile[], params?: unknown) {
  if (!files.length) {
    return { status: 'cannot_answer', category: VERBS.program.category,
             answer: `The program directory \`${programDir}\` has no source files in it.` }
  }
  const ran = params && Object.keys(params as any).length ? ` It was last run with \`${JSON.stringify(params)}\`.` : ''
  return {
    status: 'answered',
    category: VERBS.program.category,
    // Prose above the files, so the card still says something when a client cannot render the section.
    answer: `\`${programDir}\` — ${files.length} file${files.length === 1 ? '' : 's'}.${ran}`,
    sections: [{ kind: 'files', title: programDir, files }],
  }
}
