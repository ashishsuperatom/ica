// The admin's GROUNDING agent console — a live claude-code session rendered as a raw xterm terminal, with a
// single "Build" trigger (the grounding agent is a cold, one-shot builder, not a chat). Same WS transport as
// the rest of the admin app (admin → ProjectDO → code-engine), just the grounding:* keys. Press Build and the
// terminal shows the agent introspecting the sources and constructing the value→id indexes live. Mirrors
// ConnectorConsole's PTY wiring (term:attach / ui:resize with which:'grounding').

import { useEffect, useRef, useState } from 'react'
import { ANSI } from './termColors'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Hub } from './hub'
import { CodexEventLog, mergeEvent, type AgentEvent } from './CodexEventLog'   // codex (events-kind) view

export function GroundingConsole({ hub }: { hub: Hub }) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const hubRef = useRef(hub); hubRef.current = hub
  const status = hub.status
  const [busy, setBusy] = useState(false)
  const [streamKind, setStreamKind] = useState<'pty' | 'events'>('pty')   // claude → xterm; codex → CodexEventLog
  const [events, setEvents] = useState<AgentEvent[]>([])

  const attach = () => hub.send({ to: { type: 'code-engine' }, payload: { t: 'term:attach', which: 'grounding' } })
  const sendResize = () => {
    const t = termRef.current
    if (!t) return
    hub.send({ to: { type: 'code-engine' }, payload: { t: 'ui:resize', which: 'grounding', cols: t.cols, rows: t.rows } })
  }

  // ── xterm ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!elRef.current) return
    const term = new Terminal({ cursorBlink: false, fontSize: 12, convertEol: false, scrollback: 8000,
      theme: { background: '#0d0f0d', foreground: '#e6e2da', ...ANSI } })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(elRef.current)
    termRef.current = term; fitRef.current = fit
    // Raw keystrokes go to the grounding PTY too (so /login etc. works if the agent ever needs it).
    term.onData((d) => hubRef.current.send({ to: { type: 'code-engine' }, payload: { t: 'term:input', which: 'grounding', data: d } }))
    term.writeln('\x1b[2mGrounding agent — press Build to (re)construct this project’s value→id indexes. Watch it work live.\x1b[0m')
    const onResize = () => { try { fit.fit(); sendResize() } catch { /* not mounted yet */ } }
    const raf = requestAnimationFrame(onResize)
    window.addEventListener('resize', onResize)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); term.dispose(); termRef.current = null }
  }, [])

  // Subscribe to the shared hub for grounding:* frames (no own socket, no own heartbeat).
  useEffect(() => {
    setTimeout(() => { sendResize(); attach() }, 0)
    return hub.subscribe((m) => {
      if (m?.t === 'welcome') setTimeout(() => { sendResize(); attach() }, 0)
      else if (m?.t === 'grounding:stream') setStreamKind(m.kind === 'pty' ? 'pty' : 'events')
      else if (m?.t === 'grounding:event') setEvents((e) => mergeEvent(e, m.ev))       // codex structured event (live)
      else if (m?.t === 'grounding:events') setEvents(m.events ?? [])                  // codex event-log replay (reconnect)
      else if (m?.t === 'grounding:chunk') { if (m.replace) termRef.current?.clear(); termRef.current?.write(m.text ?? '') }
      else if (m?.t === 'grounding:status' && m.text) termRef.current?.writeln(`\r\n\x1b[2m— ${m.text}\x1b[0m`)
      else if (m?.t === 'grounding:done') { setBusy(false); if (m.summary && streamKind === 'pty') termRef.current?.writeln(`\r\n\x1b[32m✓ ${m.summary}\x1b[0m`) }
    })
  }, [hub])

  // Normal build = ADDITIVE (upsert-on-top, never destructive) — safe to re-run to improve. Rebuild = the ONE
  // explicit destructive path: wipe the index and start empty (confirmed), for a clean refresh that drops stale.
  const build = (rebuild = false) => {
    if (rebuild && !window.confirm('Wipe the existing grounding index and rebuild from empty? This deletes all current value→id data.')) return
    setBusy(true)
    const label = rebuild ? 'Rebuild grounding (clear first)' : 'Build / improve grounding'
    if (streamKind === 'events') setEvents((e) => [...e, { kind: 'user', text: label }])
    else termRef.current?.writeln(`\r\n\x1b[36m❯ ${label}…\x1b[0m`)
    hub.send({ to: { type: 'code-engine' }, payload: { t: 'grounding:build', rebuild } })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: 'calc(100vh - 210px)', minHeight: 460 }}>
      <div className="between">
        <div>
          <strong>Grounding agent</strong>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Builds the value→id resolution indexes — entity names, hierarchies, and id patterns — from this project’s own data. Cold: runs only when you trigger it.</div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>{status === 'live' ? 'connected' : status}</span>
          <button className="btn ghost" onClick={() => build(true)} disabled={busy || status !== 'live'} title="Wipe the index and rebuild from empty">Rebuild (clear)</button>
          <button className="btn" onClick={() => build(false)} disabled={busy || status !== 'live'}>{busy ? 'Building…' : 'Build / improve'}</button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: '#0d0f0d', borderRadius: 10, padding: '8px 10px', overflow: 'auto' }}>
        <div ref={elRef} style={{ height: '100%', display: streamKind === 'pty' ? 'block' : 'none' }} />
        {streamKind === 'events' && <CodexEventLog events={events} busy={busy} />}
      </div>
    </div>
  )
}
