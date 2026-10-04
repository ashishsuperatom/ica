// The sidebar: Home and the scenarios' roots, each starting a fresh thread. The selection marks the root the current
// thread was started from (or Home) and stays there whatever block is opened below it. The app name opens the
// sources block; the person signed in sits at the foot.

import { useEffect, useState } from 'react'
import { Sidebar as Side } from '@superatom/ui'
import UserProfile from './UserProfile'
import { scenarios, useApp } from '@/lib/catalog'
import { useThread } from '@/runtime/thread'

export default function Sidebar({ isCollapsed, onToggle }: { isCollapsed: boolean; onToggle: (collapsed: boolean) => void }) {
  const { catalog, client } = useApp()
  const thread = useThread()
  const [connected, setConnected] = useState(client.status() === 'open' || client.status() === 'mock')
  useEffect(() => client.onStatus(() => setConnected(client.status() === 'open' || client.status() === 'mock')), [client])
  const startedFrom = thread.blocks[0]?.question.focus ?? 'home'
  const items = [
    { key: 'home', label: 'Home', icon: 'lucide:home', active: thread.blocks.length === 0, onClick: () => thread.home() },
    ...scenarios(catalog).flatMap(({ scenario, root }) => (root ? [{ key: root.focus, label: root.label, icon: catalog.scenarios.find((s) => s.key === scenario)?.icon ?? 'lucide:layout-grid', active: thread.blocks.length > 0 && startedFrom === root.focus, onClick: () => thread.start(root.focus) }] : [])),
  ]
  return (
    <Side name={catalog.project.name} logo="./sa-logo.png" connected={connected} statusWord={client.status() === 'mock' ? 'Mock data' : undefined}
      onAbout={() => thread.openAbout()} groups={[{ items }]} collapsed={isCollapsed} onToggle={onToggle}
      foot={(rail) => <UserProfile showName={!rail} />} />
  )
}
