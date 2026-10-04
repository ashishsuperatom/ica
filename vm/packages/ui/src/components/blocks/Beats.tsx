// The narrator's beats — the story of a reading as it happened — as rows with the seconds each one took: a past
// beat's seconds are the gap to the beat after it and never change; the current one ticks. The same rows the
// platform's chat draws for an analysis, kept after the answer under a quiet line that opens them.

import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import type { Beat } from '../../answer/blocks'
import { markdownToHtml } from '../../lib/markdown'

function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!ticking) return; const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i) }, [ticking])
  return now
}

export function BeatRows({ beats, live, end }: { beats: Beat[]; live: boolean; end?: number }) {
  const now = useNow(live)
  const stop = end ?? now
  return (
    <div className="sa-beats">
      {beats.map((b, i) => {
        const next = beats[i + 1]?.at ?? stop
        const secs = Math.max(1, Math.round((next - b.at) / 1000))
        const current = live && i === beats.length - 1
        return (
          <div key={`${i}:${b.at}`} className={`sa-beat${current ? '' : ' sa-beat--past'}`}>
            <span className="sa-beat__secs">{secs} s</span>
            <span className="sa-beat__text sa-prose" dangerouslySetInnerHTML={{ __html: markdownToHtml(b.text) }} />
          </div>
        )
      })}
    </div>
  )
}

/** Above the answer: the beats under one line, closed until opened. */
export function BeatsDisclosure({ beats, end }: { beats: Beat[]; end: number }) {
  const [open, setOpen] = useState(false)
  if (!beats.length) return null
  return (
    <div className="sa-disclosure" data-copy="skip">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="sa-label sa-disclosure__summary">
        <Icon icon="lucide:chevron-right" />
        How it was worked out
        <span className="sa-disclosure__meta">· {beats.length} step{beats.length === 1 ? '' : 's'} · {Math.max(1, Math.round((end - beats[0].at) / 1000))} s</span>
      </button>
      {open && <div className="sa-disclosure__panel sa-beats-panel"><BeatRows beats={beats} live={false} end={end} /></div>}
    </div>
  )
}
