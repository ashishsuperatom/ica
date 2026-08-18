// The admin's coding-agent console — a live claude-code session (the connector agent) rendered as a raw
// xterm terminal, with an input box. Same WS transport as the rest of the admin app (admin → ProjectDO →
// code-engine), just the connector:* keys. You type, the terminal shows the agent working. Its main job is
// connecting data sources, but it's a general infrastructure agent.

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Hub } from './hub'

// Uses the ONE shared project hub (from ProjectDetailPage) — it opens NO socket of its own.
export function ConnectorConsole({ hub }: { hub: Hub }) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const hubRef = useRef(hub); hubRef.current = hub   // keep the latest hub for the xterm onData closure
  const status = hub.status
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')

  // Open a live, typeable terminal into the connector's PTY (raw keystrokes + full output stream). This is how
  // the admin runs `/login` directly in the browser — no SSH, copy/paste works. Auth is shared across all the
  // claude agents (one $HOME on the volume), so logging in here authenticates the analyst + modeler too.
  const attach = () => hub.send({ to: { type: 'code-engine' }, payload: { t: 'term:attach', which: 'connector' } })

  // Tell the engine to size the connector's PTY to the fitted terminal, so claude's output isn't clipped.
  const sendResize = () => {
    const t = termRef.current
    if (!t) return
    hub.send({ to: { type: 'code-engine' }, payload: { t: 'ui:resize', which: 'connector', cols: t.cols, rows: t.rows } })
  }

  // ── xterm ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!elRef.current) return
    const term = new Terminal({ cursorBlink: false, fontSize: 12, convertEol: true, scrollback: 8000,
      theme: { background: '#0d0f0d', foreground: '#cdd6cd' } })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(elRef.current)
    termRef.current = term; fitRef.current = fit
    // Raw keystrokes/paste typed in the terminal go straight to the connector's PTY (drives claude directly —
    // e.g. type `/login`, then paste the code from your browser right here).
    term.onData((d) => hubRef.current.send({ to: { type: 'code-engine' }, payload: { t: 'term:input', which: 'connector', data: d } }))
    term.writeln('\x1b[2mConnector agent — a live terminal. Type here to drive it (e.g. /login). Or use the box below.\x1b[0m')
    const onResize = () => { try { fit.fit(); sendResize() } catch { /* not mounted yet */ } }
    const raf = requestAnimationFrame(onResize)
    window.addEventListener('resize', onResize)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); term.dispose(); termRef.current = null }
  }, [])

  // Subscribe to the shared hub for connector:* frames (no own socket, no own heartbeat).
  useEffect(() => {
    setTimeout(() => { sendResize(); attach() }, 0)   // size the PTY + open the live terminal stream
    return hub.subscribe((m) => {
      if (m?.t === 'welcome') setTimeout(() => { sendResize(); attach() }, 0)   // reconnect → re-attach
      else if (m?.t === 'connector:chunk') { if (m.replace) termRef.current?.clear(); termRef.current?.write(m.text ?? '') }
      else if (m?.t === 'connector:status' && m.text) termRef.current?.writeln(`\r\n\x1b[2m— ${m.text}\x1b[0m`)
      else if (m?.t === 'connector:done') setBusy(false)
    })
  }, [hub])

  const send = (text: string) => {
    if (!text.trim()) return
    termRef.current?.writeln(`\r\n\x1b[36m❯ ${text}\x1b[0m`)   // echo the admin's message
    setBusy(true)
    hub.send({ to: { type: 'code-engine' }, payload: { t: 'connector:ask', text, reqId: Math.random().toString(36).slice(2) } })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: 'calc(100vh - 210px)', minHeight: 460 }}>
      <div className="between">
        <div>
          <strong>Coding agent</strong>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Connect a data source or run an infra task — the agent works live in the terminal.</div>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{status === 'live' ? 'connected' : status}</span>
      </div>
      <div ref={elRef} style={{ flex: 1, minHeight: 0, background: '#0d0f0d', borderRadius: 10, padding: '8px 10px', overflow: 'hidden' }} />
      <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (!input.trim()) return; send(input); setInput('') }}>
        <input className="input" style={{ flex: 1 }} value={input} onChange={(e) => setInput(e.target.value)}
          placeholder={status === 'live' ? 'Ask the connector agent…' : 'Connecting…'}
          disabled={busy || status !== 'live'} />
        <button className="btn" disabled={busy || status !== 'live' || !input.trim()}>{busy ? 'Working…' : 'Send'}</button>
      </form>
    </div>
  )
}
