// RELEASE SUPERATOM'S CONNECTORS (docs/connectors-plan.md 9b): each connector built with the one build tool (the same
// bytes and hash anywhere) and sent to the platform's registry with the release token — run by the release job
// (.github/workflows/connectors.yml) after that connector's checks. Sending an unchanged connector changes nothing (its
// hash is already the current version), so releasing them all releases exactly the ones that changed.
//
//   tsx src/release.ts --all | <id>…
//   env: CONNECTOR_RELEASE_TOKEN (the job's secret), SUPERATOM_URL (default https://superatom.site), GITHUB_SHA (its commit)

import * as esbuild from 'esbuild'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleConnector } from './bundle'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const token = process.env.CONNECTOR_RELEASE_TOKEN ?? ''
const url = (process.env.SUPERATOM_URL ?? 'https://superatom.site').replace(/\/$/, '')
const args = process.argv.slice(2)
if (!token) { console.error('release: CONNECTOR_RELEASE_TOKEN is not set'); process.exit(1) }
const all = readdirSync(join(root, 'bridges')).filter((x) => existsSync(join(root, 'bridges', x, 'bridge.mjs'))).sort()
const ids = args.includes('--all') ? all : args.filter((a) => !a.startsWith('--'))
if (!ids.length) { console.error('release: name connectors, or --all'); process.exit(1) }

let failed = 0
for (const id of ids) {
  if (!all.includes(id)) { console.error(`✗ ${id}: there is no connectors/bridges/${id}`); failed++; continue }
  const b = await bundleConnector(join(root, 'bridges', id), { esbuild, sealRoot: root })
  if (!b.ok) { console.error(`✗ ${id}: ${b.problems.join('; ')}`); failed++; continue }
  if ((b.manifest as any).builtin) { console.log(`· ${id}: the platform's own source — released with the platform`); continue }
  const r = await fetch(`${url}/api/superatom/connectors/release`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ manifest: b.manifest, code: b.code, hash: b.hash, commit: process.env.GITHUB_SHA ?? null }) })
  const d: any = await r.json().catch(() => ({}))
  if (!r.ok) { console.error(`✗ ${id}: ${d.error ?? r.status}`); failed++; continue }
  console.log(d.already ? `· ${id} ${b.hash.slice(0, 12)}: already the current version` : `✓ ${id} ${b.hash.slice(0, 12)}: released (${Math.round(b.bytes / 1024)} KB)`)
}
process.exit(failed ? 1 : 0)
