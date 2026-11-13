// ── Running a program's definitions once, when it is built (docs/programs-design.md "Where a program says what it is") ──
//
// Each side of a program says what it offers in its own code — server/index.ts `export const program = defineProgram(…)`,
// web/index.tsx `export const views = defineViews(…)`. The build runs each once and keeps what it says: server.json and
// web.json, inside the build's hash. Only the program's own files run: they are bundled together, every other import —
// React, the design system, an npm package, a library — left as a stand-in that does nothing, so nothing outside the
// program runs here (an npm package that reaches for `window` when imported cannot break a build). The definitions
// themselves come from the real @superatom/program. Each reference a definition holds is named by the export it is.

import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { existsSync } from 'node:fs'
import * as definitions from '@superatom/program'
import type { ProgramDescription, ViewsDescription } from '@superatom/program'

/** A stand-in for anything outside the program: callable, constructible, every property another stand-in. */
const standIn: any = new Proxy(function standIn() {}, {
  // __esModule: an `import * as x` or a default import takes it as it is, so any member of it is a stand-in too
  get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === '__esModule' ? true : k === 'then' ? undefined : standIn),
  apply: () => standIn, construct: () => standIn,
})

/** The module a side's entry exports, run once with its own files and stand-ins for the rest; or why it could not run. */
function runOnce(entry: string, side: 'server' | 'web'): { exports: Record<string, unknown> } | { problem: string } {
  let code: string
  try {
    const r = buildSync({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22', packages: 'external', logLevel: 'silent', jsx: 'automatic',
      // the program's own files only: never a tsconfig found around where it is built, which could lead an import elsewhere
      tsconfigRaw: '{}' })
    code = r.outputFiles[0]!.text
  } catch (e: any) {
    const first = e?.errors?.[0]
    return { problem: `${side}/${first?.location?.file?.split(`/${side}/`).pop() ?? 'index'}${first?.location ? `:${first.location.line}` : ''}: ${first?.text ?? e?.message ?? e}` }
  }
  const module = { exports: {} as Record<string, unknown> }
  const require = (name: string) => (name === '@superatom/program' || name === '@superatom/ui' ? new Proxy(definitions as any, { get: (t, k) => (k in t ? t[k] : standIn) }) : standIn)
  try { runInNewContext(code, { module, exports: module.exports, require, console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}, URL, TextEncoder, TextDecoder }, { timeout: 2000 }) }
  catch (e: any) { return { problem: `${side}/index ran into ${e?.message ?? e} when its definition was read — a file's top level only defines things` } }
  return { exports: module.exports }
}

/** Each exported value by its export's name, for naming the references a definition holds. */
const exportNames = (exports: Record<string, unknown>) => new Map(Object.entries(exports).filter(([, v]) => typeof v === 'function').map(([k, v]) => [v as (...a: any[]) => unknown, k]))
const isDefinition = (v: unknown, key: 'functions' | 'views') => !!v && typeof v === 'object' && typeof (v as any).inspect === 'function' && key in (v as any)

export interface Described { server: ProgramDescription | null; web: ViewsDescription | null; problems: string[] }

/** What a program's two sides say they are, checked against their exports and each other. A library says nothing (its
 *  functions and components are imported by the programs that use it). */
export function describeProgram(srcDir: string, name: string, library: boolean): Described {
  const problems: string[] = []
  if (library) return { server: null, web: null, problems }
  let server: ProgramDescription | null = null, web: ViewsDescription | null = null
  const s = runOnce(`${srcDir}/server/index.ts`, 'server')
  if ('problem' in s) problems.push(s.problem)
  else if (!isDefinition(s.exports.program, 'functions')) problems.push('server/index.ts says what it offers: export const program = defineProgram({ state, functions: { run: fn(run, { produces: \'view\' }) } })')
  else {
    const names = exportNames(s.exports)
    server = (s.exports.program as definitions.DefinedProgram).inspect(names)
    const def = (s.exports.program as definitions.DefinedProgram).def
    const unexported = (ref: unknown, what: string) => { if (typeof ref !== 'function' || !names.has(ref as any)) problems.push(`${what} is not exported from server/index.ts — export it there`) }
    for (const [n, d] of Object.entries(def.functions)) { unexported(d.ref, `the function ${n}`); if (d.approval) unexported(d.approval, `${n}'s approval route`) }
    for (const o of def.options ?? []) unexported(o, `the option function ${(o as any)?.name ?? '?'}`)
    for (const f of def.filters ?? []) unexported(f.options, `the filter ${f.field}'s choices`)
    if (def.check) unexported(def.check, 'its check')
    if (!server.functions.some((f) => f.name === 'run')) problems.push('a program offers run, the default: functions: { run: fn(run, { produces: \'view\' }) }')
    for (const f of def.filters ?? []) if (!(f.field in def.state)) problems.push(`the filter ${f.field} is not a field of its STATE`)
  }
  if (!existsSync(`${srcDir}/web/index.tsx`)) problems.push('web/index.tsx is required: a program is a Node.js bundle and a React bundle')
  else {
    const w = runOnce(`${srcDir}/web/index.tsx`, 'web')
    if ('problem' in w) problems.push(w.problem)
    else if (!isDefinition(w.exports.views, 'views')) problems.push('web/index.tsx says what it draws: export const views = defineViews({ Main: view(Main, { doc: \'…\' }) })')
    else {
      const names = exportNames(w.exports)
      web = (w.exports.views as definitions.DefinedViews).inspect(names)
      for (const [n, d] of Object.entries((w.exports.views as definitions.DefinedViews).views)) if (!names.has(d.ref as any)) problems.push(`the view ${n} is not exported from web/index.tsx — export it there`)
    }
  }
  // The two sides against each other: what a view reads and changes is the program's STATE; what it calls is a function.
  if (server && web) {
    const fields = new Set(Object.keys(server.state.schema))
    for (const v of web.views) {
      for (const r of v.reads) if (!fields.has(r)) problems.push(`the view ${v.name} reads ${r}, which is not a field of its STATE (${[...fields].join(', ') || 'none'})`)
      for (const m of v.sends) {
        const field = 'set' in m ? m.set : 'add' in m ? m.add : 'remove' in m ? m.remove : null
        if (field !== null && !fields.has(field)) problems.push(`the view ${v.name} changes ${field}, which is not a field of its STATE`)
        if ('call' in m) {
          const [p, fn] = String(m.call).split('.')
          if (!fn) problems.push(`the view ${v.name} sends a call "${m.call}": a call is program.fn`)
          else if (p === name && !server.functions.some((f) => f.name === fn)) problems.push(`the view ${v.name} calls ${m.call}, which ${name} does not offer`)
        }
      }
    }
  }
  return { server, web, problems }
}
