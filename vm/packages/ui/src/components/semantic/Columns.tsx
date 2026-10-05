// COLUMNS — things linked left to right, each column scrolling on its own. Selecting a thing in a column orders the next
// column: what is linked to it first, then the rest. In the next column a thing from the rest is attached to the one
// selected on the left, and a linked one detached. Each column may be searched and may add a thing of its kind.

import { useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'

export interface ColumnItem { key: string; title: string; line?: string; tag?: string }
export interface ColumnSpec {
  key: string; title: string; icon: string
  items: ColumnItem[]
  /** The thing selected here (it orders the next column). */
  selected?: string | null
  onSelect: (key: string) => void
  /** What the thing selected on the left is linked to, in its order — shown first. Absent: nothing is selected there. */
  linked?: string[]
  /** The name of the thing selected on the left, for the headings. */
  linkedTo?: string
  onAttach?: (key: string) => void
  onDetach?: (key: string) => void
  /** An action at the column's head (adding one of its kind). */
  action?: ReactNode
  /** An action on the selected thing (open it). */
  onOpen?: (key: string) => void
  empty?: string
}

function Item({ it, col, linked }: { it: ColumnItem; col: ColumnSpec; linked: boolean | null }) {
  const sel = col.selected === it.key
  return (
    <div className="sa-col__item" data-selected={sel} data-linked={linked === true}>
      <button className="sa-col__main" onClick={() => col.onSelect(it.key)} title={it.line || it.title}>
        <span className="sa-col__title">{it.title}{it.tag && <span className="sa-col__tag">{it.tag}</span>}</span>
        {it.line && <span className="sa-col__line">{it.line}</span>}
      </button>
      <span className="sa-col__acts">
        {sel && col.onOpen && <button className="sa-icon-btn" title="Open" aria-label={`Open ${it.title}`} onClick={() => col.onOpen!(it.key)}><Icon icon="lucide:panel-right-open" /></button>}
        {linked === true && col.onDetach && <button className="sa-icon-btn sa-col__detach" title={`Detach from ${col.linkedTo}`} aria-label={`Detach ${it.title}`} onClick={() => col.onDetach!(it.key)}><Icon icon="lucide:unlink" /></button>}
        {linked === false && col.onAttach && <button className="sa-icon-btn sa-col__attach" title={`Attach to ${col.linkedTo}`} aria-label={`Attach ${it.title}`} onClick={() => col.onAttach!(it.key)}><Icon icon="lucide:plus" /></button>}
      </span>
    </div>
  )
}

function Column({ col }: { col: ColumnSpec }) {
  const [q, setQ] = useState('')
  const match = (it: ColumnItem) => !q || `${it.title} ${it.key} ${it.line ?? ''}`.toLowerCase().includes(q.toLowerCase())
  const byKey = new Map(col.items.map((i) => [i.key, i]))
  const linked = col.linked ? col.linked.map((k) => byKey.get(k)).filter((x): x is ColumnItem => !!x) : null
  const rest = col.linked ? col.items.filter((i) => !col.linked!.includes(i.key)) : col.items
  return (
    <section className="sa-col" aria-label={col.title}>
      <header className="sa-col__head">
        <span className="sa-col__name"><Icon icon={col.icon} />{col.title}<span className="sa-col__count">{col.items.length}</span></span>
        {col.action}
      </header>
      <div className="sa-col__find"><Icon icon="lucide:search" /><input id={`col-find-${col.key}`} className="sa-col__input" placeholder="Find…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="sa-col__body">
        {linked && <>
          <div className="sa-col__group">In {col.linkedTo} <span className="sa-col__count">{linked.length}</span></div>
          {linked.filter(match).map((it) => <Item key={it.key} it={it} col={col} linked />)}
          {!linked.length && <p className="sa-col__empty">Nothing attached yet — attach from below.</p>}
          <div className="sa-col__group">Not in {col.linkedTo} <span className="sa-col__count">{rest.length}</span></div>
        </>}
        {rest.filter(match).map((it) => <Item key={it.key} it={it} col={col} linked={linked ? false : null} />)}
        {!col.items.length && <p className="sa-col__empty">{col.empty ?? 'Nothing here yet.'}</p>}
      </div>
    </section>
  )
}

export function Columns({ columns }: { columns: ColumnSpec[] }) {
  return <div className="sa-cols" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(16rem, 1fr))` }}>{columns.map((c) => <Column key={c.key} col={c} />)}</div>
}
