// A CASE'S TRACK — the steps something goes through (a requisition to an award; a plan to its review), in order: each
// with its label, what it holds now (`says`: the decision made, or what it will decide) and a line on what that means
// (`means`), marked done, the one being looked at (current), still ahead, or skipped. The marks sit on one line joined
// in order; the words beneath wrap, never cut. A step that can be opened is the caller's to wrap (an <Intent> in a
// session), so every surface draws a track the same.

import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'

export type TrackState = 'done' | 'current' | 'ahead' | 'skipped'
export interface TrackStep { key: string; label: string; says?: string; means?: string; state: TrackState }

export default function Track<T extends TrackStep>({ steps, label = 'Steps', render }: {
  steps: T[]
  label?: string
  /** Wraps a step that can be opened (its control); left out, or returning the inner part, the step is only shown. */
  render?: (step: T, inner: ReactNode) => ReactNode
}) {
  if (!steps.length) return null
  return (
    <div className="sa-track-wrap" data-copy="skip"><ol className="sa-track" aria-label={label}>
      {steps.map((s, i) => {
        const inner = (
          <span className="sa-track__body">
            <span className="sa-track__mark" aria-hidden>{s.state === 'done' ? <Icon icon="lucide:check" /> : s.state === 'skipped' ? '–' : i + 1}</span>
            <span className="sa-track__text">
              <span className="sa-track__label">{s.label}</span>
              {s.says && <span className="sa-track__says">{s.says}</span>}
              {s.means && <span className="sa-track__means">{s.means}</span>}
            </span>
          </span>
        )
        return (
          <li key={s.key} className="sa-track__step" data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
            {render ? render(s, inner) : inner}
          </li>
        )
      })}
    </ol></div>
  )
}
