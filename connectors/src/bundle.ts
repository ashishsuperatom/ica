// ONE CONNECTOR, BUILT — the one build tool: the repository's build (build.ts, every folder of bridges/) and a person's
// (sacli connectors build | publish, on their laptop) both call this, so the same source and drivers make the same bytes
// and the same hash wherever it runs. It checks the manifest, bundles bridge.mjs with its own driver into one
// self-contained module (a native driver named in the manifest is left for the manager to supply), and hashes it.
// esbuild is given by the caller: the repository's own, or the one installed in the connector's folder.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import { checkEngineManifest, type EngineManifest } from './contract'

type Esbuild = { build: (o: any) => Promise<{ outputFiles?: { text: string }[] }> }
export type Built = { ok: true; manifest: EngineManifest; code: string; hash: string; bytes: number } | { ok: false; problems: string[] }

export const EXPORTS_CREATE_BRIDGE = /export\s+(async\s+)?function\s+createBridge|export\s+(const|let)\s+createBridge|export\s*\{[^}]*\bcreateBridge\b/
export const MAX_BYTES = 6_000_000

/** Resolve as esbuild does, but keep anything found outside `root` out of the bundle (an import at run time instead) —
 *  so a node_modules above the folder (someone's home) never changes what is built. */
const sealedTo = (root: string) => ({
  name: 'sealed',
  setup(b: any) {
    b.onResolve({ filter: /^[^./]/ }, async (a: any) => {
      if (a.pluginData?.sealed) return undefined
      const r = await b.resolve(a.path, { kind: a.kind, resolveDir: a.resolveDir, importer: a.importer, pluginData: { sealed: true } })
      if (r.errors.length || !r.path || !isAbsolute(r.path)) return undefined
      return relative(root, r.path).startsWith('..') ? { path: a.path, external: true } : undefined
    })
  },
})

/** Build the connector in `dir` (manifest.json, bridge.mjs, its package.json). `sealRoot`: nothing outside it is bundled. */
export async function bundleConnector(dir: string, o: { esbuild: Esbuild; sealRoot?: string }): Promise<Built> {
  const id = basename(dir), problems: string[] = []
  let manifest: EngineManifest
  try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) } catch (e: any) { return { ok: false, problems: [`manifest.json is missing or not JSON (${e.message})`] } }
  problems.push(...checkEngineManifest(manifest))
  if (manifest.id !== id) problems.push(`its id is "${manifest.id}" but its folder is "${id}"`)
  if (!existsSync(join(dir, 'bridge.mjs'))) problems.push('bridge.mjs is missing')
  else if (!EXPORTS_CREATE_BRIDGE.test(readFileSync(join(dir, 'bridge.mjs'), 'utf8'))) problems.push('bridge.mjs exports createBridge({ settings, secrets })')
  if (problems.length) return { ok: false, problems }
  let code: string
  try {
    const out = await o.esbuild.build({ entryPoints: [join(dir, 'bridge.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true, write: false, logLevel: 'silent',
      plugins: [sealedTo(o.sealRoot ?? dir)], external: [...(manifest.native ?? [])],
      // a bundled CommonJS driver asks for Node's own modules with require: give the module one
      banner: { js: "import { createRequire as __saRequire } from 'node:module'; const require = __saRequire(import.meta.url);" } })
    code = out.outputFiles?.[0]?.text ?? ""
  } catch (e: any) { return { ok: false, problems: [String(e?.message ?? e).split('\n')[0]] } }
  if (code.length > MAX_BYTES) return { ok: false, problems: [`bundled it is ${(code.length / 1e6).toFixed(1)} MB — a connector is at most 6 MB`] }
  return { ok: true, manifest, code, hash: createHash('sha256').update(code).digest('hex'), bytes: code.length }
}
