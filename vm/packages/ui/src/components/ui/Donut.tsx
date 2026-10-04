// A share of the whole, as a ring (slob's Donut): ECharts' own doughnut example kept close, because that is the
// version that proved steady on the bench. Tooltip and legend come from the chart theme, which reads the tokens.
// Colours come in already resolved: a slice handed a CSS variable would be drawn black.
//
// The legend is laid out by the size of the set, and is never dropped:
//   small   (≤ 4)   one row above the ring — ECharts' own legend, as the example draws it
//   medium  (5–12)  a column beside the ring, one item per row, in HTML on the design system's legend classes;
//                   the height grows with the rows and the ring takes the space that is left
//   large   (> 12)  a scrolling list beneath the ring; the ring keeps its full size, the whole grows to a cap
// The HTML legend does what the built-in one did: pointing at an item lights its slice (lib/highlight), and
// clicking switches the slice off, remembered per browser.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactECharts from '../../lib/echarts'
import { chartTheme } from '../../design/index'
import Nothing from './Nothing'
import { recall, remember } from '../../lib/remember'
import { onHighlight, setHighlight, useHighlighted } from '../../lib/highlight'

export interface Slice { name: string; value: number; color?: string; detail?: string }
type Params = { name: string; value: number; percent: number }
type ChartRef = { getEchartsInstance?: () => { dispatchAction: (a: { type: string; seriesIndex: number; name?: string }) => void } }

const SMALL = 4, MEDIUM = 12
const ROW = 26, PAD = 32, FULL = 320, CAP = 480
export type LegendLayout = 'row' | 'column' | 'scroll'
export const legendLayout = (n: number): LegendLayout => (n <= SMALL ? 'row' : n <= MEDIUM ? 'column' : 'scroll')

