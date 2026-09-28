// "About these numbers": the notes, the settings and assumptions used, the span — collapsed, and the time it took.

import { useState } from 'react'
import { Icon } from '@iconify/react'
import { fmt } from '@/lib/format'
import type { Answer } from '@/lib/wire'

export default function About({ answer: a }: { answer: Answer }) {
  const [open, setOpen] = useState(false)
  const settings = Object.entries(a.used.settings)
  const assumptions = Object.entries(a.used.assumptions)
  const rows: Array<[string, string]> = [
    ...(a.used.window ? [['Window', a.used.window] as [string, string]] : []),
    ...(a.used.span ? [['Span', `${fmt(a.used.span.from, 'date')} → ${fmt(a.used.span.to, 'date')} (exclusive)`] as [string, string]] : []),
    ...settings.map(([k, v]) => [`Setting: ${k}`, Array.isArray(v) ? v.map(String).join(', ') : fmt(v, undefined)] as [string, string]),
    ...assumptions.map(([k, v]) => [`Assumed: ${k}`, v === null ? 'not set' : String(v)] as [string, string]),
    ...(a.today ? [['Today', fmt(a.today, 'date')] as [string, string]] : []),
    // What the answer read: the domain programs it ran (program and arguments), or, for a view not yet moved, the graph.
    ...a.asked.map((x, i): [string, string] => { const q = (x && typeof x === 'object' ? (x as Record<string, unknown>).question : null) as Record<string, unknown> | null
      return q && typeof q.program === 'string' ? [`Read ${i + 1}`, `${q.program} ${Array.isArray(q.args) ? q.args.join(' ') : ''}`] : [`Read ${i + 1}`, 'the graph'] }),
  ]
  return (
    <div className="sa-disclosure" data-copy="skip">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="sa-label sa-disclosure__summary">
        <Icon icon="lucide:chevron-right" />
        About these numbers
        <span className="sa-disclosure__meta">· {a.notes.length} note{a.notes.length === 1 ? '' : 's'} · {a.ms} ms</span>
      </button>
      {open && (
        <div className="sa-card sa-disclosure__panel">
          {a.notes.length > 0 && <ul className="sa-notes">{a.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <dl className="sa-dl sa-dl--tight">
            {rows.map(([k, v]) => (
              <div key={k} className="sa-dl__row"><dt className="sa-dl__key">{k}</dt><dd className="sa-dl__value">{v}</dd></div>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}
