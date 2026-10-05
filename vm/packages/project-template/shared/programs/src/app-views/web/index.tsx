// The next moves the application offers from this view — each an <Intent> calling move with its ops, in a new step.
import { Intent } from '@superatom/ui'

type Next = { label: string; ops: unknown[] }

export function NextMoves({ slice }: { slice?: { next: Next[] } }) {
  if (!slice?.next?.length) return null
  return (
    <div className="sa-paths__offered">
      {slice.next.map((n, i) => <Intent key={i} call={{ package: 'view', fn: 'move', params: { ops: n.ops as any } }} to="new" className="sa-btn">{n.label}</Intent>)}
    </div>
  )
}
