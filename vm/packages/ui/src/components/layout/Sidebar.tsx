// The sidebar: one line about the app (its name opens where the numbers come from), the places to go, and the person
// signed in at the foot. Where you are stays selected whatever step is opened below it. A column on a wide screen, a
// drawer on a small one, a rail of icons when collapsed.

import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'

export interface NavItem { key: string; label: string; icon: string; active?: boolean; onClick: () => void }
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
            <button onClick={() => onToggle(true)} className="sa-icon-btn sa-icon-btn--lg" title="Collapse sidebar" aria-label="Collapse sidebar"><Icon icon="mynaui:sidebar" /></button>
          </div>
          <nav className="sa-sidebar__nav sa-scroll-hide" aria-label="Sections">
            {groups.map((g, gi) => (
              <div key={gi} className="sa-sidebar__group">
                {g.label && <div className="sa-label sa-sidebar__group-label">{g.label}</div>}
                {g.items.map((i) => (
                  <button key={i.key} onClick={() => go(i)} data-active={!!i.active} className="sa-nav-item" title={i.label}><Icon icon={i.icon} /><span className="sa-nav-item__text">{i.label}</span></button>
                ))}
              </div>
            ))}
          </nav>
          {foot && <div className="sa-sidebar__foot">{foot(false)}</div>}
        </>) : (<>
          <div className="sa-sidebar__head sa-sidebar__head--centred">
            <button onClick={() => onToggle(false)} className="sa-icon-btn sa-icon-btn--lg" title="Expand sidebar" aria-label="Expand sidebar"><Icon icon="mynaui:sidebar" /></button>
          </div>
          <div className="sa-sidebar__rail">
            {groups.flatMap((g) => g.items).map((i) => (
              <button key={i.key} onClick={() => go(i)} data-active={!!i.active} className="sa-nav-item sa-nav-item--rail" title={i.label}><Icon icon={i.icon} /></button>
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
