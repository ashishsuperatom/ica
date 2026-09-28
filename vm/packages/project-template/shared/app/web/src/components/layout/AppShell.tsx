// The app shell: the sidebar and the page, the phone header, the remembered sidebar state, the connection pill.

import { useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import Sidebar from './Sidebar'
import ConnectionStatusPill from './ConnectionStatusPill'
import { recall, remember } from '@/lib/remember'

export default function AppShell({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => (window.innerWidth < 768 ? true : recall<boolean>('sidebar-collapsed', false)))
  const handleSidebarToggle = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed)
    if (window.innerWidth >= 768) remember('sidebar-collapsed', collapsed)
  }
  return (
    <>
      <div className="sa-app__topbar">
        <button onClick={() => handleSidebarToggle(!sidebarCollapsed)} className="sa-app__menu-btn" aria-label="Menu"><Icon icon="mynaui:sidebar" /></button>
        <span className="sa-app__topbar-title">Menu</span>
      </div>
      <div className="sa-app">
        <Sidebar isCollapsed={sidebarCollapsed} onToggle={handleSidebarToggle} />
        <div className="sa-app__main">
          <div className="sa-app__pill"><ConnectionStatusPill /></div>
          <main className="sa-app__page">{children}</main>
        </div>
      </div>
    </>
  )
}
