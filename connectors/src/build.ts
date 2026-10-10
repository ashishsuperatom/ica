// Build every connector in catalog/: check its manifest, bundle its server module with the SDK into one ES module (no
// imports left, nothing of Node — it runs in a Dynamic Worker), hash the two, and write dist/:
//   dist/catalog.json   every connector's manifest with its hash (what the platform lists and the connection form reads)
//   dist/code.json      the sandbox's main module, and each connector's bundled server code by id with its hash (what
//                       the platform loads to run it)
// The same source makes the same hash; a changed connector is a new hash, and connections pick it up at the next deploy.

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
import { checkManifest, type Manifest } from './contract'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const catalogDir = join(root, 'catalog'), dist = join(root, 'dist')

export async function buildAll(): Promise<{ catalog: (Manifest & { hash: string })[]; problems: string[] }> {
  const problems: string[] = []
  const catalog: (Manifest & { hash: string })[] = []
  const code: Record<string, { hash: string; server: string }> = {}
  for (const id of readdirSync(catalogDir).sort()) {
    const dir = join(catalogDir, id)
    if (!existsSync(join(dir, 'manifest.json'))) continue
    let manifest: Manifest
    try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) } catch (e: any) { problems.push(`${id}: manifest.json is not JSON (${e.message})`); continue }
    const bad = checkManifest(manifest)
    if (manifest.id !== id) bad.push(`its id is "${manifest.id}" but its folder is "${id}"`)
    if (!existsSync(join(dir, 'server.ts'))) bad.push('server.ts is required')
    if (bad.length) { problems.push(...bad.map((b) => `${id}: ${b}`)); continue }
    const out = await build({ entryPoints: [join(dir, 'server.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'silent', mainFields: ['module', 'main'] })
      .catch((e) => { problems.push(`${id}: ${e.message.split('\n')[0]}`); return null })
    if (!out) continue
    const server = out.outputFiles[0].text
    if (/\bfrom\s*["'](node:|fs|path|child_process)/.test(server)) { problems.push(`${id}: the server module imports something of Node; connectors run in a Worker`); continue }
    const hash = createHash('sha256').update(JSON.stringify(manifest)).update('\0').update(server).digest('hex')
    catalog.push({ ...manifest, hash })
    code[id] = { hash, server }
  }
  // The sandbox's main module, bundled once for every connector (it imports the connector as ./connector.js).
  const main = await build({ entryPoints: [join(root, 'src', 'sandbox-main.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'silent', external: ['./connector.js'] })
  const sandbox = main.outputFiles[0].text
  // The ready bridges of the code connectors — each a folder of its own (bridges/<name>/: bridge.mjs and a package.json
  // with ITS OWN driver, a workspace package here): the platform attaches a connector's bridge to each connection made
  // with it, so a source runs whatever door it was made from.
  const bridges: Record<string, string> = {}
  const bdir = join(root, 'bridges')
  // Each is bundled WITH its own driver (a pure-JavaScript package, in its folder's package.json): one self-contained module the
  // data source manager loads as it is — the engine installs nothing for any connector. A driver that needs native code
  // (DuckDB) is not bundled: the data source manager supplies it (createBridge({ drivers })).
  if (existsSync(bdir)) for (const name of readdirSync(bdir).filter((x) => existsSync(join(bdir, x, 'bridge.mjs'))).sort()) {
    const f = `${name}/bridge.mjs`
    const src = readFileSync(join(bdir, f), 'utf8')
    if (!/export\s+(async\s+)?function\s+createBridge|export\s+(const|let)\s+createBridge/.test(src)) { problems.push(`bridges/${f}: a bridge exports createBridge({ settings, secrets })`); continue }
    const out = await build({ entryPoints: [join(bdir, f)], bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true, write: false, logLevel: 'silent',
      // SEALED TO THIS FOLDER: a module that resolves outside it (a node_modules in someone's home, above the repository)
      // is left as an import, never bundled — so every machine builds the same bytes as the committed dist.
      plugins: [sealedTo(root)],
      // a bundled CommonJS driver asks for Node's own modules with require: give the module one
      banner: { js: "import { createRequire as __saRequire } from 'node:module'; const require = __saRequire(import.meta.url);" } })
      .catch((e) => { problems.push(`bridges/${f}: ${e.message.split('\n')[0]}`); return null })
    if (!out) continue
    const code = out.outputFiles[0].text
    if (code.length > 2_000_000) { problems.push(`bridges/${f}: bundled it is ${(code.length / 1e6).toFixed(1)} MB — a bridge is at most 2 MB`); continue }
    bridges[name] = code
  }
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'bridges.json'), JSON.stringify(bridges) + '\n')
  writeFileSync(join(dist, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
  writeFileSync(join(dist, 'code.json'), JSON.stringify({ sandbox, connectors: code }) + '\n')
  return { catalog, problems }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await buildAll()
  for (const c of r.catalog) console.log(`${c.hash.slice(0, 12)}  ${c.id}  (${c.offers.data ? 'data' : ''}${c.offers.data && c.offers.actions ? ' · ' : ''}${c.offers.actions ? 'actions' : ''})`)
  if (r.problems.length) { console.error(r.problems.map((p) => `✗ ${p}`).join('\n')); process.exit(1) }
}
