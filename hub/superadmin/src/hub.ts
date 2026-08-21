// ── The project hub connection ────────────────────────────────────────────────
// ONE persistent WebSocket per PROJECT, owned by ProjectDetailPage so it survives switching
// sidebar views. The admin SPA never talks to code-engine directly — it connects to the project's
// Durable Object (always superatom.site, even when the SPA is served locally), authenticates as the
// superadmin 'admin' role, and the DO relays req/res frames to the engine. The DO stores nothing.
//
// Two ways to use it:
//   • send/subscribe — fire-and-forget streams (the connector terminal, analyst chunks)
//   • request(view)  — a correlated round-trip to the engine's INSPECTOR, returning a promise
// Everything shares the one socket; `reqId` is what keeps concurrent inspector panels apart.

import { useEffect, useRef, useState, useCallback } from 'react'

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
}

export function useProjectHub(projectId: string | undefined, token: string | null): Hub {
  const [status, setStatus] = useState<Hub['status']>('connecting')
  const [err, setErr] = useState('')
  const [waking, setWaking] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const subscribers = useRef(new Set<(m: any) => void>())
  // reqId → the promise callbacks waiting on it. Cleared on resolve, reject, or socket close.
  const pending = useRef(new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>())

  useEffect(() => {
    if (!token || !projectId) return
    let closed = false
    function connect() {
      const ws = new WebSocket(`${HUB}/_ws/${projectId}?token=${encodeURIComponent(token!)}`)
      wsRef.current = ws
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, role: 'admin' }))
      ws.onclose = () => {
        setStatus('down')
        // Fail every in-flight request rather than leaving panels spinning until their timeouts.
        for (const [, p] of pending.current) { clearTimeout(p.timer); p.reject(new Error('hub disconnected')) }
        pending.current.clear()
        if (!closed) setTimeout(connect, 3000)
      }
      ws.onerror = () => ws.close()
      ws.onmessage = (e) => {
        const raw = JSON.parse(e.data); const m = raw.payload ?? raw
        if (m?.t === 'welcome') { setStatus('live'); setErr('') }
        else if (m?.t === 'machine:waking') setWaking(true)
        else if (m?.t === 'engine:ready') setWaking(false)
        else if (m?.t === 'error') setErr(m.message ?? m.reason ?? 'hub error')
        // Resolve a waiting inspector request.
        if (m?.t === 'inspect:res' && m.reqId) {
          const p = pending.current.get(m.reqId)
          if (p) { clearTimeout(p.timer); pending.current.delete(m.reqId); setWaking(false); p.resolve(m) }
        }
        subscribers.current.forEach(fn => { try { fn(m) } catch { /* one bad subscriber can't break the hub */ } })
      }
    }
    connect()
    // Keepalive so the non-hibernating DO stays warm and the idle admin WS isn't dropped.
    const ka = setInterval(() => { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'heartbeat' })) }, 12000)
    return () => { closed = true; clearInterval(ka); wsRef.current?.close() }
  }, [token, projectId])

  const send = useCallback((msg: any) => { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(msg)) }, [])

  const request = useCallback((view: string, args: Record<string, unknown> = {}) => {
    return new Promise<any>((resolve, reject) => {
      const ws = wsRef.current
      if (ws?.readyState !== 1) { reject(new Error('not connected to the project hub')); return }
      const reqId = Math.random().toString(36).slice(2)
      const timer = window.setTimeout(() => {
        pending.current.delete(reqId)
        reject(new Error('the engine did not answer in time — it may be starting up'))
      }, REQUEST_TIMEOUT_MS)
      pending.current.set(reqId, { resolve, reject, timer })
      ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'inspect:req', view, reqId, ...args } }))
    })
  }, [])

  const subscribe = useCallback((fn: (m: any) => void) => {
    subscribers.current.add(fn)
    return () => { subscribers.current.delete(fn) }
  }, [])

  return { status, err, waking, send, subscribe, request }
}
