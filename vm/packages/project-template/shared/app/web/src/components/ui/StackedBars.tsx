// Horizontal stacked bars in the design system: Inter, faint grid, the meaning colours, rounded ends (slob's
// StackedBars). The chart's colours, fonts and tooltip come from the chart theme, which reads the tokens; a
// `marker` series is drawn as a line across the row (a budget, a target) rather than a bar.

import ReactECharts from '@/lib/echarts'
import { chartTheme, read } from '@/design'
import { setHighlight } from '@/lib/highlight'
import Nothing from './Nothing'
import type { ReactNode } from 'react'

export interface Series {
  key: string
  label: string
  /** A design token, e.g. var(--series-2). Resolved at render, since the chart draws on a canvas. */
  color: string
  /** Drawn as a mark across the row rather than a bar: a budget, a target. */
  marker?: boolean
}

const token = (v: string) => (v.startsWith('var(') ? read(v.slice(4, -1)) || '#94a3b8' : v)

export default function StackedBars({ rows, labelKey, series, rowHeight = 30, onSelect, colorOf, channel, empty = 'Nothing to chart yet', format }: {
  rows: Array<Record<string, unknown>>
  labelKey: string
  series: Series[]
  rowHeight?: number
  onSelect?: (label: string) => void
  /** A colour per bar rather than per series, for a chart whose rows are the categories themselves. Single series only. */
  colorOf?: (row: Record<string, unknown>) => string
  /** Points at the same thing as the figures beside it (lib/highlight). */
  channel?: string
  empty?: ReactNode
  format: (v: number) => string
}) {
  const t = chartTheme()
  const money = format
  const ordered = [...rows].reverse() // largest at the top
  const bars = series.filter((s) => !s.marker)
  const markers = series.filter((s) => s.marker)
  const n = (r: Record<string, unknown>, k: string) => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : 0)

  const option = {
    animationDuration: 300,
    grid: { left: 4, right: 72, top: 8, bottom: 8, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(16,24,40,0.04)' } },
      ...t.tooltip,
      formatter: (params: Array<{ value?: number; marker: string; seriesName: string; axisValue: string; seriesType: string }>) => {
        const barParams = params.filter((p) => p.seriesType === 'bar')
        const total = barParams.reduce((s, p) => s + (p.value ?? 0), 0)
        const lines = params.map((p) => `<div style="display:flex;gap:16px;justify-content:space-between"><span style="color:${t.muted}">${p.marker}${p.seriesName}</span><span>${money(p.value ?? 0)}</span></div>`)
        const foot = barParams.length > 1 ? `<div style="display:flex;justify-content:space-between;margin-top:4px;padding-top:4px;border-top:1px solid ${t.line}"><span style="color:${t.muted}">Total</span><span>${money(total)}</span></div>` : ''
        return `<div style="font-weight:500;margin-bottom:4px">${params[0]?.axisValue}</div>${lines.join('')}${foot}`
      },
    },
    xAxis: { type: 'value', axisLabel: { ...t.fontSmall, color: t.faint, formatter: (v: number) => money(v) }, splitLine: { lineStyle: { color: t.line } }, axisLine: { show: false } },
    yAxis: { type: 'category', data: ordered.map((r) => String(r[labelKey] ?? '')), axisLabel: { ...t.font, color: t.ink, width: 170, overflow: 'truncate' }, axisTick: { show: false }, axisLine: { lineStyle: { color: t.line } } },
    series: [
      ...bars.map((s, i) => ({
        name: s.label, type: 'bar', stack: 'total', barWidth: 14,
        data: ordered.map((r) => (colorOf && bars.length === 1 ? { value: n(r, s.key), itemStyle: { color: colorOf(r) } } : n(r, s.key))),
        itemStyle: { color: token(s.color), borderRadius: i === bars.length - 1 ? [0, 4, 4, 0] : 0 },
        emphasis: { focus: 'series' },
        label: i === bars.length - 1 ? { show: true, position: 'right', ...t.fontSmall, color: t.muted, formatter: (p: { dataIndex: number }) => money(bars.reduce((sum, x) => sum + n(ordered[p.dataIndex], x.key), 0)) } : { show: false },
      })),
      ...markers.map((s) => ({ name: s.label, type: 'scatter', symbol: 'rect', symbolSize: [3, 22], data: ordered.map((r) => n(r, s.key)), itemStyle: { color: token(s.color) }, emphasis: { scale: false }, z: 3 })),
    ],
  }

  if (!rows.some((r) => series.some((s) => n(r, s.key) > 0))) return <Nothing icon="lucide:bar-chart-3">{empty}</Nothing>
  return (
    <div className="sa-chart">
      <div className={`sa-chart-legend${series.length > 4 ? ' sa-chart-legend--wrap' : ''}`} data-copy="skip">
        {(colorOf ? markers : series).map((s) => (
          <span key={s.key} className="sa-chart-legend__item">
            <span className={`sa-chart-legend__swatch${s.marker ? ' sa-chart-legend__swatch--line' : ''}`} style={{ background: s.color }} />
            <span className="sa-chart-legend__text" title={s.label}>{s.label}</span>
          </span>
        ))}
      </div>
      <ReactECharts
        option={option}
        style={{ height: rows.length * rowHeight + 36, width: '100%' }}
        opts={{ renderer: 'svg' }}
        notMerge
        onEvents={{ ...(onSelect ? { click: (p: { name: string }) => onSelect(p.name) } : {}), mouseover: (p: { name: string }) => setHighlight(channel, p.name), mouseout: () => setHighlight(channel, null) }}
      />
    </div>
  )
}
