// Publish the built client (dist/) as a dashboard of this project, through the control plane's own API —
// the same calls the admin console's uploader makes. Needs a signed-in token (the `sa-token` value from a
// superatom tab's localStorage), because uploading is a provisioning action.
//
//   SA_TOKEN=<token> node publish.mjs                 create "<project name> decisions" and upload dist/ to it
//   SA_TOKEN=<token> DASH_ID=<id> node publish.mjs    upload dist/ to an existing dashboard (a new build)
//
// Prints the dashboard's URL. Never writes the token anywhere.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PROJECT as SHOWN } from '../server/project.mjs'

const HOST = process.env.SA_HOST ?? 'https://superadmin.superatom.site'
// The project this client belongs to (.env.local, as the build reads it) and the name it goes by (server/project.mjs).
const local = Object.fromEntries(readFileSync(new URL('./.env.local', import.meta.url), 'utf8').split('\n').map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]))
const PROJECT = process.env.SA_PROJECT ?? local.VITE_PROJECT_ID
const NAME = process.env.DASH_NAME ?? `${SHOWN.name} decisions`
if (!PROJECT) { console.error('no project: VITE_PROJECT_ID in .env.local, or SA_PROJECT'); process.exit(1) }
const token = process.env.SA_TOKEN
if (!token) { console.error('SA_TOKEN is needed: the sa-token value from a signed-in superatom tab'); process.exit(1) }
const auth = { authorization: `Bearer ${token}` }
const api = `${HOST}/api/projects/${PROJECT}/dashboards`

let id = process.env.DASH_ID
if (!id) {
  const r = await fetch(api, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: NAME }) })
  if (!r.ok) { console.error(`creating the dashboard failed: ${r.status} ${await r.text()}`); process.exit(1) }
  id = (await r.json()).id
  console.log(`created dashboard ${id}`)
}

const dist = new URL('./dist/', import.meta.url).pathname
const files = []
const walk = (dir) => { for (const name of readdirSync(dir)) { const p = join(dir, name); statSync(p).isDirectory() ? walk(p) : files.push(p) } }
walk(dist)
const form = new FormData()
for (const f of files) { const rel = relative(dist, f); form.append(rel, new Blob([readFileSync(f)]), rel.split('/').pop()) }
const up = await fetch(`${api}/${encodeURIComponent(id)}/upload`, { method: 'POST', headers: auth, body: form })
if (!up.ok) { console.error(`upload failed: ${up.status} ${await up.text()}`); process.exit(1) }
console.log(`uploaded ${files.length} files: ${await up.text()}`)
console.log(`open: ${HOST.replace('superadmin.', '')}/dashboard/${id}/   (or the project's own host)`)
