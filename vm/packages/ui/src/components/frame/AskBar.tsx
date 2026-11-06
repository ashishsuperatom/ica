// The ask bar: words typed at the foot of a thread (Enter sends, Shift+Enter breaks a line), stuck to the bottom of the
// page, the same on every surface: attaching on the left (not yet), the words, sending on the right. What the words go to
// is the surface's: it is given the send and says whether it is working.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { QUESTION_MAX_CHARS } from '@superatom/platform-types'

export default function AskBar({ onAsk, busy = false, waits = false, placeholder = 'Ask a question…', working, center = false }: {
  onAsk: (text: string) => void
  busy?: boolean
  /** While busy, more can be asked: each waits its turn (the session's turns), and they are asked together. */
  waits?: boolean
  placeholder?: string
  /** What is being worked on, above the field, while busy. */
  working?: ReactNode
  /** Alone on the page (a new chat): in its middle, not stuck to the foot. */
  center?: boolean
}) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const el = box.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px` }, [text])
  const closed = busy && !waits
  const send = () => { const t = text.trim(); if (!t || closed || t.length > QUESTION_MAX_CHARS) return; onAsk(t); setText('') }
  // The count shows only near the most a question may be.
  const near = text.length > QUESTION_MAX_CHARS * 0.8
  return (
    <div className={`sa-askbar${center ? ' sa-askbar--center' : ''}`} data-copy="skip">
      {busy && working && <div className="sa-askbar__working" aria-live="polite">{working}</div>}
      <form className="sa-askbar__form" onSubmit={(e) => { e.preventDefault(); send() }}>
        <div className="sa-askbar__field">
          <button type="button" className="sa-icon-btn sa-askbar__plus" disabled aria-label="Attach" title="Attach — not yet">
            <Icon icon="lucide:plus" />
          </button>
          <textarea id="sa-ask" ref={box} className="sa-askbar__input" rows={1} value={text} disabled={closed} maxLength={QUESTION_MAX_CHARS}
            placeholder={closed ? 'Working on it…' : busy ? 'Ask more — it waits its turn' : placeholder} aria-label={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          {near && <span className="sa-askbar__count" aria-live="polite">{text.length.toLocaleString()} / {QUESTION_MAX_CHARS.toLocaleString()}</span>}
          <button type="submit" className="sa-icon-btn sa-askbar__send" disabled={closed || !text.trim()} aria-label="Ask" title="Ask (Enter)">
            <Icon icon={busy && !text.trim() ? 'lucide:loader' : 'lucide:arrow-up'} className={busy && !text.trim() ? 'sa-spin' : undefined} />
          </button>
        </div>
      </form>
    </div>
  )
}
