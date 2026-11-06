// ONE CARD (answer/cards.ts, the contract): its rows — wherever it is put: inside an answer, inside a program's block,
// inside a UI. A card hinted as a chart (:::bar, :::line, :::pie) is drawn as that chart from its rows (answer/chart.ts),
// its table a click away; one whose rows do not make a chart is drawn as its table.
// `reading` (in an answer): drawn to be read — a plain table (ReadingTable), a quiet chart with a caption — and Open gives
// the full one to work with (search, group, every row and measure).
import { useState } from 'react'
import { BlockView } from '../blocks'
import { Section } from '../ui/Section'
import { EChart } from '../ui/EChart'
import { chartKind, chartOption, chartData } from '../../answer/chart'
import type { Card } from '../../answer/cards'
import { ReadingTable } from './ReadingTable'

const table = (card: Card) => <BlockView block={{ type: 'table', title: card.title ?? '', columns: card.columns, rows: card.rows }} />

export function CardView({ card, reading = false }: { card: Card; reading?: boolean }) {
  const kind = chartKind(card.hint)
  const [opened, setOpened] = useState(false)
  if (reading && !opened) return <ReadingCard card={card} kind={kind} onOpen={() => setOpened(true)} />
  return <div className="sa-stack">{reading && <button type="button" className="sa-btn sa-btn--link sa-reading__close" onClick={() => setOpened(false)}>Close</button>}<FullCard card={card} kind={kind} /></div>
}

/** The card to work with: the chart (its table a click away) or the table, with every tool. */
function FullCard({ card, kind }: { card: Card; kind: ReturnType<typeof chartKind> }) {
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

/** The card as it reads in an answer: a plain table, or a quiet chart with its caption; Open for the full one. */
function ReadingCard({ card, kind, onOpen }: { card: Card; kind: ReturnType<typeof chartKind>; onOpen: () => void }) {
  const option = kind ? chartOption(card, kind, { quiet: true }) : null
  const data = kind ? chartData(card) : null
  const left = data ? data.series.filter((s) => s.unit !== data.series[0].unit || s.scale !== data.series[0].scale).length : 0
  const open = <button type="button" className="sa-btn sa-btn--link" onClick={onOpen}>Open</button>
  if (!option) return <div className="sa-reading">{<ReadingTable title={card.title} columns={card.columns} rows={card.rows} />}<div className="sa-reading__acts">{open}</div></div>
  return (
    <figure className="sa-reading sa-readchart">
      {card.title && <figcaption className="sa-readtable__title">{card.title}</figcaption>}
      <EChart option={option} height={kind === 'pie' ? 260 : 240} />
      <div className="sa-reading__acts">{card.description && <span className="sa-reading__caption">{card.description}</span>}{left > 0 && <span className="sa-reading__caption">{left} more measure{left === 1 ? '' : 's'} in another unit — open to see {left === 1 ? 'it' : 'them'}</span>}{open}</div>
    </figure>
  )
}
