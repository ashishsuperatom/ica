// AN ENGINE STARTED FROM ITS IMAGE WITH ONE SETTING — SUPERATOM_KEY, a key of the project — sets itself up: wherever it
// runs (a container service, a machine), nothing else needs to be given. Every other setting has its default (the
// image's layout: everything on the volume, start.sh) and anything given explicitly wins (Fly, the installer and sacli
// give them as before).
//   by default          the project's engine: the first start asks the platform for what it connects with
//                       (GET /engine-credentials, as the installer does — a key holding project.manage)
//   SA_ENGINE_MODE=cell the key's person's cell (docs/cell-engine.md): the first start asks the platform for the cell's
//                       own credential (POST /cell — a key of theirs for this one cell, in Keys)
// What it got is kept on its volume, one file per mode (so changing the mode and restarting never mixes them); every
// later start reads it back and asks nothing. Imported first by the engine, so every setting it reads afterwards is set.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'

const key = (process.env.SUPERATOM_KEY ?? '').trim()
if (key && !process.env.ICA_KEY) {
  const cell = (process.env.SA_ENGINE_MODE ?? '').trim().toLowerCase() === 'cell'
  const home = process.env.SUPERATOM_HOME ?? '/app/data'
  const kept = join(home, cell ? 'cell.json' : 'engine.json')
  const fail = (what: string): never => { console.error(`[setup] ${what}`); process.exit(1) }
  let c: any = await readFile(kept, 'utf8').then((x) => JSON.parse(x), () => null)
  if (!c) {
    const pid = /^sak_([0-9a-f-]{36})_/.exec(key)?.[1] ?? fail(`SUPERATOM_KEY is not a key of a project (sak_<project>_<person>_…) — make one in the app: Keys`)
    const raw = (process.env.SUPERATOM_PLATFORM ?? 'superatom.site').replace(/\/$/, '')
    const platform = /^https?:\/\//.test(raw) ? raw : `https://${raw}`
    const r = await fetch(`${platform}/api/projects/${pid}${cell ? '/cell' : '/engine-credentials'}`, {
      ...(cell ? { method: 'POST', body: JSON.stringify({ host: process.env.SA_HOST_NAME ?? hostname() }) } : {}),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) })
      .catch((e) => fail(`cannot reach ${platform} (${e.message}) — check this machine reaches it`))
    if (!r.ok) fail(`${platform} refused the key (${r.status}): ${(await r.text()).slice(0, 300)} — ${cell ? 'use a key of yours for the project' : 'use a key of the project holding project.manage'}, still in force`)
    c = await r.json()
    await mkdir(home, { recursive: true })
    await writeFile(kept, JSON.stringify(c), { mode: 0o600 })
    console.log(cell ? `[setup] ${c.person}'s cell for ${c.name ?? c.project}: its own key made (Keys: ${c.keyId}) and kept on the volume`
      : `[setup] the engine of ${c.name ?? c.project}: what it connects with, got and kept on the volume`)
  }
  const slug = String(c.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const given = Object.fromEntries(Object.entries({
    ICA_PROJECT: c.project, ICA_KEY: cell ? c.cellKey : c.engineKey, ICA_HUB: c.hub, SUPERATOM_PLATFORM: c.platform, SUPERATOM_HOME: home,
    ...(slug ? { PROJECT_NAME: cell ? `${slug}-cell` : slug } : {}),
    ...(cell ? { SA_ENGINE_MODE: 'cell', SA_CELL_PERSON: c.person, ...(c.modelKey ? { SA_MODEL_KEY: c.modelKey } : {}) } : {}),
  }).filter(([k]) => !process.env[k] || k === 'ICA_KEY'))   // anything given explicitly wins
  Object.assign(process.env, given)
}
