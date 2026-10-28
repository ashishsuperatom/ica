// PATHS FROM HERE — at the end of every step, so no step is a dead end: what the step's programs offer (their option
// functions), one strip. Every path is an intent the session takes (<Intent>), so the one listener sends it.

import { Intent, type ScreenIntent } from '../../intent'
import { MovePill } from '../question/NextMoves'

export interface Offered { label: string; intent: ScreenIntent }

export default function Paths({ block, offered }: { block: string; offered: Offered[] }) {
  if (!offered.length) return null   // nothing to offer: no strip (an empty one still takes the stack's gaps)
  return (
    <div className="sa-paths" data-copy="skip">
      <div className="sa-next" aria-label="Next moves">
        {offered.map((a, i) => <Intent key={i} {...a.intent} block={block} className="sa-btn sa-btn--pill" title={a.label}><MovePill label={a.label} /></Intent>)}
      </div>
    </div>
  )
}
