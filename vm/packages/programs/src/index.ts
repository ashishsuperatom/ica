// ── Programs — a Node.js bundle and a React bundle, built from source, identified by hash ───────────────────────────
//
// A program's source is a folder:
//
//   manifest.json   id, name, version, scope, owner, attachesTo (org knowledge index path), reads, ui.blocks, package?
//   server/         its Node side — index.ts exports its functions (`run` the default, and any others it declares)
//   web/            its React side — index.tsx exports a component per block it gives the UI
//   doc.md          its small documentation, injected into the agent
//
// Building compiles every .ts/.tsx file with TypeScript (per file, the same source always giving the same bytes).
// The platform's own libraries — React, the table, the charts, the design system — stay bare imports, supplied when
// the program is loaded, so every program uses the same ones and none bundles its own copy. The built program's
// hash covers the manifest, the doc and every built file: the same source always has the same hash, and any change
// makes a new one. Programs are immutable: a hash is never rebuilt with other content.
//
// The store keeps built programs by hash (a folder per hash here; R2 in the platform). The loader imports a
// program's Node side and gives it to the STATE engine as a package; `inspect` says where a function lives.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { checkProgram, type ProgramManifest } from '@superatom/platform-types'

/** What a program's author writes; the build adds hash and bundles. */
export type ProgramSource = Omit<ProgramManifest, 'hash' | 'node' | 'ui'> & { node?: { runtime?: ('on-prem' | 'worker')[] }; ui: { blocks: string[] } }

export class ProgramError extends Error {
  constructor(public problems: string[]) { super(problems.join('; ')) }
}

/** Libraries the platform supplies to every program at load time: a program imports them, never bundles them. */
export const PLATFORM_LIBRARIES = ['react', 'react/jsx-runtime', 'react-dom', 'echarts', '@superatom/ui', '@superatom/design'] as const

const COMPILER: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  sourceMap: false, removeComments: false, verbatimModuleSyntax: false, isolatedModules: true,
}

const files = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p] }).sort() : []
const posix = (p: string) => p.split(sep).join('/')

