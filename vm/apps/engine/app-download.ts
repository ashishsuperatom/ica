// THE PROJECT'S APP, as this engine runs it. Its source lives in the platform (published with `sacli app publish`, each
// version kept by its hash); this engine downloads the part it runs — server/ — into <projectDir>/app/server, on every
// welcome and whenever the platform says it changed (app:changed), then reloads the app. Nothing here is edited by hand:
// a file the platform's version does not have is removed, so what runs is exactly what was published.

import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import type { Platform } from './platform.js'

export function createAppDownload(o: { projectDir: string; platform: Platform | null; reload: () => Promise<void>; log?: (s: string) => void }) {
  const root = join(o.projectDir, 'app')
  const mark = join(root, '.version')   // the hash of the version written here
  let busy = false, again = false

  async function sync() {
    if (!o.platform) return
    if (busy) { again = true; return }
    busy = true
    try {
      const cur = await o.platform.currentApp()
      if (!cur) return
      const have = existsSync(mark) ? readFileSync(mark, 'utf8').trim() : ''
      if (have === cur.hash) return
      const files = await o.platform.fetchApp(cur.hash)
      const server = Object.entries(files).filter(([p]) => p.startsWith('server/'))
      // What runs is exactly the published version: its files written, any other file under server/ removed.
      const wanted = new Set(server.map(([p]) => join(root, p)))
      const walk = (d: string): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]) : []
      for (const f of walk(join(root, 'server'))) if (!wanted.has(f)) rmSync(f)
      for (const [p, text] of server) { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text.startsWith('base64:') ? Buffer.from(text.slice(7), 'base64') : text) }
      writeFileSync(mark, cur.hash)
      o.log?.(`[app] version ${cur.hash.slice(0, 12)} from the platform (published by ${cur.by}) — reloading`)
      await o.reload()
    } catch (e: any) { o.log?.(`[app] the platform's app could not be downloaded: ${e?.message ?? e}`) }
    finally { busy = false; if (again) { again = false; void sync() } }
  }
  return { sync, onMessage: (p: any) => { if (p?.t === 'app:changed') void sync() } }
}
