// How the screen reaches the platform right now: a coloured dot. When it connects or loses the connection the word shows
// beside it for a few seconds, then folds away; hovering (or focusing) the dot shows it again, with any detail.
//
// WHILE THE PROJECT UPDATES (a new release of its engine is being switched in), a small card takes the dot's place until
// the update ends: that it is updating and since when — so everyone using the project knows why answers pause. When it ends, "Updated" shows for a few seconds and folds back to the dot.

import { useEffect, useState } from 'react'

export type Connection = 'open' | 'connecting' | 'reconnecting' | 'rejected' | 'mock'
/** The project updating: `state` 'switching' while it runs; anything else when it has ended. */
export interface Upgrading { state: string; version?: string | null; startedAt: string }
/** The person's development environment (sacli dev), while they are in one: its name and what it changes. */
export interface DevEnvironment { name: string; names: string[] }

const SAY_FOR_MS = 5000

export default function ConnectionStatus({ status, message, upgrading, dev }: { status: Connection; message?: string; upgrading?: Upgrading | null; dev?: DevEnvironment | null }) {
  const active = upgrading?.state === 'switching'
  const ended = !!upgrading && !active
  const colour = status === 'open' ? 'var(--win)' : status === 'mock' ? 'var(--series-2)' : status === 'rejected' ? 'var(--loss)' : 'var(--warn)'
  const word = ended && upgrading?.state === 'switched' ? 'Updated' : status === 'open' ? 'Connected' : status === 'mock' ? 'Mock data' : status === 'rejected' ? 'Rejected' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'
  const since = active && upgrading ? new Date(upgrading.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  const detail = message
  // Said when it changes, then just the dot (a state that needs attention — or an update — stays said until it changes).
  const [saying, setSaying] = useState(true)
  useEffect(() => {
    setSaying(true)
    if (active || (status !== 'open' && status !== 'mock')) return
    const t = setTimeout(() => setSaying(false), SAY_FOR_MS)
    return () => clearTimeout(t)
  }, [status, active, upgrading?.state])
  // While it updates: a card of its own, in plain words — what is happening and when answers are back. The build's name
  // is for operators (the admin console's Engine version page), never shown here.
  if (active && upgrading) return (
    <div className="sa-updating" role="status" aria-live="polite">
      <span className="sa-spinner" aria-hidden />
      <div className="sa-updating__words">
        <span className="sa-updating__title">Updating Superatom</span>
        <span className="sa-updating__line">Back in about a minute · started {since}</span>
      </div>
    </div>
  )
  // In a development environment: said for as long as it lasts — this person sees their own changes, nobody else does.
  if (dev) {
    const changes = dev.names.length ? dev.names.join(', ') : 'nothing yet'
    return (
      <div className="sa-devenv" role="status" aria-live="polite" title={`Development environment ${dev.name}: only you see ${changes}; everyone else sees what is published`}>
        <span className="sa-dot" aria-hidden />
        <div className="sa-devenv__words">
          <span className="sa-devenv__title">Your environment · {dev.name}</span>
          <span className="sa-devenv__line">Only you see: {changes}</span>
        </div>
      </div>
    )
  }
  return (
    <span className="sa-status" data-saying={saying} tabIndex={0} role="status" aria-live="polite"
      aria-label={detail ? `${word} · ${detail}` : word} title={detail ? `${word} · ${detail}` : word}>
      <span className="sa-dot" style={{ background: colour }} />
      <span className="sa-status__words">
        {word}
        {detail && status !== 'mock' && <span className="sa-status__detail">· {detail}</span>}
      </span>
    </span>
  )
}
