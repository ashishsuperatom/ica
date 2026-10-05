// COLUMNS — a graph walked left to right. Each column holds every thing of its kind; selecting a thing on the left
// puts what it holds first in the column to its right, then a separator, then the rest — attached to the selection with
// + , detached with the unlink. Each column scrolls on its own, has a width of its own (dragged at its edge, kept in this
// browser) and never narrower than it can be read: past the window, the columns scroll sideways. One search above them
// all; beside them, the detail of what is selected.

import { useEffect, useRef, useState, type ReactNode } from 'react'
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

const MIN = 260

function Item({ it, col, linked }: { it: ColumnItem; col: ColumnSpec; linked: boolean | null }) {
  return (
    <div className="sa-col__item" data-selected={col.selected === it.key} data-linked={linked === true}>
      <button className="sa-col__main" onClick={() => col.onSelect(it.key)} title={it.line || it.title}>
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
        {!col.loading && linked && <>
          <div className="sa-col__group">In {col.linkedTo} <span className="sa-col__count">{linked.length}</span></div>
          {linked.map((it) => <Item key={it.key} it={it} col={col} linked />)}
          {!linked.length && <p className="sa-col__empty">Nothing in it yet — attach from below.</p>}
          <div className="sa-col__group sa-col__group--rest">Not in {col.linkedTo} <span className="sa-col__count">{rest.length}</span></div>
        </>}
        {!col.loading && rest.map((it) => <Item key={it.key} it={it} col={col} linked={linked ? false : null} />)}
        {!col.loading && !col.items.length && <p className="sa-col__empty">{col.empty ?? 'Nothing here.'}</p>}
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
  const width = (k: string) => widths[k] ?? (k === 'detail' ? 460 : 320)
  const handle = (k: string) => (
    <span className="sa-cols__resize" role="separator" aria-orientation="vertical" aria-label="Resize the column" title="Drag to resize · double-click for its usual width"
      onPointerDown={(e) => { e.preventDefault(); drag.current = { key: k, x: e.clientX, w: (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width }; document.body.classList.add('sa-resizing') }}
      onDoubleClick={() => setWidths((w) => { const { [k]: _gone, ...rest } = w; remember(`cols:${keep}`, rest); return rest })} />
  )
  return (
    <div className="sa-cols" style={{ gridTemplateColumns: names.map((k, i) => (i === names.length - 1 ? `minmax(${width(k)}px, 1fr)` : `${width(k)}px`)).join(' ') }}>
      {columns.map((c) => <div key={c.key} className="sa-cols__cell"><Column col={c} />{handle(c.key)}</div>)}
      {detail && <div className="sa-cols__cell"><section className="sa-col sa-col--detail" aria-label="Selected">{detail}</section>{handle('detail')}</div>}
    </div>
  )
}
