// The application in the platform's shell: this application's sidebar, its thread, its connection.

import type { ReactNode } from 'react'
import { AppShell as Shell } from '@superatom/ui'
import Sidebar from './Sidebar'
import ConnectionStatusPill from './ConnectionStatusPill'

export default function AppShell({ children }: { children: ReactNode }) {
  return <Shell sidebar={(collapsed, toggle) => <Sidebar isCollapsed={collapsed} onToggle={toggle} />} status={<ConnectionStatusPill />}>{children}</Shell>
}
