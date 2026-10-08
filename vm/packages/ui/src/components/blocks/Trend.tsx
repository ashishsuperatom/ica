// Values over time: periods along the axis, one or more series — an area (the default: how much, and how it moved), a
// line (levels, such as prices) or columns (stacked amounts per period). A period that names a window (rowWindow)
// narrows the view to it when clicked. Colours from the series' meaning, else the series palette; values written the
// screen's way (useFormat).

import ReactECharts from '../../lib/echarts'
import { Section } from '../ui/Section'
import TimeColumns from '../ui/TimeColumns'
import { ACCENT, STATE_ACCENT, paint, chartTheme, type Accent } from '../../design/index'
import { asNumber, month } from '../../lib/format'
import { useFormat } from '../../lib/formats'
import type { Block, Series } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

const SERIES_ACCENT: Accent[] = ['series-1', 'series-2', 'series-3', 'warn', 'win']
const colourOf = (s: Series, i: number): string => paint(s.state ? STATE_ACCENT[s.state] : SERIES_ACCENT[i % SERIES_ACCENT.length])

export default function Trend({ block, onRowWindow }: { block: Extract<Block, { type: 'trend' }> } & BlockCallbacks) {
  const { fmt, short } = useFormat()
  const label = (p: string) => (/^\d{4}-\d{2}$/.test(p) ? month(p) : p)
  const values = (p: string, k: string) => asNumber(block.values[p]?.[k]) ?? 0
  const win = block.rowWindow
  const head = { icon: 'lucide:activity', accent: 'series-1' as Accent, title: block.title, note: block.note }
  if (block.draw === 'columns') {
    return (
      <Section {...head}>
        <TimeColumns periods={block.periods} series={block.series.map((s, i) => ({ key: s.key, label: s.label, color: colourOf(s, i) }))} label={label}
          values={Object.fromEntries(block.periods.map((p) => [p, Object.fromEntries(block.series.map((s) => [s.key, values(p, s.key)]))]))} format={(v) => short(v, block.unit)} />
      </Section>
    )
  }
  const t = chartTheme()
  const area = (block.draw ?? 'area') === 'area'
  const option = {
    animation: false,
    grid: { left: 4, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', ...t.tooltip, valueFormatter: (v: number) => fmt(v, block.unit) },
    xAxis: { type: 'category', boundaryGap: false, data: block.periods.map(label), axisLabel: { ...t.fontSmall, color: t.faint, hideOverlap: true }, axisTick: { show: false }, axisLine: { lineStyle: { color: t.line } } },
    yAxis: { type: 'value', scale: !area, axisLabel: { hideOverlap: true, ...t.fontSmall, color: t.faint, formatter: (v: number) => short(v, block.unit) }, splitLine: { lineStyle: { color: t.line } } },
    series: block.series.map((s, i) => ({
      name: s.label, type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2, color: colourOf(s, i) }, itemStyle: { color: colourOf(s, i) },
      ...(area ? { areaStyle: { color: colourOf(s, i), opacity: 0.18 } } : {}),
      data: block.periods.map((p) => values(p, s.key)),
    })),
  }
  const onEvents = win ? { click: (e: { dataIndex?: number }) => { const p = block.periods[e.dataIndex ?? -1]; if (p) onRowWindow?.(win.kind, p) } } : undefined
  return (
    <Section {...head}>
      <div className="sa-chart">
        {block.series.length > 1 && (
          <div className="sa-chart-legend sa-chart-legend--wrap" data-copy="skip">
            {block.series.map((s, i) => <span key={s.key} className="sa-chart-legend__item"><span className="sa-chart-legend__swatch" style={{ background: colourOf(s, i) }} /><span className="sa-chart-legend__text">{s.label}</span></span>)}
          </div>
        )}
        <ReactECharts option={option} style={{ height: 260, width: '100%' }} notMerge onEvents={onEvents} />
      </div>
    </Section>
  )
}
