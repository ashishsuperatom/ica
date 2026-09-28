// The sidebar: Home and the three roots. Each root starts a fresh thread. The selection marks the root the current
// thread was started from (or Home) and stays there whatever block is opened below it. The app name opens the
// sources block; the person signed in sits at the foot. A column on a wide screen, a drawer on a small one.

import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import UserProfile from './UserProfile'
import { scenarios, useApp } from '@/lib/catalog'
import { useThread } from '@/runtime/thread'


export default function Sidebar({ isCollapsed, onToggle }: { isCollapsed: boolean; onToggle: (collapsed: boolean) => void }) {
  const { catalog, client } = useApp()
  const thread = useThread()
  const [connected, setConnected] = useState(client.status() === 'open' || client.status() === 'mock')
  useEffect(() => client.onStatus(() => setConnected(client.status() === 'open' || client.status() === 'mock')), [client])

  const nav = [
    { key: 'home', label: 'Home', icon: 'lucide:home', go: () => thread.home() },
    ...scenarios(catalog).flatMap(({ scenario, root }) => (root ? [{ key: root.focus, label: root.label, icon: catalog.scenarios.find((s) => s.key === scenario)?.icon ?? 'lucide:layout-grid', go: () => thread.start(root.focus) }] : [])),
  ]
  const startedFrom = thread.blocks[0]?.question.focus ?? 'home'
  const isActive = (key: string) => (key === 'home' ? thread.blocks.length === 0 : startedFrom === key)
  const closeOnMobile = () => window.innerWidth < 768 && onToggle(true)
  const go = (item: { go: () => void }) => { item.go(); closeOnMobile() }
  const about = () => { thread.openAbout(); closeOnMobile() }
  const status = client.status() === 'mock' ? 'Mock data' : connected ? 'Connected' : 'Reconnecting…'
  const dot = <span className="sa-dot" style={{ background: client.status() === 'mock' ? 'var(--series-2)' : connected ? 'var(--win)' : 'var(--warn)' }} title={status} />

  return (
    <>
      {!isCollapsed && <div className="sa-sidebar__scrim" onClick={() => onToggle(true)} />}
      <aside className="sa-sidebar" data-collapsed={isCollapsed}>
        {!isCollapsed ? (
          <>
            <div className="sa-sidebar__head">
              <button onClick={about} className="sa-sidebar__brand" title={`${status} · where the numbers come from`}>
                <img src="./sa-logo.png" alt="" className="sa-sidebar__logo" />
                <span className="sa-sidebar__name truncate">{catalog.project.name}</span>
                {dot}
              </button>
              <button onClick={() => onToggle(true)} className="sa-icon-btn sa-icon-btn--lg" title="Collapse sidebar" aria-label="Collapse sidebar"><Icon icon="mynaui:sidebar" /></button>
            </div>
            <nav className="sa-sidebar__nav sa-scroll-hide" aria-label="Sections">
              {nav.map((item) => (
                <button key={item.key} onClick={() => go(item)} data-active={isActive(item.key)} className="sa-nav-item" title={item.label}><Icon icon={item.icon} /><span className="sa-nav-item__text">{item.label}</span></button>
              ))}
            </nav>
            <div className="sa-sidebar__foot"><UserProfile showName /></div>
          </>
        ) : (
          <>
            <div className="sa-sidebar__head sa-sidebar__head--centred">
              <button onClick={() => onToggle(false)} className="sa-icon-btn sa-icon-btn--lg" title="Expand sidebar" aria-label="Expand sidebar"><Icon icon="mynaui:sidebar" /></button>
            </div>
            <div className="sa-sidebar__rail">
              {nav.map((item) => (
                <button key={item.key} onClick={() => go(item)} data-active={isActive(item.key)} className="sa-nav-item sa-nav-item--rail" title={item.label}><Icon icon={item.icon} /></button>
              ))}
            </div>
            <div className="sa-sidebar__foot sa-sidebar__foot--rail">
              <button onClick={about} className="sa-icon-btn" title={`${status} · where the numbers come from`}>{dot}</button>
              <UserProfile />
            </div>
          </>
        )}
      </aside>
    </>
  )
}
