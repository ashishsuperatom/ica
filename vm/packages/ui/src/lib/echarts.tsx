// ECharts built from the parts charts use, not the whole library: bars, pies, lines and areas over time, scatters,
// heatmaps, and the tooltip/legend/grid/dataset/visual map/zoom/mark lines they sit in, on the canvas renderer (the full
// build is four times the size). `echarts` is this build, for EChart (any option from these parts).
import * as echarts from 'echarts/core'
import { BarChart, HeatmapChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { DataZoomComponent, DatasetComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import type { EChartsReactProps } from 'echarts-for-react'

echarts.use([BarChart, HeatmapChart, LineChart, PieChart, ScatterChart, DataZoomComponent, DatasetComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, VisualMapComponent, CanvasRenderer])
export { echarts }

// echarts-for-react is CommonJS: one bundler hands over its component, another the module object around it (React then
// refuses it as an element type, error #130). Take the component either way.
const Core = ((ReactEChartsCore as any).default ?? ReactEChartsCore) as typeof ReactEChartsCore

/** The React chart, bound to this build. Same props as the default export of echarts-for-react. */
export default function ReactECharts(props: Omit<EChartsReactProps, 'echarts'> & { ref?: unknown }) {
  return <Core echarts={echarts} {...(props as EChartsReactProps)} />
}
