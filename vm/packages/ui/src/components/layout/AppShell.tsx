// The app shell, the same for every surface: where to go on the left, the thread in the middle, the artifacts on the
// right; the phone header; the sidebar's and the pane's states remembered per browser; the connection status.
//
// The artifacts pane opens and closes from one place: its head's top-right corner. Closed, it narrows to a rail whose
// head holds the same button in the same corner.

import { useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { recall, remember } from '../../lib/remember'

export default function AppShell({ sidebar, children, artifacts, artifactsCount, status }: {
  /** The left: given whether it is collapsed and how to toggle it. */
  sidebar: (collapsed: boolean, toggle: (collapsed: boolean) => void) => ReactNode
  children: ReactNode
  /** The right: the artifacts of the work (a decision record, a file, a plan). */
  artifacts?: ReactNode
  /** How many there are, shown on the closed rail. */
  artifactsCount?: number
  status?: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 768 ? true : recall<boolean>('sidebar-collapsed', false)))
  const [paneOpen, setPaneOpen] = useState(() => recall<boolean>('artifacts-open', true))
  const toggle = (c: boolean) => { setCollapsed(c); if (window.innerWidth >= 768) remember('sidebar-collapsed', c) }
  const pane = (o: boolean) => { setPaneOpen(o); remember('artifacts-open', o) }
  return (
    <>
      <div className="sa-app__topbar">
        <button onClick={() => toggle(!collapsed)} className="sa-app__menu-btn" aria-label="Menu"><Icon icon="mynaui:sidebar" /></button>
        <span className="sa-app__topbar-title">Menu</span>
      </div>
      <div className="sa-app">
        {sidebar(collapsed, toggle)}
        <div className="sa-app__main">
          {status && <div className="sa-app__pill">{status}</div>}
          <main className="sa-app__page">{children}</main>
        </div>
        {artifacts && (
          <aside className={`sa-artifacts${paneOpen ? '' : ' sa-artifacts--rail'}`} aria-label="Artifacts">
            <div className="sa-artifacts__head">
              {paneOpen && <span className="sa-label">Artifacts</span>}
              <button className="sa-icon-btn sa-artifacts__toggle" onClick={() => pane(!paneOpen)} aria-expanded={paneOpen}
                title={paneOpen ? 'Hide the artifacts' : 'Show the artifacts'} aria-label={paneOpen ? 'Hide the artifacts' : 'Show the artifacts'}>
                <Icon icon={paneOpen ? 'lucide:panel-right-close' : 'lucide:panel-right-open'} />
              </button>
            </div>
            {paneOpen
              ? <div className="sa-artifacts__body">{artifacts}</div>
              : !!artifactsCount && <button className="sa-artifacts__count" onClick={() => pane(true)} title={`${artifactsCount} artifacts`}>{artifactsCount}</button>}
          </aside>
        )}
      </div>
    </>
  )
}
