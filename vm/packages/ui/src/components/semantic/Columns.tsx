// COLUMNS — a graph walked left to right. Each column holds every thing of its kind; selecting a thing on the left
// puts what it holds first in the column to its right, in a lane of its own with an edge drawn to each from the
// selection, then the rest, quieter — attached to the selection with + , detached with the unlink. Each column scrolls on its own, has a width of its own (dragged at its edge, kept in this
// browser) and never narrower than it can be read: past the window, the columns scroll sideways. One search above them
// all; beside them, the detail of what is selected.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { recall, remember } from '../../lib/remember'

export interface ColumnItem { key: string; title: string; line?: string; tag?: string }
export interface ColumnSpec {
  key: string; title: string; icon: string
  /** What the column holds now ("Every atomic concept", "In <the selected one>"). */
  caption?: string
  /** Every thing of the column's kind. */
  items: ColumnItem[]
  selected?: string | null
  onSelect: (key: string) => void
  /** What the thing selected on the left holds, in its order: shown first, above a separator. */
  linked?: string[]
  /** The name of the thing selected on the left, for the headings. */
  linkedTo?: string
  /** Attach one of the rest to the selection on the left; detach a linked one. */
  onAttach?: (key: string) => void
  onDetach?: (key: string) => void
  /** Make a new thing of this kind. */
  onNew?: () => void
  empty?: string
  /** Its things are on their way: rows of their size are drawn, never an empty column that then fills. */
  loading?: boolean
}

const MIN = 260          // narrowest a dragged column may be
const COLUMN_W = 340     // a column's width until dragged
const DETAIL_W = 680     // the detail's width until dragged

/** ↑ ↓ in a column move what is selected in it, in the order shown (what the selection holds first, then the rest). */
function step(e: ReactKeyboardEvent<HTMLButtonElement>, col: ColumnSpec, key: string) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const body = e.currentTarget.closest('.sa-col__body'); if (!body) return
  const keys = [...body.querySelectorAll<HTMLElement>('.sa-col__item[data-key]')].map((el) => el.dataset.key!)
  const next = keys[keys.indexOf(key) + (e.key === 'ArrowDown' ? 1 : -1)]
  if (!next) return
  e.preventDefault()
  col.onSelect(next)
  requestAnimationFrame(() => { const el = body.querySelector<HTMLElement>(`.sa-col__item[data-key="${CSS.escape(next)}"] .sa-col__main`); el?.focus(); el?.scrollIntoView({ block: 'nearest' }) })
}

function Item({ it, col, linked }: { it: ColumnItem; col: ColumnSpec; linked: boolean | null }) {
  return (
    <div className="sa-col__item" data-key={it.key} data-selected={col.selected === it.key} data-linked={linked === null ? undefined : String(linked)}>
      <button className="sa-col__main" onClick={() => col.onSelect(it.key)} onKeyDown={(e) => step(e, col, it.key)} title={it.line || it.title}>
        <span className="sa-col__title">{it.title}{it.tag && <span className="sa-col__tag">{it.tag}</span>}</span>
        {it.line && <span className="sa-col__line">{it.line}</span>}
      </button>
      {linked === true && col.onDetach && <button className="sa-icon-btn sa-col__act sa-col__detach" title={`Detach from ${col.linkedTo}`} aria-label={`Detach ${it.title} from ${col.linkedTo}`} onClick={() => col.onDetach!(it.key)}><Icon icon="lucide:unlink" /></button>}
      {linked === false && col.onAttach && <button className="sa-icon-btn sa-col__act sa-col__attach" title={`Attach to ${col.linkedTo}`} aria-label={`Attach ${it.title} to ${col.linkedTo}`} onClick={() => col.onAttach!(it.key)}><Icon icon="lucide:plus" /></button>}
    </div>
  )
}

