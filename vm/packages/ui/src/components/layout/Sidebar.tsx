// The sidebar: one line about the app (its name opens where the numbers come from), the places to go, and the person
// signed in at the foot. Where you are stays selected whatever step is opened below it. A column on a wide screen, a
// drawer on a small one, a rail of icons when collapsed.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'

export interface NavItem {
  key: string; label: string
  /** Drawn before the words; a plain list (conversations) goes without. */
  icon?: string; active?: boolean; onClick: () => void
  /** What can be done to the item (rename, pin…): a "…" on hover opens it; `close` shuts it after a choice. */
  menu?: (close: () => void) => ReactNode
}
export interface NavGroup { label?: string; items: NavItem[] }

export default function Sidebar({ name, logo, connected, statusWord, onAbout, groups, foot, collapsed, onToggle }: {
  name: string; logo?: string; connected: boolean; statusWord?: string; onAbout?: () => void
  groups: NavGroup[]; foot?: (rail: boolean) => ReactNode; collapsed: boolean; onToggle: (collapsed: boolean) => void
}) {
  const close = () => typeof window !== 'undefined' && window.innerWidth < 768 && onToggle(true)
  const go = (i: NavItem) => { i.onClick(); close() }
  const word = statusWord ?? (connected ? 'Connected' : 'Reconnecting…')
  const dot = <span className="sa-dot" style={{ background: connected ? 'var(--win)' : 'var(--warn)' }} title={word} />
  return (
    <>
      {!collapsed && <div className="sa-sidebar__scrim" onClick={() => onToggle(true)} />}
      <aside className="sa-sidebar" data-collapsed={collapsed}>
        {!collapsed ? (<>
          <div className="sa-sidebar__head">
            <button onClick={() => { onAbout?.(); close() }} className="sa-sidebar__brand" title={`${word} · where the numbers come from`}>
              {logo && <img src={logo} alt="" className="sa-sidebar__logo" />}
              <span className="sa-sidebar__name truncate">{name}</span>
              {dot}
            </button>
            <button onClick={() => onToggle(true)} className="sa-icon-btn sa-icon-btn--lg" title="Collapse sidebar" aria-label="Collapse sidebar"><Icon icon="solar:sidebar-minimalistic-linear" /></button>
          </div>
          <nav className="sa-sidebar__nav sa-scroll-hide" aria-label="Sections">
            <NavList groups={groups} onGo={close} />
          </nav>
          {foot && <div className="sa-sidebar__foot">{foot(false)}</div>}
        </>) : (<>
          <div className="sa-sidebar__head sa-sidebar__head--centred">
            <button onClick={() => onToggle(false)} className="sa-icon-btn sa-icon-btn--lg" title="Expand sidebar" aria-label="Expand sidebar"><Icon icon="solar:sidebar-minimalistic-linear" /></button>
          </div>
          <div className="sa-sidebar__rail">
            {groups[0]?.items.map((i) => (
              <button key={i.key} onClick={() => go(i)} data-active={!!i.active} className="sa-nav-item sa-nav-item--rail" title={i.label}><Icon icon={i.icon ?? 'solar:chat-round-line-linear'} /></button>
            ))}
          </div>
          <div className="sa-sidebar__foot sa-sidebar__foot--rail">
            <button onClick={() => onAbout?.()} className="sa-icon-btn" title={`${word} · where the numbers come from`}>{dot}</button>
            {foot?.(true)}
          </div>
        </>)}
      </aside>
    </>
  )
}

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
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  const button = <button onClick={onGo} data-active={!!item.active} className="sa-nav-item" title={item.label}>{item.icon && <Icon icon={item.icon} />}<span className="sa-nav-item__text">{item.label}</span></button>
  if (!item.menu) return button
  return (
    <div className="sa-nav-row" ref={ref} data-open={open}>
      {button}
      <button type="button" className="sa-nav-row__more" onClick={() => setOpen((o) => !o)} title="More" aria-label={`More for ${item.label}`} aria-expanded={open}><Icon icon="solar:menu-dots-bold" /></button>
      {open && <div className="sa-menu sa-nav-row__menu" role="menu">{item.menu(() => setOpen(false))}</div>}
    </div>
  )
}
