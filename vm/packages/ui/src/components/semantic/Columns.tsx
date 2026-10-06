// COLUMNS — a graph walked left to right. Each column holds every thing of its kind; selecting a thing on the left
// puts what it holds first in the column to its right, in a lane of its own with an edge drawn to each from the
// selection, then the rest, quieter — attached to the selection with + , detached with the unlink. Each column scrolls on its own, has a width of its own (dragged at its edge, kept in this
// browser) and never narrower than it can be read: past the window, the columns scroll sideways. One search above them
// all; beside them, the detail of what is selected.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
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
const MIN_SHARED = 220   // narrowest a column sharing the space may be

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
  const drag = useRef<{ key: string; x: number; w: number } | null>(null)
  useEffect(() => {
    const move = (e: PointerEvent) => { const d = drag.current; if (!d) return; setWidths((w) => ({ ...w, [d.key]: Math.max(MIN, Math.round(d.w + e.clientX - d.x)) })) }
    const up = () => { if (!drag.current) return; drag.current = null; document.body.classList.remove('sa-resizing'); setWidths((w) => { remember(`cols:${keep}`, w); return w }) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [keep])
  // A column keeps the width it was dragged to while the window has room for it; until dragged the columns share the space (never narrower than they can be
  // read), the detail a larger share — so the whole graph fits the window wherever it can, and scrolls sideways only past it.
  const track = (k: string, last: boolean) => {
    const w = widths[k]
    // a dragged width is what the column takes when there is room; in a narrower window it gives some up, down to readable
    if (w) return last ? `minmax(${Math.min(w, 340)}px, 1fr)` : `minmax(${MIN_SHARED}px, ${w}px)`
    return k === 'detail' ? 'minmax(340px, 1.6fr)' : `minmax(${MIN_SHARED}px, 1fr)`
  }
  const edges = useEdges(columns)
  const handle = (k: string) => (
    <span className="sa-cols__resize" role="separator" aria-orientation="vertical" aria-label="Resize the column" title="Drag to resize · double-click for its usual width"
      onPointerDown={(e) => { e.preventDefault(); drag.current = { key: k, x: e.clientX, w: (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width }; document.body.classList.add('sa-resizing') }}
      onDoubleClick={() => setWidths((w) => { const { [k]: _gone, ...rest } = w; remember(`cols:${keep}`, rest); return rest })} />
  )
  return (
    <div className="sa-cols" ref={edges.ref} style={{ gridTemplateColumns: names.map((k, i) => track(k, i === names.length - 1)).join(' ') }}>
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
