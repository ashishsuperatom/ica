// How the screen reaches the platform right now: a coloured dot. When it connects or loses the connection the word shows
// beside it for a few seconds, then folds away; hovering (or focusing) the dot shows it again, with any detail.
//
// WHILE THE PROJECT UPDATES (a new release of its engine is being switched in), the dot grows into a notice that stays
// until the update ends: that it is updating, to which version, since when — so everyone using the project knows why
// answers pause. When it ends, "Updated" shows for a few seconds and folds back to the dot.

import { useEffect, useState } from 'react'

export type Connection = 'open' | 'connecting' | 'reconnecting' | 'rejected' | 'mock'
/** The project updating: `state` 'switching' while it runs; anything else when it has ended. */
export interface Upgrading { state: string; version?: string | null; startedAt: string }

const SAY_FOR_MS = 5000

export default function ConnectionStatus({ status, message, upgrading }: { status: Connection; message?: string; upgrading?: Upgrading | null }) {
  const active = upgrading?.state === 'switching'
  const ended = !!upgrading && !active
  const colour = active ? 'var(--warn)' : status === 'open' ? 'var(--win)' : status === 'mock' ? 'var(--series-2)' : status === 'rejected' ? 'var(--loss)' : 'var(--warn)'
  const word = active ? 'Updating to a newer version' : ended && upgrading?.state === 'switched' ? 'Updated' : status === 'open' ? 'Connected' : status === 'mock' ? 'Mock data' : status === 'rejected' ? 'Rejected' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'
  const since = active && upgrading ? new Date(upgrading.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  const detail = active ? `${upgrading?.version ? `${upgrading.version} · ` : ''}started ${since} · answers resume in about a minute` : message
  // Said when it changes, then just the dot (a state that needs attention — or an update — stays said until it changes).
  const [saying, setSaying] = useState(true)
  useEffect(() => {
    setSaying(true)
    if (active || (status !== 'open' && status !== 'mock')) return
    const t = setTimeout(() => setSaying(false), SAY_FOR_MS)
    return () => clearTimeout(t)
  }, [status, active, upgrading?.state])
  return (
    <span className="sa-status" data-saying={saying} data-upgrading={active || undefined} tabIndex={0} role="status" aria-live="polite"
      aria-label={detail ? `${word} · ${detail}` : word} title={detail ? `${word} · ${detail}` : word}>
      <span className="sa-dot" style={{ background: colour }} />
      <span className="sa-status__words">
        {word}
        {detail && status !== 'mock' && <span className="sa-status__detail">· {detail}</span>}
      </span>
    </span>
  )
}
