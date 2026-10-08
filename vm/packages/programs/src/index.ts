// ── Programs — a Node.js bundle and a React bundle, built from source, identified by hash ───────────────────────────
//
// A program's source is a folder:
//
//   manifest.json   id, name, version, scope, owner, attachesTo (org knowledge index path), reads, ui.blocks, package?
//   server/         its Node side — index.ts exports its functions (`run` the default, and any others it declares)
//   web/            its React side — index.tsx exports a component per block it gives the UI
//   doc.md          its small documentation, injected into the agent
//
// A program may be a LIBRARY (manifest `kind: "library"`): functions in server/ and components in web/ that other
// programs use — no STATE, no blocks of its own. A program names the libraries it uses (`uses: ["<name>"]`, or
// "<name>@<hash prefix>" to pin a build) and imports them as `@lib/<name>[/<file>.js]`. Building it records which build
// of each it links (`uses: [{ name, hash }]`, inside its hash) — the library is not copied in: it is kept once, as its
// own build, and loading resolves `@lib/<name>` to that one build (in Node through a resolve hook, lib-resolve.ts; in the
// browser through the loader), so N programs using one library load it once, as one module. A new library build makes a
// new program build only when the program is built again; nothing changes under a program already built.
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
import { checkProgram, PLATFORM_LIBRARIES, type ProgramManifest } from '@superatom/platform-types'
import { BUNDLE_FORMAT, digestInput, verifyBundle, type ProgramBundle } from './bundle.ts'
import { installLibResolve } from './lib-resolve.ts'
export * from './bundle.ts'

/** What a program's author writes; the build adds hash and bundles. */
export type ProgramSource = Omit<ProgramManifest, 'hash' | 'node' | 'ui' | 'uses'> & { node?: { runtime?: ('on-prem' | 'worker')[] }; ui: { blocks: string[]; head?: string[] }; uses?: string[] }

export class ProgramError extends Error {
  constructor(public problems: string[]) { super(problems.join('; ')) }
}

export { PLATFORM_LIBRARIES }

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

/** An import of a library: `@lib/<name>` or `@lib/<name>/<file>.js`. */
export const LIB = /^@lib\/([a-z][a-z0-9-]*)(\/.+)?$/

/** Compile one side (server or web): every .ts/.tsx to .js, other files copied; `@lib/<name>` imports only of the
 *  libraries it uses. Refuses what would not load. */
