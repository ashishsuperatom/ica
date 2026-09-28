// Headline figures as Kpi tiles: the label, the figure in its state's colour, the hint beneath.

import { Kpi } from '@/components/ui/Section'
import { STATE_ACCENT } from '@/design'
import { fmt } from '@/lib/format'
import type { Block } from '@/lib/wire'

export default function Kpis({ block }: { block: Extract<Block, { type: 'kpis' }> }) {
  if (!block.items.length) return null
  return (
    <div className="sa-kpi-grid">
      {block.items.map((k, i) => <Kpi key={i} label={k.label} value={fmt(k.value, k.unit)} foot={k.hint} accent={k.state ? STATE_ACCENT[k.state] : 'series-1'} />)}
    </div>
  )
}
