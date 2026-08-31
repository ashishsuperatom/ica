// The admin's ANALYST console — ask the analyst a question and watch it work, then see the answer. Same WS
// transport as the other consoles (admin → ProjectDO → code-engine); uses the analyst:* + analyse keys. The
// analyst runs on claude (pty → xterm) OR codex (events → CodexEventLog); we render per the announced kind.
// Unlike the user UI (watch-only), THIS is interactive — the admin can drive the analyst directly.

import { useEffect, useRef, useState } from 'react'
import { ANSI, COLS, ROWS } from './termColors'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Hub } from './hub'
import { CodexEventLog, mergeEvent, type AgentEvent } from './CodexEventLog'

export function AnalystConsole({ hub }: { hub: Hub }) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const hubRef = useRef(hub); hubRef.current = hub
  const sidRef = useRef<string>(crypto.randomUUID())   // one stable admin-analyst session for follow-ups
  const status = hub.status
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [streamKind, setStreamKind] = useState<'pty' | 'events'>('pty')
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [answer, setAnswer] = useState('')

  const attach = () => hub.send({ to: { type: 'code-engine' }, payload: { t: 'term:attach', which: 'analyst' } })
  const sendResize = () => { hub.send({ to: { type: 'code-engine' }, payload: { t: 'ui:resize', which: 'analyst', cols: COLS, rows: ROWS } }) }   // fixed geometry — every viewer + the PTY agree

  useEffect(() => {
    if (!elRef.current) return
    const term = new Terminal({ cursorBlink: false, fontSize: 11, convertEol: false, cols: COLS, rows: ROWS, scrollback: 8000, theme: { background: '#0d0f0d', foreground: '#e6e2da', ...ANSI } })
    term.open(elRef.current)
    termRef.current = term
    term.onData((d) => hubRef.current.send({ to: { type: 'code-engine' }, payload: { t: 'term:input', which: 'analyst', data: d } }))
    const onResize = () => { try { sendResize() } catch { /* not mounted */ } }
    const raf = requestAnimationFrame(onResize); window.addEventListener('resize', onResize)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); term.dispose(); termRef.current = null }
  }, [])

  useEffect(() => {
    setTimeout(() => { sendResize(); attach() }, 0)
    return hub.subscribe((m) => {
      if (m?.t === 'welcome') setTimeout(() => { sendResize(); attach() }, 0)
      else if ((m?.t === 'agent:hello' && m.lane === 'analyst') || m?.t === 'term:stream') setStreamKind((m.streamKind ?? m.kind) === 'pty' ? 'pty' : 'events')
      else if (m?.t === 'agent:event' && m.lane === 'analyst') setEvents((e) => mergeEvent(e, m.ev))          // codex event (live)
      else if (m?.t === 'agent:events' && m.lane === 'analyst') setEvents(m.events ?? [])                     // codex replay (reconnect)
      else if (m?.t === 'analyst:chunk') { if (m.replace) termRef.current?.clear(); termRef.current?.write(m.text ?? '') }
      else if (m?.t === 'analyst:answer') { setBusy(false); const a = m.answer; setAnswer(a?.answer ? String(a.answer) : (a ? JSON.stringify(a).slice(0, 500) : '')) }
      // The turn ending is a lane STATUS now (agent:status state:'done'); analyst:done stopped being sent
      // when the lanes landed, so this console's spinner never cleared.
      else if (m?.t === 'agent:status' && m.lane === 'analyst' && m.state === 'done') setBusy(false)
    })
  }, [hub])

  const ask = (text: string) => {
    if (!text.trim()) return
    setBusy(true); setAnswer('')
    if (streamKind === 'events') setEvents((e) => [...e, { kind: 'user', text }])
    else termRef.current?.writeln(`\r\n\x1b[36m❯ ${text}\x1b[0m`)
    hub.send({ to: { type: 'code-engine' }, payload: { t: 'analyse', question: text, sessionId: sidRef.current, questionId: crypto.randomUUID() } })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: 'calc(100vh - 210px)', minHeight: 460 }}>
      <div className="between">
        <div><strong>Analyst</strong><div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Ask a question and watch the analyst build the program and answer it, live.</div></div>
        <span className="muted" style={{ fontSize: 12 }}>{status === 'live' ? 'connected' : status}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: '#0d0f0d', borderRadius: 10, padding: '8px 10px', overflow: 'auto' }}>
        <div ref={elRef} style={{ height: '100%', display: streamKind === 'pty' ? 'block' : 'none' }} />
        {streamKind === 'events' && <CodexEventLog events={events} busy={busy} />}
      </div>
      {answer && <div className="card" style={{ fontSize: 13, lineHeight: 1.5 }}><strong>Answer.</strong> {answer}</div>}
      <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (!input.trim()) return; ask(input); setInput('') }}>
        <input className="input" style={{ flex: 1 }} value={input} onChange={(e) => setInput(e.target.value)}
          placeholder={status === 'live' ? 'Ask the analyst a question…' : 'Connecting…'} disabled={busy || status !== 'live'} />
        <button className="btn" disabled={busy || status !== 'live' || !input.trim()}>{busy ? 'Working…' : 'Ask'}</button>
      </form>
    </div>
  )
}
