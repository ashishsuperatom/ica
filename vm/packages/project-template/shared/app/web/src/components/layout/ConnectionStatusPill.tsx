// How the app reaches the engine right now, in the platform's pill.

import { useEffect, useState } from 'react'
import { ConnectionStatus } from '@superatom/ui'
import { useApp } from '@/lib/catalog'

export default function ConnectionStatusPill() {
  const { client } = useApp()
  const [, tick] = useState(0)
  useEffect(() => client.onStatus(() => tick((n) => n + 1)), [client])
  return <ConnectionStatus status={client.status() === 'closed' ? 'reconnecting' : client.status() as 'open' | 'connecting' | 'rejected' | 'mock'} message={client.message() || undefined} />
}
