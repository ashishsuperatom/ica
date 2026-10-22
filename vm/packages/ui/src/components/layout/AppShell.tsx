// The app shell, the same for every surface: where to go on the left, the thread in the middle, the artifacts on the
// right; the phone header; the sidebar's and the pane's states remembered per browser; the connection status.
//
// The artifacts pane: one small square at the bottom right, level with the ask bar, opens it and — in the same spot —
// closes it; closed, its badge says how many artifacts there are.

import { useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { recall, remember } from '../../lib/remember'
import { ArrangeProvider, ArrangeButton, ArrangeBar } from '../frame/arrange'

export default function AppShell({ sidebar, children, artifacts, artifactsCount, status, crumbs, wide = false, accent }: {
  /** The left: given whether it is collapsed and how to toggle it. */
  sidebar: (collapsed: boolean, toggle: (collapsed: boolean) => void) => ReactNode
  children: ReactNode
  /** The right: the artifacts of the work (a decision record, a file, a plan). */
  artifacts?: ReactNode
  /** How many there are, shown on the closed rail. */
  artifactsCount?: number
  status?: ReactNode
  /** Where you are, at the top (Breadcrumbs). */
  crumbs?: ReactNode
  /** A working console: blocks use the width there is, rather than a reading column. */
  wide?: boolean
  /** The colour of the place the page is in (its sidebar place's): the page's selections take its tint (--place-accent). */
  accent?: string
}) {
  const [collapsed, setCollapsed] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 768 ? true : recall<boolean>('sidebar-collapsed', false)))
  const [paneOpen, setPaneOpen] = useState(() => recall<boolean>('artifacts-open', false))
  const toggle = (c: boolean) => { setCollapsed(c); if (window.innerWidth >= 768) remember('sidebar-collapsed', c) }
  const pane = (o: boolean) => { setPaneOpen(o); remember('artifacts-open', o) }
  return (
    <ArrangeProvider>
      <div className="sa-app__topbar">
        <button onClick={() => toggle(!collapsed)} className="sa-app__menu-btn" aria-label="Menu"><Icon icon="solar:sidebar-minimalistic-linear" /></button>
        <span className="sa-app__topbar-title">Menu</span>
      </div>
      <div className="sa-app" data-wide={wide}>
        {sidebar(collapsed, toggle)}
        <div className="sa-app__main">
          {crumbs && <div className="sa-app__crumbs">{crumbs}</div>}
          {/* Without breadcrumbs, a slim line of its own holds the status, so nothing lies over the page's first card. */}
          {!crumbs && <div className="sa-app__topline">{status}</div>}
          {crumbs && status && <div className="sa-app__pill">{status}</div>}
          <main className="sa-app__page" style={accent ? ({ ['--place-accent' as string]: accent } as CSSProperties) : undefined}>
            {children}
            {/* Arrange is about the content: at its end, in the page's own flow (where there are cards to arrange). */}
            <div className="sa-app__page-end"><ArrangeButton /></div>
          </main>
          {/* Arranging: its bar at the top of the content area, centred on it, still while the page scrolls. */}
          <ArrangeBar />
        </div>
        {artifacts && paneOpen && (
          <aside className="sa-artifacts" aria-label="Artifacts">
            <div className="sa-artifacts__head"><span className="sa-label">Artifacts</span></div>
            <div className="sa-artifacts__body">{artifacts}</div>
          </aside>
        )}
        {/* The bottom right corner, level with the ask bar: the artifacts square — open, it closes the pane; closed, it
            says how many there are. */}
        <div className="sa-app__corner">
          {artifacts && paneOpen && (
            <button className="sa-artifacts__fab" data-open onClick={() => pane(false)} aria-expanded title="Hide the artifacts" aria-label="Hide the artifacts">
              <Icon icon="solar:sidebar-minimalistic-linear" />
            </button>
          )}
          {artifacts && !paneOpen && (
            <button className="sa-artifacts__fab" onClick={() => pane(true)} aria-expanded={false} data-has={!!artifactsCount}
              title={artifactsCount ? `${artifactsCount} artifact${artifactsCount === 1 ? '' : 's'} — show them` : 'Artifacts — nothing yet'} aria-label="Show the artifacts">
              <Icon icon="solar:documents-linear" />
              {!!artifactsCount && <span className="sa-artifacts__badge">{artifactsCount > 99 ? '99+' : artifactsCount}</span>}
            </button>
          )}
        </div>
      </div>
    </ArrangeProvider>
  )
}
