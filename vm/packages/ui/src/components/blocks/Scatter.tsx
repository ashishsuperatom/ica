// Two figures per thing, one point each (spend against on-time delivery), coloured by its group's meaning; an axis may
// be logarithmic (spend spans orders of magnitude). A point opens its row (rowMove).

import ReactECharts from '../../lib/echarts'
import { Section } from '../ui/Section'
import { paint, STATE_ACCENT, chartTheme, type Accent } from '../../design/index'
import { useFormat } from '../../lib/formats'
import type { Block, Series } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

const SERIES_ACCENT: Accent[] = ['series-1', 'series-2', 'series-3', 'warn', 'win']
const colourOf = (s: Series, i: number): string => paint(s.state ? STATE_ACCENT[s.state] : SERIES_ACCENT[i % SERIES_ACCENT.length])

export default function Scatter({ block, onRow }: { block: Extract<Block, { type: 'scatter' }> } & BlockCallbacks) {
  const { fmt, short } = useFormat()
  const t = chartTheme()
  const groups = block.groups.length ? block.groups : [{ key: '', label: block.title }]
  const inGroup = (g: Series) => block.points.filter((p) => (g.key ? p.group === g.key : true))
  const option = {
    animation: false,
    grid: { left: 4, right: 12, top: 28, bottom: 4, containLabel: true },
    legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { ...t.fontSmall, color: t.muted } },
    tooltip: { trigger: 'item', ...t.tooltip, formatter: (p: { data: [number, number, string] }) => `${p.data[2]}<br/>${block.x.label} ${fmt(p.data[0], block.x.unit)} · ${block.y.label} ${fmt(p.data[1], block.y.unit)}` },
    xAxis: { type: block.x.log ? 'log' : 'value', name: block.x.label, nameLocation: 'middle', nameGap: 24, nameTextStyle: { ...t.fontSmall, color: t.faint }, ...(block.x.min != null ? { min: block.x.min } : {}), ...(block.x.max != null ? { max: block.x.max } : {}),
      axisLabel: { ...t.fontSmall, color: t.faint, hideOverlap: true, formatter: (v: number) => short(v, block.x.unit) }, splitLine: { lineStyle: { color: t.line } } },
    yAxis: { type: 'value', name: block.y.label, nameTextStyle: { ...t.fontSmall, color: t.faint }, ...(block.y.min != null ? { min: block.y.min } : {}), ...(block.y.max != null ? { max: block.y.max } : {}),
      axisLabel: { ...t.fontSmall, color: t.faint, formatter: (v: number) => short(v, block.y.unit) }, splitLine: { lineStyle: { color: t.line } } },
    series: groups.map((g, i) => ({ name: g.label, type: 'scatter', symbolSize: 9, itemStyle: { color: colourOf(g, i), opacity: 0.75 }, data: inGroup(g).map((p) => [p.x, p.y, p.label, p.key]) })),
  }
  const move = block.rowMove
  const onEvents = move ? { click: (e: { data?: [number, number, string, string] }) => { if (e.data) onRow?.(move, { key: e.data[3], label: e.data[2] }) } } : undefined
  return (
    <Section icon="lucide:chart-scatter" accent="series-1" title={block.title} note={block.note}>
      <div className="sa-chart" data-copy="skip"><ReactECharts option={option} style={{ height: 320, width: '100%' }} notMerge onEvents={onEvents} /></div>
    </Section>
  )
}
