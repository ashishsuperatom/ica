// PATHS FROM HERE — at the end of every step, so no step is a dead end: what the decision memory has learned people do
// from a situation like this one (with why, and how it went), what the step's programs offer, and asking in words.
//
//   learned · similar   its paths first, one click each
//   learned · changed   its paths, with what has moved since they were learned, and a word to check first
//   not learned         the programs' actions and asking; this step is remembered, so it can become memory
//
// Every path is an intent the session takes (<Intent>), so the one listener sends it.

import { Icon } from '../ui/Icon'
import { Intent, type ScreenIntent } from '../../intent'
import { MovePill } from '../question/NextMoves'

export interface LearnedPath { id: string; label: string; reasoning: string; intent: ScreenIntent & { text?: string }; record?: { taken: number; succeeded: number; failed: number } }
export interface Recognised {
  mode: 'learned-similar' | 'learned-changed' | 'not-learned'
  why: string
  matches: { id: string; title: string; description: string; world: { drift: { figure: string; now: number; min: number; max: number }[]; thin: boolean }; paths: LearnedPath[] }[]
}
export interface Offered { label: string; intent: ScreenIntent }

const recordWords = (r?: LearnedPath['record']) => !r || !r.taken ? 'not taken yet' : `taken ${r.taken}×${r.succeeded ? ` · ${r.succeeded} went well` : ''}${r.failed ? ` · ${r.failed} did not` : ''}`

export default function Paths({ block, recognised, offered, onAsk }: { block: string; recognised?: Recognised | null; offered: Offered[]; onAsk?: (text: string) => void }) {
  const best = recognised && recognised.mode !== 'not-learned' ? recognised.matches[0] : null
  return (
    <div className="sa-paths" data-copy="skip">
      {best && (
        <div className="sa-paths__learned" data-mode={recognised!.mode}>
          <div className="sa-paths__head">
            <Icon icon={recognised!.mode === 'learned-similar' ? 'lucide:route' : 'lucide:triangle-alert'} />
            <span className="sa-label">{recognised!.mode === 'learned-similar' ? 'Paths taken from here before' : 'Paths taken before — the situation has moved'}</span>
            <span className="sa-paths__why" title={best.description}>{best.title}</span>
          </div>
          {recognised!.mode === 'learned-changed' && <p className="sa-note sa-paths__note">{recognised!.why}. Check with the agent before taking one.</p>}
          <div className="sa-paths__list">
            {best.paths.map((p) => p.intent.text
              ? <button key={p.id} className="sa-path" title={p.reasoning} onClick={() => onAsk?.(p.intent.text!)}><span className="sa-path__label">{p.label}</span><span className="sa-path__meta">{recordWords(p.record)}</span><span className="sa-path__why">{p.reasoning}</span></button>
              : <Intent key={p.id} {...(p.intent as ScreenIntent)} block={block} className="sa-path" title={p.reasoning}><span className="sa-path__label">{p.label}</span><span className="sa-path__meta">{recordWords(p.record)}</span><span className="sa-path__why">{p.reasoning}</span></Intent>)}
          </div>
        </div>
      )}
      {offered.length > 0 && (
        <div className="sa-next" aria-label="Next moves">
          {offered.map((a, i) => <Intent key={i} {...a.intent} block={block} className="sa-btn sa-btn--pill" title={a.label}><MovePill label={a.label} /></Intent>)}
        </div>
      )}
    </div>
  )
}
