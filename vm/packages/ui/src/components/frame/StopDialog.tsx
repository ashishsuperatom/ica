// STOPPING A TURN: Escape while an agent is working asks first — "Stop answering?" — with nothing chosen: Enter or Escape
// again keeps it working; only Stop, clicked, stops it. Once asked, the dialog says it is stopping until the engine says
// the turn has ended (the agent interrupted, its turn over).

import { useEffect, useState, type ReactNode } from 'react'
import { Dialog } from '../semantic'

/** `const { dialog, ask } = useStopOnEscape(working, stop)` — render `dialog` once; `ask()` opens it from a control (the
 *  input's orb), as Escape does; `stop` resolves when the turn has ended. */
export function useStopOnEscape(working: boolean, stop: () => Promise<unknown>): { dialog: ReactNode; ask: () => void } {
  const [asking, setAsking] = useState(false)
  const [stopping, setStopping] = useState(false)
  useEffect(() => { if (!working) { setAsking(false); setStopping(false) } }, [working])
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (asking && !stopping && (e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); setAsking(false); return }
      if (!asking && working && e.key === 'Escape' && !document.querySelector('.sa-dialog')) { e.preventDefault(); setAsking(true) }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [asking, stopping, working])
  const ask = () => { if (working) setAsking(true) }
  if (!asking) return { dialog: null, ask }
  const doStop = () => { setStopping(true); void stop().finally(() => { setStopping(false); setAsking(false) }) }
  return { ask, dialog: (
    <Dialog title={stopping ? 'Stopping…' : 'Stop answering?'} onClose={() => { if (!stopping) setAsking(false) }} actions={<>
      <button type="button" className="sa-btn" disabled={stopping} onClick={() => setAsking(false)}>Keep going</button>
      <button type="button" className="sa-btn sa-btn--danger" disabled={stopping} onClick={doStop}>{stopping ? 'Stopping…' : 'Stop'}</button>
    </>}>
      <p className="sa-note">{stopping ? 'Waiting for the agent to stop.' : 'The agent stops where it is; nothing is answered. Questions waiting their turn still go.'}</p>
    </Dialog>
  ) }
}
