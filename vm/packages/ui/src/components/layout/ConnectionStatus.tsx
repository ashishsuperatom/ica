// How the screen reaches the platform right now: a coloured dot. When it connects or loses the connection the word shows
// beside it for a few seconds, then folds away; hovering (or focusing) the dot shows it again, with any detail.
//
// WHILE THE PROJECT UPDATES (a new release of its engine is being switched in), a small card takes the dot's place until
// the update ends: that it is updating and since when — so everyone using the project knows why answers pause. When it ends, "Updated" shows for a few seconds and folds back to the dot.

import { useEffect, useState } from 'react'

export type Connection = 'open' | 'connecting' | 'reconnecting' | 'rejected' | 'mock'
/** The project updating: `state` 'switching' while it runs; anything else when it has ended. */
export interface Upgrading { state: string; version?: string | null; startedAt: string }
/** The person's development environment (sacli dev), while they are in one: its name and what it changes — and, to
 *  open on a click, whose it is, what attached it (a key's name: "sacli on <machine>"), since when, last rebuilt. */
export interface DevEnvironment { name: string; names: string[]; owner?: string; via?: string | null; attachedAt?: string | null; lastUsed?: string | null }

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
  const [open, setOpen] = useState(false)
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
    const time = (t?: string | null) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null)
    // Clicked, it says more — whose it is, what attached it, since when — and how to leave or remove it.
    const rows: [string, string | null][] = [['Whose', dev.owner ?? null], ['Started from', dev.via ?? null], ['Since', time(dev.attachedAt)], ['Last rebuilt', time(dev.lastUsed)], ['Changes', changes]]
    return (
      <div className="sa-devenv" data-open={open}>
        <button type="button" className="sa-devenv__head" aria-expanded={open} onClick={() => setOpen(!open)}
          title={open ? 'Fewer details' : 'More about this environment'}>
          <span className="sa-dot" aria-hidden />
          <span className="sa-devenv__words" role="status" aria-live="polite">
            <span className="sa-devenv__title">Your environment · {dev.name}</span>
            <span className="sa-devenv__line">Only you see: {changes}</span>
          </span>
        </button>
        {open && (
          <div className="sa-devenv__more">
            <dl>{rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
            <p className="sa-devenv__hint">Everyone else sees what is published. <code>sacli dev stop</code> leaves it (kept to resume) · <code>sacli dev delete</code> removes it.</p>
          </div>
        )}
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
