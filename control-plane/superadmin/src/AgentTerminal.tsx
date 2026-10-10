// One engine agent, live, in the admin console: its terminal (claude → a raw xterm over its PTY, typeable — this is
// how an admin runs `/login` in the browser) or its event log (codex → CodexEventLog), as the lane announces. The
// connector, analyst and grounding pages are this with their own controls. Everything travels on the ONE project hub
// (admin → ProjectDO → engine); nothing here opens a socket of its own.
//
// A lane's frames: `<which>:chunk` (terminal bytes), `<which>:status` (a line said between turns), `<which>:done` or
// `agent:status` done (the turn ended), `agent:hello` / `term:stream` (which kind it streams), `agent:event(s)` (codex).

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ANSI, COLS, ROWS } from './termColors'
import type { Hub } from './hub'
import { CodexEventLog, mergeEvent, type AgentEvent } from './CodexEventLog'
import { Status } from '@superatom/ui'

export type Which = 'connector' | 'analyst' | 'grounding'
const TERM_BG = '#0d0f0d'   // the terminal's background: xterm's theme and its frame agree

export function useAgentTerminal(hub: Hub, which: Which, { greeting, onFrame }: {
  /** The terminal's first line. */
  greeting?: string
  /** A frame the lane's own page reads (an answer, a summary), after the shared handling. */
  onFrame?: (m: any, say: (line: string) => void) => void
} = {}) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const hubRef = useRef(hub); hubRef.current = hub
  const onFrameRef = useRef(onFrame); onFrameRef.current = onFrame
  const [busy, setBusy] = useState(false)
  const [streamKind, setStreamKind] = useState<'pty' | 'events'>('pty')
  const kindRef = useRef(streamKind); kindRef.current = streamKind
  const [events, setEvents] = useState<AgentEvent[]>([])
  const toEngine = (payload: Record<string, unknown>) => hubRef.current.send({ to: { type: 'code-engine' }, payload })
  // The PTY at the fixed geometry every viewer shares, then its live stream.
  const attach = () => { toEngine({ t: 'ui:resize', which, cols: COLS, rows: ROWS }); toEngine({ t: 'term:attach', which }) }

  useEffect(() => {
    if (!elRef.current) return
    const term = new Terminal({ cursorBlink: false, fontSize: 11, convertEol: false, cols: COLS, rows: ROWS, scrollback: 8000, theme: { background: TERM_BG, foreground: '#e6e2da', ...ANSI } })
    term.open(elRef.current)
    termRef.current = term
    term.onData((data) => toEngine({ t: 'term:input', which, data }))   // keystrokes and pastes drive the agent directly
    if (greeting) term.writeln(`\x1b[2m${greeting}\x1b[0m`)
    const onResize = () => { try { toEngine({ t: 'ui:resize', which, cols: COLS, rows: ROWS }) } catch { /* not mounted yet */ } }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); term.dispose(); termRef.current = null }
  }, [which])   // eslint-disable-line react-hooks/exhaustive-deps

  const say = (line: string) => termRef.current?.writeln(line)
  useEffect(() => {
    setTimeout(attach, 0)
    return hub.subscribe((m) => {
      if (m?.t === 'welcome') setTimeout(attach, 0)   // a reconnect: attach again
      else if ((m?.t === 'agent:hello' && m.lane === which) || m?.t === 'term:stream') setStreamKind((m.streamKind ?? m.kind) === 'pty' ? 'pty' : 'events')
      else if (m?.t === 'agent:event' && m.lane === which) setEvents((e) => mergeEvent(e, m.ev))
      else if (m?.t === 'agent:events' && m.lane === which) setEvents(m.events ?? [])
      else if (m?.t === `${which}:chunk`) { if (m.replace) termRef.current?.clear(); termRef.current?.write(m.text ?? '') }
      else if (m?.t === `${which}:status` && m.text) say(`\r\n\x1b[2m— ${m.text}\x1b[0m`)
      else if (m?.t === `${which}:done` || m?.t === `${which}:answer` || (m?.t === 'agent:status' && m.lane === which && m.state === 'done')) setBusy(false)
      onFrameRef.current?.(m, (line) => { if (kindRef.current === 'pty') say(line) })
    })
  }, [hub, which])   // eslint-disable-line react-hooks/exhaustive-deps

  /** A turn begins: shown as the person's line (in the terminal, or as a user turn in the event log), then sent. */
  const start = (shown: string, payload: Record<string, unknown>) => {
    setBusy(true)
    if (kindRef.current === 'events') setEvents((e) => [...e, { kind: 'user', text: shown }])
    else say(`\r\n\x1b[36m❯ ${shown}\x1b[0m`)
    toEngine(payload)
  }
  const live = hub.status === 'live'
  const status = <Status state={live ? 'ok' : hub.status === 'connecting' ? 'running' : 'attention'}>{live ? 'connected' : hub.status}</Status>
  // The frame's height is what xterm fills; the xterm stays mounted (its buffer survives) while the event log shows.
  const view = (
    <div className="sa-card sa-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--sp-2) var(--sp-2h)', background: streamKind === 'pty' ? TERM_BG : undefined }}>
      <div ref={elRef} style={{ height: '100%', display: streamKind === 'pty' ? 'block' : 'none' }} />
      {streamKind === 'events' && <CodexEventLog events={events} busy={busy} />}
    </div>
  )
  return { busy, live, start, status, view }
}

/** The page around it: the controls above, the terminal filling what is left of the window, then what follows. */
export function AgentPage({ top, children, below }: { top: ReactNode; children: ReactNode; below?: ReactNode }) {
  return (
    <div className="sa-stack" style={{ height: 'calc(100vh - 210px)', minHeight: 460 }}>
      <div className="sa-row sa-row--tight">{top}</div>
      {children}
      {below}
    </div>
  )
}

/** A message box under the terminal. */
export function AskLine({ disabled, busy, placeholder, verb, onAsk }: { disabled: boolean; busy: boolean; placeholder: string; verb: string; onAsk: (text: string) => void }) {
  const [text, setText] = useState('')
  return (
    <form className="sa-row" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; onAsk(text.trim()); setText('') }}>
      <input className="sa-input sa-grow" aria-label={verb} value={text} onChange={(e) => setText(e.target.value)} placeholder={disabled ? 'Connecting…' : placeholder} disabled={disabled || busy} />
      <button className="sa-btn sa-btn--primary" disabled={disabled || busy || !text.trim()}>{busy ? 'Working…' : verb}</button>
    </form>
  )
}