function DonutChart({ slices, height = 280, onSelect, remembers, channel, empty = 'Nothing to divide up yet', legend = true, format }: {
  slices: Slice[]
  height?: number
  onSelect?: (name: string) => void
  remembers?: string
  channel?: string
  empty?: ReactNode
  /** The chart's own legend. Off where the caller draws the parts beside the ring instead. */
  legend?: boolean
  format: (v: number) => string
}) {
  const select = useRef(onSelect)
  select.current = onSelect
  const click = useCallback((p: Params) => select.current?.(p.name), [])
  const store = useRef(remembers)
  store.current = remembers
  const legendChange = useCallback((p: { selected: Record<string, boolean> }) => store.current && remember(`legend.${store.current}`, p.selected), [])
  const link = useRef(channel)
  link.current = channel
  const over = useCallback((p: Params) => setHighlight(link.current, p.name), [])
  const out = useCallback(() => setHighlight(link.current, null), [])
  const events = useMemo(() => ({ click, legendselectchanged: legendChange, mouseover: over, mouseout: out }), [click, legendChange, over, out])

  const chart = useRef<ChartRef | null>(null)
  useEffect(() => onHighlight(channel, (name) => {
    const api = chart.current?.getEchartsInstance?.()
    if (!api) return
    api.dispatchAction({ type: 'downplay', seriesIndex: 0 })
    if (name) api.dispatchAction({ type: 'highlight', seriesIndex: 0, name })
  }), [channel])

  const live = slices.filter((s) => s.value > 0)
  const layout: LegendLayout = legend ? legendLayout(live.length) : 'row'
  const html = legend && layout !== 'row'
  // Which slices are switched off — ECharts keeps it for its own legend; the HTML legend keeps it here.
  const [off, setOff] = useState<Record<string, boolean>>(() => (remembers ? recall<Record<string, boolean>>(`legend.${remembers}`, {}) : {}))
  const toggle = (name: string) => setOff((o) => { const n = { ...o, [name]: o[name] === false }; if (n[name]) delete n[name]; else n[name] = false; if (store.current) remember(`legend.${store.current}`, n); return n })
  const lit = useHighlighted(channel)
  const shown = html ? live.filter((s) => off[s.name] !== false) : live
  const total = shown.reduce((a, s) => a + s.value, 0)

  // The height: the base, or enough rows beside the ring, or the ring plus a capped list beneath.
  const rows = live.length
  const chartHeight = layout === 'column' ? Math.max(height, rows * ROW + PAD) : layout === 'scroll' ? Math.max(height, FULL) : height
  const box = useMemo(() => ({ height: chartHeight }), [chartHeight])
  const selected = !html && remembers ? off : undefined
  const key = `${JSON.stringify(shown)}|${legend}|${layout}`

  const option = useMemo(() => {
    const t = chartTheme()
    const data = shown.map((s) => ({ name: s.name, value: s.value, ...(s.color ? { itemStyle: { color: s.color } } : {}) }))
    const detail = new Map(slices.map((s) => [s.name, s.detail]))
    // With the legend in a row above, the ring sits under it as the example draws it; otherwise it has the whole box.
    const radius = layout === 'row' ? ['40%', '70%'] : ['44%', '78%']
    const center = layout === 'row' ? ['50%', '55%'] : ['50%', '50%']
    return {
      tooltip: { trigger: 'item', ...t.tooltip, formatter: (p: Params) => `${p.name}<br/><b>${format(p.value)}</b> · ${p.percent}% of the total${detail.get(p.name) ? `<br/><span style="color:${t.muted}">${detail.get(p.name)}</span>` : ''}` },
      legend: { show: legend && !html, top: '5%', left: 'center', ...t.legend, ...(selected && Object.keys(selected).length ? { selected } : {}) },
      series: [{
        type: 'pie', radius, center, avoidLabelOverlap: false,
        itemStyle: { borderRadius: 10, borderColor: t.surface, borderWidth: 2 },
        label: { show: false, position: 'center' },
        emphasis: { label: { show: true, fontFamily: t.font.fontFamily, fontSize: 16, fontWeight: 600, formatter: (p: Params) => `${format(p.value)}\n{sub|${Math.round(p.percent)}% of the total}`, rich: { sub: { fontFamily: t.font.fontFamily, fontSize: 11, fontWeight: 400, color: t.muted, padding: [4, 0, 0, 0] } } } },
        labelLine: { show: false },
        data,
      }],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!live.length) return <Nothing icon="lucide:pie-chart" height={height}>{empty}</Nothing>
  // Beside a legend column the canvas is a square as tall as the rows, so the ring is drawn from the height.
  // Beside a legend column the wrapper is a definite square (capped by the row's width in CSS) and the canvas fills it,
  // so ECharts measures a real size; a percentage inside a shrink-to-fit flex item would resolve to nothing.
  const canvas = <ReactECharts ref={chart as never} option={option} style={layout === 'column' ? { height: chartHeight, width: '100%' } : box} onEvents={events} />
  if (!html) return <div className="sa-ring" data-legend="row">{canvas}</div>
  const list = (
    <div className="sa-ring__legend sa-scroll" role="list" aria-label="Slices" style={layout === 'scroll' ? { maxHeight: CAP - chartHeight } : undefined}>
      {live.map((s) => {
        const isOff = off[s.name] === false
        const share = !isOff && total ? `${Math.round((s.value / total) * 100)}%` : ''
        const full = `${format(s.value)}${share ? ` · ${share}` : ''}`
        return (
          <button key={s.name} type="button" role="listitem" className="sa-ring__item" data-off={isOff} data-lit={lit === s.name}
            title={`${s.name} · ${full}${isOff ? ' · hidden, click to show' : ' · click to hide from the whole'}`}
            onMouseEnter={() => !isOff && setHighlight(channel, s.name)} onMouseLeave={() => setHighlight(channel, null)} onClick={() => toggle(s.name)}>
            <span className="sa-ring__swatch" style={{ background: s.color ?? 'var(--series-3)' }} aria-hidden />
            <span className="sa-ring__name">{s.name}</span>
            <span className="sa-ring__value sa-ring__value--full">{full}</span>
            {share && <span className="sa-ring__value sa-ring__value--short">{share}</span>}
          </button>
        )
      })}
    </div>
  )
  return (
    <div className="sa-ring" data-legend={layout}>
      <div className="sa-ring__canvas" style={layout === 'column' ? { width: chartHeight } : undefined}>{canvas}</div>
      {list}
    </div>
  )
}

const Donut = memo(DonutChart, (a, b) => a.height === b.height && a.legend === b.legend && JSON.stringify(a.slices) === JSON.stringify(b.slices))
export default Donut
