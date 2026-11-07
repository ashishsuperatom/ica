// THE OPEN KINDS: what an agent draws itself when the simple ones (table, bar, line, pie — the agent writes data, our
// components decide how it looks) cannot say it. `:::echarts x.json` is an ECharts option, drawn as written with the house
// theme under it; `:::html x.html` is HTML of its own, shown as written in a sandboxed frame — its scripts run apart from
// the page (no session, no cookies, nothing of the app reachable), and the frame takes the height of what it holds.

import { useEffect, useRef, useState } from 'react'
import type { Block } from '../../answer/blocks'
import { EChart } from '../ui/EChart'

export function EchartsBlock({ block }: { block: Extract<Block, { type: 'echarts' }> }) {
  const height = typeof (block.option as any).height === 'number' ? (block.option as any).height : 360
  return <div className="sa-openblock">{block.title && <div className="sa-readtable__title">{block.title}</div>}<EChart option={block.option as any} height={height} /></div>
}

// Told by the frame how tall what it holds is (it cannot be read across the sandbox): sent as it changes.
const SIZER = `<script>(function(){var t=function(){parent.postMessage({saHtmlHeight:document.documentElement.scrollHeight},'*')};new ResizeObserver(t).observe(document.documentElement);addEventListener('load',t);t()})()</script>`

export function HtmlBlock({ block }: { block: Extract<Block, { type: 'html' }> }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(240)
  useEffect(() => {
    const on = (e: MessageEvent) => { if (e.source === frame.current?.contentWindow && typeof e.data?.saHtmlHeight === 'number') setHeight(Math.max(40, Math.min(e.data.saHtmlHeight, 4000))) }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])
  return <div className="sa-openblock">{block.title && <div className="sa-readtable__title">{block.title}</div>}
    <iframe ref={frame} className="sa-htmlblock" title={block.title || 'A part of the answer'} sandbox="allow-scripts" srcDoc={block.html + SIZER} style={{ height }} />
  </div>
}
