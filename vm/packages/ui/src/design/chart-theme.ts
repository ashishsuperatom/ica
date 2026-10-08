// The chart theme: ECharts colours, fonts, tooltip and legend styling derived from the tokens, so charts and the
// rest of the screen agree by construction. A canvas cannot read a CSS variable, so the tokens are resolved here,
// at render, never at import (the stylesheet may not be there yet when a module loads).

import { paint, read, ACTION_PALETTE } from './color'

const px = (v: string, fallback: number) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback }

export interface ChartTheme {
  font: { fontFamily: string; fontSize: number }
  fontSmall: { fontFamily: string; fontSize: number }
  ink: string
  muted: string
  faint: string
  line: string
  surface: string
  palette: readonly string[]
  /** The tooltip box, as ECharts wants it: the app's card, floating. */
  tooltip: { backgroundColor: string; borderColor: string; borderWidth: number; padding: number[]; textStyle: { fontFamily: string; fontSize: number; color: string }; extraCssText: string; appendToBody: true; className: string }
  legend: { textStyle: { fontFamily: string; fontSize: number; color: string } }
}

export function chartTheme(): ChartTheme {
  const family = read('--font') || 'Inter, sans-serif'
  const font = { fontFamily: family, fontSize: px(read('--t-sm'), 12) }
  const fontSmall = { fontFamily: family, fontSize: px(read('--t-xs'), 11) }
  const ink = paint('ink'), muted = paint('muted'), faint = paint('faint'), line = paint('line'), surface = paint('surface')
  return {
    font, fontSmall, ink, muted, faint, line, surface,
    palette: ACTION_PALETTE,
    tooltip: {
      backgroundColor: surface,
      borderColor: line,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { ...font, color: ink },
      extraCssText: `box-shadow: none; border-radius: ${read('--r-md') || '9px'};`,
      appendToBody: true,
      className: 'sa-chart-tooltip',
    },
    legend: { textStyle: { ...font, color: ink } },
  }
}
