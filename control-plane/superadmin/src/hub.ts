// ── The project hub connection ────────────────────────────────────────────────
// ONE persistent WebSocket per PROJECT, shared by every screen that uses the project (counted: opened by the first,
// closed a moment after the last lets go, so moving between pages keeps it). The admin SPA never talks to code-engine directly — it connects to the project's
// Durable Object (always superatom.site, even when the SPA is served locally), authenticates as the
// superadmin 'admin' role, and the DO relays req/res frames to the engine. The DO stores nothing.
//
// Two ways to use it:
//   • send/subscribe — fire-and-forget streams (the connector terminal, analyst chunks)
//   • request(view)  — a correlated round-trip to the engine's INSPECTOR, returning a promise
// Everything shares the one socket; `reqId` is what keeps concurrent inspector panels apart.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { sender, receiver } from '../../../clients/transport'
import { parcelStore, apiOfHub } from '../../../clients/parcels'

const HUB = 'wss://superatom.site'
/** How long a request waits before we call the engine unresponsive. Generous: a cold Fly machine
 *  is woken by the DO on first contact, and that wake takes real seconds. */
const REQUEST_TIMEOUT_MS = 30_000

export type Hub = {
  status: 'connecting' | 'live' | 'down'
  err: string
  /** Set when the DO told us it is waking a suspended machine — the UI shows "starting…" instead of an error. */
  waking: boolean
  send: (msg: any) => void                          // raw frame through the ONE shared project socket
  subscribe: (fn: (m: any) => void) => () => void   // every (unwrapped) message; returns an unsubscribe
  /** Correlated inspector round-trip: request('nodes', { kind: 'unit' }) → the engine's reply payload. */
  request: (view: string, args?: Record<string, unknown>) => Promise<any>
  /** Any message to the engine or the hub, answered by its reply. */
  call: (payload: Record<string, unknown>) => Promise<any>
}

/** One project's connection, shared by every screen using it. */
type Conn = {
  key: string; projectId: string; token: string
  ws: WebSocket | null; closed: boolean; refs: number; ka?: number; closing?: number
  view: { status: Hub['status']; err: string; waking: boolean }
  watchers: Set<() => void>
  subscribers: Set<(m: any) => void>
  pending: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>
}
const conns = new Map<string, Conn>()

function set(c: Conn, patch: Partial<Conn['view']>) { c.view = { ...c.view, ...patch }; c.watchers.forEach((w) => w()) }

function open(c: Conn) {
  const ws = new WebSocket(`${HUB}/_ws/${c.projectId}?token=${encodeURIComponent(c.token)}`)
  c.ws = ws
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: c.token, role: 'admin' }))
  // Frames in through the transport (parts and parcels are its business), whole messages out to the handlers.
  const inbound = receiver({ deliver: (whole) => onWire(whole), parcels: parcelStore({ api: apiOfHub(HUB), projectId: c.projectId }) })
  ws.onclose = () => {
    inbound.reset()
    set(c, { status: 'down' })
    // Fail every in-flight request rather than leaving panels spinning until their timeouts.
    for (const [, p] of c.pending) { clearTimeout(p.timer); p.reject(new Error('hub disconnected')) }
    c.pending.clear()
    if (!c.closed) setTimeout(() => { if (!c.closed) open(c) }, 3000)
  }
  ws.onerror = () => ws.close()
  ws.onmessage = (e) => { const raw = JSON.parse(e.data); const frame = raw.payload ?? raw; if (frame) void inbound.receive(frame) }
  const onWire = (m: any) => {
    if (m?.t === 'welcome') set(c, { status: 'live', err: '' })
    else if (m?.t === 'machine:waking') set(c, { waking: true })
    else if (m?.t === 'engine:ready') set(c, { waking: false })
    else if (m?.t === 'error') set(c, { err: m.message ?? m.reason ?? 'hub error' })
    // Resolve a waiting request (an inspector view, or any message sent with call()).
    if (m?.reqId && c.pending.has(m.reqId)) {
      const p = c.pending.get(m.reqId)!
      clearTimeout(p.timer); c.pending.delete(m.reqId); if (c.view.waking) set(c, { waking: false }); p.resolve(m)
    }
    c.subscribers.forEach((fn) => { try { fn(m) } catch { /* one bad subscriber can't break the hub */ } })
  }
}

function acquire(projectId: string, token: string): Conn {
  const key = `${projectId}|${token}`
  let c = conns.get(key)
  if (!c) {
    c = { key, projectId, token, ws: null, closed: false, refs: 0, view: { status: 'connecting', err: '', waking: false }, watchers: new Set(), subscribers: new Set(), pending: new Map() }
    conns.set(key, c)
    open(c)
    // Keepalive so the DO stays warm and the idle admin socket isn't dropped.
    const cc = c
    c.ka = window.setInterval(() => { if (cc.ws?.readyState === 1) cc.ws.send(JSON.stringify({ type: 'heartbeat' })) }, 12000)
  }
  clearTimeout(c.closing)
  c.refs++
  return c
}

function release(c: Conn) {
  c.refs--
  if (c.refs > 0) return
  // Closed a moment later, so going from one page of the project to another keeps the socket.
  c.closing = window.setTimeout(() => { if (c.refs > 0) return; c.closed = true; clearInterval(c.ka); c.ws?.close(); conns.delete(c.key) }, 5000)
}

const IDLE: Conn['view'] = { status: 'connecting', err: '', waking: false }

export function useProjectHub(projectId: string | undefined, token: string | null): Hub {
  const [conn, setConn] = useState<Conn | null>(null)
  useEffect(() => {
    if (!projectId || !token) { setConn(null); return }
    const c = acquire(projectId, token); setConn(c)
    return () => release(c)
  }, [projectId, token])
  const view = useSyncExternalStore(
    (w) => { if (!conn) return () => {}; conn.watchers.add(w); return () => { conn.watchers.delete(w) } },
    () => conn?.view ?? IDLE)
  // The same object until the connection's state changes: screens depend on it, and a new one each render made them
  // re-subscribe, re-attach and re-ask the engine on every render.
  return useMemo(() => {
    const ask = (payload: Record<string, unknown>, timeoutWords: string) => new Promise<any>((resolve, reject) => {
      const ws = conn?.ws
      if (!conn || ws?.readyState !== 1) { reject(new Error('not connected to the project hub')); return }
      const reqId = Math.random().toString(36).slice(2)
      const timer = window.setTimeout(() => { conn.pending.delete(reqId); reject(new Error(timeoutWords)) }, REQUEST_TIMEOUT_MS)
      conn.pending.set(reqId, { resolve, reject, timer })
      void sender({ send: (frame) => ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: frame })), parcels: parcelStore({ api: apiOfHub(HUB), projectId: conn.projectId, credential: conn.token }) }).send({ ...payload, reqId })
    })
    return {
      ...view,
      send: (msg: any) => { if (conn?.ws?.readyState === 1) conn.ws.send(JSON.stringify(msg)) },
      subscribe: (fn: (m: any) => void) => { conn?.subscribers.add(fn); return () => { conn?.subscribers.delete(fn) } },
      request: (v: string, args: Record<string, unknown> = {}) => ask({ t: 'inspect:req', view: v, ...args }, 'the engine did not answer in time — it may be starting up'),
      call: (payload: Record<string, unknown>) => ask(payload, 'no answer in time'),
    }
  }, [conn, view])
}
