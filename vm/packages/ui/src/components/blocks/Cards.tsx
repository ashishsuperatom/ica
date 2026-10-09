// Cards side by side: each a thing to act on — its tone's icon tile, its title, the figure, the line beneath, and where
// it leads (its own move, else the block's; the button names the action). The ⓘ on a card opens what it means and how
// it is worked out, in place.

import { useState } from 'react'
import { Icon } from '../ui/Icon'
import { useFormat } from '../../lib/formats'
import type { Block, CardItem } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

const TONE_ICON: Record<string, string> = { critical: 'lucide:octagon-alert', warning: 'lucide:triangle-alert', ok: 'lucide:circle-check', info: 'lucide:info' }

function Card({ item, onOpen }: { item: CardItem; onOpen?: () => void }) {
  const { fmt } = useFormat()
  const [why, setWhy] = useState(false)
  return (
    <div className="sa-card sa-act-card" data-tone={item.tone ?? 'info'} data-copy="line">
      <div className="sa-act-card__head">
        <span className="sa-act-card__tile"><Icon icon={item.icon ?? TONE_ICON[item.tone ?? 'info']} /></span>
        <span className="sa-act-card__title">{item.title}</span>
        {item.about && <button type="button" className="sa-icon-btn" aria-expanded={why} title="What is this?" onClick={() => setWhy(!why)}><Icon icon="lucide:info" /></button>}
      </div>
      <div className="sa-figure sa-act-card__value">{fmt(item.value, item.unit)}</div>
      {item.sub && <div className="sa-act-card__sub">{item.sub}</div>}
      {why && item.about && (
        <div className="sa-about" data-copy="skip">
          <p><b>What this means.</b> {item.about.means}</p>
          {item.about.calc && <p><b>How it is worked out.</b> {item.about.calc}</p>}
        </div>
      )}
      {onOpen && <button type="button" className="sa-btn sa-btn--link sa-act-card__action" onClick={onOpen}>{item.action ?? 'Open'} <Icon icon="lucide:arrow-right" /></button>}
    </div>
  )
}

export default function Cards({ block, onRow }: { block: Extract<Block, { type: 'cards' }> } & BlockCallbacks) {
  if (!block.items.length) return null
  return (
    <div className="sa-act-cards" aria-label={block.title}>
      {block.title && <div className="sa-label sa-act-cards__title">{block.title}</div>}
      <div className="sa-act-cards__grid">
        {block.items.map((it) => {
          const move = it.move ?? block.rowMove
          return <Card key={it.key} item={it} onOpen={move && onRow ? () => onRow(move, { key: it.key, label: it.title }) : undefined} />
        })}
      </div>
    </div>
  )
}
