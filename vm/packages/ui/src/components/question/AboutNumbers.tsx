// "About these numbers": what an answer stands on — its notes, the window and span used, the settings and assumptions in
// force, today, and what it read — collapsed under one quiet line with how many notes and how long it took.

import { useState } from 'react'
import { Icon } from '../ui/Icon'
import { fmt } from '../../lib/format'

export interface AboutFacts { used?: any; notes?: string[]; asked?: unknown[]; ms?: number; today?: string }

export default function AboutNumbers({ about: a }: { about?: AboutFacts | null }) {
  const [open, setOpen] = useState(false)
  if (!a) return null
  const used = a.used ?? {}
  const notes = a.notes ?? []
  const rows: Array<[string, string]> = [
    ...(used.window ? [['Window', String(used.window)] as [string, string]] : []),
    ...(used.span ? [['Span', `${fmt(used.span.from, 'date')} → ${fmt(used.span.to, 'date')} (exclusive)`] as [string, string]] : []),
    ...Object.entries(used.settings ?? {}).map(([k, v]) => [`Setting: ${k}`, Array.isArray(v) ? v.map(String).join(', ') : fmt(v, undefined)] as [string, string]),
    ...Object.entries(used.assumptions ?? {}).map(([k, v]) => [`Assumed: ${k}`, v === null ? 'not set' : String(v)] as [string, string]),
    ...(a.today ? [['Today', fmt(a.today, 'date')] as [string, string]] : []),
    // What the answer read: the programs it ran (program and arguments), else the graph.
    ...(a.asked ?? []).map((x: any, i: number): [string, string] => { const q = x && typeof x === 'object' ? x.question : null
      return q && typeof q.program === 'string' ? [`Read ${i + 1}`, `${q.program} ${Array.isArray(q.args) ? q.args.join(' ') : ''}`] : [`Read ${i + 1}`, 'the graph'] }),
  ]
  return (
    <div className="sa-disclosure" data-copy="skip">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="sa-label sa-disclosure__summary">
        <Icon icon="lucide:chevron-right" />
        About these numbers
        <span className="sa-disclosure__meta">· {notes.length} note{notes.length === 1 ? '' : 's'}{a.ms ? ` · ${a.ms} ms` : ''}</span>
      </button>
      {open && (
        <div className="sa-card sa-disclosure__panel">
          {notes.length > 0 && <ul className="sa-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <dl className="sa-dl sa-dl--tight">
            {rows.map(([k, v]) => <div key={k} className="sa-dl__row"><dt className="sa-dl__key">{k}</dt><dd className="sa-dl__value">{v}</dd></div>)}
          </dl>
        </div>
      )}
    </div>
  )
}
