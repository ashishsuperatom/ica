// Build every connector (bridges/<id>/): check its manifest, bundle its code with its own driver into one self-contained
// module, hash it, and write dist/:
//   dist/engine.json     the platform's OWN sources' manifests (builtin: SA-WAREHOUSE) with hash and size
//   dist/bridges.json    their bundled code by id — released with the platform, the only connector code it carries
//   dist/released.json   every other connector, built ({ manifest with hash and size, code }): Superatom's connectors are
//                        released apart from the platform (src/release.ts, the release job, its registry) — the platform
//                        never imports this; the platform's tests fill a test registry from it
// The same source makes the same hash; a changed connector is a new hash, offered to its connections as a newer version.

import * as esbuild from 'esbuild'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleConnector } from './bundle'
import type { EngineManifest } from './contract'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

export async function buildAll(): Promise<{ engine: (EngineManifest & { hash: string; bytes: number })[]; problems: string[] }> {
  const problems: string[] = []
  // The ready bridges of the code connectors — each a folder of its own (bridges/<name>/: bridge.mjs and a package.json
  // with ITS OWN driver, a workspace package here): the platform attaches a connector's bridge to each connection made
  // with it, so a source runs whatever door it was made from.
  const bridges: Record<string, string> = {}
  const engine: (EngineManifest & { hash: string; bytes: number })[] = []
  const released: { manifest: EngineManifest & { hash: string; bytes: number }; code: string }[] = []
  const bdir = join(root, 'bridges')
  // Each ENGINE CONNECTOR is a folder (bridges/<id>/): its manifest, its code (bridge.mjs) and its package.json with ITS OWN
  // driver. The code is bundled WITH its driver (a pure-JavaScript package): one self-contained module the data source
  // manager loads as it is — the engine installs nothing for any connector. A driver that needs native code (DuckDB) is
  // named in the manifest (native) and supplied by the manager (createBridge({ drivers })). Its hash is its version.
  if (existsSync(bdir)) for (const id of readdirSync(bdir).filter((x) => existsSync(join(bdir, x, 'bridge.mjs'))).sort()) {
    // sealed to the package: its own drivers bundled, nothing from above the repository
    const b = await bundleConnector(join(bdir, id), { esbuild, sealRoot: root })
    if (!b.ok) { problems.push(...b.problems.map((p) => `bridges/${id}: ${p}`)); continue }
    const m = { ...b.manifest, hash: b.hash, bytes: b.bytes }
    if ((b.manifest as any).builtin) { bridges[id] = b.code; engine.push(m) }
    else released.push({ manifest: m, code: b.code })
  }
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'bridges.json'), JSON.stringify(bridges) + '\n')
  writeFileSync(join(dist, 'engine.json'), JSON.stringify(engine, null, 2) + '\n')
  writeFileSync(join(dist, 'released.json'), JSON.stringify(released) + '\n')
  return { engine, problems }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await buildAll()
  for (const c of r.engine) console.log(`${c.hash.slice(0, 12)}  ${c.id}  engine · ${c.kind} · ${c.dialect} · ${(c.bytes / 1e3).toFixed(0)} KB`)
  if (r.problems.length) { console.error(r.problems.map((p) => `✗ ${p}`).join('\n')); process.exit(1) }
}
