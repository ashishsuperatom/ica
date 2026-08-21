// ── claude-code → structured events (from the JSONL transcript, not the PTY) ─────────────────────────────
// claude-code is a full-screen TUI over a PTY — great for an interactive terminal, terrible to mirror as a
// read-only feed (cursor-addressed redraws garble). But claude ALSO writes a clean, structured transcript to
// ~/.claude/projects/<encoded-cwd>/<session>.jsonl — one JSON line per event. This module turns that transcript
// into the SAME AgentEvent[] that codex/opencode already emit, so the UI renders claude through the one shared
// event log — no PTY, no LLM. The PTY path is untouched: it stays as an on-demand "raw terminal" view.
//
// This file is PURE parsing/accumulation (no fs) so it's unit-testable against a real .jsonl. The tailer that
// feeds it live lines lives in claude.ts.
import type { AgentEvent } from './session.js'

const asStr = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? x.content ?? '').join('') : ''
const short = (s: string, n = 400) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// claude's transcript dir encodes the cwd: every '/' and '.' becomes '-'.
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${cwd.replace(/[/.]/g, '-')}/${sessionId}.jsonl`
}

// One assistant tool_use → an AgentEvent (a 'file' op for reads/writes, else a 'command').
function toolUseToEvent(p: any): AgentEvent {
  const name = p.name as string
  const inp = p.input ?? {}
  const id = p.id as string
  if (name === 'Bash') return { kind: 'command', id, command: short(inp.command ?? '', 2000), status: 'in_progress' }
  if (['Write', 'Edit', 'MultiEdit', 'Read', 'NotebookEdit'].includes(name))
    return { kind: 'file', id, text: inp.file_path ?? inp.notebook_path ?? '', status: 'in_progress' }
  // any other tool (Grep/Glob/WebFetch/…) → a command line, so it still shows what happened
  return { kind: 'command', id, command: `${name} ${short(JSON.stringify(inp), 300)}`, status: 'in_progress' }
}

// A stateful accumulator: feed it transcript entries (parsed JSON objects) in order; it maintains the rolling
// AgentEvent[] (for events() replay) and returns the events to EMIT for each entry (started → completed merged
// by tool_use_id, exactly like codex). `thinking` blocks are skipped — they're redacted (signature only) in the
// transcript, and we don't want raw reasoning anyway.
export function makeClaudeEventLog(cap = 600) {
  const events: AgentEvent[] = []
  const byId = new Map<string, AgentEvent>()
  const push = (ev: AgentEvent) => { events.push(ev); if (ev.id) byId.set(ev.id, ev); if (events.length > cap) events.shift() }

  function handleEntry(o: any): AgentEvent[] {
    const emitted: AgentEvent[] = []
    const c = o?.message?.content
    if (!Array.isArray(c)) return emitted
    if (o.type === 'assistant') {
      let i = 0
      for (const p of c) {
        if (p.type === 'tool_use') { const ev = toolUseToEvent(p); push(ev); emitted.push(ev) }
        else if (p.type === 'text' && p.text?.trim()) {
          const ev: AgentEvent = { kind: 'message', id: `${o.message.id}:${i}`, text: p.text.trim(), done: true }
          push(ev); emitted.push(ev)
        }
        i++
      }
    } else if (o.type === 'user') {
      for (const p of c) {
        if (p.type !== 'tool_result') continue
        const prior = byId.get(p.tool_use_id)
        const output = short(asStr(p.content), 4000)
        const status = p.is_error ? 'failed' : 'completed'
        if (prior) { prior.output = prior.kind === 'command' ? output : prior.output; prior.status = status; prior.done = true; emitted.push({ ...prior }) }
        else { const ev: AgentEvent = { kind: 'command', id: p.tool_use_id, output, status, done: true }; push(ev); emitted.push(ev) }
      }
    }
    return emitted
  }

  return { events: () => events, handleEntry }
}
