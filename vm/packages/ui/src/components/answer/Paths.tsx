// PATHS FROM HERE — at the end of every step, so no step is a dead end: what the step's programs offer (their option
// functions) and the next intents its answer's intent node offers (docs/intent-graph.md), one strip. A program's path is
// an intent the session takes (<Intent>), so the one listener sends it; a next intent is asked, as words.

import { Intent, type ScreenIntent } from '../../intent'
import { MovePill } from '../question/NextMoves'

export interface Offered { label: string; intent: ScreenIntent }

/** A next intent: its label (said from what is there), and the words that ask it. */
export interface NextAsk { label: string; text: string; /** A suggested one's kind (interpolation, extrapolation, novelty). */ kind?: string | null }

/** What each kind of suggested next question is, said to the person. */
const KIND_WORD: Record<string, string> = { interpolation: 'One step further', extrapolation: 'What the data points to', novelty: 'Another direction' }

export default function Paths({ block, offered, asks = [], onAsk }: { block: string; offered: Offered[]; asks?: NextAsk[]; onAsk?: (text: string) => void }) {
  const questions = onAsk ? asks : []
  if (!offered.length && !questions.length) return null   // nothing to offer: no strip (an empty one still takes the stack's gaps)
  return (
    <div className="sa-paths" data-copy="skip">
      <div className="sa-next" aria-label="Next moves">
        {offered.map((a, i) => <Intent key={i} {...a.intent} block={block} className="sa-btn sa-btn--pill" title={a.label}><MovePill label={a.label} /></Intent>)}
        {questions.map((q, i) => <button key={`q${i}`} type="button" className="sa-btn sa-btn--pill" title={q.kind ? `${KIND_WORD[q.kind] ?? q.kind}: ${q.text}` : q.text} onClick={() => onAsk!(q.text)}><MovePill label={q.label} /></button>)}
      </div>
    </div>
  )
}
