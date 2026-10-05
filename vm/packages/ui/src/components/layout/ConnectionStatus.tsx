// How the screen reaches the platform right now: a coloured dot. When it connects or loses the connection the word shows
// beside it for a few seconds, then folds away; hovering (or focusing) the dot shows it again, with any detail.

import { useEffect, useState } from 'react'

export type Connection = 'open' | 'connecting' | 'reconnecting' | 'rejected' | 'mock'

const SAY_FOR_MS = 5000

export default function ConnectionStatus({ status, message }: { status: Connection; message?: string }) {
  const colour = status === 'open' ? 'var(--win)' : status === 'mock' ? 'var(--series-2)' : status === 'rejected' ? 'var(--loss)' : 'var(--warn)'
  const word = status === 'open' ? 'Connected' : status === 'mock' ? 'Mock data' : status === 'rejected' ? 'Rejected' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'
  // Said when it changes, then just the dot (a state that needs attention stays said until it changes).
  const [saying, setSaying] = useState(true)
  useEffect(() => {
    setSaying(true)
    if (status !== 'open' && status !== 'mock') return
    const t = setTimeout(() => setSaying(false), SAY_FOR_MS)
    return () => clearTimeout(t)
  }, [status])
  return (
    <span className="sa-status" data-saying={saying} tabIndex={0} role="status" aria-label={message ? `${word} · ${message}` : word} title={message ? `${word} · ${message}` : word}>
      <span className="sa-dot" style={{ background: colour }} />
      <span className="sa-status__words">
        {word}
        {message && status !== 'mock' && <span className="sa-status__detail">· {message}</span>}
      </span>
    </span>
  )
}
