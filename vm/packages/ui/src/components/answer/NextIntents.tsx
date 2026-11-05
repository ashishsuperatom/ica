// WHAT TO ASK NEXT — the next intents an answer's intent node offers (docs/intent-graph.md), at the very end of the step:
// at most three, each a card large enough to take at a glance — the question, and what kind of next step it is. One is asked
// by a click, as words.

import { Icon } from '../ui/Icon'

export interface NextIntent { id: string; title: string; label: string; tag: 'asked' | 'suggested'; kind?: string | null }

/** What each kind of next intent is, said to the person. */
const KIND: Record<string, { word: string; icon: string }> = {
  asked: { word: 'Asked before', icon: 'lucide:history' },
  interpolation: { word: 'One step further', icon: 'lucide:arrow-down-right' },
  extrapolation: { word: 'What the data points to', icon: 'lucide:trending-up' },
  novelty: { word: 'Another direction', icon: 'lucide:compass' },
}

export default function NextIntents({ next, onAsk }: { next: NextIntent[]; onAsk: (text: string) => void }) {
  if (!next.length) return null
  return (
    <section className="sa-nextintents" aria-label="What to ask next" data-copy="skip">
      {next.slice(0, 3).map((n) => {
        const k = KIND[n.tag === 'asked' ? 'asked' : n.kind ?? ''] ?? KIND.asked
        return (
          <button key={n.id} type="button" className="sa-nextintents__card" title={n.title} onClick={() => onAsk(n.title)}>
            <span className="sa-nextintents__kind"><Icon icon={k.icon} />{k.word}</span>
            <span className="sa-nextintents__q">{n.label}</span>
          </button>
        )
      })}
    </section>
  )
}
