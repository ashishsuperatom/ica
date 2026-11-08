// THE OPEN KINDS: what an agent draws itself when the simple ones (table, bar, line, pie — the agent writes data, our
// components decide how it looks) cannot say it. `:::echarts x.json` is an ECharts option, drawn as written with the house
// theme under it; `:::html x.html` is HTML of its own, shown as written in a sandboxed frame — its scripts run apart from
// the page (no session, no cookies, nothing of the app reachable), and the frame takes the height of what it holds.

import { useEffect, useRef, useState } from 'react'
import type { Block } from '../../answer/blocks'
import { EChart } from '../ui/EChart'
import { Icon } from '../ui/Icon'
import { useProgramEnv } from '../frame/programEnv'
import { Dialog } from '../semantic'

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

/** How the browser can show a file itself, with nothing added: as an image, a PDF (its own viewer), a video or sound, HTML
 *  (in a sealed frame, as the html block), or text. null: it cannot (a spreadsheet, a slide deck) — it is downloaded. */
const viewOf = (mime: string): 'image' | 'pdf' | 'video' | 'audio' | 'html' | 'text' | null =>
  mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio'
    : mime === 'text/html' ? 'html' : mime.startsWith('text/') || mime === 'application/json' ? 'text' : null
const TEXT_MAX = 200_000

/** A file the answer gives (`:::file out/<name>`): its name and size. A click shows it, when the browser can, with its
 *  download beside; any other file is downloaded. Read through the person's door either way. */
export function FileBlock({ block }: { block: Extract<Block, { type: 'file' }> }) {
  const env = useProgramEnv()
  const [state, setState] = useState<'' | 'getting' | 'failed'>('')
  const [open, setOpen] = useState<{ url: string; text?: string } | null>(null)
  const view = viewOf(block.mime)
  const ref = { session: block.session, hash: block.hash, name: block.name }
  const download = async () => {
    if (!env?.download) return
    setState('getting')
    try { await env.download(ref); setState('') } catch { setState('failed') }
  }
  const show = async () => {
    if (state === 'getting') return
    if (!view || !env?.preview) return download()
    setState('getting')
    try {
      const url = await env.preview(ref)
      if (!url) throw new Error('not read')
      const text = view === 'text' || view === 'html' ? (await (await fetch(url)).text()).slice(0, TEXT_MAX) : undefined
      setOpen({ url, ...(text !== undefined ? { text } : {}) }); setState('')
    } catch { setState('failed') }
  }
  return (<>
    <button type="button" className="sa-fileblock" onClick={show} disabled={!env?.download} title={env?.download ? (view ? `Show ${block.name}` : `Download ${block.name}`) : block.name}>
      <Icon icon={state === 'getting' ? 'lucide:loader' : view ? 'lucide:file-search' : 'lucide:file-down'} className={state === 'getting' ? 'sa-spin' : undefined} />
      <span className="sa-fileblock__name">{block.name}</span>
      <span className="sa-fileblock__size">{state === 'failed' ? 'Not read — try again' : sizeOf(block.size)}</span>
    </button>
    {open && <Dialog full title={block.name} onClose={() => setOpen(null)} actions={<>
      <button type="button" className="sa-btn" onClick={() => setOpen(null)}>Close</button>
      {/* the file is here already (shown from it): saved from this copy at once, not read again */}
      <a className="sa-btn sa-btn--primary" href={open.url} download={block.name} autoFocus>Download</a>
    </>}>
      <div className="sa-filepreview" data-view={view}>
        {view === 'image' && <img src={open.url} alt={block.name} />}
        {view === 'pdf' && <iframe src={open.url} title={block.name} />}
        {view === 'video' && <video src={open.url} controls />}
        {view === 'audio' && <audio src={open.url} controls />}
        {view === 'html' && <iframe sandbox="allow-scripts" srcDoc={open.text} title={block.name} />}
        {view === 'text' && <pre>{open.text}</pre>}
      </div>
    </Dialog>}
  </>)
}
