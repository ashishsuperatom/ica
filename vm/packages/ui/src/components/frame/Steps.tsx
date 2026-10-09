// A thread as a page: the steps on the current path, the first at the top and the newest at the bottom, a hairline with
// the time between them, and a branch bar above any step whose parent has more than one child (the fork), so the other
// branches are a click away. Shift+↑/↓ moves between steps. What each step shows is the caller's.

import type { ReactNode } from 'react'
import { useBlockKeys } from './navigation'
import BranchBar, { type Sibling } from './BranchBar'

export function Separator({ at }: { at: string }) {
  const d = new Date(at)
  const time = Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return (
    <div className="sa-separator" aria-hidden>
      <span className="sa-separator__line" />
      <span className="sa-separator__time"><span className="sa-separator__dot" />{time}</span>
      <span className="sa-separator__line sa-separator__line--r" />
    </div>
  )
}

export interface StepItem { id: string; at: string; siblings?: Sibling[]; node: ReactNode }

export default function Steps({ items, onSwitch, empty, after, before }: { items: StepItem[]; onSwitch: (id: string) => void; empty?: ReactNode; after?: ReactNode; /** Above the first step, in the same column (a page's greeting). */ before?: ReactNode }) {
  useBlockKeys(items.map((b) => b.id))
  return (
    <div className="sa-thread">
      <div className="sa-thread__column thread-blocks">
        {before}
        {items.length === 0 && empty}
        {items.map((s, i) => (
          <div key={s.id} className="sa-thread__item">
            {i > 0 && <Separator at={s.at} />}
            {s.siblings && s.siblings.length > 1 && <BranchBar siblings={s.siblings} onSwitch={onSwitch} />}
            {s.node}
          </div>
        ))}
      </div>
      {after}
    </div>
  )
}
