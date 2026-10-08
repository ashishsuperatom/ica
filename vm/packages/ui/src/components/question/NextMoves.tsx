// The next moves from a view: each a pill that opens what it says in a new step. What a move sends is the caller's (an
// <Intent> in a session, a thread's open in a dashboard), so every surface draws them the same.

import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'

export function MovePill({ label, children }: { label: string; children?: ReactNode }) {
  return <><span className="sa-btn__text">{children ?? label}</span><Icon icon="mdi:arrow-right" className="sa-btn__icon" /></>
}

export default function NextMoves<T extends { label: string }>({ moves, render }: { moves: T[]; render: (move: T, i: number, inner: ReactNode) => ReactNode }) {
  if (!moves.length) return null
  return <div className="sa-next" aria-label="Next moves" data-copy="skip">{moves.map((m, i) => render(m, i, <MovePill label={m.label} />))}</div>
}
