// A CELL STARTED FROM ITS IMAGE WITH ONE SETTING (docs/cell-engine.md): SUPERATOM_CELL_KEY, the person's key for the
// project. Where no installer ran (a service that starts the image itself), the engine does what the installer's --cell
// does: the first time, it asks the platform for the cell's own credential (POST /cell — a key of the person's for this
// one cell, revocable in Keys) and keeps it, with what it connects with, on its volume; every later start reads it back.
// Imported first by the engine, so every setting it reads afterwards is already set. Nothing happens without the key.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'

const key = (process.env.SUPERATOM_CELL_KEY ?? '').trim()
if (key) {
  const home = process.env.SUPERATOM_HOME ?? '/app/data'
  const kept = join(home, 'cell.json')
  let c: any = await readFile(kept, 'utf8').then((x) => JSON.parse(x), () => null)
  if (!c) {
    const pid = /^sak_([0-9a-f-]{36})_/.exec(key)?.[1]
    if (!pid) { console.error('[cell] SUPERATOM_CELL_KEY is not a key of a project (sak_<project>_<person>_…) — make one in the app: Keys'); process.exit(1) }
    const raw = (process.env.SUPERATOM_PLATFORM ?? 'superatom.site').replace(/\/$/, '')
    const platform = /^https?:\/\//.test(raw) ? raw : `https://${raw}`
    const r = await fetch(`${platform}/api/projects/${pid}/cell`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ host: process.env.SA_HOST_NAME ?? hostname() }), signal: AbortSignal.timeout(30_000) })
      .catch((e) => { console.error(`[cell] cannot reach ${platform} (${e.message}) — check this machine reaches it`); process.exit(1) })
    if (!r.ok) { console.error(`[cell] ${platform} refused the cell (${r.status}): ${(await r.text()).slice(0, 300)} — use a key of yours for the project, still in force`); process.exit(1) }
    c = await r.json()
    await mkdir(home, { recursive: true })
    await writeFile(kept, JSON.stringify(c), { mode: 0o600 })
    console.log(`[cell] ${c.person}'s cell for ${c.name ?? c.project}: its own key made (Keys: ${c.keyId}) and kept on the volume`)
  }
  Object.assign(process.env, {
    SA_ENGINE_MODE: 'cell', SA_CELL_PERSON: c.person, ICA_PROJECT: c.project, ICA_KEY: c.cellKey, ICA_HUB: c.hub,
    SUPERATOM_PLATFORM: c.platform, ...(c.modelKey ? { SA_MODEL_KEY: c.modelKey } : {}), SUPERATOM_HOME: home,
    DATASOURCES_DIR: process.env.DATASOURCES_DIR ?? join(home, 'datasources'),
  })
}
