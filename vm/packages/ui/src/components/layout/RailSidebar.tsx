// The two-level sidebar: a thin rail that is always there, with the big places (home, agents…) and the person at its
// foot; beside it the panel of the place picked in the rail — its own list (conversations, agents…). Pinned, both show.
// Unpinned, the rail alone shows, and resting on a rail place opens its panel over the page until the pointer leaves —
// clicking a place opens its panel and keeps it (pinned); a panel resting over the page floats, a pinned one sits flat;
// pinned, resting on another place shows its panel in the same spot for as long as the pointer stays.
// On a phone it is a drawer holding both.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { recall, remember } from '../../lib/remember'
import SuperatomMark from './SuperatomMark'
import { NavList } from './Sidebar'

/** How wide the panel may be dragged, in pixels. */
const PANEL_MIN = 200, PANEL_MAX = 440

export interface RailPlace {
  key: string; label: string; icon: string
  /** The place's own colour: its icon always, a light tint of it behind when hovered or where one is. */
  accent?: string
  /** Going there (a page); a place with a panel opens its panel too. */
  onClick?: () => void
  /** The place's own list, shown beside the rail. */
  panel?: ReactNode
  /** Small icon buttons in the panel's head beside the name (activity, search). */
  actions?: ReactNode
}

export default function RailSidebar({ name, places: given, current, foot, pinned, onPin, onMark, markTitle = 'About Superatom', onHome }: {
  name: string
  /** The project's name at the panel's head opens its home. */
  onHome: () => void
  /** The Superatom mark at the top of the rail, always there, and what it opens (the about page; the console's top). */
  onMark: () => void; markTitle?: string
  places: RailPlace[]
  /** The rail place where the person is. */
  current: string
  /** The person, at the rail's foot. */
  foot?: ReactNode
  /** Pinned: the panel stays beside the rail (on a phone: the drawer is open). */
  pinned: boolean; onPin: (pinned: boolean) => void
}) {
  const phone = () => typeof window !== 'undefined' && window.innerWidth < 768
  // Every place has a panel: one without pages of its own shows itself as the one row. So resting on any place shows
  // a panel, a click on any place pins it, and a pinned panel always has something in it.
  const places: (RailPlace & { panel: ReactNode })[] = given.map((p) => p.panel ? p as RailPlace & { panel: ReactNode } : { ...p,
    panel: <NavList groups={[{ label: p.label, items: [{ key: p.key, label: p.label, icon: p.icon, active: p.key === current, onClick: () => p.onClick?.() }] }]} /> })
  const isPlace = (k: string) => places.some((p) => p.key === k)
  // Whose panel is shown: where the person is, or the place last picked; on a page of no place (about), the last one.
  const [shown, setShown] = useState(isPlace(current) ? current : places[0]?.key ?? '')
  useEffect(() => { if (isPlace(current)) setShown(current) }, [current])   // eslint-disable-line react-hooks/exhaustive-deps
  const [peek, setPeek] = useState<string | null>(null)   // unpinned: the place whose panel is open over the page
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hold = () => clearTimeout(leave.current)
  const away = () => { hold(); leave.current = setTimeout(() => setPeek(null), 220) }
  useEffect(() => () => clearTimeout(leave.current), [])
  // The panel's width: dragged at its right edge between PANEL_MIN and PANEL_MAX, kept in this browser.
  const [width, setWidth] = useState(() => { const w = recall<number>('sidebar-panel-w', 0); return w >= PANEL_MIN && w <= PANEL_MAX ? w : 0 })
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const panel = (e.currentTarget.parentElement as HTMLElement), x0 = e.clientX, w0 = panel.getBoundingClientRect().width
    let w = w0
    const move = (m: PointerEvent) => { w = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w0 + m.clientX - x0))); setWidth(w) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; remember('sidebar-panel-w', w) }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const open = peek ?? (pinned ? shown : null)
  const place = places.find((p) => p.key === open) ?? null
  const pick = (p: RailPlace) => {
    clearTimeout(leave.current)
    setShown(p.key); setPeek(null); if (!pinned && !phone()) onPin(true)
    p.onClick?.()
  }
  return (
    <>
      {pinned && <div className="sa-sidebar__scrim" onClick={() => onPin(false)} />}
      <aside className="sa-railbar" data-pinned={pinned} onMouseLeave={away} onMouseEnter={hold}>
        <nav className="sa-railbar__rail" aria-label="Places">
          <button type="button" className="sa-railbar__mark" data-active={current === 'about'} title={markTitle} aria-label={markTitle} onClick={onMark}
            onMouseEnter={() => { if (!pinned) setPeek(null) }}><SuperatomMark size={26} /></button>
          {places.map((p) => (
            <button key={p.key} type="button" className="sa-railbar__place" style={p.accent ? { '--accent': p.accent } as React.CSSProperties : undefined} data-active={p.key === current} data-open={p.key === open}
              title={p.label} aria-label={p.label} onClick={() => pick(p)}
              onMouseEnter={() => { if (!phone()) { hold(); setPeek(p.key) } }}>
              <Icon icon={p.icon} />
            </button>
          ))}
          <span className="sa-railbar__gap" />
          {foot}
        </nav>
        {place && (
          <div className="sa-railbar__panel" data-floating={!pinned} style={{ ...(width ? { width } : {}), ...(place.accent ? { '--accent': place.accent } : {}) } as React.CSSProperties}>
            <div className="sa-sidebar__head">
              <button type="button" className="sa-sidebar__brand" title={`${name} — home`} onClick={() => { onHome(); if (phone()) onPin(false) }}><span className="sa-sidebar__name truncate">{name}</span></button>
              {place.actions}
              <button type="button" onClick={() => { clearTimeout(leave.current); onPin(!pinned); setPeek(null) }} data-on={pinned} aria-pressed={pinned} className="sa-icon-btn sa-icon-btn--lg"
                title={pinned ? 'Close the side panel' : 'Keep the side panel open'} aria-label={pinned ? 'Close the side panel' : 'Keep the side panel open'}><Icon icon="solar:sidebar-minimalistic-linear" /></button>
            </div>
            <div className="sa-sidebar__nav sa-scroll-hide" onClick={(e) => { if (phone() && (e.target as HTMLElement).closest('.sa-nav-item')) onPin(false) }}>{place.panel}</div>
            <div className="sa-railbar__resize" role="separator" aria-orientation="vertical" aria-label="Drag to widen or narrow the side panel" title="Drag to widen; double-click for the usual width"
              onPointerDown={drag} onDoubleClick={() => { setWidth(0); remember('sidebar-panel-w', 0) }} />
          </div>
        )}
      </aside>
    </>
  )
}
