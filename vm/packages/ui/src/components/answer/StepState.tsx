// STEP STATE — under a step's answer: what the session has established at this step (its thread's facts, the ones this
// step established or changed marked), and the next questions the step offered — one click asks one. Nothing when the
// step has neither.

import { Icon } from '../ui/Icon'
import { MovePill } from '../question/NextMoves'

export default function StepState({ facts, added, options = [], onAsk }: { facts: Record<string, string | number | boolean>; added: string[]; options?: string[]; onAsk?: (text: string) => void }) {
  const names = Object.keys(facts)
  if (!names.length && !options.length) return null
  const fresh = new Set(added)
  return (
    <div className="sa-paths" data-copy="skip">
      {!!names.length && (
        <div className="sa-step-state" aria-label="What this step has established">
          <Icon icon="lucide:map-pin" className="sa-step-state__icon" />
          {names.map((n) => {
            const v = facts[n] === true ? 'yes' : facts[n] === false ? 'no' : String(facts[n])
            return <span key={n} className="sa-step-state__fact" data-new={fresh.has(n) || undefined} title={`${n}: ${v}${fresh.has(n) ? ' — established here' : ''}`}><b>{n}</b> {v}</span>
          })}
        </div>
      )}
      {!!options.length && onAsk && (
        <div className="sa-next" aria-label="Next questions">
          {options.map((q) => <button key={q} type="button" className="sa-btn sa-btn--pill" title={q} onClick={() => onAsk(q)}><MovePill label={q} /></button>)}
        </div>
      )}
    </div>
  )
}
