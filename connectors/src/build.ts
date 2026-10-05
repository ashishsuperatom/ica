// Build every connector in catalog/: check its manifest, bundle its server module with the SDK into one ES module (no
// imports left, nothing of Node — it runs in a Dynamic Worker), hash the two, and write dist/:
//   dist/catalog.json   every connector's manifest with its hash (what the platform lists and the connection form reads)
//   dist/code.json      the sandbox's main module, and each connector's bundled server code by id with its hash (what
//                       the platform loads to run it)
// The same source makes the same hash; a changed connector is a new hash, and connections pick it up at the next deploy.

import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
  writeFileSync(join(dist, 'code.json'), JSON.stringify({ sandbox, connectors: code }) + '\n')
  return { catalog, problems }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await buildAll()
  for (const c of r.catalog) console.log(`${c.hash.slice(0, 12)}  ${c.id}  (${c.offers.data ? 'data' : ''}${c.offers.data && c.offers.actions ? ' · ' : ''}${c.offers.actions ? 'actions' : ''})`)
  if (r.problems.length) { console.error(r.problems.map((p) => `✗ ${p}`).join('\n')); process.exit(1) }
}
