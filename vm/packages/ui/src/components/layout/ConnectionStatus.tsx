// How the screen reaches the platform right now: a coloured dot. When it connects or loses the connection the word shows
// beside it for a few seconds, then folds away; hovering (or focusing) the dot shows it again, with any detail.
//
// WHILE THE PROJECT UPDATES (a new release of its engine is being switched in), a small card takes the dot's place until
// the update ends: that it is updating and since when — so everyone using the project knows why answers pause. When it ends, "Updated" shows for a few seconds and folds back to the dot.

import { useEffect, useState, type ReactNode } from 'react'

export type Connection = 'open' | 'connecting' | 'reconnecting' | 'rejected' | 'mock'
/** The project updating: `state` 'switching' while it runs; anything else when it has ended. */
export interface Upgrading { state: string; version?: string | null; startedAt: string }
/** The person's development environment (sacli dev), while they are in one: its name, what in it differs from what
 *  everyone sees (as `program <name>`, `agent <name>`, `map`), what attached it (a key's name), since when, and when it
 *  was last rebuilt. */
export interface DevEnvironment { id?: string; name: string; names: string[]; via?: string | null; attachedAt?: string | null; lastUsed?: string | null }

const SAY_FOR_MS = 5000

/** `onStop` leaves the environment (kept, to resume); `onDelete` removes it with its builds — each resolves with what went
 *  wrong, or nothing. Without them the card only says how (from sacli). */
export default function ConnectionStatus({ status, message, upgrading, dev, onStop, onDelete }: { status: Connection; message?: string; upgrading?: Upgrading | null; dev?: DevEnvironment | null
  onStop?: () => Promise<string | void>; onDelete?: () => Promise<string | void> }) {
  const active = upgrading?.state === 'switching'
  const ended = !!upgrading && !active
  const colour = status === 'open' ? 'var(--win)' : status === 'mock' ? 'var(--series-2)' : status === 'rejected' ? 'var(--loss)' : 'var(--warn)'
  const word = ended && upgrading?.state === 'switched' ? 'Updated' : status === 'open' ? 'Connected' : status === 'mock' ? 'Mock data' : status === 'rejected' ? 'Rejected' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'
  const since = active && upgrading ? new Date(upgrading.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  const detail = message
  // Said when it changes, then just the dot (a state that needs attention — or an update — stays said until it changes).
  const [saying, setSaying] = useState(true)
  const [open, setOpen] = useState(false)
  // Stop or delete: each asks once more first (a click by mistake does nothing); one at a time; what went wrong is said.
  const [busy, setBusy] = useState<'stop' | 'delete' | null>(null)
  const [asking, setAsking] = useState<'stop' | 'delete' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const run = async (what: 'stop' | 'delete', fn?: () => Promise<string | void>) => {
    if (!fn || busy) return
    setBusy(what); setFailed(null)
    try { const wrong = await fn(); if (wrong) setFailed(wrong) } catch (e: any) { setFailed(String(e?.message ?? e)) }
    setBusy(null); setAsking(null)
  }
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
  // In a development environment: said for as long as it lasts. It answers one question — what do I see that everyone
  // else does not? — computed against what is published now (an identical build is not a difference). Nothing else.
  let devPart: ReactNode = null
  if (dev) {
    const differs = dev.names.map((n) => n.replace(/^program /, '').replace(/^map$/, 'the map'))
    const line = differs.length ? `Differs from what everyone sees: ${differs.join(', ')}` : 'Nothing differs from what everyone sees yet'
    const when = (t?: string | null) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null)
    const rebuilt = dev.lastUsed ? new Date(dev.lastUsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
    // Its story in one line: since when, what attached it, when it was last rebuilt — so even "nothing differs" says something.
    const story = [dev.attachedAt ? `since ${when(dev.attachedAt)}` : null, dev.via ? `from ${dev.via}` : null, dev.lastUsed && dev.lastUsed !== dev.attachedAt ? `rebuilt ${when(dev.lastUsed)}` : null].filter(Boolean).join(' · ')
    // Beside the connection dot, in the bar: an amber dot. Hovered (or focused) its card opens below it — what it is;
    // clicked it stays open with Stop and Delete. Never floating over the app.
    devPart = (
      <span className="sa-devenv" data-open={open || !!asking || !!busy}>
        <button type="button" className="sa-devenv__dot" aria-expanded={open} onClick={() => setOpen(!open)}
          aria-label={`Your test version · ${dev.name} — ${line}`} title={open ? 'Close' : 'Your test version — stop or delete it'}>
          <span className="sa-dot" aria-hidden />
        </button>
        <span className="sa-devenv__pop">
          <span className="sa-devenv__card">
            <span className="sa-devenv__words" role="status" aria-live="polite">
              <span className="sa-devenv__title">Your test version · {dev.name}</span>
              <span className="sa-devenv__line">{line}{differs.length && rebuilt ? ` · rebuilt ${rebuilt}` : ''}</span>
              {story && <span className="sa-devenv__line">{story[0].toUpperCase() + story.slice(1)}</span>}
            </span>
            {open && (
              <span className="sa-devenv__more">
                {onStop || onDelete ? (
                  <span className="sa-devenv__actions">
                    {asking === 'stop' ? <>
                        <button type="button" className="sa-btn sa-btn--primary" disabled={!!busy} onClick={() => void run('stop', onStop)}>{busy === 'stop' ? 'Stopping…' : `Stop ${dev.name} — kept to resume`}</button>
                        <button type="button" className="sa-btn" disabled={!!busy} onClick={() => setAsking(null)}>Keep working in it</button></>
                      : asking === 'delete' ? <>
                        <button type="button" className="sa-btn sa-btn--danger" disabled={!!busy} onClick={() => void run('delete', onDelete)}>{busy === 'delete' ? 'Deleting…' : `Delete ${dev.name} and its builds`}</button>
                        <button type="button" className="sa-btn" disabled={!!busy} onClick={() => setAsking(null)}>Keep it</button></>
                      : <>
                        {onStop && <button type="button" className="sa-btn" onClick={() => setAsking('stop')}>Stop…</button>}
                        {onDelete && <button type="button" className="sa-btn" onClick={() => setAsking('delete')}>Delete…</button>}</>}
                  </span>
                ) : <span className="sa-devenv__hint"><code>sacli dev stop</code> leaves it (kept to resume) · <code>sacli dev delete</code> removes it.</span>}
                {failed && <span className="sa-devenv__hint" role="alert">{failed}</span>}
              </span>
            )}
          </span>
        </span>
      </span>
    )
  }
  const connection = (
    <span className="sa-status" data-saying={saying} tabIndex={0} role="status" aria-live="polite"
      aria-label={detail ? `${word} · ${detail}` : word} title={detail ? `${word} · ${detail}` : word}>
      <span className="sa-dot" style={{ background: colour }} />
      <span className="sa-status__words">
        {word}
        {detail && status !== 'mock' && <span className="sa-status__detail">· {detail}</span>}
      </span>
    </span>
  )
  // The connection is always said; a development environment adds its dot beside it.
  return devPart ? <span className="sa-statusbar">{connection}{devPart}</span> : connection
}
