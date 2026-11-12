// Two figures per thing, one point each (spend against on-time delivery), coloured by its group's meaning; an axis may
// be logarithmic (spend spans orders of magnitude). A point opens its row (rowMove). Drawn plainly (a Part, no card);
// one view at a time: it opens on the chart, its table behind the quiet view button (useOneView).

import ReactECharts from '../../lib/echarts'
import { Part } from '../ui/Section'
import { useOneView, type ViewOption } from '../ui/ViewToggle'
import { ChartTable } from './ChartTable'
import { paint, STATE_ACCENT, chartTheme, type Accent } from '../../design/index'
import { useFormat } from '../../lib/formats'
import type { Block, Series } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

const SERIES_ACCENT: Accent[] = ['series-1', 'series-2', 'series-3', 'warn', 'win']
const colourOf = (s: Series, i: number): string => paint(s.state ? STATE_ACCENT[s.state] : SERIES_ACCENT[i % SERIES_ACCENT.length])

const CHART: ViewOption<'chart'> = { value: 'chart', icon: 'lucide:chart-scatter', label: 'Chart' }

export default function Scatter({ block, onRow }: { block: Extract<Block, { type: 'scatter' }> } & BlockCallbacks) {
  const { fmt, short } = useFormat()
  const [view, toggle] = useOneView(`scatter.${block.title}`, [CHART])
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
    <Part title={block.title} note={block.note} tools={toggle}>
      {view === 'table'
        ? <ChartTable axis="" empty="Nothing in scope" columns={[{ key: 'x', label: block.x.label, unit: block.x.unit }, { key: 'y', label: block.y.label, unit: block.y.unit }, ...(block.groups.length ? [{ key: 'group', label: 'Group', unit: 'text' }] : [])]}
            rows={block.points.map((p) => ({ label: p.label, values: { x: p.x, y: p.y, group: block.groups.find((g) => g.key === p.group)?.label ?? p.group ?? '' }, ...(move ? { open: () => onRow?.(move, { key: p.key, label: p.label }) } : {}) }))} />
        : <div className="sa-chart" data-copy="skip"><ReactECharts option={option} style={{ height: 320, width: '100%' }} notMerge onEvents={onEvents} /></div>}
    </Part>
  )
}