/** Every import a module makes, by specifier. */
function importsOf(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** Compile one side (server or web): every .ts/.tsx to .js, other files copied. Refuses what would not load. */
function compileSide(srcDir: string, outDir: string, side: 'server' | 'web'): string[] {
  const problems: string[] = []
  const written: string[] = []
  for (const file of files(srcDir)) {
    const rel = posix(relative(srcDir, file))
    if (/\.(test|spec)\.tsx?$/.test(rel)) continue
    const source = readFileSync(file, 'utf8')
    let outRel = rel, out = source
    if (/\.tsx?$/.test(rel) && !rel.endsWith('.d.ts')) {
      const r = ts.transpileModule(source, { compilerOptions: COMPILER, fileName: rel, reportDiagnostics: true })
      for (const d of r.diagnostics ?? []) problems.push(`${side}/${rel}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
      out = r.outputText
      outRel = rel.replace(/\.tsx?$/, '.js')
      for (const spec of importsOf(out)) {
        if (spec.startsWith('.')) {
          // ESM needs the extension: an author writes ./x.js for ./x.ts, as TypeScript expects.
          if (!/\.(js|mjs|json)$/.test(spec)) problems.push(`${side}/${rel} imports "${spec}" without its extension — write "${spec}.js"`)
        } else if (side === 'web' && !(PLATFORM_LIBRARIES as readonly string[]).some((l) => spec === l || spec.startsWith(l + '/'))) {
          problems.push(`web/${rel} imports "${spec}": the React side may import only the platform's libraries (${PLATFORM_LIBRARIES.join(', ')}) and its own files — anything else goes into the program's own files`)
        }
      }
    } else if (rel.endsWith('.d.ts')) continue
    const target = join(outDir, outRel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, out)
    written.push(outRel)
  }
  if (problems.length) throw new ProgramError(problems)
  return written
}

/** The hash of a built program: its manifest, its doc and every built file, by path, in order. */
function hashBuilt(dir: string): string {
  const h = createHash('sha256')
  for (const f of files(dir)) {
    const rel = posix(relative(dir, f))
    if (rel === 'built.json') continue
    h.update(`${rel}\n`); h.update(readFileSync(f)); h.update('\n')
  }
  return h.digest('hex')
}

export interface Built { hash: string; dir: string; manifest: ProgramManifest }

/** Build a program from its source folder into the store: compiled, checked, hashed. Building the same source twice
 *  gives the same hash and writes nothing new. */
export function buildProgram(srcDir: string, store: ProgramStore): Built {
  const problems: string[] = []
  const manifestFile = join(srcDir, 'manifest.json')
  if (!existsSync(manifestFile)) throw new ProgramError([`${srcDir} has no manifest.json`])
  let source: ProgramSource
  try { source = JSON.parse(readFileSync(manifestFile, 'utf8')) } catch (e: any) { throw new ProgramError([`manifest.json: ${e.message}`]) }
  if (!existsSync(join(srcDir, 'server', 'index.ts'))) problems.push('server/index.ts is required: a program is a Node.js bundle and a React bundle')
  if (!existsSync(join(srcDir, 'web', 'index.tsx'))) problems.push('web/index.tsx is required: a program is a Node.js bundle and a React bundle')
  if (!existsSync(join(srcDir, 'doc.md'))) problems.push('doc.md is required: without it an agent cannot use the program')
  if (problems.length) throw new ProgramError(problems)

  const staging = join(store.root, `.building-${process.pid}-${Date.now()}`)
  rmSync(staging, { recursive: true, force: true })
  try {
    compileSide(join(srcDir, 'server'), join(staging, 'node'), 'server')
    compileSide(join(srcDir, 'web'), join(staging, 'web'), 'web')
    writeFileSync(join(staging, 'doc.md'), readFileSync(join(srcDir, 'doc.md')))
    // The manifest as built: what the author wrote, with the bundles named. The hash is added after hashing.
    const built: Omit<ProgramManifest, 'hash'> = {
      ...source,
      node: { bundle: 'node/index.js', runtime: source.node?.runtime ?? ['on-prem'] },
      ui: { bundle: 'web/index.js', blocks: source.ui?.blocks ?? [] },
      ...(source.package ? { package: { ...source.package, doc: 'doc.md' } } : {}),
    }
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(built, null, 2))
    const hash = hashBuilt(staging)
    const manifest: ProgramManifest = { ...built, hash }
    const bad = checkProgram(manifest)
    if (bad.length) throw new ProgramError(bad)
    writeFileSync(join(staging, 'built.json'), JSON.stringify({ hash, at: new Date().toISOString() }))
    const dir = store.dirOf(hash)
    if (existsSync(dir)) { rmSync(staging, { recursive: true, force: true }); return { hash, dir, manifest } }   // immutable: already there
    renameSync(staging, dir)
    return { hash, dir, manifest }
  } catch (e) { rmSync(staging, { recursive: true, force: true }); throw e }
}

/** Built programs, kept by hash. */
export class ProgramStore {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true }) }
  dirOf(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ProgramError([`"${hash}" is not a program hash`])
    return join(this.root, hash)
  }
  has(hash: string): boolean { return existsSync(join(this.dirOf(hash), 'manifest.json')) }
  manifest(hash: string): ProgramManifest {
    if (!this.has(hash)) throw new ProgramError([`no program ${hash.slice(0, 12)} in the store`])
    // The hash is not inside the files it is the hash of: it is the folder's name.
    return { ...JSON.parse(readFileSync(join(this.dirOf(hash), 'manifest.json'), 'utf8')), hash }
  }
  doc(hash: string): string { return readFileSync(join(this.dirOf(hash), 'doc.md'), 'utf8') }
  /** Every program in the store, newest build first. */
  list(): ProgramManifest[] {
    return readdirSync(this.root).filter((n) => /^[0-9a-f]{64}$/.test(n) && this.has(n)).map((n) => this.manifest(n))
  }
  /** Is a stored program what its hash says? (Its files were not changed after it was built.) */
  verify(hash: string): boolean { return hashBuilt(this.dirOf(hash)) === hash }
}

/** Where a program's function lives — not its source, its place: the program by hash, the built file, the export. */
export function inspect(store: ProgramStore, hash: string, fn: string): { program: string; hash: string; file: string; export: string; source: string } {
  const m = store.manifest(hash)
  const declared = m.package?.functions.some((f) => f.name === fn) ?? fn === 'run'
  if (!declared) throw new ProgramError([`program "${m.name}" has no function ${fn}()`])
  return { program: m.name, hash, file: join(store.dirOf(hash), m.node.bundle), export: fn, source: `server/index.ts` }
}

/** Import a program's Node side: its functions, by name. The store's copy is checked against its hash first. */
export async function loadNode(store: ProgramStore, hash: string): Promise<{ manifest: ProgramManifest; functions: Record<string, (...args: any[]) => any> }> {
  if (!store.verify(hash)) throw new ProgramError([`program ${hash.slice(0, 12)} in the store does not match its hash: it was changed after it was built`])
  const manifest = store.manifest(hash)
  const mod = await import(pathToFileURL(join(store.dirOf(hash), manifest.node.bundle)).href)
  const functions: Record<string, (...args: any[]) => any> = {}
  for (const f of manifest.package?.functions ?? [{ name: 'run' }]) {
    if (typeof mod[f.name] !== 'function') throw new ProgramError([`program "${manifest.name}" declares ${f.name}() but server/index.ts does not export it`])
    functions[f.name] = mod[f.name]
  }
  return { manifest, functions }
}

/** A program's part in STATE, ready for the STATE engine: its package spec and its functions. */
export async function loadPackage(store: ProgramStore, hash: string): Promise<{ name: string; hash: string; spec: NonNullable<ProgramManifest['package']>; functions: Record<string, (...args: any[]) => any> }> {
  const { manifest, functions } = await loadNode(store, hash)
  if (!manifest.package) throw new ProgramError([`program "${manifest.name}" takes no part in STATE (no package in its manifest)`])
  return { name: manifest.package.owns, hash, spec: manifest.package, functions }
}
