// The connection to a project's hub, as an agent: one WebSocket to the project's Durable Object, hello with the agent
// key, then requests to the engine matched to their replies by reqId. Large replies arrive in parts or as parcels and
// are made whole by the platform's own transport, exactly as in the browser.

import { receiver, sender } from '../../clients/transport.ts'
import { apiOfHub, parcelStore } from '../../clients/parcels.ts'
import { CliError, projectOfKey } from './config.ts'

export interface Hub {
  project: { id: string; name?: string }
  wsId: string
  /** Send a payload to the engine; resolves with the reply that carries the same reqId. */
  request(payload: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<any>
  /** Every whole message as it arrives (narration, answers…); returns a function that stops listening. */
  on(fn: (m: any) => void): () => void
  close(): void
}

const CLOSE_REASONS: Record<number, number> = { 4001: 3, 4003: 3 }

export async function connect(o: { key: string; hub: string; timeoutMs?: number; log?: (s: string) => void }): Promise<Hub> {
  const project = projectOfKey(o.key)
  if (!project) throw new CliError('that is not an agent key (sak_<project>_<secret>) — make one in the project\'s admin console', 3)
  // The key goes in the hello, never in the URL; ?agent=1 tells the edge what kind of connection this is.
  const url = `${o.hub.replace(/\/$/, '')}/_ws/${project}?agent=1`
  const ws = new WebSocket(url)
  const listeners = new Set<(m: any) => void>()
  const waiting = new Map<string, { resolve: (m: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let closed: { code: number; reason: string } | null = null
  let welcome: any = null

  const fail = (e: Error) => { for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(e) } waiting.clear() }
  const inbound = receiver({
    deliver: (m: any) => {
      if (!m) return
      if (m.t === 'welcome') welcome = m
      for (const fn of listeners) fn(m)
      const w = m.reqId ? waiting.get(m.reqId) : undefined
      if (w) { waiting.delete(m.reqId); clearTimeout(w.timer); if (m.t === 'error') w.reject(new CliError(m.reason ?? m.message ?? 'refused')); else w.resolve(m) }
      // The engine is being started: every wait gets longer, once.
      if (m.t === 'machine:waking') { o.log?.('the engine is starting — this can take a minute'); for (const w of waiting.values()) w.timer.refresh?.() }
      if (m.t === 'error' && !m.reqId && m.source === 'compute') fail(new CliError(m.message ?? 'the engine is offline', 4))
    },
    parcels: parcelStore({ api: apiOfHub(url.replace(/\?.*$/, '')), projectId: project }),
  })
  ws.addEventListener('message', (e) => { try { const raw = JSON.parse(String(e.data)); if (raw?.payload) void inbound.receive(raw.payload) } catch { /* not ours */ } })
  ws.addEventListener('close', (e) => {
    closed = { code: e.code, reason: e.reason }
    for (const fn of listeners) fn({ t: '__closed', code: e.code, reason: e.reason })
    fail(new CliError(e.reason ? `the hub closed the connection: ${e.reason}` : `the connection closed (${e.code})`, CLOSE_REASONS[e.code] ?? 4))
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CliError(`could not reach ${o.hub} in ${Math.round((o.timeoutMs ?? 15000) / 1000)}s`, 4)), o.timeoutMs ?? 15000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new CliError(`could not connect to ${o.hub}`, 4)) }, { once: true })
  })
  ws.send(JSON.stringify({ type: 'hello', role: 'agent', key: o.key }))
  // Welcomed, or refused with a reason.
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (welcome) return resolve()
      if (closed) return reject(new CliError(closed.reason || `refused (${closed.code})`, CLOSE_REASONS[closed.code] ?? 4))
      if (Date.now() - t0 > (o.timeoutMs ?? 15000)) return reject(new CliError('the hub did not welcome this connection', 4))
      setTimeout(tick, 25)
    }
    tick()
  })

  // A big message goes beside the wire as a parcel, stored with this key — the same transport every end uses.
  const out = sender({ send: (frame: unknown) => ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: frame })), parcels: parcelStore({ api: apiOfHub(url.replace(/\?.*$/, '')), projectId: project, credential: o.key }) })
  let n = 0
  return {
    project: { id: project, name: welcome.project?.name },
    wsId: welcome.wsId,
    request(payload, opts = {}) {
      if (closed) return Promise.reject(new CliError('the connection is closed', 4))
      const reqId = `sacli-${process.pid}-${++n}`
      return new Promise((resolve, reject) => {
        const ms = opts.timeoutMs ?? 120_000
        const timer = setTimeout(() => { waiting.delete(reqId); reject(new CliError(`no reply to ${String(payload.t)} in ${Math.round(ms / 1000)}s`, 4)) }, ms)
        waiting.set(reqId, { resolve, reject, timer })
        void out.send({ ...payload, reqId })
      })
    },
    on(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    close() { try { ws.close(1000, 'done') } catch { /* closing */ } },
  }
}
