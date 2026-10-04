// The app shell, the same for every surface: where to go on the left, the thread in the middle, the artifacts on the
// right; the phone header; the sidebar's and the pane's states remembered per browser; the connection status.

import { useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { recall, remember } from '../../lib/remember'

export default function AppShell({ sidebar, children, artifacts, status }: {
  /** The left: given whether it is collapsed and how to toggle it. */
  sidebar: (collapsed: boolean, toggle: (collapsed: boolean) => void) => ReactNode
  children: ReactNode
  /** The right: the artifacts of the work (a decision record, a file, a plan). Hidden until there is something. */
  artifacts?: ReactNode
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
        {artifacts && (paneOpen
          ? <aside className="sa-artifacts" aria-label="Artifacts">
              <div className="sa-artifacts__head">
                <span className="sa-label">Artifacts</span>
                <button className="sa-icon-btn" onClick={() => pane(false)} title="Hide the artifacts" aria-label="Hide the artifacts"><Icon icon="lucide:panel-right-close" /></button>
              </div>
              <div className="sa-artifacts__body">{artifacts}</div>
            </aside>
          : <button className="sa-artifacts__open sa-icon-btn" onClick={() => pane(true)} title="Show the artifacts" aria-label="Show the artifacts"><Icon icon="lucide:panel-right-open" /></button>)}
      </div>
    </>
  )
}
