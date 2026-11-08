// The narrator's beats — the story of a reading as it happened — as rows with the seconds each one took: a past
// beat's seconds are the gap to the beat after it and never change; the current one ticks. The same rows the
// platform's chat draws for an analysis, kept after the answer under a quiet line that opens them.

import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import type { Beat } from '../../answer/blocks'
import { markdownToHtml } from '../../lib/markdown'

function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!ticking) return; const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i) }, [ticking])
  return now
}

/** Words the working line cycles through while an answer is being worked out: that something is happening, not what. */
const WORKING = ['Working', 'Thinking', 'Considering', 'Piecing it together', 'Still on it', 'Weighing it up']

/** While an answer is worked out: a word that changes every few seconds, softly lit — so a long silence between steps
 *  still says the work goes on. */
/** The agent working, in a word, for a title. */
const whoWorks = (agent?: string) => (agent === 'analyst' ? 'The analyst' : agent === 'composer' ? 'The composer' : undefined)

export function WorkingLine({ agent }: { /** Which agent is working: its colour. */ agent?: string } = {}) {
  const [i, setI] = useState(0)
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % WORKING.length), 2800); return () => clearInterval(t) }, [])
  return <div className="sa-working-line" aria-hidden data-agent={agent} title={whoWorks(agent)}><span className="sa-working-line__dot" /><span key={i} className="sa-working-line__word">{WORKING[i]}…</span></div>
}

/** The steps, each with its seconds — kept in their place but shown only when asked: a click on any step shows them all,
 *  another hides them. */
/** The lines of a change, old to new: each kept, taken out or put in (the longest common run of lines kept). */
function lineDiff(a: string, b: string): { kind: ' ' | '-' | '+'; text: string }[] {
  const x = a.split('\n').slice(0, 400), y = b.split('\n').slice(0, 400)
  const n = x.length, m = y.length, L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: { kind: ' ' | '-' | '+'; text: string }[] = []
  let i = 0, j = 0
  while (i < n && j < m) { if (x[i] === y[j]) { out.push({ kind: ' ', text: x[i] }); i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ kind: '-', text: x[i++] }); else out.push({ kind: '+', text: y[j++] }) }
  while (i < n) out.push({ kind: '-', text: x[i++] })
  while (j < m) out.push({ kind: '+', text: y[j++] })
  return out
}

/** A file's change, as the lines it takes out and puts in (a new file: all of it put in). */
function FileChange({ file }: { file: NonNullable<NonNullable<Beat['tool']>['file']> }) {
  const lines = file.content != null ? file.content.split('\n').map((text) => ({ kind: '+' as const, text })) : (file.edits ?? []).flatMap((e, i) => [...(i ? [{ kind: '…' as const, text: '' }] : []), ...lineDiff(e.old, e.new)])
  return <pre className="sa-diff">{lines.map((l, i) => <span key={i} className="sa-diff__line" data-kind={l.kind}>{l.kind === '…' ? '⋯' : `${l.kind} ${l.text}`}{'\n'}</span>)}</pre>
}

/** How much a file tool changed: lines put in and taken out. */
const changeCount = (file: NonNullable<NonNullable<Beat['tool']>['file']>) => {
  if (file.content != null) return { add: file.content.split('\n').length, del: 0 }
  let add = 0, del = 0
  for (const e of file.edits ?? []) for (const l of lineDiff(e.old, e.new)) { if (l.kind === '+') add++; if (l.kind === '-') del++ }
  return { add, del }
}

/** A tool call, in one line: the command shortened (what it ran, on what), and how it went; opened, the command whole and
 *  what it gave back. */
