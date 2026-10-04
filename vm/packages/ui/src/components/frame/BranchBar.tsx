// The branches that fork from the step above: one is on the visible path, the others are a click away.

import { Icon } from '@iconify/react'

export interface Sibling { id: string; label: string; cause?: string; active: boolean }

export default function BranchBar({ siblings, onSwitch }: { siblings: Sibling[]; onSwitch: (id: string) => void }) {
  return (
    <div role="tablist" aria-label="Branches from here" className="sa-branchbar">
      <Icon icon="lucide:git-branch" />
      <span className="sa-branchbar__word">Branches here:</span>
      {siblings.map((s, i) => (
        <button key={s.id} role="tab" aria-selected={s.active} className="sa-branch" data-active={s.active} title={s.cause} onClick={() => !s.active && onSwitch(s.id)}>
          {i + 1}. {s.label}{s.cause ? ` — ${s.cause}` : ''}
        </button>
      ))}
    </div>
  )
}
