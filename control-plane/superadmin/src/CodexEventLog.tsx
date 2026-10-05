// ── CodexEventLog — CANONICAL (admin) ─────────────────────────────────────────────────────────────────
// The structured view for 'events'-kind harnesses (codex): the counterpart of the xterm 'pty' view. Renders
// the normalized AgentEvent stream (mirror of the engine's ica/session.ts AgentEvent) the way the native codex
// client does — command runs with collapsed output, assistant messages, reasoning, turn rules — plus a
// "thinking" line for the silent reasoning phase.
//
// THIS FILE IS CANONICAL. The user-ui has a COPY (control-plane/user-ui/src/CodexEventLog.tsx) that references
// this one — make changes HERE first, then sync the copy. (Deliberate copy, not a shared import.)
import { useEffect, useState } from 'react'
import { Code, Icon, Status } from '@superatom/ui'

export type AgentEvent = { kind: 'command' | 'message' | 'reasoning' | 'file' | 'turn' | 'user'; id?: string; text?: string; command?: string; output?: string; status?: string; done?: boolean }

// Merge one live event into the log: update the block with the same id (started→updated→completed), else append.
export function mergeEvent(evs: AgentEvent[], e: AgentEvent): AgentEvent[] {
  if (e.id) { const i = evs.findIndex((x) => x.id === e.id); if (i >= 0) { const n = evs.slice(); n[i] = e; return n } }
  return [...evs, e]
}

// Minimal inline markdown → HTML: bold + code only (italics deliberately not parsed), plus `- ` bullet lines.
// Paragraphs and lists are plain elements; .sa-prose spaces them.
function inlineMd(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')
}
function md(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out: string[] = []; let para: string[] = [], bul: string[] = []
  const fp = () => { if (para.length) { out.push(`<p>${para.join('<br/>')}</p>`); para = [] } }
  const fb = () => { if (bul.length) { out.push(`<ul>${bul.join('')}</ul>`); bul = [] } }
  for (const ln of esc.split('\n')) {
    const m = ln.match(/^\s*[-•]\s+(.*)/)
    if (m) { fp(); bul.push(`<li>${inlineMd(m[1])}</li>`) }
    else if (ln.trim() === '') { fb(); fp() }
    else { fb(); para.push(inlineMd(ln)) }
  }
  fp(); fb(); return out.join('')
}

function CmdOutput({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const lines = text.replace(/\s+$/, '').split('\n')
  const CAP = 5, hidden = lines.length - CAP
  const shown = open || hidden <= 0 ? lines : lines.slice(0, CAP)
  return (
    <div className="sa-prose">
      <pre>{shown.join('\n')}</pre>
      {hidden > 0 && <button type="button" className="sa-btn sa-btn--link" onClick={() => setOpen((o) => !o)}>
        <Icon icon={open ? 'lucide:chevron-up' : 'lucide:chevron-down'} className="sa-btn__icon" />{open ? 'Show less' : `${hidden} more lines`}
      </button>}
    </div>
  )
}

function CodexEvent({ e }: { e: AgentEvent }) {
  if (e.kind === 'turn') return <hr />
  if (e.kind === 'user') return (
    <p className="sa-row sa-row--tight"><Icon icon="lucide:chevron-right" className="sa-faint" /><strong>{e.text}</strong></p>
  )
  if (e.kind === 'command') return (
    <div className="sa-stack sa-stack--3">
      <div className="sa-row sa-row--wrap">
        <Status state={e.status === 'in_progress' ? 'running' : 'ok'}>Ran</Status>
        <Code>{e.command}</Code>
      </div>
      {e.output ? <CmdOutput text={e.output} /> : null}
    </div>
  )
  if (e.kind === 'file') return (
    <div className="sa-row sa-row--wrap"><Status state="ok">Edited</Status><Code>{e.text}</Code></div>
  )
  return <div className={e.kind === 'reasoning' ? 'sa-prose sa-muted' : 'sa-prose'} dangerouslySetInnerHTML={{ __html: md(e.text ?? '') }} />
}

function ThinkingLine() {
  const [n, setN] = useState(1)
  useEffect(() => { const t = setInterval(() => setN((x) => (x % 3) + 1), 420); return () => clearInterval(t) }, [])
  return <p className="sa-row sa-muted"><span className="sa-spinner" />codex is thinking{'.'.repeat(n)}</p>
}

export function CodexEventLog({ events, busy }: { events: AgentEvent[]; busy?: boolean }) {
  const last = events[events.length - 1]
  const streaming = !!last && last.done === false && (last.kind === 'command' || last.kind === 'message' || last.kind === 'reasoning')
  const thinking = !!busy && !streaming
  if (!events.length && !thinking) return null
  return (
    <div className="sa-stack">
      {events.map((e, i) => <CodexEvent key={e.id ?? `turn${i}`} e={e} />)}
      {thinking && <ThinkingLine />}
    </div>
  )
}