function compileSide(srcDir: string, outDir: string, side: 'server' | 'web', libs: string[] = []): string[] {
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
        const lib = LIB.exec(spec)
        if (lib) {
          if (!libs.includes(lib[1])) problems.push(`${side}/${rel} imports "${spec}", but the manifest does not use "${lib[1]}" — add it to "uses"`)
          else if (lib[2] && !/\.(js|mjs|json)$/.test(lib[2])) problems.push(`${side}/${rel} imports "${spec}" without its extension — write "${spec}.js"`)
          continue
        }
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

/** A built program's files by path (not the store's own built.json). Program files are text; a file that is not
 *  valid UTF-8 is refused, so the bundle carries exactly the bytes the hash was taken over. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of files(dir)) {
    const rel = posix(relative(dir, f))
    if (rel === 'built.json') continue
    const bytes = readFileSync(f)
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new ProgramError([`${rel} is not text: a program's files are text (code, JSON, Markdown)`])
    out[rel] = text
  }
  return out
}

/** The hash of a built program: its manifest, its doc and every built file — as bundle.ts defines it. */
function hashBuilt(dir: string): string {
  return createHash('sha256').update(digestInput(filesOf(dir))).digest('hex')
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
  const library = source.kind === 'library'
  if (library) { if (!existsSync(join(srcDir, 'server', 'index.ts')) && !existsSync(join(srcDir, 'web', 'index.tsx'))) problems.push('a library has server/index.ts (its functions), web/index.tsx (its components), or both') }
  else {
    if (!existsSync(join(srcDir, 'server', 'index.ts'))) problems.push('server/index.ts is required: a program is a Node.js bundle and a React bundle')
    if (!existsSync(join(srcDir, 'web', 'index.tsx'))) problems.push('web/index.tsx is required: a program is a Node.js bundle and a React bundle')
  }
  if (!existsSync(join(srcDir, 'doc.md'))) problems.push('doc.md is required: without it an agent cannot use the program')
  if (source.uses !== undefined && (!Array.isArray(source.uses) || source.uses.some((u) => typeof u !== 'string' || !/^[a-z][a-z0-9-]*(@[0-9a-f]{8,64})?$/.test(u)))) problems.push('manifest "uses" lists libraries by name, or "<name>@<hash prefix>" to pin a build')
  if (problems.length) throw new ProgramError(problems)
  // The libraries it uses: each the build named (newest by name, or the pinned hash), and each one a library.
  const uses = (source.uses ?? []).map((u) => {
    const [name, pin] = u.split('@')
    let hash: string
    try { hash = store.resolve(pin ?? name) } catch { throw new ProgramError([`it uses "${u}", which is not built here — build the library first`]) }
    const m = store.manifest(hash)
    if (m.name !== name) throw new ProgramError([`"${u}": that build is "${m.name}", not "${name}"`])
    if (m.kind !== 'library') throw new ProgramError([`it uses "${name}", which is a program, not a library — a library has "kind": "library"`])
    if (name === source.name) throw new ProgramError(['a program cannot use itself'])
    return { name, hash }
  })
  const libs = uses.map((u) => u.name)
  // One build of each library in all it links, through its libraries too: two builds of one library would be two
  // modules where the program means one.
  const seen = new Map<string, string>()
  for (const l of linked(store, uses)) { const had = seen.get(l.name); if (had && had !== l.hash) throw new ProgramError([`it would link two builds of "${l.name}" (${had.slice(0, 12)} and ${l.hash.slice(0, 12)}) — build the libraries against one`]); seen.set(l.name, l.hash) }

  const staging = join(store.root, `.building-${process.pid}-${Date.now()}`)
  rmSync(staging, { recursive: true, force: true })
  try {
    compileSide(join(srcDir, 'server'), join(staging, 'node'), 'server', libs)
    compileSide(join(srcDir, 'web'), join(staging, 'web'), 'web', libs)
    writeFileSync(join(staging, 'doc.md'), readFileSync(join(srcDir, 'doc.md')))
    // The source it was built from travels with it (source/…), inside its hash: the platform keeps a program's source
    // with its build, so it can be read and built again from there — never only on one machine's disk.
    for (const f of files(srcDir)) {
      const rel = posix(relative(srcDir, f))
      if (!/^(manifest\.json|doc\.md|(server|web)\/.+)$/.test(rel) || /(^|\/)(node_modules|dist)\//.test(rel)) continue
      const to = join(staging, 'source', rel); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, readFileSync(f))
    }
    // The manifest as built: what the author wrote, with the bundles named. The hash is added after hashing.
    const { uses: _named, ...rest } = source
    const built: Omit<ProgramManifest, 'hash'> = {
      ...rest,
      ...(uses.length ? { uses } : {}),
      node: { bundle: 'node/index.js', runtime: source.node?.runtime ?? ['on-prem'] },
      ui: { bundle: 'web/index.js', blocks: source.ui?.blocks ?? [], ...(source.ui?.head?.length ? { head: source.ui.head } : {}) },
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

/** Every library build a program links — its own and theirs, each once. */
export function linked(store: ProgramStore, uses: { name: string; hash: string }[]): { name: string; hash: string }[] {
  const out: { name: string; hash: string }[] = []
  const walk = (list: { name: string; hash: string }[]) => {
    for (const u of list) {
      if (out.some((x) => x.hash === u.hash)) continue
      out.push(u)
      if (store.has(u.hash)) walk(store.manifest(u.hash).uses ?? [])
    }
  }
  walk(uses)
  return out
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
  /** When a program was built (from its built.json). */
  builtAt(hash: string): string {
    try { return JSON.parse(readFileSync(join(this.dirOf(hash), 'built.json'), 'utf8')).at ?? '' } catch { return '' }
  }
  /** A program by hash, by a hash prefix of 8 or more characters, or by name (its newest build). */
  resolve(ref: string): string {
    const all = this.list()
    const byHash = /^[0-9a-f]{8,64}$/.test(ref)
    const hits = byHash ? all.filter((m) => m.hash.startsWith(ref)) : all.filter((m) => m.name === ref)
    if (!hits.length) throw new ProgramError([`no program "${ref}" in the store`])
    if (byHash && hits.length > 1) throw new ProgramError([`"${ref}" names ${hits.length} programs: give more of the hash`])
    return hits.sort((a, b) => this.builtAt(b.hash).localeCompare(this.builtAt(a.hash)))[0].hash
  }
  /** Is a stored program what its hash says? (Its files were not changed after it was built.) */
  verify(hash: string): boolean { return hashBuilt(this.dirOf(hash)) === hash }
}

/** A stored program as one bundle, to send or keep elsewhere. Checked against its hash first. */
export function toBundle(store: ProgramStore, hash: string): ProgramBundle {
  if (!store.verify(hash)) throw new ProgramError([`program ${hash.slice(0, 12)} in the store does not match its hash`])
  return { format: BUNDLE_FORMAT, hash, files: filesOf(store.dirOf(hash)) }
}

/** Keep a bundle in the store — refused unless its files are what its hash says. Keeping one already there is a no-op. */
export async function fromBundle(store: ProgramStore, bundle: unknown): Promise<string> {
  const bad = await verifyBundle(bundle)
  if (bad.length) throw new ProgramError(bad)
  const b = bundle as ProgramBundle
  if (store.has(b.hash)) return b.hash
  const staging = join(store.root, `.receiving-${process.pid}-${Date.now()}`)
  try {
    for (const [p, text] of Object.entries(b.files)) { const f = join(staging, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text) }
    if (hashBuilt(staging) !== b.hash) throw new ProgramError(['the bundle did not survive being written'])
    writeFileSync(join(staging, 'built.json'), JSON.stringify({ hash: b.hash, at: new Date().toISOString(), received: true }))
    if (store.has(b.hash)) { rmSync(staging, { recursive: true, force: true }); return b.hash }
    renameSync(staging, store.dirOf(b.hash))
    return b.hash
  } catch (e) { rmSync(staging, { recursive: true, force: true }); throw e }
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
  // Its libraries, each the build it names, here and whole: `@lib/<name>` resolves to them (lib-resolve.ts).
  for (const l of linked(store, manifest.uses ?? [])) {
    if (!store.has(l.hash)) throw new ProgramError([`program "${manifest.name}" uses ${l.name} ${l.hash.slice(0, 12)}, which is not here`])
    if (!store.verify(l.hash)) throw new ProgramError([`library ${l.name} ${l.hash.slice(0, 12)} in the store does not match its hash`])
  }
  if (manifest.uses?.length) installLibResolve()
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
