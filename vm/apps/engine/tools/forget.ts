// CLI: completely delete a program and everything the question that built it generated.
//
//   pnpm exec tsx tools/forget.ts <programDir>            # e.g. programs/top-customers-freight-yoy
//   pnpm exec tsx tools/forget.ts --q "how many customers do we have?"
//   pnpm exec tsx tools/forget.ts --qid <qid>
//
// Paths come from the SAME env the engine reads (ICA_PROJECT + ENGINE_STATE_DIR/ENGINE_DATA_DIR/
// ENGINE_WORKSPACE_DIR), so it targets the right project's state on any box. Run with the engine STOPPED for
// that project (both hold the sqlite); for a live delete without stopping anything, send the `program:forget`
// WS message instead — same primitive, in-process.
//
// This is the operator/manual door. The protocol handler in engine.ts is the admin-UI door. Both call the one
// shared forgetProgram() in ../forget.ts.

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { openAnswers } from '../answers.js'
import { forgetProgram, type ForgetTarget } from '../forget.js'

const argv = process.argv.slice(2)
function flag(name: string): string | undefined {
  const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true)
const target: ForgetTarget = { programDir: flag('--dir') ?? positional, question: flag('--q'), qid: flag('--qid') }
if (!target.programDir && !target.question && !target.qid) {
  console.error('usage: tsx tools/forget.ts <programDir> | --q "<question>" | --qid <qid>')
  process.exit(2)
}

const PROJECT = process.env.ICA_PROJECT || ''
if (!PROJECT) { console.error('need ICA_PROJECT (the project whose state to prune)'); process.exit(2) }
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const VM_ROOT = join(__dirname, '..', '..', '..')                        // apps/engine/tools → vm monorepo root
const STATE_ROOT = process.env.ENGINE_STATE_DIR ?? join(VM_ROOT, '.state')
const WORKSPACE = join(process.env.ENGINE_WORKSPACE_DIR ?? STATE_ROOT, PROJECT)
const ANSWERS_DB = join(process.env.ENGINE_DATA_DIR ?? STATE_ROOT, PROJECT, 'db', 'answers.sqlite')
if (!existsSync(ANSWERS_DB)) { console.error(`no answers db at ${ANSWERS_DB} — wrong project id or state dir?`); process.exit(2) }

const store = openAnswers(ANSWERS_DB)
const res = forgetProgram(store, WORKSPACE, target)
console.log(JSON.stringify(res, null, 2))
process.exit(res.ok ? 0 : 1)
