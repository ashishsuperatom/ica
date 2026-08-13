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
