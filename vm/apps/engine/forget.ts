// ── Invalidate a program — "completely delete everything a question generated" ─────────────────────────
// One primitive, called from two places: the WS protocol (`program:forget`, admin-triggered) and a CLI
// (tools/forget.ts, operator-triggered). It is deterministic and engine-owned — no LLM.
//
// "Everything generated" = the reflex reuse cache (answers rows), the run-audit history (program_runs), the
// program FILES (programs/<slug>/), and the per-question deliverable folders (out/<qid>/). After a forget, the
// SAME question rebuilds from scratch — reflex finds no cached answer, and the analyst finds no program on disk.
//
// Deliberately OUT of scope: semantic atoms (learned, consolidated knowledge in the model graph that other
// programs may reference) and the agent SESSION (per-role, not per-question). Invalidation targets the program,
// not the accumulated learning around it.

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeQuestion, type AnswerStore } from './answers.js'

// Identify the program to forget by any ONE of: its dir, the question that built it, or a qid it produced.
export interface ForgetTarget { programDir?: string; question?: string; qid?: string }
export interface ForgetResult {
  ok: boolean
  programDir?: string          // what we resolved to (echoed for the admin UI)
  answers: number              // reflex-cache rows removed
  runs: number                 // run-audit rows removed
  qids: string[]               // question ids the program produced
  files: string[]              // workspace-relative paths removed (the program dir + out/<qid> folders)
  error?: string
}

// `store` deletes the rows; `workspace` is the project home (programs/ + out/ live under it) so we delete files.
export function forgetProgram(store: AnswerStore, workspace: string, target: ForgetTarget): ForgetResult {
  let programDir = target.programDir
  if (!programDir && target.question) programDir = store.programDirForNorm(normalizeQuestion(target.question)) ?? undefined
  if (!programDir && target.qid) programDir = store.get(target.qid)?.programDir

  if (!programDir) {
    // No program bound — but a bare (program-less) answer may still be cached under this question. Forget that.
    if (target.question) {
      const n = store.forgetNorm(normalizeQuestion(target.question))
      return { ok: n > 0, answers: n, runs: 0, qids: [], files: [], error: n ? undefined : 'no matching program or cached answer' }
    }
    return { ok: false, answers: 0, runs: 0, qids: [], files: [], error: 'target did not resolve to a program (pass programDir, question, or qid)' }
  }

  const del = store.forgetProgram(programDir)
  const files: string[] = []
  try { rmSync(join(workspace, programDir), { recursive: true, force: true }); files.push(programDir) } catch { /* already gone */ }
  for (const qid of del.qids) {
    try { rmSync(join(workspace, 'out', qid), { recursive: true, force: true }); files.push(`out/${qid}`) } catch { /* already gone */ }
  }
  return { ok: true, programDir, answers: del.answers, runs: del.runs, qids: del.qids, files }
}
