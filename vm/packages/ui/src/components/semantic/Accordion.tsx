// AN ACCORDION OF A SELECTED THING'S DETAIL — the detail beside a graph's columns (the composition graph, the intent
// graph): every part of it a row; several may be open at once; `openOnly` closes the rest and opens one alone (scrolled into
// view within the detail panel). ↑ ↓ move between rows, Enter opens or closes one; the first row offers Open all.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'

export interface AccItem { key: string; title: ReactNode; n?: number; icon?: string; tag?: ReactNode; acts?: ReactNode; body: () => ReactNode }

/** Everything about the selected node, in one accordion: several rows may be open at once; `openOnly` (a concept picked in
 *  its column) closes the rest and opens alone. ↑ ↓ move between rows, Enter opens or closes one. */
export function Accordion({ items, openOnly = null, initial = [] }: { items: AccItem[]; openOnly?: string | null; initial?: string[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(openOnly ? [openOnly] : initial))
  const heads = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    if (!openOnly) return
    setOpen(new Set([openOnly]))
    // Into view within the detail panel only — scrollIntoView would also slide the columns sideways.
    requestAnimationFrame(() => {
      const item = heads.current[items.findIndex((x) => x.key === openOnly)]?.closest('.sa-acc__item') as HTMLElement | null
      const pane = item?.closest('.sa-col--detail') as HTMLElement | null
      if (!item || !pane) return
      const ir = item.getBoundingClientRect(), pr = pane.getBoundingClientRect()
      if (ir.top < pr.top) pane.scrollTop -= pr.top - ir.top + 8
      else if (ir.bottom > pr.bottom) pane.scrollTop += Math.min(ir.bottom - pr.bottom + 8, ir.top - pr.top - 8)
    })
  }, [openOnly])   // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const keys = (e: KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null
    if (to === null || to < 0 || to >= items.length) return
    e.preventDefault(); heads.current[to]?.focus()
  }
  const all = items.length > 0 && items.every((x) => open.has(x.key))
  const openAll = <button className="sa-btn sa-btn--link" onClick={() => setOpen(all ? new Set() : new Set(items.map((x) => x.key)))}>{all ? 'Close all' : 'Open all'}</button>
  return (
    <div className="sa-acc sa-acc--flat">
        {items.map((it, i) => {
          const isOpen = open.has(it.key)
          return (
            <section key={it.key} className="sa-acc__item" data-open={isOpen} data-head={i === 0 || undefined}>
              <div className="sa-acc__head">
                <button ref={(el) => { heads.current[i] = el }} className="sa-acc__toggle" aria-expanded={isOpen} onClick={() => toggle(it.key)} onKeyDown={(e) => keys(e, i)}>
                  <Icon icon="lucide:chevron-right" className="sa-acc__chev" />
                  <span className="sa-acc__n">{it.n !== undefined ? it.n : it.icon ? <Icon icon={it.icon} /> : null}</span>
                  <span className="sa-acc__title">{it.title}</span>
                  {it.tag}
                </button>
                {(it.acts || i === 0) && <span className="sa-acc__acts">{it.acts}{i === 0 && openAll}</span>}
              </div>
              {isOpen && <div className="sa-acc__body">{it.body()}</div>}
            </section>
          )
        })}
    </div>
  )
}
