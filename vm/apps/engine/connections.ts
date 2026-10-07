// THE PROJECT'S CONNECTIONS, as this engine runs them. They live in the platform (each one's bridge, settings and sealed
// secrets); this engine downloads them — on every welcome, and whenever the platform says they changed
// (connections:changed) — writes each bridge where the data source manager loads it (datasources/<name>/bridge.mjs, by
// its hash), and registers it with the manager, its settings and secrets handed over in memory (never written here).
// A manager that restarted is given its sources again. A bridge the connector agent writes here is generated here, so
// it goes up to the platform (upload) and comes back down like any other.

import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Platform } from './platform.js'

export interface Connection { id: string; name: string; connector: string; settings: Record<string, unknown>; secrets: Record<string, string>; bridge: string | null }

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export function createConnections(o: { dir: string; manager: string; platform: Platform | null; send: (msg: Record<string, unknown>) => boolean; log?: (s: string) => void; applied?: () => void }) {
  let held: Connection[] = []
  const fileOf = (name: string) => join(o.dir, name, 'bridge.mjs')

  /** Make the manager hold exactly these sources: each bridge written by its hash, registered with its config. */
  async function apply(list: Connection[]) {
    held = list
    for (const c of list) {
      if (!c.bridge) { o.log?.(`[connections] ${c.name} has no bridge yet`); continue }
      const file = fileOf(c.name)
      try {
        if (!existsSync(file) || sha(readFileSync(file, 'utf8')) !== c.bridge) {
          if (!o.platform) throw new Error('this engine cannot reach the platform')
          const code = await o.platform.fetchBridge(c.bridge)
          if (sha(code) !== c.bridge) throw new Error('the bridge read is not the one its hash names')
          mkdirSync(join(o.dir, c.name), { recursive: true }); writeFileSync(file, code)
        }
        const r = await fetch(`${o.manager}/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: c.name, path: file, config: { settings: c.settings, secrets: c.secrets } }) })
        const j: any = await r.json().catch(() => ({}))
        if (!r.ok || !j.ok) o.log?.(`[connections] ${c.name} did not load: ${j.error ?? r.status}`)
      } catch (e: any) { o.log?.(`[connections] ${c.name}: ${e?.message ?? e}`) }
    }
    // Sources the platform no longer has are taken away.
    const have = await sources()
    for (const id of have) if (!list.some((c) => c.name === id)) await fetch(`${o.manager}/sources`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {})
    report()
    o.applied?.()   // the sources are loaded: whatever depends on them (the index's build) may go on
  }

  const sources = async (): Promise<string[]> => {
    try { const j: any = await (await fetch(`${o.manager}/sources`, { signal: AbortSignal.timeout(4000) })).json(); return (j?.sources ?? []).map((x: any) => String(x.id)) } catch { return [] }
  }
  /** How each source stands (ready or not), for the platform to show beside its connection. */
  function report() {
    void fetch(`${o.manager}/sources`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).then((j: any) => {
      o.send({ type: 'sources:report', sources: (j?.sources ?? []).map((x: any) => ({ id: x.id, kind: x.kind, dialect: x.dialect, description: x.description, ready: !!x.ready })) })
    }).catch(() => {})
  }

  // A manager that restarted holds nothing: give it its sources again.
  const watch = setInterval(async () => {
    if (!held.length) return
    const have = await sources()
    if (held.some((c) => c.bridge && !have.includes(c.name))) { o.log?.('[connections] the data source manager lost its sources — giving them again'); await apply(held) }
  }, 30_000)
  watch.unref?.()

  return {
    /** Ask the platform for this project's connections (on welcome, and when they change). */
    pull: () => { o.send({ type: 'connections:pull' }) },
    /** A message from the platform about connections. */
    onMessage: (p: any) => {
      if (p?.t === 'connections:changed') o.send({ type: 'connections:pull' })
      else if (p?.t === 'connections:list') { if (p.error) o.log?.(`[connections] the platform did not give them: ${p.error}`); else void apply(Array.isArray(p.connections) ? p.connections : []) }
    },
    /** Bridges written here (by the connector agent) that the platform does not have: up to it, one by one. */
    async uploadWritten() {
      if (!o.platform || !existsSync(o.dir)) return
      for (const name of readdirSync(o.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
        const file = fileOf(name)
        if (!existsSync(file)) continue
        const code = readFileSync(file, 'utf8')
        if (held.some((c) => c.name === name && c.bridge === sha(code))) continue
        try { const r = await o.platform.uploadBridge(name, code); o.log?.(`[connections] ${name}'s bridge went up to the platform (${r.bridge.slice(0, 12)})`) }
        catch (e: any) { o.log?.(`[connections] ${name}'s bridge did not go up: ${e?.message ?? e}`) }
      }
    },
    close: () => clearInterval(watch),
  }
}
