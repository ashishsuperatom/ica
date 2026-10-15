// ONE CONNECTION'S PROCESS (docs/connectors-plan.md step 4). The data source manager starts one of these for every
// connection it holds (index.ts, `hosted`): the connection's connector module is loaded here, with its settings and
// secrets, and nowhere else — so a connector that crashes, hangs or leaks takes only its own connection with it, and one
// connection's secrets are never in another's memory. The manager asks over the IPC channel; every call is answered
// with its id. Plain JavaScript (no TypeScript loader), so a host starts in a fraction of a second.
//
// A PERSON'S OWN CLIENT (docs/connectors-plan.md R2): a connection that reads with each person's own key holds, beside its
// shared one, a client per person — the same connector, made with their values — in this same process (no process per
// person). The manager gives one when a person's first read needs it (`person`); every later read of theirs uses it; it
// is closed after 30 minutes unused, or at once when their key changes or goes (`forget`). A call for a person who has
// none held is answered NO_PERSON — the manager then asks for their key.

import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'

// Drivers the manager supplies to the connectors that ask (a native driver cannot travel in a bundle: DuckDB).
const DRIVERS = { duckdb: () => import('@duckdb/node-api') }

let bridge = null
let made = null   // what makes one: the connector's createBridge, its data folder
const people = new Map()   // person (a hash of their address) → { bridge, at }
const IDLE_MS = 30 * 60_000
const closeOf = (b) => { try { b?.close?.() } catch { /* closing anyway */ } }
const send = (m) => { try { process.send?.(m) } catch { /* the manager is gone */ } }
const plainError = (e) => ({ message: String(e?.message ?? e).slice(0, 4000), code: e?.code ?? null, transient: bridge?.isTransient ? !!safe(() => bridge.isTransient(e)) : null })
const safe = (f) => { try { return f() } catch { return null } }

process.on('message', async (m) => {
  if (m?.t === 'load') {
    try {
      const base = isAbsolute(m.path) ? pathToFileURL(m.path).href : new URL(m.path, import.meta.url).href
      const mod = await import(`${base}?t=${Date.now()}`)
      made = { createBridge: mod.createBridge, dataDir: m.dataDir }
      bridge = await mod.createBridge({ ...m.config, drivers: DRIVERS, dataDir: m.dataDir })
      send({ t: 'loaded', id: m.id, about: { kind: bridge.kind, dialect: bridge.dialect, description: bridge.description, testable: typeof bridge.test === 'function', appends: typeof bridge.append === 'function', acts: typeof bridge.act === 'function', lists: typeof bridge.children === 'function', tree: Array.isArray(bridge.tree) ? bridge.tree : null }, ready: !!safe(() => bridge.ready()) })
    } catch (e) { send({ t: 'loaded', id: m.id, error: plainError(e) }) }
    return
  }
  if (m?.t === 'person') {
    try {
      if (!made) throw new Error('the connection is not loaded')
      const b = await made.createBridge({ ...m.config, drivers: DRIVERS, dataDir: made.dataDir })
      closeOf(people.get(m.person)?.bridge)
      people.set(m.person, { bridge: b, at: Date.now() })
      send({ t: 'answer', id: m.id, value: { people: people.size } })
    } catch (e) { send({ t: 'answer', id: m.id, error: plainError(e) }) }
    return
  }
  if (m?.t === 'forget') { closeOf(people.get(m.person)?.bridge); people.delete(m.person); send({ t: 'answer', id: m.id, value: { people: people.size } }); return }
  if (m?.t === 'call') {
    const own = m.person ? people.get(m.person) : null
    if (m.person && !own) return send({ t: 'answer', id: m.id, error: { message: 'no client of theirs is held', code: 'NO_PERSON', transient: false } })
    const b = own ? own.bridge : bridge
    if (own) own.at = Date.now()
    if (!b) return send({ t: 'answer', id: m.id, error: { message: 'the connection is not loaded' } })
    try {
      const f = b[m.op]
      if (typeof f !== 'function') throw new Error(`its connector has no ${m.op}`)
      const value = await f.apply(b, m.args ?? [])
      send({ t: 'answer', id: m.id, value, ready: !!safe(() => bridge.ready()) })
    } catch (e) { send({ t: 'answer', id: m.id, error: plainError(e), ready: !!safe(() => bridge.ready()) }) }
    return
  }
  if (m?.t === 'ready') { send({ t: 'ready', ready: !!safe(() => bridge?.ready()) }); return }
  if (m?.t === 'close') { for (const p of people.values()) closeOf(p.bridge); try { await bridge?.close?.() } catch { /* closing anyway */ } process.exit(0) }
})
process.on('disconnect', () => { for (const p of people.values()) closeOf(p.bridge); try { bridge?.close?.() } catch { /* going anyway */ } process.exit(0) })
// A person's client unused for 30 minutes is closed (their next read asks for their key again).
setInterval(() => { for (const [p, x] of people) if (Date.now() - x.at > IDLE_MS) { closeOf(x.bridge); people.delete(p) } }, 60_000).unref()
// A connector's stray rejection is its own failure, not the process's end: reported, the process kept.
process.on('unhandledRejection', (e) => send({ t: 'warn', message: String(e?.message ?? e).slice(0, 500) }))
