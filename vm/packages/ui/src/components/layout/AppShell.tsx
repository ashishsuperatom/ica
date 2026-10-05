// The app shell, the same for every surface: where to go on the left, the thread in the middle, the artifacts on the
// right; the phone header; the sidebar's and the pane's states remembered per browser; the connection status.
//
// The artifacts pane: open, its head's button closes it; closed, it is a small square at the bottom right, level with the
// ask bar, with a badge saying how many artifacts there are, and opens it.

import { useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { recall, remember } from '../../lib/remember'
import { ArrangeProvider, ArrangeButton } from '../frame/arrange'

export default function AppShell({ sidebar, children, artifacts, artifactsCount, status, crumbs, wide = false }: {
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
}) {
  const [collapsed, setCollapsed] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 768 ? true : recall<boolean>('sidebar-collapsed', false)))
  const [paneOpen, setPaneOpen] = useState(() => recall<boolean>('artifacts-open', false))
  const toggle = (c: boolean) => { setCollapsed(c); if (window.innerWidth >= 768) remember('sidebar-collapsed', c) }
  const pane = (o: boolean) => { setPaneOpen(o); remember('artifacts-open', o) }
  return (
    <ArrangeProvider>
      <div className="sa-app__topbar">
        <button onClick={() => toggle(!collapsed)} className="sa-app__menu-btn" aria-label="Menu"><Icon icon="mynaui:sidebar" /></button>
        <span className="sa-app__topbar-title">Menu</span>
      </div>
      <div className="sa-app" data-wide={wide}>
        {sidebar(collapsed, toggle)}
        <div className="sa-app__main">
          {crumbs && <div className="sa-app__crumbs">{crumbs}</div>}
          {status && <div className="sa-app__pill">{status}</div>}
          <main className="sa-app__page">{children}</main>
        </div>
        {artifacts && paneOpen && (
          <aside className="sa-artifacts" aria-label="Artifacts">
            <div className="sa-artifacts__head">
              <span className="sa-label">Artifacts</span>
              <button className="sa-icon-btn sa-artifacts__toggle" onClick={() => pane(false)} aria-expanded title="Hide the artifacts" aria-label="Hide the artifacts">
                <Icon icon="lucide:panel-right-close" />
              </button>
            </div>
            <div className="sa-artifacts__body">{artifacts}</div>
          </aside>
        )}
        {/* Closed, the pane is a small square at the bottom right, level with the ask bar, saying how many there are. */}
        {artifacts && !paneOpen && (
          <button className="sa-artifacts__fab" onClick={() => pane(true)} aria-expanded={false} data-has={!!artifactsCount}
            title={artifactsCount ? `${artifactsCount} artifact${artifactsCount === 1 ? '' : 's'} — show them` : 'Artifacts — nothing yet'} aria-label="Show the artifacts">
            <Icon icon="lucide:files" />
            {!!artifactsCount && <span className="sa-artifacts__badge">{artifactsCount > 99 ? '99+' : artifactsCount}</span>}
          </button>
        )}
        {/* Arrange: every block's cards (and every arranged page's) moved up or down, kept in this browser. */}
        <div className="sa-app__arrange" data-beside-artifacts={!!artifacts && !paneOpen}><ArrangeButton /></div>
      </div>
    </ArrangeProvider>
  )
}
