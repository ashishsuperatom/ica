// The two-level sidebar: a thin rail that is always there (the Superatom mark, the big places, the person at its foot)
// and beside it the panel of one place.
//
// What shows is decided by three plain values: the place chosen (where a pinned panel rests: the place of the page the
// person is on, or one they clicked in the rail since they came to this page), the place pointed at (only while the
// pointer is over the sidebar), and pinned. The panel is the pointed place's, else the
// chosen one's; it shows when pinned or while pointing. Clicking a place chooses it and pins; the toggle in the
// panel's head pins and unpins. Every place has a panel — one with nothing under it shows an empty one. On a phone
// the whole sidebar is a drawer.

import { useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { recall, remember } from '../../lib/remember'
import SuperatomMark from './SuperatomMark'
import { NavList } from './Sidebar'

/** How wide the panel may be dragged, in pixels. */
const PANEL_MIN = 200, PANEL_MAX = 440

export interface RailPlace {
  key: string; label: string; icon: string
  /** The place's own colour: its icon always, faded. */
  accent?: string
  /** Going there (a page), on a click. */
  onClick?: () => void
  /** The place's own list, shown in the panel; without it the panel is empty. */
  panel?: ReactNode
  /** Small icon buttons in the panel's head beside the name (activity, search). */
  actions?: ReactNode
}

export default function RailSidebar({ name, places, current, foot, pinned, onPin, onMark, markTitle = 'About Superatom', onHome }: {
  name: string
  places: RailPlace[]
  /** The rail place where the person is (marked in the rail; the panel opens on it first). */
  current: string
  /** The person, at the rail's foot. */
  foot?: ReactNode
  /** Pinned: the panel stays beside the rail (on a phone: the drawer is open). */
  pinned: boolean; onPin: (pinned: boolean) => void
  /** The Superatom mark at the top of the rail, and what it opens. */
  onMark: () => void; markTitle?: string
  /** The name at the panel's head opens its home. */
  onHome: () => void
}) {
  // The panel opens on the place where the person is, unless they clicked another rail place since they got here. A click
  // is forgotten the moment the place changes (the page moved: from the panel, a link, anywhere) — so a click made on
  // one visit never comes back on a later visit to the same place. One value decides what the panel shows: `chosen`.
  const [clicked, setClicked] = useState<string | null>(null)
  const [at, setAt] = useState(current)
  if (at !== current) { setAt(current); setClicked(null) }   // adjusted while rendering: never one frame of the old click
  const chosen = (at === current && clicked) || (places.some((p) => p.key === current) ? current : places[0]?.key ?? '')
  const setChosen = (key: string) => setClicked(key)
  const [pointed, setPointed] = useState<string | null>(null)
  const phone = () => typeof window !== 'undefined' && window.innerWidth < 768
  const place = places.find((p) => p.key === (pointed ?? chosen)) ?? places[0]
  const showPanel = !!place && (pinned || pointed !== null)

  // The panel's width: dragged at its right edge between PANEL_MIN and PANEL_MAX, kept in this browser.
  const [width, setWidth] = useState(() => { const w = recall<number>('sidebar-panel-w', 0); return w >= PANEL_MIN && w <= PANEL_MAX ? w : 0 })
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const x0 = e.clientX, w0 = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width
    let w = w0
    const move = (m: PointerEvent) => { w = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w0 + m.clientX - x0))); setWidth(w) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; remember('sidebar-panel-w', w) }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  return (
    <>
      {pinned && <div className="sa-sidebar__scrim" onClick={() => onPin(false)} />}
      <aside className="sa-railbar" data-pinned={pinned} onMouseLeave={() => setPointed(null)}>
        <nav className="sa-railbar__rail" aria-label="Places">
          <button type="button" className="sa-railbar__mark" data-active={current === 'about'} title={markTitle} aria-label={markTitle} onClick={onMark}><SuperatomMark size={26} /></button>
          {places.map((p) => (
            <button key={p.key} type="button" className="sa-railbar__place" style={p.accent ? { '--accent': p.accent } as React.CSSProperties : undefined}
              data-active={p.key === current} data-open={showPanel && p.key === place?.key} title={p.label} aria-label={p.label}
              onMouseEnter={() => { if (!phone()) setPointed(p.key) }}
              onClick={() => { setChosen(p.key); setPointed(null); if (!pinned && !phone()) onPin(true); p.onClick?.() }}>
              <Icon icon={p.icon} />
            </button>
          ))}
          <span className="sa-railbar__gap" />
          {foot}
        </nav>
        {showPanel && place && (
          <div className="sa-railbar__panel" data-floating={!pinned} style={{ ...(width ? { width } : {}), ...(place.accent ? { '--accent': place.accent } : {}) } as React.CSSProperties}>
            <div className="sa-sidebar__head">
              <button type="button" className="sa-sidebar__brand" title={`${name} — home`} onClick={() => { onHome(); if (phone()) onPin(false) }}><span className="sa-sidebar__name truncate">{name}</span></button>
              {place.actions}
              <button type="button" onClick={() => { if (!pinned) setChosen(place.key); onPin(!pinned) }} data-on={pinned} aria-pressed={pinned} className="sa-icon-btn sa-icon-btn--lg"
                title={pinned ? 'Close the side panel' : 'Keep the side panel open'} aria-label={pinned ? 'Close the side panel' : 'Keep the side panel open'}><Icon icon="solar:sidebar-minimalistic-linear" /></button>
            </div>
            <div className="sa-sidebar__nav sa-scroll-hide" onClick={(e) => { if (phone() && (e.target as HTMLElement).closest('.sa-nav-item')) onPin(false) }}>
              {place.panel ?? <NavList groups={[{ label: place.label, items: [] }]} />}
            </div>
            <div className="sa-railbar__resize" role="separator" aria-orientation="vertical" aria-label="Drag to widen or narrow the side panel" title="Drag to widen; double-click for the usual width"
              onPointerDown={drag} onDoubleClick={() => { setWidth(0); remember('sidebar-panel-w', 0) }} />
          </div>
        )}
      </aside>
    </>
  )
}
