// Who holds how much, largest first, and the running share: a column per row on the value axis, the cumulative share as
// a line on its own 0–100% axis. A column opens its row (rowMove). Colours and fonts from the theme; values written
// the screen's way (useFormat).

import ReactECharts from '../../lib/echarts'
import { Section } from '../ui/Section'
import { paint, chartTheme } from '../../design/index'
import { asNumber } from '../../lib/format'
import { useFormat } from '../../lib/formats'
import type { Block } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

export default function Pareto({ block, onRow }: { block: Extract<Block, { type: 'pareto' }> } & BlockCallbacks) {
  const { fmt, short } = useFormat()
  const t = chartTheme()
  const rows = [...block.rows].map((r) => ({ ...r, v: asNumber(r.value) ?? 0 })).sort((a, b) => b.v - a.v)
  const total = rows.reduce((a, r) => a + r.v, 0)
  let run = 0
  const cum = rows.map((r) => { run += r.v; return total ? (run / total) * 100 : 0 })
  const bar = paint('series-1'), line = paint('win')
  const option = {
    animation: false,
    grid: { left: 4, right: 4, top: 28, bottom: 4, containLabel: true },
    legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { ...t.fontSmall, color: t.muted }, data: ['Value', 'Cumulative %'] },
    tooltip: { trigger: 'axis', ...t.tooltip, formatter: (ps: { dataIndex: number }[]) => { const i = ps[0]?.dataIndex ?? 0; return `${rows[i]?.label}<br/>${fmt(rows[i]?.v, block.unit)} · ${cum[i]?.toFixed(1)}% so far` } },
    xAxis: { type: 'category', data: rows.map((r) => r.label), axisLabel: { ...t.fontSmall, color: t.muted, rotate: rows.length > 6 ? 35 : 0, width: 110, overflow: 'truncate', interval: 0 }, axisTick: { show: false }, axisLine: { lineStyle: { color: t.line } } },
    yAxis: [
      { type: 'value', axisLabel: { ...t.fontSmall, color: t.faint, formatter: (v: number) => short(v, block.unit) }, splitLine: { lineStyle: { color: t.line } } },
      { type: 'value', min: 0, max: 100, axisLabel: { ...t.fontSmall, color: t.faint, formatter: '{value}%' }, splitLine: { show: false } },
    ],
    series: [
      { name: 'Value', type: 'bar', barMaxWidth: 28, itemStyle: { color: bar, borderRadius: [3, 3, 0, 0] }, data: rows.map((r) => r.v) },
      { name: 'Cumulative %', type: 'line', yAxisIndex: 1, smooth: false, symbolSize: 6, lineStyle: { width: 2, color: line }, itemStyle: { color: line }, data: cum.map((c) => +c.toFixed(1)) },
    ],
  }
  const move = block.rowMove
  const onEvents = move ? { click: (e: { dataIndex?: number }) => { const r = rows[e.dataIndex ?? -1]; if (r) onRow?.(move, { key: r.key ?? r.label, label: r.label }) } } : undefined
  return (
    <Section icon="lucide:chart-column-increasing" accent="series-1" title={block.title} note={block.note}>
      <div className="sa-chart" data-copy="skip">
        <ReactECharts option={option} style={{ height: 300, width: '100%' }} notMerge onEvents={onEvents} />
      </div>
    </Section>
  )
}