function Column({ col }: { col: ColumnSpec }) {
  const byKey = new Map(col.items.map((i) => [i.key, i]))
  const linked = col.linked ? col.linked.map((k) => byKey.get(k)).filter((x): x is ColumnItem => !!x) : null
  const rest = col.linked ? col.items.filter((i) => !col.linked!.includes(i.key)) : col.items
  return (
    <section className="sa-col" aria-label={col.title}>
      <header className="sa-col__head">
        <span className="sa-col__name"><Icon icon={col.icon} />{col.title}<span className="sa-col__count">{col.items.length}</span></span>
        {col.onNew && <button className="sa-btn sa-btn--link" onClick={col.onNew}><Icon icon="lucide:plus" className="sa-btn__icon" />New</button>}
      </header>
      {col.caption && <div className="sa-col__caption">{col.caption}</div>}
      <div className="sa-col__body">
        {col.loading && Array.from({ length: 8 }, (_, i) => (
          <div key={`l${i}`} className="sa-col__item" aria-hidden><span className="sa-col__main"><span className="sa-skeleton" style={{ width: `${50 + ((i * 17) % 40)}%`, height: 12 }} /><span className="sa-skeleton" style={{ width: '80%', height: 9, marginTop: 6 }} /></span></div>))}
        {!col.loading && !col.items.length && <p className="sa-col__empty">{col.empty ?? 'Nothing here.'}</p>}
        {!col.loading && linked && col.items.length > 0 && <>
          <div className="sa-col__lane" data-empty={!linked.length}>
            <div className="sa-col__group sa-col__group--in">In {col.linkedTo} <span className="sa-col__count">{linked.length}</span></div>
            {linked.map((it) => <Item key={it.key} it={it} col={col} linked />)}
            {!linked.length && <p className="sa-col__empty">None yet{col.onAttach ? ' — attach one below with +' : ''}</p>}
          </div>
          {rest.length > 0 && <div className="sa-col__group sa-col__group--rest">Others <span className="sa-col__count">{rest.length}</span></div>}
        </>}
        {!col.loading && rest.map((it) => <Item key={it.key} it={it} col={col} linked={linked ? false : null} />)}
      </div>
    </section>
  )
}

/** One search over every column: the caller filters what each holds. */
export function ColumnsSearch({ value, onChange, placeholder = 'Search everything…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="sa-cols__search"><Icon icon="lucide:search" /><input id="cols-search" className="sa-col__input" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      {value && <button className="sa-icon-btn" aria-label="Clear the search" onClick={() => onChange('')}><Icon icon="lucide:x" /></button>}</div>
  )
}

/** The columns, then the detail of what is selected. `keep`: where the widths are kept in this browser. */
export function Columns({ columns, detail, keep = 'columns' }: { columns: ColumnSpec[]; detail?: ReactNode; keep?: string }) {
  const names = [...columns.map((c) => c.key), ...(detail ? ['detail'] : [])]
  const [widths, setWidths] = useState<Record<string, number>>(() => recall<Record<string, number>>(`cols:${keep}`, {}))
  const drag = useRef<{ key: string; x: number; w: number; left0: number; lastX: number } | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // The width follows the pointer AND the scroll: near the scroller's right edge the columns scroll on by themselves, so
    // the last column can be dragged wider than the window.
    const widthNow = () => { const d = drag.current, el = scroller.current; if (!d || !el) return; setWidths((w) => ({ ...w, [d.key]: Math.max(MIN, Math.round(d.w + d.lastX - d.x + el.scrollLeft - d.left0)) })) }
    let timer = 0
    const edgeScroll = () => {
      const d = drag.current, el = scroller.current; if (!d || !el) { timer = 0; return }
      // Only once the pointer has been dragged right, into the last 24px: a handle that merely starts near the edge (the
      // detail's, when the columns fill the window) must not run away. Slow at first, faster the closer to the edge.
      const right = el.getBoundingClientRect().right, into = d.lastX - (right - 24)
      if (d.lastX > d.x + 8 && into > 0) { const before = el.scrollLeft; el.scrollLeft += Math.ceil(into / 6); if (el.scrollLeft !== before) widthNow() }
      timer = window.setTimeout(edgeScroll, 16)
    }
    const move = (e: PointerEvent) => { const d = drag.current; if (!d) return; d.lastX = e.clientX; widthNow(); if (!timer) timer = window.setTimeout(edgeScroll, 16) }
    const up = () => { if (!drag.current) return; drag.current = null; if (timer) { clearTimeout(timer); timer = 0 } document.body.classList.remove('sa-resizing'); setWidths((w) => { remember(`cols:${keep}`, w); return w }) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (timer) clearTimeout(timer) }
  }, [keep])
  // Every column has a width — the one it was dragged to, else a roomy default — and past the window the columns scroll
  // sideways; a window wider than them all leaves the space after the last one.
  const track = (k: string) => `${widths[k] ?? (k === 'detail' ? DETAIL_W : COLUMN_W)}px`
  const edges = useEdges(columns)
  const handle = (k: string) => (
    <span className="sa-cols__resize" role="separator" aria-orientation="vertical" aria-label="Resize the column" title="Drag to resize · double-click for its usual width"
      onPointerDown={(e) => { e.preventDefault(); drag.current = { key: k, x: e.clientX, lastX: e.clientX, left0: scroller.current?.scrollLeft ?? 0, w: (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width }; document.body.classList.add('sa-resizing') }}
      onDoubleClick={() => setWidths((w) => { const { [k]: _gone, ...rest } = w; remember(`cols:${keep}`, rest); return rest })} />
  )
  return (
    <div className="sa-cols" ref={(el) => { edges.ref.current = el; scroller.current = el }} style={{ gridTemplateColumns: [...names.map(track), 'minmax(0, 1fr)'].join(' ') }}>
      <svg className="sa-cols__edges" aria-hidden width={edges.size.w} height={edges.size.h}>{edges.paths.map((d, i) => <path key={i} d={d} />)}</svg>
      {columns.map((c) => <div key={c.key} className="sa-cols__cell"><Column col={c} />{handle(c.key)}</div>)}
      {detail && <div className="sa-cols__cell"><section className="sa-col sa-col--detail" aria-label="Selected">{detail}</section>{handle('detail')}</div>}
    </div>
  )
}

