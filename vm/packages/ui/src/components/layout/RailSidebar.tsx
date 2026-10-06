// The two-level sidebar: a thin rail that is always there, with the big places (home, agents…) and the person at its
// foot; beside it the panel of the place picked in the rail — its own list (conversations, agents…). Pinned, both show.
// Unpinned, the rail alone shows, and resting on a rail place opens its panel over the page until the pointer leaves.
// On a phone it is a drawer holding both.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { recall, remember } from '../../lib/remember'

/** How wide the panel may be dragged, in pixels. */
const PANEL_MIN = 200, PANEL_MAX = 440

export interface RailPlace {
  key: string; label: string; icon: string
  /** Going there (a page); a place with a panel opens its panel too. */
  onClick?: () => void
  /** The place's own list, shown beside the rail. */
  panel?: ReactNode
  /** Small icon buttons in the panel's head beside the name (activity, search). */
  actions?: ReactNode
}

export default function RailSidebar({ name, connected, statusWord, places, current, foot, pinned, onPin }: {
  name: string; connected: boolean; statusWord?: string
  places: RailPlace[]
  /** The rail place where the person is. */
  current: string
  /** The person, at the rail's foot. */
  foot?: ReactNode
  /** Pinned: the panel stays beside the rail (on a phone: the drawer is open). */
  pinned: boolean; onPin: (pinned: boolean) => void
}) {
  const phone = () => typeof window !== 'undefined' && window.innerWidth < 768
  // Whose panel is shown: where the person is, or the place last picked; on a page of no place (profile), the last one.
  const [shown, setShown] = useState(current || places.find((p) => p.panel)?.key || '')
  useEffect(() => { if (current) setShown(current) }, [current])
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
  const open = pinned ? shown : peek
  const place = places.find((p) => p.key === open && p.panel) ?? null
  const word = statusWord ?? (connected ? 'Connected' : 'Reconnecting…')
  const pick = (p: RailPlace) => {
    if (p.panel) { setShown(p.key); if (!pinned) setPeek(p.key) }
    p.onClick?.()
  }
  return (
    <>
      {pinned && <div className="sa-sidebar__scrim" onClick={() => onPin(false)} />}
      <aside className="sa-railbar" data-pinned={pinned} onMouseLeave={away} onMouseEnter={hold}>
        <nav className="sa-railbar__rail" aria-label="Places">
          {places.map((p) => (
            <button key={p.key} type="button" className="sa-railbar__place" data-active={p.key === current} data-open={p.key === open && !!p.panel}
              title={p.label} aria-label={p.label} onClick={() => pick(p)}
              onMouseEnter={() => { if (!pinned && !phone()) { hold(); setPeek(p.panel ? p.key : null) } }}>
              <Icon icon={p.icon} />
            </button>
          ))}
          <span className="sa-railbar__gap" />
          <span className="sa-dot" style={{ background: connected ? 'var(--win)' : 'var(--warn)' }} title={word} />
          {foot}
        </nav>
        {place && (
          <div className="sa-railbar__panel" data-floating={!pinned} style={width ? { width } : undefined}>
            <div className="sa-sidebar__head">
              <span className="sa-sidebar__brand" title={name}><span className="sa-sidebar__name truncate">{name}</span></span>
              {place.actions}
              <button type="button" onClick={() => { onPin(!pinned); setPeek(null) }} className="sa-icon-btn sa-icon-btn--lg"
                title={pinned ? 'Close the side panel' : 'Keep the side panel open'} aria-label={pinned ? 'Close the side panel' : 'Keep the side panel open'}><Icon icon="mynaui:sidebar" /></button>
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
