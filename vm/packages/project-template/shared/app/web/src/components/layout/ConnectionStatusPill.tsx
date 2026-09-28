// A small pill saying how the app reaches the engine right now.

import { useEffect, useState } from 'react'
import { useApp } from '@/lib/catalog'

export default function ConnectionStatusPill() {
  const { client } = useApp()
  const [, tick] = useState(0)
  useEffect(() => client.onStatus(() => tick((n) => n + 1)), [client])
  const status = client.status()
  const colour = status === 'open' ? 'var(--win)' : status === 'mock' ? 'var(--series-2)' : status === 'rejected' ? 'var(--loss)' : 'var(--warn)'
  const word = status === 'open' ? 'Connected' : status === 'mock' ? 'Mock data' : status === 'rejected' ? 'Rejected' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'
  return (
    <span className="sa-status" title={client.message() || word}>
      <span className="sa-dot" style={{ background: colour }} />
      {word}
      {client.message() && status !== 'mock' && <span className="sa-status__detail">· {client.message()}</span>}
    </span>
  )
}
