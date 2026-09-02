// Execute a program in a FRESH SUBPROCESS — never in-process.
//
// The engine is a long-lived process running under tsx, and tsx caches transpiled modules by PATH, IGNORING
// the `?t=` import cache-busting query the kernel adds. So an in-process re-run of a program AFTER the analyst
// edited it (a modify, or a rebuild of the same program dir) would execute the STALE cached module and silently
// serve the OLD answer — the analyst really changes the files, but the engine runs yesterday's code. Verified:
// in a persistent tsx process, editing a file then re-importing with a new `?t=` still returns the old module.
//
// A subprocess starts with an EMPTY module cache, so it always runs the CURRENT code. We reuse run.mjs (the
// same entry the analyst uses to verify), which executes the program and writes the full provenance manifest
// (output + finalShapeHash + ui + graph) to <programDir>/program.json — we read that back as the result.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const execFileP = promisify(execFile)

export type ProgramRun = {
  output: any
  finalShapeHash?: string
  ui?: any
  ms?: number
  nodes?: any[]
  edges?: any[]
  branches?: any[]
  root?: string
}

/**
 * Run `<cwd>/<programDir>/program.ts` with `params` in a fresh `tsx run.mjs` subprocess and return its manifest.
 * Throws if the program errors (non-zero exit) — callers already wrap this to record a run failure.
 */
export async function execProgram(cwd: string, programDir: string, params: any): Promise<ProgramRun> {
  // tsx is on PATH (the engine is started via `pnpm exec tsx`, which the child inherits). stdout carries the
  // program's rendered output; the authoritative manifest is written to program.json — we read that.
  await execFileP('tsx', ['run.mjs', `${programDir}/program.ts`, JSON.stringify(params ?? {})],
    { cwd, env: process.env, maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(await readFile(join(cwd, programDir, 'program.json'), 'utf8')) as ProgramRun
}

/** THE VIEW-MODEL A PROGRAM PRODUCED, taken out of the unit envelope.
 *
 *  A unit returns `{ answer: <view> }` — that is the contract, and the canonical example program returns a
 *  unit's output directly (`return ctx.use('single-metric-view', …)`), so a program's output IS the envelope.
 *  Every consumer then has to unwrap it, and all three of them instead did `{ ...out }`, which buries the view
 *  one level down. The card reads `a.answer` as its prose and prints "[object Object]"; `a.headline` and
 *  `a.sections` are undefined beside it, so the KPI and every table disappear without a word.
 *
 *  Only a genuine envelope is unwrapped: an `answer` that is a plain OBJECT. A program may return the view
 *  directly, and in the flat format `answer` is an ARRAY of prose lines — neither is an envelope.
 *
 *  One function, used by all three consumers, because three copies of this rule is how it drifts back apart. */
export function answerView(out: any): any {
  const view = out && typeof out === 'object' && out.answer
    && typeof out.answer === 'object' && !Array.isArray(out.answer) ? out.answer : out
  return { ...view, status: view?.status ?? 'answered' }
}

/** Keep `answer` as an alias of `text` on the way out.
 *
 *  The view-model's prose field is `text` now — `answer` used to name BOTH the prose and, one level up, the
 *  whole view-model, and that collision is what put an object where prose belonged and printed
 *  "[object Object]" to a user.
 *
 *  But the wire is shared: the iOS client reads `answer` for prose (EngineAnswer.swift), and the Teams channel
 *  passes `answer` through untouched. Renaming the field without an alias would silently blank the prose in
 *  both — a client that cannot be rebuilt in the same breath as the engine must not be broken by an engine
 *  rename. So both keys travel, `text` is authoritative, and `answer` follows it until those clients move.
 *
 *  Only ever set when `answer` is not already prose, so an older program that still writes `answer` wins. */
export function withProseAlias(a: any): any {
  if (!a || typeof a !== 'object') return a
  const answerIsProse = typeof a.answer === 'string' || Array.isArray(a.answer)
  if (a.text !== undefined && !answerIsProse) return { ...a, answer: a.text }
  if (a.text === undefined && answerIsProse) return { ...a, text: a.answer }
  return a
}
