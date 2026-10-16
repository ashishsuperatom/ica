// A CARD DRAWN AS A CHART — on the web, the runtime that draws charts (answer/cards.ts: a card is rows; its marker's kind
// is a hint). The rows say it all: the first column that is not a number is what the chart is drawn along (a month, a
// branch), each number column a series. A card that cannot be read so (no number column, nothing to draw along) is null:
// drawn as its table, never a chart that would mislead.
import type { Card } from './cards'

export type ChartKind = 'bar' | 'line' | 'pie'
export const chartKind = (hint?: string): ChartKind | null => (hint === 'bar' || hint === 'chart' ? 'bar' : hint === 'line' ? 'line' : hint === 'pie' ? 'pie' : null)

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

/** The chart's axis and series from a card's rows, or null when they do not make one. */
export function chartData(card: Card): { along: { key: string; label: string; values: string[] }; series: { key: string; label: string; unit?: string; values: (number | null)[] }[] } | null {
  if (!card.rows.length) return null
  const isNumber = (key: string) => card.rows.every((r) => r[key] == null || num(r[key]) !== null) && card.rows.some((r) => num(r[key]) !== null)
  const along = card.columns.find((c) => !isNumber(c.key))
  const series = card.columns.filter((c) => c !== along && isNumber(c.key))
  if (!along || !series.length) return null
  return {
    along: { key: along.key, label: along.label, values: card.rows.map((r) => String(r[along.key] ?? '')) },
    series: series.map((c) => ({ key: c.key, label: c.label, ...(c.unit ? { unit: c.unit } : {}), values: card.rows.map((r) => num(r[c.key])) })),
  }
}

/** The ECharts option for a card (themed by the EChart component), or null: draw the table. */
export function chartOption(card: Card, kind: ChartKind): Record<string, unknown> | null {
  const d = chartData(card)
  if (!d) return null
  const many = d.series.length > 1
  if (kind === 'pie') return {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, type: 'scroll' },
    series: [{ type: 'pie', radius: ['40%', '70%'], name: d.series[0].label, data: d.along.values.map((name, i) => ({ name, value: d.series[0].values[i] })) }],
  }
  return {
    tooltip: { trigger: 'axis' },
    ...(many ? { legend: { top: 0, type: 'scroll' } } : {}),
    grid: { left: 8, right: 16, top: many ? 32 : 12, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: d.along.values, axisTick: { show: false } },
    yAxis: { type: 'value' },
    series: d.series.map((s) => ({ type: kind, name: s.label, data: s.values, ...(kind === 'line' ? { showSymbol: d.along.values.length <= 24 } : { barMaxWidth: 36 }) })),
  }
}
