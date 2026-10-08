// The sidebar's lists: groups of places under their labels, each place a row with an optional "…" menu and quick
// actions. The two-level sidebar (RailSidebar) shows them in its panel.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'

export interface NavItem {
  key: string; label: string
  /** Drawn before the words; a plain list (conversations) goes without. */
  icon?: string; active?: boolean; onClick: () => void
  /** What can be done to the item (rename, pin…): a "…" on hover opens it; `close` shuts it after a choice. */
  menu?: (close: () => void) => ReactNode
  /** Quick actions beside the "…" on hover (pin): the name gives them room. */
  quick?: { key: string; icon: string; label: string; onClick: () => void }[]
}
export interface NavGroup { label?: string; items: NavItem[] }

/** Groups of places, each under its label. `onGo` runs after a place is picked (a drawer closes). */
export function NavList({ groups, onGo }: { groups: NavGroup[]; onGo?: () => void }) {
  return <>{groups.map((g, gi) => (
    <div key={g.label ?? gi} className="sa-sidebar__group">
      {g.label && <div className="sa-label sa-sidebar__group-label">{g.label}</div>}
      {g.items.map((i) => <NavRow key={i.key} item={i} onGo={() => { i.onClick(); onGo?.() }} />)}
    </div>
  ))}</>
}

/** One place in the sidebar, with its "…" menu when it has one. */
function NavRow({ item, onGo }: { item: NavItem; onGo: () => void }) {
  const [open, setOpen] = useState(false)
  // Where the menu opens: from the "…" that was clicked — below it, starting at it, kept inside the window.
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setAt({ top: Math.min(r.bottom + 4, window.innerHeight - 240), left: Math.min(r.left, window.innerWidth - 232) })
    setOpen((o) => !o)
  }
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  const button = <button onClick={onGo} data-active={!!item.active} className="sa-nav-item" title={item.label}>{item.icon && <Icon icon={item.icon} />}<span className="sa-nav-item__text">{item.label}</span></button>
  if (!item.menu && !item.quick?.length) return button
  return (
    <div className="sa-nav-row" ref={ref} data-open={open} data-active={!!item.active}>
      {button}
      <span className="sa-nav-row__acts">
        {item.menu && <button type="button" className="sa-nav-row__act" onClick={toggle} title="More" aria-label={`More for ${item.label}`} aria-expanded={open}><Icon icon="solar:menu-dots-bold" /></button>}
        {item.quick?.map((q) => <button key={q.key} type="button" className="sa-nav-row__act" onClick={q.onClick} title={q.label} aria-label={q.label}><Icon icon={q.icon} /></button>)}
      </span>
      {open && item.menu && <div className="sa-menu sa-menu--list sa-nav-row__menu" role="menu" style={{ top: at.top, left: at.left }} onClick={(e) => { if ((e.target as HTMLElement).closest('[data-menu-close]')) setOpen(false) }}>{item.menu(() => setOpen(false))}</div>}
    </div>
  )
}
