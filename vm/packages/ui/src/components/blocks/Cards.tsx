// Cards side by side: each a thing to act on — its tone's icon tile, its title, the figure, the line beneath. The whole
// card is the control: it opens where the card leads (its own move, else the block's). Its ⓘ opens what it means and
// how it is worked out, from the right (AboutDrawer).

import { useState } from 'react'
import { Icon } from '../ui/Icon'
import AboutDrawer from '../ui/AboutDrawer'
import { useFormat } from '../../lib/formats'
import type { Block, CardItem } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

const TONE_ICON: Record<string, string> = { critical: 'lucide:octagon-alert', warning: 'lucide:triangle-alert', ok: 'lucide:circle-check', info: 'lucide:info' }

function Card({ item, onOpen }: { item: CardItem; onOpen?: () => void }) {
  const { fmt } = useFormat()
  const [why, setWhy] = useState(false)
  const body = (
    <>
      <div className="sa-act-card__head">
        <span className="sa-act-card__tile"><Icon icon={item.icon ?? TONE_ICON[item.tone ?? 'info']} /></span>
        <span className="sa-act-card__title">{item.title}</span>
        {item.about && <span role="button" tabIndex={0} className="sa-icon-btn" title="What is this?" aria-label="What is this?"
          onClick={(e) => { e.stopPropagation(); setWhy(true) }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setWhy(true) } }}><Icon icon="lucide:info" /></span>}
      </div>
      <div className="sa-figure sa-act-card__value">{fmt(item.value, item.unit)}</div>
      {item.sub && <div className="sa-act-card__sub">{item.sub}</div>}
    </>
  )
  return (
    <>
      {onOpen
        ? <button type="button" className="sa-card sa-act-card sa-act-card--open" data-tone={item.tone ?? 'info'} data-copy="line" onClick={onOpen} title={item.action ?? `Open ${item.title}`}>{body}</button>
        : <div className="sa-card sa-act-card" data-tone={item.tone ?? 'info'} data-copy="line">{body}</div>}
      {why && item.about && <AboutDrawer title={item.title} about={item.about} onClose={() => setWhy(false)} />}
    </>
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
