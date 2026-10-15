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

export interface StepItem { id: string; at: string; siblings?: Sibling[]; node: ReactNode; /** A program's UI: the full width, outside the thread's column. */ full?: boolean }

/** The steps as runs: consecutive column steps together, each full-width step alone (at least one run, for the empty). */
function runsOf(items: StepItem[]): { s: StepItem; i: number }[][] {
  const runs: { s: StepItem; i: number }[][] = []
  items.forEach((s, i) => { const last = runs.at(-1); if (last && !s.full && !last[0].s.full) last.push({ s, i }); else runs.push([{ s, i }]) })
  return runs.length ? runs : [[]]
}

export default function Steps({ items, onSwitch, empty, after, before, fill = false }: { items: StepItem[]; onSwitch: (id: string) => void; empty?: ReactNode; after?: ReactNode; /** Above the first step, in the same column (a page's greeting). */ before?: ReactNode; /** The last step at least a screen tall (a conversation: a question just asked can reach the top). */ fill?: boolean }) {
  useBlockKeys(items.map((b) => b.id))
  return (
    <div className="sa-thread">
      {/* the steps in order: runs of them in the column; a program's UI (full) across the whole width between them */}
      {runsOf(items).map((run, r) => (
        <div key={run[0]?.s.id ?? 'empty'} className={run[0]?.s.full ? 'sa-thread__full thread-blocks' : 'sa-thread__column thread-blocks'}>
          {r === 0 && before}
          {r === 0 && items.length === 0 && empty}
          {run.map(({ s, i }) => (
            <div key={s.id} className={`sa-thread__item${fill && i === items.length - 1 ? ' sa-thread__item--fill' : ''}`}>
              {i > 0 && <Separator at={s.at} />}
              {s.siblings && s.siblings.length > 1 && <BranchBar siblings={s.siblings} onSwitch={onSwitch} />}
              {s.node}
            </div>
          ))}
        </div>
      ))}
      {after}
    </div>
  )
}
