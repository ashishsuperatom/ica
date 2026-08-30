// The analyst/composer agent event log — event types, live-merge, and the rendered stream (per-agent
// colour rail + interleaved narrator beats). Extracted from App.tsx.
import React, { useState, useEffect } from 'react'
import { renderInlineMd } from './format'

export type AgentEvent = { kind: 'command' | 'message' | 'reasoning' | 'file' | 'turn' | 'user' | 'narration'; id?: string; text?: string; command?: string; output?: string; status?: string; done?: boolean; agent?: 'composer' | 'analyst' | 'narrator' }

// Merge one live event into the log: update the block with the same id (started→updated→completed), else append.
export function mergeEvent(evs: AgentEvent[], e: AgentEvent): AgentEvent[] {
  if (e.id) { const i = evs.findIndex(x => x.id === e.id); if (i >= 0) { const n = evs.slice(); n[i] = e; return n } }
  return [...evs, e]
}

// A command's output, collapsed to the first few lines with a +N-lines toggle (matches the native client).
// Find the first BALANCED json object/array in a string that actually parses (string-escape aware), so a JSON
// blob embedded in a run's mixed text output can be lifted out and pretty-printed separately from the trace.
function findJsonSpan(text: string): { start: number; end: number; value: any } | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue
    let depth = 0, inStr = false, esc = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') { if (--depth === 0) { try { const v = JSON.parse(text.slice(i, j + 1)); if (v && typeof v === 'object') return { start: i, end: j + 1, value: v } } catch { /* not this one */ } break } }
    }
  }
  return null
}
const CODE_PRE: React.CSSProperties = { margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#54634f', fontSize: 12, lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', background: '#ece8de', border: '1px solid #e0dacd', borderRadius: 4, padding: '6px 9px' }
const TRACE_TXT: React.CSSProperties = { color: '#8a8f86', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '2px 0' }

function CmdOutput({ text, claude }: { text: string; claude?: boolean }) {
  const [open, setOpen] = useState(false)
  const raw = text.replace(/\s+$/, '')
  // claude-only: lift an embedded JSON blob out of mixed output → pretty-print it apart from the run trace.
  const span = claude ? findJsonSpan(raw) : null
  const pre = span ? raw.slice(0, span.start).trim() : ''
  const post = span ? raw.slice(span.end).trim() : ''
  let main = span ? JSON.stringify(span.value, null, 2) : raw
  if (!span && claude) { const t = raw.trim(); if (/^[[{]/.test(t)) { try { main = JSON.stringify(JSON.parse(t), null, 2) } catch { /* node-inspect etc. → as-is */ } } }
  const lines = main.split('\n')
  const CAP = 12, hidden = lines.length - CAP
  const shown = open || hidden <= 0 ? lines : lines.slice(0, CAP)
  return (
    <div style={{ marginTop: 4 }}>
      {pre && <div style={TRACE_TXT}>{pre}</div>}
      {main.trim() && <pre style={CODE_PRE}>{shown.join('\n')}</pre>}
      {post && <div style={TRACE_TXT}>{post}</div>}
      {hidden > 0 && <span onClick={() => setOpen(o => !o)} style={{ cursor: 'pointer', color: '#8a7a3a', fontSize: 11, userSelect: 'none' }}>{open ? '▲ show less' : `▾ +${hidden} lines`}</span>}
    </div>
  )
}

function CodexEvent({ e, claude }: { e: AgentEvent; claude?: boolean }) {
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' as const }
  if (e.kind === 'turn') return <div style={{ borderTop: '1px solid #ddd6ca', margin: '14px 0' }} />
  // Narrator beat — the business-language line the end user sees, interleaved here in time order.
  if (e.kind === 'narration') return (
    <div className="sa-md" style={{ margin: '7px 0', fontSize: 13, color: '#726f60', fontStyle: 'italic' }}>
      <span style={{ color: '#a99f8c', fontStyle: 'normal', marginRight: 6 }}>◈ narrator</span>
      <span dangerouslySetInnerHTML={{ __html: renderInlineMd(e.text || '') }} />
    </div>
  )
  // A STRONG per-question divider — a full-width rule + the question in bold — so questions are unmistakably
  // separated and easy to scan/jump between. (Its wrapper carries data-role="q" for Shift+Arrow nav.)
  if (e.kind === 'user') return (
    <div style={{ margin: '30px 0 14px' }}>
      <div style={{ borderTop: '2px solid #b0a48c', marginBottom: 12 }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', color: '#1a1a1a', fontSize: 14.5, fontWeight: 700, lineHeight: 1.4 }}>
        <span style={{ color: '#9aa79b', fontWeight: 500, fontSize: 12, letterSpacing: '.04em', textTransform: 'uppercase', flex: '0 0 auto', paddingTop: 1 }}>Question</span>
        <span dangerouslySetInnerHTML={{ __html: renderInlineMd(e.text || '') }} />
      </div>
    </div>
  )
  if (e.kind === 'command') return (
    <div style={{ margin: '9px 0' }}>
      <div style={{ color: '#2f3d2c', fontSize: 12.5, ...mono }}>
        <span style={{ color: e.status === 'in_progress' ? '#b07d1a' : '#3a7d3a' }}>●</span>{' '}
        <span style={{ color: '#6b7a6c' }}>Ran</span> {e.command}
      </div>
      {e.output ? <CmdOutput text={e.output} claude={claude} /> : null}
    </div>
  )
  if (e.kind === 'file') return (
    <div style={{ margin: '9px 0' }}>
      <div style={{ color: '#2f3d2c', fontSize: 12.5, ...mono }}>
        <span style={{ color: '#3a7d3a' }}>●</span> <span style={{ color: '#6b7a6c' }}>Edited</span> {(e.text || '').split('/').slice(-3).join('/')}
      </div>
      {e.output ? <CmdOutput text={e.output} claude={claude} /> : null}
    </div>
  )
  const muted = e.kind === 'reasoning'   // reasoning is subdued; a message is the prominent prose
  const color = muted ? '#7a857c' : '#263124'
  // claude-only: a long PROSE message reads better broken into sentences (never applied to command OUTPUT,
  // which can be code). Only split when there's genuinely more than one sentence.
  if (claude && !muted && e.text) {
    const parts = e.text.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((s) => s.trim()).filter(Boolean)
    if (parts.length > 1) return (
      <div style={{ margin: '9px 0', color: '#263124', fontSize: 13, lineHeight: 1.55 }}>
        {parts.map((p, i) => <div key={i} style={{ margin: '3px 0' }} dangerouslySetInnerHTML={{ __html: renderInlineMd(p) }} />)}
      </div>
    )
  }
  return <div style={{ margin: '9px 0', color, fontSize: 13, lineHeight: 1.55, fontStyle: muted ? 'italic' : 'normal' }}
    dangerouslySetInnerHTML={{ __html: renderInlineMd(e.text ?? '') }} />
}

// Codex reasons SILENTLY before its next action (no event streams during that phase), so a turn can look
// stuck. Show a "thinking…" line whenever the turn is busy but nothing is actively streaming (the last event
// has completed / there's no event yet) — the fact it's working, without exposing the reasoning content.
function ThinkingLine() {
  const [n, setN] = useState(1)
  useEffect(() => { const t = setInterval(() => setN(x => (x % 3) + 1), 420); return () => clearInterval(t) }, [])
  return <div style={{ color: '#9a7b1a', fontSize: 12.5, fontStyle: 'italic', margin: '9px 0' }}>◐ agent is thinking{'.'.repeat(n)}</div>
}

export function CodexEventLog({ events, busy, claude }: { events: AgentEvent[]; busy?: boolean; claude?: boolean }) {
  // ACCORDION: click a question to collapse everything under it (until the next question), so you can scan across
  // questions. State is the set of collapsed question ids.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (qid: string) => setCollapsed(s => { const n = new Set(s); n.has(qid) ? n.delete(qid) : n.add(qid); return n })

  const last = events[events.length - 1]
  const streaming = !!last && last.done === false && (last.kind === 'command' || last.kind === 'message' || last.kind === 'reasoning')
  const thinking = !!busy && !streaming   // busy but nothing actively streaming ⇒ reasoning between steps
  if (!events.length && !thinking) return null

  // A coloured left rail per agent — composer (blue), analyst (amber), narrator (grey). Walk the events tracking
  // which QUESTION each belongs to; a collapsed question hides its steps.
  let curQ = ''                          // id of the question the following events belong to
  const rows: React.ReactElement[] = []
  events.forEach((e, i) => {
    const c = e.agent === 'composer' ? '#4a90d9' : e.agent === 'analyst' ? '#c08a2b' : e.agent === 'narrator' ? '#a99f8c' : ''
    // A 'user' block is a QUESTION boundary → anchor it for Shift+Arrow nav (data-qlog, distinct from the chat
    // feed's data-role="q") AND make it the accordion header (click to collapse/expand its steps).
    if (e.kind === 'user') {
      const qid = e.id ?? `turn${i}`
      curQ = qid
      const isCol = collapsed.has(qid)
      rows.push(
        <div key={qid} data-qlog="" style={{ scrollMarginTop: 10, cursor: 'pointer' }} onClick={() => toggle(qid)}
             title={isCol ? 'Click to expand this question' : 'Click to collapse this question'}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <span style={{ color: '#b0a48c', fontSize: 12, userSelect: 'none', paddingTop: 2 }}>{isCol ? '▸' : '▾'}</span>
            <div style={{ flex: 1, minWidth: 0 }}><CodexEvent e={e} claude={claude} /></div>
          </div>
        </div>,
      )
      return
    }
    if (curQ && collapsed.has(curQ)) return   // this step's question is collapsed → hide it
    rows.push(<div key={e.id ?? `turn${i}`} style={c ? { borderLeft: `3px solid ${c}`, paddingLeft: 10 } : undefined}><CodexEvent e={e} claude={claude} /></div>)
  })
  return <div>{rows}{thinking && <ThinkingLine />}</div>
}
