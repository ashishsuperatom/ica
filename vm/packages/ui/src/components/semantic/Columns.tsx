// COLUMNS — a graph walked left to right. Each column holds what the selection to its left composes (the caller decides
// what that is); selecting a thing changes the columns to its right. A column may attach another thing to the one
// selected on its left (from a searchable list of what is not attached yet), detach one, and add a new one. Beside the
// columns, a detail panel shows what is selected. Each column scrolls on its own.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'

export interface ColumnItem { key: string; title: string; line?: string; tag?: string }
export interface ColumnSpec {
  key: string; title: string; icon: string
  /** What the column says it holds now ("In <the selected one>", "Every atomic concept"). */
  caption?: string
  items: ColumnItem[]
  selected?: string | null
  onSelect: (key: string) => void
  /** Detach a thing from the one selected on the left (absent: these cannot be detached here). */
  onDetach?: (key: string) => void
  detachLabel?: string
  /** Attach another thing to the one selected on the left. */
  attach?: { label: string; candidates: ColumnItem[]; onAttach: (key: string) => void }
  /** Make a new thing of this kind. */
  onNew?: () => void
  empty?: string
}

function Picker({ attach, onClose }: { attach: NonNullable<ColumnSpec['attach']>; onClose: () => void }) {
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc) }
  }, [onClose])
  const list = attach.candidates.filter((c) => !q || `${c.title} ${c.key} ${c.line ?? ''}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="sa-col__picker" ref={box} role="dialog" aria-label={attach.label}>
      <div className="sa-col__find"><Icon icon="lucide:search" /><input className="sa-col__input" autoFocus placeholder={attach.label} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="sa-col__picklist">
        {list.map((c) => (
          <button key={c.key} className="sa-col__pick" onClick={() => attach.onAttach(c.key)} title={c.line || c.title}>
            <Icon icon="lucide:plus" /><span className="sa-col__picktext"><span className="sa-col__title">{c.title}</span>{c.line && <span className="sa-col__line">{c.line}</span>}</span>
          </button>
        ))}
        {!list.length && <p className="sa-col__empty">{attach.candidates.length ? 'Nothing matches.' : 'Everything is attached already.'}</p>}
      </div>
    </div>
  )
}

function Column({ col }: { col: ColumnSpec }) {
  const [q, setQ] = useState('')
  const [picking, setPicking] = useState(false)
  const list = col.items.filter((it) => !q || `${it.title} ${it.key} ${it.line ?? ''}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <section className="sa-col" aria-label={col.title}>
      <header className="sa-col__head">
        <span className="sa-col__name"><Icon icon={col.icon} />{col.title}<span className="sa-col__count">{col.items.length}</span></span>
        <span className="sa-col__headacts">
          {col.attach && <button className="sa-btn sa-btn--link" onClick={() => setPicking(true)} title={col.attach.label}><Icon icon="lucide:link" className="sa-btn__icon" />Attach</button>}
          {col.onNew && <button className="sa-btn sa-btn--link" onClick={col.onNew}><Icon icon="lucide:plus" className="sa-btn__icon" />New</button>}
        </span>
        {picking && col.attach && <Picker attach={{ ...col.attach, onAttach: (k) => { col.attach!.onAttach(k); setPicking(false) } }} onClose={() => setPicking(false)} />}
      </header>
      {col.caption && <div className="sa-col__caption">{col.caption}</div>}
      <div className="sa-col__find"><Icon icon="lucide:search" /><input className="sa-col__input" placeholder="Find…" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Find in ${col.title}`} /></div>
      <div className="sa-col__body">
        {list.map((it) => (
          <div key={it.key} className="sa-col__item" data-selected={col.selected === it.key}>
            <button className="sa-col__main" onClick={() => col.onSelect(it.key)} title={it.line || it.title}>
              <span className="sa-col__title">{it.title}{it.tag && <span className="sa-col__tag">{it.tag}</span>}</span>
              {it.line && <span className="sa-col__line">{it.line}</span>}
            </button>
            {col.onDetach && <button className="sa-icon-btn sa-col__detach" title={col.detachLabel ?? 'Detach'} aria-label={`${col.detachLabel ?? 'Detach'} ${it.title}`} onClick={() => col.onDetach!(it.key)}><Icon icon="lucide:unlink" /></button>}
          </div>
        ))}
        {!col.items.length && <p className="sa-col__empty">{col.empty ?? 'Nothing here.'}</p>}
        {!!col.items.length && !list.length && <p className="sa-col__empty">Nothing matches.</p>}
      </div>
    </section>
  )
}

/** The columns, then the detail of what is selected. */
export function Columns({ columns, detail }: { columns: ColumnSpec[]; detail?: ReactNode }) {
  return (
    <div className="sa-cols" style={{ gridTemplateColumns: `${columns.map(() => 'minmax(15rem, 1fr)').join(' ')}${detail ? ' minmax(22rem, 1.6fr)' : ''}` }}>
      {columns.map((c) => <Column key={c.key} col={c} />)}
      {detail && <section className="sa-col sa-col--detail" aria-label="Selected">{detail}</section>}
    </div>
  )
}
