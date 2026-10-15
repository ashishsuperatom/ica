// Build every connector (bridges/<id>/): check its manifest, bundle its code with its own driver into one self-contained
// module, hash it, and write dist/:
//   dist/engine.json    every connector's manifest with its hash (its version) and size — the platform's catalogue
//   dist/bridges.json   each connector's bundled code by id — what a connection made with it runs
// The same source makes the same hash; a changed connector is a new hash, offered to its connections as a newer version.

import { build, type Plugin } from 'esbuild'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

/** Resolve as esbuild does, but keep anything found outside `dir` out of the bundle (an import at run time instead). */
const sealedTo = (dir: string): Plugin => ({
  name: 'sealed',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, async (a) => {
      if (a.pluginData?.sealed) return undefined
      const r = await b.resolve(a.path, { kind: a.kind, resolveDir: a.resolveDir, importer: a.importer, pluginData: { sealed: true } })
      if (r.errors.length || !r.path || !isAbsolute(r.path)) return undefined
      const rel = relative(dir, r.path)
      return rel.startsWith('..') ? { path: a.path, external: true } : undefined
    })
  },
})
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkEngineManifest, type EngineManifest } from './contract'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

export async function buildAll(): Promise<{ engine: (EngineManifest & { hash: string; bytes: number })[]; problems: string[] }> {
  const problems: string[] = []
  // The ready bridges of the code connectors — each a folder of its own (bridges/<name>/: bridge.mjs and a package.json
  // with ITS OWN driver, a workspace package here): the platform attaches a connector's bridge to each connection made
  // with it, so a source runs whatever door it was made from.
  const bridges: Record<string, string> = {}
  const engine: (EngineManifest & { hash: string; bytes: number })[] = []
  const bdir = join(root, 'bridges')
  // Each ENGINE CONNECTOR is a folder (bridges/<id>/): its manifest, its code (bridge.mjs) and its package.json with ITS OWN
  // driver. The code is bundled WITH its driver (a pure-JavaScript package): one self-contained module the data source
  // manager loads as it is — the engine installs nothing for any connector. A driver that needs native code (DuckDB) is
  // named in the manifest (native) and supplied by the manager (createBridge({ drivers })). Its hash is its version.
  if (existsSync(bdir)) for (const id of readdirSync(bdir).filter((x) => existsSync(join(bdir, x, 'bridge.mjs'))).sort()) {
    const f = `${id}/bridge.mjs`
    let manifest: EngineManifest
    try { manifest = JSON.parse(readFileSync(join(bdir, id, 'manifest.json'), 'utf8')) } catch (e: any) { problems.push(`bridges/${id}: manifest.json is missing or not JSON (${e.message})`); continue }
    const bad = checkEngineManifest(manifest)
    if (manifest.id !== id) bad.push(`its id is "${manifest.id}" but its folder is "${id}"`)
    if (bad.length) { problems.push(...bad.map((b) => `bridges/${id}: ${b}`)); continue }
    const src = readFileSync(join(bdir, f), 'utf8')
    if (!/export\s+(async\s+)?function\s+createBridge|export\s+(const|let)\s+createBridge|export\s*\{[^}]*\bcreateBridge\b/.test(src)) { problems.push(`bridges/${f}: a connector exports createBridge({ settings, secrets })`); continue }
    const out = await build({ entryPoints: [join(bdir, f)], bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true, write: false, logLevel: 'silent',
      // SEALED TO THIS FOLDER: a module that resolves outside it (a node_modules in someone's home, above the repository)
      // is left as an import, never bundled — so every machine builds the same bytes as the committed dist.
      plugins: [sealedTo(root)], external: [...(manifest.native ?? [])],
      // a bundled CommonJS driver asks for Node's own modules with require: give the module one
      banner: { js: "import { createRequire as __saRequire } from 'node:module'; const require = __saRequire(import.meta.url);" } })
      .catch((e) => { problems.push(`bridges/${f}: ${e.message.split('\n')[0]}`); return null })
    if (!out) continue
    const code = out.outputFiles[0].text
    if (code.length > 6_000_000) { problems.push(`bridges/${f}: bundled it is ${(code.length / 1e6).toFixed(1)} MB — a connector is at most 6 MB`); continue }
    bridges[id] = code
    engine.push({ ...manifest, hash: createHash('sha256').update(code).digest('hex'), bytes: code.length })
  }
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'bridges.json'), JSON.stringify(bridges) + '\n')
  writeFileSync(join(dist, 'engine.json'), JSON.stringify(engine, null, 2) + '\n')
  return { engine, problems }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await buildAll()
  for (const c of r.engine) console.log(`${c.hash.slice(0, 12)}  ${c.id}  engine · ${c.kind} · ${c.dialect} · ${(c.bytes / 1e3).toFixed(0)} KB`)
  if (r.problems.length) { console.error(r.problems.map((p) => `✗ ${p}`).join('\n')); process.exit(1) }
}
