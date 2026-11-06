// The narrator's beats — the story of a reading as it happened — as rows with the seconds each one took: a past
// beat's seconds are the gap to the beat after it and never change; the current one ticks. The same rows the
// platform's chat draws for an analysis, kept after the answer under a quiet line that opens them.

import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import type { Beat } from '../../answer/blocks'
import { markdownToHtml } from '../../lib/markdown'

function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!ticking) return; const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i) }, [ticking])
  return now
}

/** Words the working line cycles through while an answer is being worked out: that something is happening, not what. */
const WORKING = ['Working', 'Thinking', 'Considering', 'Piecing it together', 'Still on it', 'Weighing it up']

/** While an answer is worked out: a word that changes every few seconds, softly lit — so a long silence between steps
 *  still says the work goes on. */
/** The agent working, in a word, for a title. */
const whoWorks = (agent?: string) => (agent === 'analyst' ? 'The analyst' : agent === 'composer' ? 'The composer' : undefined)

export function WorkingLine({ agent }: { /** Which agent is working: its colour. */ agent?: string } = {}) {
  const [i, setI] = useState(0)
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % WORKING.length), 2800); return () => clearInterval(t) }, [])
  return <div className="sa-working-line" aria-hidden data-agent={agent} title={whoWorks(agent)}><span className="sa-working-line__dot" /><span key={i} className="sa-working-line__word">{WORKING[i]}…</span></div>
}

/** The steps, each with its seconds — kept in their place but shown only when asked: a click on any step shows them all,
 *  another hides them. */
export function BeatRows({ beats, live, end }: { beats: Beat[]; live: boolean; end?: number }) {
  const now = useNow(live)
  const stop = end ?? now
  const [times, setTimes] = useState(false)
  return (
    <div className="sa-beats" data-times={times || undefined} onClick={() => setTimes(!times)} title={times ? 'Hide the times' : 'Show the times'}>
      {beats.map((b, i) => {
        const next = beats[i + 1]?.at ?? stop
        const secs = Math.max(1, Math.round((next - b.at) / 1000))
        const current = live && i === beats.length - 1
        return (
          <div key={`${i}:${b.at}`} className={`sa-beat${current ? '' : ' sa-beat--past'}`} data-agent={b.agent}>
            <span className="sa-beat__secs">{secs} s</span>
            {b.agent && <span className="sa-beat__who" title={whoWorks(b.agent)} aria-label={whoWorks(b.agent)} />}
            <span className="sa-beat__text sa-prose" dangerouslySetInnerHTML={{ __html: markdownToHtml(b.text) }} />
          </div>
        )
      })}
    </div>
  )
}

/** Above the answer: the beats under one line, closed until opened. */
export function BeatsDisclosure({ beats, end, time = true }: { beats: Beat[]; end: number; /** Say how long it took (left out where it is said already). */ time?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!beats.length) return null
  return (
    <div className="sa-disclosure" data-copy="skip">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="sa-label sa-disclosure__summary">
        <Icon icon="lucide:chevron-right" />
        How it was worked out
        <span className="sa-disclosure__meta">· {beats.length} step{beats.length === 1 ? '' : 's'}{time ? ` · ${Math.max(1, Math.round((end - beats[0].at) / 1000))} s` : ''}</span>
      </button>
      {open && <div className="sa-disclosure__panel sa-beats-panel"><BeatRows beats={beats} live={false} end={end} /></div>}
    </div>
  )
}
