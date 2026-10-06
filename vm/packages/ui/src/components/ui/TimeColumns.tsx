// Columns over time, stacked by series (slob's look: Inter, a faint grid, rounded tops, the series colours): one column
// per day (or month), each series a part of it. For "what happened when" — use, activity, volume.

import ReactECharts from '../../lib/echarts'
import { chartTheme, ACTION_PALETTE } from '../../design/index'
import Nothing from './Nothing'
import type { ReactNode } from 'react'

export interface TimeSeries { key: string; label: string; color?: string }

export default function TimeColumns({ periods, series, values, height = 240, format, empty = 'Nothing happened in this time', label }: {
  /** The periods in order (ISO days or months). */
  periods: string[]
  series: TimeSeries[]
  /** values[period][series.key] */
  values: Record<string, Record<string, number>>
  height?: number
  format: (v: number) => string
  empty?: ReactNode
  /** How a period is written on the axis. */
  label?: (period: string) => string
}) {
  const t = chartTheme()
  const any = periods.some((p) => series.some((s) => (values[p]?.[s.key] ?? 0) > 0))
  if (!any) return <Nothing icon="lucide:chart-column">{empty}</Nothing>
  const name = label ?? ((p: string) => (/^\d{4}-\d{2}-\d{2}$/.test(p) ? new Date(`${p}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : p))
  const option = {
    animation: false,
    grid: { left: 4, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(16,24,40,0.04)' } }, ...t.tooltip,
      formatter: (ps: Array<{ value: number; marker: string; seriesName: string; axisValue: string }>) => {
        const shown = ps.filter((p) => p.value > 0)
        const total = shown.reduce((sum, p) => sum + p.value, 0)
        return `<div style="font-weight:500;margin-bottom:4px">${ps[0]?.axisValue ?? ''}</div>${shown.map((p) => `<div style="display:flex;gap:16px;justify-content:space-between"><span style="color:${t.muted}">${p.marker}${p.seriesName}</span><span>${format(p.value)}</span></div>`).join('')}${shown.length > 1 ? `<div style="display:flex;justify-content:space-between;margin-top:4px;padding-top:4px;border-top:1px solid ${t.line}"><span style="color:${t.muted}">Total</span><span>${format(total)}</span></div>` : ''}`
      },
    },
    xAxis: { type: 'category', data: periods.map(name), axisLabel: { ...t.fontSmall, color: t.faint, hideOverlap: true }, axisTick: { show: false }, axisLine: { lineStyle: { color: t.line } } },
    yAxis: { type: 'value', axisLabel: { hideOverlap: true, ...t.fontSmall, color: t.faint, formatter: (v: number) => format(v) }, splitLine: { lineStyle: { color: t.line } } },
    series: series.map((s, i) => ({
      name: s.label, type: 'bar', stack: 'total', barMaxWidth: 18,
      data: periods.map((p) => values[p]?.[s.key] ?? 0),
      itemStyle: { color: s.color ?? ACTION_PALETTE[i % ACTION_PALETTE.length], borderRadius: i === series.length - 1 ? [3, 3, 0, 0] : 0 },
      emphasis: { focus: 'series' },
    })),
  }
  return (
    <div className="sa-chart">
      {series.length > 1 && (
        <div className="sa-chart-legend sa-chart-legend--wrap" data-copy="skip">
          {series.map((s, i) => <span key={s.key} className="sa-chart-legend__item"><span className="sa-chart-legend__swatch" style={{ background: s.color ?? ACTION_PALETTE[i % ACTION_PALETTE.length] }} /><span className="sa-chart-legend__text">{s.label}</span></span>)}
        </div>
      )}
      <ReactECharts option={option} style={{ height, width: '100%' }} opts={{ renderer: 'svg' }} notMerge />
    </div>
  )
}