function ToolStep({ tool }: { tool: NonNullable<Beat['tool']> }) {
  const [open, setOpen] = useState(false)
  const f = tool.file
  const edits = f && f.tool !== 'Read' ? changeCount(f) : null
  const line = f ? `${f.tool === 'Write' ? 'Write' : f.tool === 'Read' ? 'Read' : 'Update'}(${f.path.split('/').slice(-3).join('/')})` : tool.command.replace(/\s+/g, ' ').replace(/^(\.\/|bash -lc |\/bin\/bash -lc )/, '').trim()
  return (
    <div className="sa-toolstep" data-open={open || undefined} data-status={tool.status}>
      <button type="button" className="sa-toolstep__line" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open) }} title={open ? 'Close' : 'What it ran, and what it gave back'}>
        <Icon icon={tool.status === 'running' ? 'lucide:loader' : tool.status === 'failed' ? 'lucide:circle-x' : f ? (f.tool === 'Read' ? 'lucide:file-text' : 'lucide:file-pen-line') : 'lucide:terminal'} className={tool.status === 'running' ? 'sa-spin' : undefined} />
        <span className="sa-toolstep__cmd">{line}</span>
        {edits && <span className="sa-toolstep__count"><span data-kind="+">+{edits.add}</span> <span data-kind="-">−{edits.del}</span></span>}
      </button>
      {open && f && f.tool !== 'Read' && <div className="sa-toolstep__body"><FileChange file={f} /></div>}
      {open && !(f && f.tool !== 'Read') && <div className="sa-toolstep__body">
        <pre className="sa-toolstep__pre">{f ? f.path : tool.command}</pre>
        {tool.output ? <pre className="sa-toolstep__pre sa-toolstep__out">{tool.output}</pre> : <p className="sa-note">{tool.status === 'running' ? 'Still running…' : 'It gave nothing back.'}</p>}
      </div>}
    </div>
  )
}

export function BeatRows({ beats, live, end }: { beats: Beat[]; live: boolean; end?: number }) {
  const now = useNow(live)
  const stop = end ?? now
  const [times, setTimes] = useState(false)
  return (
    // An agent's own work (the workbench: what it says and runs) is a log of its own — never drawn as narration.
    <div className="sa-beats" data-own={beats.length > 0 && beats.every((b) => b.agent === 'workbench') || undefined} data-times={times || undefined} onClick={() => setTimes(!times)} title={times ? 'Hide the times' : 'Show the times'}>
      {beats.map((b, i) => {
        const next = beats[i + 1]?.at ?? stop
        const secs = Math.max(1, Math.round((next - b.at) / 1000))
        const current = live && i === beats.length - 1
        return (
          b.tool ? <ToolStep key={b.tool.id} tool={b.tool} /> :
          <div key={`${i}:${b.at}`} className={`sa-beat${current ? '' : ' sa-beat--past'}`} data-agent={b.agent}>
            <span className="sa-beat__secs">{secs} s</span>
            {b.agent && <span className="sa-beat__who" title={whoWorks(b.agent)} aria-label={whoWorks(b.agent)} />}
            <span className="sa-beat__text sa-prose" dangerouslySetInnerHTML={{ __html: markdownToHtml(b.text) }} />
          </div>
        )
      })}
    </div>
  )
}

/** Above the answer: the beats under one line, closed until opened. */
export function BeatsDisclosure({ beats, end, time = true }: { beats: Beat[]; end: number; /** Say how long it took (left out where it is said already). */ time?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!beats.length) return null
  return (
    <div className="sa-disclosure" data-copy="skip">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="sa-label sa-disclosure__summary">
        <Icon icon="lucide:chevron-right" />
        {beats.length > 0 && beats.every((b) => b.agent === 'workbench') ? 'What it did' : 'How it was worked out'}
        <span className="sa-disclosure__meta">· {beats.length} step{beats.length === 1 ? '' : 's'}{time ? ` · ${Math.max(1, Math.round((end - beats[0].at) / 1000))} s` : ''}</span>
      </button>
      {open && <div className="sa-disclosure__panel sa-beats-panel"><BeatRows beats={beats} live={false} end={end} /></div>}
    </div>
  )
}
