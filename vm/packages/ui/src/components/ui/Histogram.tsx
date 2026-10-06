// A HISTOGRAM: how a column's values spread — one bar a bin, each with its range, its rows and its share in the tooltip.
// Numbers over equal bins between a low and a high; dates by day or month. Small enough to sit in a side panel.

import ReactECharts from '../../lib/echarts'
import { chartTheme } from '../../design/index'

const N = new Intl.NumberFormat()
const short = (v: number) => (Math.abs(v) >= 1000 ? N.format(Math.round(v)) : String(Math.round(v * 1000) / 1000))

export default function Histogram({ bins, labels, height = 120, unit = 'rows' }: {
  bins: number[]
  /** Each bin's name, in order: its range ("12.1 – 550") or its period ("2026-05"). */
  labels: string[]
  height?: number
  unit?: string
}) {
  const t = chartTheme()
  const total = bins.reduce((a, b) => a + b, 0) || 1
  const option = {
    animation: false,
    grid: { left: 2, right: 2, top: 6, bottom: 2, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(16,24,40,0.05)' } }, ...t.tooltip,
      formatter: (ps: Array<{ dataIndex: number }>) => {
        const i = ps[0]?.dataIndex ?? 0
        return `<div style="font-weight:500;margin-bottom:2px">${labels[i] ?? ''}</div><div>${N.format(bins[i] ?? 0)} ${unit} <span style="color:${t.muted}">· ${(((bins[i] ?? 0) / total) * 100).toFixed(1)}%</span></div>`
      },
    },
    xAxis: { type: 'category', data: labels, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: t.line } } },
    yAxis: { type: 'value', axisLabel: { hideOverlap: true, ...t.fontSmall, color: t.faint, formatter: (v: number) => short(v) }, splitNumber: 2, splitLine: { lineStyle: { color: t.line } } },
    series: [{ type: 'bar', data: bins, barCategoryGap: '8%', itemStyle: { color: t.palette[0], borderRadius: [2, 2, 0, 0] }, emphasis: { itemStyle: { opacity: 0.85 } } }],
  }
  return <ReactECharts option={option} style={{ height, width: '100%' }} notMerge opts={{ renderer: 'canvas' }} />
}
