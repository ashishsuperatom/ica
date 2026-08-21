// ── CodexEventLog — CANONICAL (admin) ─────────────────────────────────────────────────────────────────
// The structured view for 'events'-kind harnesses (codex): the counterpart of the xterm 'pty' view. Renders
// the normalized AgentEvent stream (mirror of the engine's ica/session.ts AgentEvent) the way the native codex
// client does — command runs with collapsed output, assistant messages, reasoning, turn rules — plus a
// "thinking" line for the silent reasoning phase.
//
// THIS FILE IS CANONICAL. The user-ui has a COPY (control-plane/user-ui/src/CodexEventLog.tsx) that references
// this one — make changes HERE first, then sync the copy. (Deliberate copy, not a shared import.)
import { useEffect, useState } from 'react'

export type AgentEvent = { kind: 'command' | 'message' | 'reasoning' | 'file' | 'turn' | 'user'; id?: string; text?: string; command?: string; output?: string; status?: string; done?: boolean }

// Merge one live event into the log: update the block with the same id (started→updated→completed), else append.
export function mergeEvent(evs: AgentEvent[], e: AgentEvent): AgentEvent[] {
  if (e.id) { const i = evs.findIndex((x) => x.id === e.id); if (i >= 0) { const n = evs.slice(); n[i] = e; return n } }
  return [...evs, e]
}

// Minimal inline markdown → HTML: bold + code only (italics deliberately not parsed), plus `- ` bullet lines.
function inlineMd(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')
}
function md(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out: string[] = []; let para: string[] = [], bul: string[] = []
  const fp = () => { if (para.length) { out.push(para.join('<br/>')); para = [] } }
  const fb = () => { if (bul.length) { out.push(`<ul style="margin:6px 0;padding-left:18px">${bul.join('')}</ul>`); bul = [] } }
  for (const ln of esc.split('\n')) {
    const m = ln.match(/^\s*[-•]\s+(.*)/)
    if (m) { fp(); bul.push(`<li>${inlineMd(m[1])}</li>`) }
    else if (ln.trim() === '') { fb(); fp() }
    else { fb(); para.push(inlineMd(ln)) }
  }
  fp(); fb(); return out.join('')
}

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' as const }

function CmdOutput({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const lines = text.replace(/\s+$/, '').split('\n')
  const CAP = 5, hidden = lines.length - CAP
  const shown = open || hidden <= 0 ? lines : lines.slice(0, CAP)
  return (
    <div style={{ marginTop: 4 }}>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#8a9a8c', fontSize: 12, lineHeight: 1.5, ...mono }}>{shown.join('\n')}</pre>
      {hidden > 0 && <span onClick={() => setOpen((o) => !o)} style={{ cursor: 'pointer', color: '#6f8a70', fontSize: 11, userSelect: 'none' }}>{open ? '▲ show less' : `▾ +${hidden} lines`}</span>}
    </div>
  )
}

function CodexEvent({ e }: { e: AgentEvent }) {
  if (e.kind === 'turn') return <div style={{ borderTop: '1px solid #263026', margin: '14px 0' }} />
  if (e.kind === 'user') return (
    <div style={{ margin: '16px 0 10px', paddingTop: 12, borderTop: '1px solid #263026', color: '#e7efe7', fontSize: 13.5, fontWeight: 600 }}>
      <span style={{ color: '#6f8a70' }}>›</span> {e.text}
    </div>
  )
  if (e.kind === 'command') return (
    <div style={{ margin: '9px 0' }}>
      <div style={{ color: '#cfe3d0', fontSize: 12.5, ...mono }}>
        <span style={{ color: e.status === 'in_progress' ? '#c9a24a' : '#7fae7f' }}>●</span>{' '}
        <span style={{ color: '#9db29e' }}>Ran</span> {e.command}
      </div>
      {e.output ? <CmdOutput text={e.output} /> : null}
    </div>
  )
  if (e.kind === 'file') return (
    <div style={{ margin: '9px 0', color: '#cfe3d0', fontSize: 12.5, ...mono }}>
      <span style={{ color: '#7fae7f' }}>●</span> <span style={{ color: '#9db29e' }}>Edited</span> {e.text}
    </div>
  )
  const muted = e.kind === 'reasoning'
  return <div style={{ margin: '9px 0', color: muted ? '#8a9a8c' : '#d3e4d4', fontSize: 13, lineHeight: 1.55, fontStyle: muted ? 'italic' : 'normal' }} dangerouslySetInnerHTML={{ __html: md(e.text ?? '') }} />
}

function ThinkingLine() {
  const [n, setN] = useState(1)
  useEffect(() => { const t = setInterval(() => setN((x) => (x % 3) + 1), 420); return () => clearInterval(t) }, [])
  return <div style={{ color: '#c9a24a', fontSize: 12.5, fontStyle: 'italic', margin: '9px 0' }}>◐ codex is thinking{'.'.repeat(n)}</div>
}

export function CodexEventLog({ events, busy }: { events: AgentEvent[]; busy?: boolean }) {
  const last = events[events.length - 1]
  const streaming = !!last && last.done === false && (last.kind === 'command' || last.kind === 'message' || last.kind === 'reasoning')
  const thinking = !!busy && !streaming
  if (!events.length && !thinking) return null
  return (
    <div>
      {events.map((e, i) => <CodexEvent key={e.id ?? `turn${i}`} e={e} />)}
      {thinking && <ThinkingLine />}
    </div>
  )
}