/** The edges of the graph: from the thing selected in a column to each thing it holds in a column to its right (the
 *  nearest column left of a linked column that has a selection). Drawn beneath the columns, so they show in the gaps
 *  between them; a thing scrolled out of sight is reached at its column's edge. Measured again on scroll and resize. */
function useEdges(columns: ColumnSpec[]) {
  const ref = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<string[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  const sig = columns.map((c) => `${c.key}:${c.selected ?? ''}:${(c.linked ?? []).join(',')}:${c.items.length}`).join('|')
  useEffect(() => {
    const root = ref.current; if (!root) return
    let frame = 0
    const measure = () => {
      frame = 0
      const box = root.getBoundingClientRect()
      const cells = [...root.querySelectorAll<HTMLElement>(':scope > .sa-cols__cell')].slice(0, columns.length)
      const out: string[] = []
      columns.forEach((col, j) => {
        if (!col.linked?.length) return
        let src: HTMLElement | null = null, i = j - 1
        for (; i >= 0 && !src; i--) src = cells[i]?.querySelector<HTMLElement>('.sa-col__item[data-selected="true"]') ?? null
        const body = cells[j]?.querySelector<HTMLElement>('.sa-col__body'); if (!src || !body) return
        const srcBody = src.closest<HTMLElement>('.sa-col__body')!.getBoundingClientRect()
        const s = src.getBoundingClientRect()
        const sy = Math.min(Math.max(s.top + s.height / 2, srcBody.top), srcBody.bottom) - box.top + root.scrollTop
        const sx = s.right - box.left + root.scrollLeft
        const shown = body.getBoundingClientRect()
        // Passing a column (the selection is further left): a straight line out of the selection, behind the columns
        // between, fanning out in the gap before this one.
        const skips = i + 1 < j - 1
        const gap = parseFloat(getComputedStyle(root).columnGap) || 0
        const fanFrom = skips ? cells[j]!.getBoundingClientRect().left - box.left + root.scrollLeft - gap : sx
        if (skips) out.push(`M${sx},${sy} H${fanFrom}`)
        for (const t of body.querySelectorAll<HTMLElement>('.sa-col__item[data-linked="true"]')) {
          const r = t.getBoundingClientRect()
          const ty = Math.min(Math.max(r.top + r.height / 2, shown.top + 4), shown.bottom - 4) - box.top + root.scrollTop
          const tx = r.left - box.left + root.scrollLeft
          const half = Math.max(12, (tx - fanFrom) / 2)
          out.push(`M${fanFrom},${sy} C${fanFrom + half},${sy} ${tx - half},${ty} ${tx},${ty}`)
        }
      })
      setPaths(out); setSize({ w: root.scrollWidth, h: root.scrollHeight })
    }
    const soon = () => { if (!frame) frame = requestAnimationFrame(measure) }
    soon()
    root.addEventListener('scroll', soon, true)
    const ro = new ResizeObserver(soon); ro.observe(root)
    window.addEventListener('resize', soon)
    return () => { if (frame) cancelAnimationFrame(frame); root.removeEventListener('scroll', soon, true); ro.disconnect(); window.removeEventListener('resize', soon) }
  }, [sig])   // eslint-disable-line react-hooks/exhaustive-deps -- `sig` is what the edges depend on
  return { ref, paths, size }
}
