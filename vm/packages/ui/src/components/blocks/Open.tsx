// THE OPEN KINDS: what an agent draws itself when the simple ones (table, bar, line, pie — the agent writes data, our
// components decide how it looks) cannot say it. `:::echarts x.json` is an ECharts option, drawn as written with the house
// theme under it; `:::html x.html` is HTML of its own, shown as written in a sandboxed frame — its scripts run apart from
// the page (no session, no cookies, nothing of the app reachable), and the frame takes the height of what it holds.

import { useEffect, useRef, useState } from 'react'
import type { Block } from '../../answer/blocks'
import { EChart } from '../ui/EChart'
import { Icon } from '../ui/Icon'
import { useProgramEnv } from '../frame/programEnv'

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

const sizeOf = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/** A file the answer gives (`:::file out/<name>`): its name and size; a click downloads it through the person's door. */
export function FileBlock({ block }: { block: Extract<Block, { type: 'file' }> }) {
  const env = useProgramEnv()
  const [state, setState] = useState<'' | 'getting' | 'failed'>('')
  const get = async () => {
    if (!env?.download || state === 'getting') return
    setState('getting')
    try { await env.download({ session: block.session, hash: block.hash, name: block.name }); setState('') } catch { setState('failed') }
  }
  return (
    <button type="button" className="sa-fileblock" onClick={get} disabled={!env?.download} title={env?.download ? `Download ${block.name}` : block.name}>
      <Icon icon={state === 'getting' ? 'lucide:loader' : 'lucide:file-down'} className={state === 'getting' ? 'sa-spin' : undefined} />
      <span className="sa-fileblock__name">{block.name}</span>
      <span className="sa-fileblock__size">{state === 'failed' ? 'Not downloaded — try again' : sizeOf(block.size)}</span>
    </button>
  )
}
