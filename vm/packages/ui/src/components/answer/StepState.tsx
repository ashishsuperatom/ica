// STEP STATE — under a step's answer: what the session has established at this step (its thread's facts), the ones this
// step established or changed marked. Nothing when nothing is established.

import { Icon } from '../ui/Icon'

export default function StepState({ facts, added }: { facts: Record<string, string | number | boolean>; added: string[] }) {
  const names = Object.keys(facts)
  if (!names.length) return null
  const fresh = new Set(added)
  return (
    <div className="sa-step-state" data-copy="skip" aria-label="What this step has established">
      <Icon icon="lucide:map-pin" className="sa-step-state__icon" />
      {names.map((n) => {
        const v = facts[n] === true ? 'yes' : facts[n] === false ? 'no' : String(facts[n])
        return <span key={n} className="sa-step-state__fact" data-new={fresh.has(n) || undefined} title={`${n}: ${v}${fresh.has(n) ? ' — established here' : ''}`}><b>{n}</b> {v}</span>
      })}
    </div>
  )
}
