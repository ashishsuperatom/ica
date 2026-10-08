// What a card says when it has nothing to say: not an error and not a loading state. A quiet mark, what is
// missing, and where it would come from, centred in whatever space it is given.

import { Icon } from './Icon'
import type { ReactNode } from 'react'

export default function Nothing({ icon = 'lucide:circle-dashed', children, hint, height }: {
  icon?: string
  children: ReactNode
  /** What would put something here, when a reader could do it themselves. */
  hint?: ReactNode
  /** Keeps the space a chart would have taken, so a card does not change size when its figures arrive. */
  height?: number
}) {
  return (
    <div className="sa-empty" style={height ? { minHeight: height } : undefined}>
      <span className="sa-empty__mark" aria-hidden><Icon icon={icon} /></span>
      <span className="sa-empty__text">{children}</span>
      {hint && <span className="sa-empty__hint">{hint}</span>}
    </div>
  )
}
