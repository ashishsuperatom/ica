// ONE ECHARTS CHART, for any view or program: give it an ECharts option and it is drawn, dressed in the design system's
// chart theme (colours, font, tooltip, axis ink) wherever the option says nothing of its own, resized with its box, a
// click handed back. A program imports this instead of writing its own wrapper.
import { useEffect, useMemo, useRef } from 'react'
import { echarts } from '../../lib/echarts'
import { chartTheme } from '../../design/index'

type Option = Record<string, any>
const isObj = (v: unknown): v is Option => !!v && typeof v === 'object' && !Array.isArray(v)

/** The option over the theme: what the option sets wins; axes, legend and tooltip get the theme's ink and font. */
export function themedOption(o: Option): Option {
  const t = chartTheme()
  const axis = (a: unknown): unknown => (Array.isArray(a) ? a.map(axis) : isObj(a) ? { ...a,
    axisLabel: { ...t.fontSmall, color: t.faint, hideOverlap: true, ...(a.axisLabel ?? {}) }, axisLine: { lineStyle: { color: t.line }, ...(a.axisLine ?? {}) },
    splitLine: { lineStyle: { color: t.line }, ...(a.splitLine ?? {}) }, nameTextStyle: { ...t.fontSmall, color: t.muted, ...(a.nameTextStyle ?? {}) } } : a)
  return {
    animation: false, color: t.palette, textStyle: t.font, ...o,
    tooltip: { ...t.tooltip, ...(isObj(o.tooltip) ? o.tooltip : {}) },
    ...(o.legend ? { legend: Array.isArray(o.legend) ? o.legend : { ...t.legend, ...o.legend } } : {}),
    ...(o.xAxis !== undefined ? { xAxis: axis(o.xAxis) } : {}),
    ...(o.yAxis !== undefined ? { yAxis: axis(o.yAxis) } : {}),
  }
}

export interface EChartPick { name: string; seriesName?: string; value?: unknown; data?: unknown; dataIndex?: number }

export function EChart({ option, height = 300, onPick, plain = false }: {
  option: Option
  height?: number
  /** A click on a point, a bar, a slice. */
  onPick?: (p: EChartPick) => void
  /** Drawn exactly as given, without the theme under it. */
  plain?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null)
  const pick = useRef(onPick); pick.current = onPick
  const shown = useMemo(() => (plain ? option : themedOption(option)), [option, plain])
  useEffect(() => {
    if (!box.current) return
    const c = echarts.init(box.current, undefined, { renderer: 'canvas' })
    chart.current = c
    c.on('click', (p: any) => pick.current?.(p))
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(box.current)
    return () => { ro.disconnect(); c.dispose(); chart.current = null }
  }, [])
  useEffect(() => { chart.current?.setOption(shown, true) }, [shown])
  return <div ref={box} className="sa-echart" style={{ width: '100%', height, cursor: onPick ? 'pointer' : undefined }} />
}
