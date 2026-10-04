// THE ARTIFACTS — on the right: what the work produced and decided. A decision record (the decision, the options
// considered, the path chosen, the reasoning, the data it rested on, who approved), a file, a report, a plan — each
// immutable and versioned, linked to the step that made it.

import { Icon } from '@iconify/react'

export interface Artifact {
  id: string
  kind: 'decision' | 'file' | 'report' | 'plan' | string
  title: string
  at: string
  by?: string
  /** The step that made it. */
  step?: { block: string; step: number }
  version?: number
  status?: string
  summary?: string
}

const ICON: Record<string, string> = { decision: 'lucide:gavel', file: 'lucide:file', report: 'lucide:file-text', plan: 'lucide:list-checks' }

export default function Artifacts({ items, onOpen, onReveal, empty }: { items: Artifact[]; onOpen?: (a: Artifact) => void; onReveal?: (block: string) => void; empty?: string }) {
  if (!items.length) return <p className="sa-note sa-artifacts__empty">{empty ?? 'Nothing decided or made yet. Decisions and files from this work appear here.'}</p>
  return (
    <ul className="sa-artifacts__list">
      {items.map((a) => (
        <li key={a.id} className="sa-artifact" data-kind={a.kind}>
          <button className="sa-artifact__main" onClick={() => onOpen?.(a)} title={a.summary ?? a.title}>
            <Icon icon={ICON[a.kind] ?? 'lucide:package'} />
            <span className="sa-artifact__title">{a.title}</span>
            {a.status && <span className="sa-pill" data-state={a.status === 'approved' ? 'ok' : a.status === 'pending' ? 'warning' : undefined}>{a.status}</span>}
          </button>
          <div className="sa-artifact__meta">
            {new Date(a.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
            {a.by && <> · {a.by.replace(/^(email|user):/, '')}</>}
            {a.version && a.version > 1 && <> · v{a.version}</>}
            {a.step && <> · <button className="sa-block__link" onClick={() => onReveal?.(a.step!.block)}>step {a.step.step}</button></>}
          </div>
          {a.summary && <p className="sa-note sa-artifact__summary">{a.summary}</p>}
        </li>
      ))}
    </ul>
  )
}
