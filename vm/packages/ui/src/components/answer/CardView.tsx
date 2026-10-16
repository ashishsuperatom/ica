// ONE CARD (answer/cards.ts, the contract): its rows — wherever it is put: inside an answer, inside a program's block,
// inside a UI. A card hinted as a chart (:::bar, :::line, :::pie) is drawn as that chart from its rows (answer/chart.ts),
// its table a click away; one whose rows do not make a chart is drawn as its table.
import { useState } from 'react'
import { BlockView } from '../blocks'
import { Section } from '../ui/Section'
import { EChart } from '../ui/EChart'
import { chartKind, chartOption } from '../../answer/chart'
import type { Card } from '../../answer/cards'

const table = (card: Card) => <BlockView block={{ type: 'table', title: card.title ?? '', columns: card.columns, rows: card.rows }} />

export function CardView({ card }: { card: Card }) {
  const kind = chartKind(card.hint)
  const option = kind ? chartOption(card, kind) : null
  const [asTable, setAsTable] = useState(false)
  if (!option) return table(card)
  if (asTable) return <div className="sa-stack">{table(card)}<button className="sa-btn sa-btn--link" style={{ alignSelf: 'flex-start' }} onClick={() => setAsTable(false)}>Show as a chart</button></div>
  return (
    <Section icon={kind === 'line' ? 'lucide:chart-line' : kind === 'pie' ? 'lucide:chart-pie' : 'lucide:chart-column'} accent="series-1" title={card.title ?? ''}
      note={`${card.rows.length} row${card.rows.length === 1 ? '' : 's'}`}
      actions={<button className="sa-btn sa-btn--link" onClick={() => setAsTable(true)}>Show the rows</button>}>
      <div className="sa-section__chart"><EChart option={option} height={kind === 'pie' ? 300 : 280} /></div>
    </Section>
  )
}
