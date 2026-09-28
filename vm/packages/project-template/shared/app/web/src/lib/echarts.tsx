// ECharts built from the parts these charts use, not the whole library: bars, pies, a scatter for marker
// points, and the tooltip/legend/grid they sit in, on the canvas renderer. The full build is four times the size.
import * as echarts from 'echarts/core'
import { BarChart, PieChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import type { EChartsReactProps } from 'echarts-for-react'

echarts.use([BarChart, PieChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

/** The React chart, bound to this build. Same props as the default export of echarts-for-react. */
export default function ReactECharts(props: Omit<EChartsReactProps, 'echarts'> & { ref?: unknown }) {
  return <ReactEChartsCore echarts={echarts} {...(props as EChartsReactProps)} />
}
