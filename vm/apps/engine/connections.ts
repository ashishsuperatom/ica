// THE PROJECT'S CONNECTIONS, as this engine runs them. They live in the platform (each one's bridge, settings and sealed
// secrets); this engine downloads them — on every welcome, and whenever the platform says they changed
// (connections:changed) — writes each bridge where the data source manager loads it (datasources/<name>/bridge.mjs, by
// its hash), and registers it with the manager, its settings and secrets handed over in memory (never written here).
// A manager that restarted is given its sources again. A bridge the connector agent writes here is generated here, so
// it goes up to the platform (upload) and comes back down like any other.

import { asSystem } from './manager.js'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Platform } from './platform.js'
import type { Workloads } from './workloads.js'

export interface Connection { id: string; name: string; connector: string; settings: Record<string, unknown>; secrets: Record<string, string>; bridge: string | null; /** what was wanted, as a spec (workloads) */ spec?: string }

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export function createConnections(o: { dir: string; manager: string; platform: Platform | null; send: (msg: Record<string, unknown>) => boolean; log?: (s: string) => void; applied?: () => void; workloads?: Workloads; /** a source's index, as held here (for inspect) */ indexOf?: (source: string) => unknown }) {
  let held: Connection[] = []
  const fileOf = (name: string) => join(o.dir, name, 'bridge.mjs')

  // HOW EACH CONNECTION STANDS (workloads): pending without a bridge; failed when its bridge will not load; degraded while
  // it cannot reach its source; ready. Its version is its bridge's hash; its spec is what the platform wanted.
  const restarts = new Map<string, number>()
  const status = (c: Connection, state: 'pending' | 'starting' | 'ready' | 'degraded' | 'failed', error?: { what: string; detail?: string }) =>
    o.workloads?.set({ kind: 'connection', id: c.name, state, version: c.bridge ? c.bridge.slice(0, 12) : null, spec: c.spec ?? null, restarts: restarts.get(c.name) ?? 0, error: error ?? null })

  const loadedAt = new Map<string, number>()
  const tested = new Map<string, number>()
  /** The manager asks the connector itself whether it reaches its source (POST /test, at most 30 s). */
  async function probe(name: string): Promise<{ ok: boolean; tested: boolean; error?: string }> {
    tested.set(name, Date.now())
    try { const r: any = await fetch(`${o.manager}/test`, asSystem({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: name }), signal: AbortSignal.timeout(35_000) })).then((x) => x.json()); return { ok: !!r.ok, tested: !!r.tested, error: r.error } }
    catch (e: any) { return { ok: false, tested: false, error: String(e?.message ?? e) } }
  }
  /** Whether a loaded source reaches its source now: ready, or — after its first minute — degraded. */
  async function recheck(c: Connection) {
    const st = o.workloads?.get('connection', c.name)?.state
    if (!held.includes(c) || st === 'pending') return
    const x = (await fetch(`${o.manager}/sources`, asSystem({ signal: AbortSignal.timeout(4000) })).then((r) => r.json()).catch(() => null) as any)?.sources?.find((s: any) => s.id === c.name)
    if (!x) return
    // ITS PROCESS (the manager's hosted.ts): started again after a crash, or left stopped after crashing again and again.
    const p = x.process
    if (p) {
      restarts.set(c.name, Math.max(restarts.get(c.name) ?? 0, Number(p.restarts) || 0))
      if (p.state === 'failed') { if (st !== 'failed') status(c, 'failed', { what: 'its process keeps stopping — it was left stopped', detail: p.lastError ?? undefined }); return }
      if (p.state === 'restarting' || p.state === 'starting') { status(c, 'starting', { what: 'its process stopped; it is being started again', detail: p.lastError ?? undefined }); return }
    }
    // A connector that tests itself is tested again when idle a while (every 5 minutes) — not every 30 s against a source.
    if (x.testable) {
      if (st === 'ready' && Date.now() - (tested.get(c.name) ?? 0) < 5 * 60_000) return   // ready: looked at again every 5 minutes; anything else at once
      const t = await probe(c.name)
      if (t.ok && st !== 'ready') status(c, 'ready')
      if (!t.ok && st === 'ready') status(c, 'degraded', { what: 'it cannot reach its source', detail: t.error })
      return
    }
    if (x.ready) { if (st !== 'ready') status(c, 'ready'); return }
    if (Date.now() - (loadedAt.get(c.name) ?? 0) >= 60_000 && st !== 'degraded') status(c, 'degraded', { what: 'it cannot reach its source right now' })
  }

  /** One source loaded into the manager — its bridge written by its hash, registered with its config. */
  async function load(c: Connection): Promise<{ ok: boolean; ready?: boolean; error?: string }> {
    if (!c.bridge) { status(c, 'pending', { what: 'it has no bridge yet' }); return { ok: false, error: 'it has no bridge yet' } }
    status(c, 'starting')
    const file = fileOf(c.name)
    try {
      if (!existsSync(file) || sha(readFileSync(file, 'utf8')) !== c.bridge) {
        if (!o.platform) throw new Error('this engine cannot reach the platform')
        const code = await o.platform.fetchBridge(c.bridge)
        if (sha(code) !== c.bridge) throw new Error('the bridge read is not the one its hash names')
        mkdirSync(join(o.dir, c.name), { recursive: true }); writeFileSync(file, code)
      }
      // The platform's own warehouse reads with this engine's address and key — given to it as any connection's settings and
      // secrets, in memory: its process has no environment of the engine's.
      const config = c.connector === 'sa-warehouse'
        ? { settings: { ...c.settings, platform: process.env.SUPERATOM_PLATFORM ?? '', project: process.env.ICA_PROJECT ?? '' }, secrets: { ...c.secrets, key: process.env.ICA_KEY ?? '' } }
        : { settings: c.settings, secrets: c.secrets }
      const r = await fetch(`${o.manager}/sources`, asSystem({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: c.name, path: file, config }) }))
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) throw new Error(String(j.error ?? r.status))
      loadedAt.set(c.name, Date.now())
      // A connector that can test itself is TESTED: signed in and a trivial read — ready, or degraded with why.
      const t = await probe(c.name)
      if (t.tested) { status(c, t.ok ? 'ready' : 'degraded', t.ok ? undefined : { what: 'it cannot reach its source', detail: t.error }); return { ok: true, ready: t.ok } }
      // One that cannot (it connects after it loads: a socket) is STARTING, looked at again soon — degraded only once it
      // has had a minute and still cannot reach its source.
      const ready = !!j.source?.ready
      if (ready) status(c, 'ready')
      else { status(c, 'starting'); for (const ms of [3_000, 10_000, 30_000, 65_000]) setTimeout(() => void recheck(c), ms).unref?.() }
      return { ok: true, ready }
    } catch (e: any) {
      o.log?.(`[connections] ${c.name}: ${e?.message ?? e}`)
      status(c, 'failed', { what: 'its bridge could not be loaded', detail: String(e?.message ?? e).slice(0, 500) })
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  /** Make the manager hold exactly these sources. */
  async function apply(list: Connection[]) {
    const was = held
    held = list
    // Only what changed is loaded again — a connection the platform wants exactly as before (its spec), still held by the
    // manager, keeps running untouched: adding one source never reconnects the others.
    const loaded = new Set(await sources())
    for (const c of list) {
      const before = was.find((x) => x.name === c.name)
      if (before && c.spec && before.spec === c.spec && before.bridge === c.bridge && loaded.has(c.name)) continue
      await load(c)
    }
    // Sources the platform no longer has are taken away.
    const have = await sources()
    for (const id of have) if (!list.some((c) => c.name === id)) await fetch(`${o.manager}/sources`, asSystem({ method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })).catch(() => {})
    for (const c of was) if (!list.some((x) => x.name === c.name)) o.workloads?.gone('connection', c.name)
    report()
    o.applied?.()   // the sources are loaded: whatever depends on them (the index's build) may go on
  }

  const sources = async (): Promise<string[]> => {
    try { const j: any = await (await fetch(`${o.manager}/sources`, asSystem({ signal: AbortSignal.timeout(4000) }))).json(); return (j?.sources ?? []).map((x: any) => String(x.id)) } catch { return [] }
  }
  /** What each source is (its kind, dialect, how to query it), as its bridge says — for its connection on the platform.
   *  How each stands is its workload. */
  function report() {
    void fetch(`${o.manager}/sources`, asSystem({ signal: AbortSignal.timeout(4000) })).then((r) => r.json()).then((j: any) => {
      o.send({ type: 'sources:report', sources: (j?.sources ?? []).map((x: any) => ({ id: x.id, kind: x.kind, dialect: x.dialect, description: x.description })) })
    }).catch(() => {})
  }

  // A manager that restarted holds nothing: give it its sources again.
  const watch = setInterval(async () => {
    if (!held.length) return
    const have = await sources()
    if (held.some((c) => c.bridge && !have.includes(c.name))) { o.log?.('[connections] the data source manager lost its sources — giving them again'); await apply(held); return }
    // Whether each can reach its source now (a source that comes back, or goes away, between reads).
    for (const c of held) await recheck(c)
  }, 30_000)
  watch.unref?.()

  // What may be done to a connection, and looked into (the kinds: platform-types workloads.ts). Refreshing its index is
  // the platform's own (a tracked job), so it never reaches here.
  const named = (id: string) => { const c = held.find((x) => x.name === id); if (!c) throw new Error(`this engine runs no connection ${id}`); return c }
  o.workloads?.onAct('connection', async (id, action) => {
    const c = named(id)
    if (action === 'restart') {
      restarts.set(id, (restarts.get(id) ?? 0) + 1)
      const r = await load(c)
      if (!r.ok) throw new Error(`it did not load again: ${r.error}`)
      return { note: r.ready ? 'loaded again; it reaches its source' : 'loaded again, but it cannot reach its source right now' }
    }
    if (action === 'test') {
      const t = await probe(id)
      if (!t.tested) {
        const x = (await fetch(`${o.manager}/sources`, asSystem({ signal: AbortSignal.timeout(10_000) })).then((r) => r.json()) as any)?.sources?.find((s: any) => s.id === id)
        if (!x) throw new Error('the data source manager does not hold it — restart it')
        t.ok = !!x.ready
      }
      status(c, t.ok ? 'ready' : 'degraded', t.ok ? undefined : { what: 'it cannot reach its source', detail: t.error })
      if (!t.ok) throw new Error(`it cannot reach its source${t.error ? `: ${t.error}` : ''}`)
      return { note: t.tested ? 'it signed in and read from its source' : 'it says it reaches its source' }
    }
    if (action === 'clear-cache') {
      const r: any = await fetch(`${o.manager}/cache/forget`, asSystem({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      return { note: `forgot ${r.forgot ?? 0} result${r.forgot === 1 ? '' : 's'} read from it` }
    }
    throw new Error(`a connection has no action "${action}" here`)
  })
  o.workloads?.onInspect('connection', async (id, aspect) => {
    named(id)
    if (aspect === 'cache') {
      const r: any = await fetch(`${o.manager}/cache?source=${encodeURIComponent(id)}`, asSystem({ signal: AbortSignal.timeout(10_000) })).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      return { data: r }
    }
    if (aspect === 'index') return { data: o.indexOf?.(id) ?? null }
    throw new Error(`a connection has no aspect "${aspect}" here`)
  })

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
