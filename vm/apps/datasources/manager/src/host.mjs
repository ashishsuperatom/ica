// ONE CONNECTION'S PROCESS (docs/connectors-plan.md step 4). The data source manager starts one of these for every
// connection it holds (index.ts, `hosted`): the connection's connector module is loaded here, with its settings and
// secrets, and nowhere else — so a connector that crashes, hangs or leaks takes only its own connection with it, and one
// connection's secrets are never in another's memory. The manager asks over the IPC channel; every call is answered
// with its id. Plain JavaScript (no TypeScript loader), so a host starts in a fraction of a second.

import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'

// Drivers the manager supplies to the connectors that ask (a native driver cannot travel in a bundle: DuckDB).
const DRIVERS = { duckdb: () => import('@duckdb/node-api') }

let bridge = null
const send = (m) => { try { process.send?.(m) } catch { /* the manager is gone */ } }
const plainError = (e) => ({ message: String(e?.message ?? e).slice(0, 4000), code: e?.code ?? null, transient: bridge?.isTransient ? !!safe(() => bridge.isTransient(e)) : null })
const safe = (f) => { try { return f() } catch { return null } }

process.on('message', async (m) => {
  if (m?.t === 'load') {
    try {
      const base = isAbsolute(m.path) ? pathToFileURL(m.path).href : new URL(m.path, import.meta.url).href
      const mod = await import(`${base}?t=${Date.now()}`)
      bridge = await mod.createBridge({ ...m.config, drivers: DRIVERS, dataDir: m.dataDir })
      send({ t: 'loaded', id: m.id, about: { kind: bridge.kind, dialect: bridge.dialect, description: bridge.description, testable: typeof bridge.test === 'function', appends: typeof bridge.append === 'function' }, ready: !!safe(() => bridge.ready()) })
    } catch (e) { send({ t: 'loaded', id: m.id, error: plainError(e) }) }
    return
  }
  if (m?.t === 'call') {
    if (!bridge) return send({ t: 'answer', id: m.id, error: { message: 'the connection is not loaded' } })
    try {
      const f = bridge[m.op]
      if (typeof f !== 'function') throw new Error(`its connector has no ${m.op}`)
      const value = await f.apply(bridge, m.args ?? [])
      send({ t: 'answer', id: m.id, value, ready: !!safe(() => bridge.ready()) })
    } catch (e) { send({ t: 'answer', id: m.id, error: plainError(e), ready: !!safe(() => bridge.ready()) }) }
    return
  }
  if (m?.t === 'ready') { send({ t: 'ready', ready: !!safe(() => bridge?.ready()) }); return }
  if (m?.t === 'close') { try { await bridge?.close?.() } catch { /* closing anyway */ } process.exit(0) }
})
process.on('disconnect', () => { try { bridge?.close?.() } catch { /* going anyway */ } process.exit(0) })
// A connector's stray rejection is its own failure, not the process's end: reported, the process kept.
process.on('unhandledRejection', (e) => send({ t: 'warn', message: String(e?.message ?? e).slice(0, 500) }))
