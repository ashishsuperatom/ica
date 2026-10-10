// The sidebar: the kit's two-level sidebar with one place, the app, whose panel lists Home and the scenarios' roots,
// each starting a fresh thread. The selection marks the root the current thread was started from (or Home) and stays
// there whatever block is opened below it. The Superatom mark opens the sources block; the connection sits in the
// panel's head; the person signed in sits at the foot.

import { useEffect, useState } from 'react'
import { ConnectionStatus, NavList, RailSidebar, type Connection } from '@superatom/ui'
import UserProfile from './UserProfile'
import { scenarios, useApp } from '@/lib/catalog'
import type { Status } from '@/lib/client'
import { useThread } from '@/runtime/thread'

/** The client's state in the kit's words: a closed socket is one being reconnected. */
const connection = (s: Status): Connection => (s === 'closed' ? 'reconnecting' : s)

export default function Sidebar({ isCollapsed, onToggle }: { isCollapsed: boolean; onToggle: (collapsed: boolean) => void }) {
  const { catalog, client } = useApp()
  const thread = useThread()
  const [status, setStatus] = useState(() => client.status())
  useEffect(() => client.onStatus(() => setStatus(client.status())), [client])
  const startedFrom = thread.blocks[0]?.question.focus ?? 'home'
  const items = [
    { key: 'home', label: 'Home', icon: 'lucide:home', active: thread.blocks.length === 0, onClick: () => thread.home() },
    ...scenarios(catalog).flatMap(({ scenario, root }) => (root ? [{ key: root.focus, label: root.label, icon: catalog.scenarios.find((s) => s.key === scenario)?.icon ?? 'lucide:layout-grid', active: thread.blocks.length > 0 && startedFrom === root.focus, onClick: () => thread.start(root.focus) }] : [])),
  ]
  const place = { key: 'app', label: catalog.project.name, icon: 'lucide:layout-grid', panel: <NavList groups={[{ items }]} />, actions: <ConnectionStatus status={connection(status)} /> }
  return (
    <RailSidebar name={catalog.project.name} places={[place]} current="app" pinned={!isCollapsed} onPin={(p) => onToggle(!p)}
      onMark={() => thread.openAbout()} markTitle="Sources" onHome={() => thread.home()} foot={<UserProfile showName={false} />} />
  )
}
