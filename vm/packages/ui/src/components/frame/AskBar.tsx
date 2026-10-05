// The ask bar: words typed at the foot of a thread (Enter sends, Shift+Enter breaks a line), stuck to the bottom of the
// page, the same on every surface: attaching on the left (not yet), the words, sending on the right. What the words go to
// is the surface's: it is given the send and says whether it is working.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'

export default function AskBar({ onAsk, busy = false, placeholder = 'Ask a question…', working }: {
  onAsk: (text: string) => void
  busy?: boolean
  placeholder?: string
  /** What is being worked on, above the field, while busy. */
  working?: ReactNode
}) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const el = box.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px` }, [text])
  const send = () => { const t = text.trim(); if (!t || busy) return; onAsk(t); setText('') }
  return (
    <div className="sa-askbar" data-copy="skip">
      {busy && working && <div className="sa-askbar__working" aria-live="polite">{working}</div>}
      <form className="sa-askbar__form" onSubmit={(e) => { e.preventDefault(); send() }}>
        <div className="sa-askbar__field">
          <button type="button" className="sa-icon-btn sa-askbar__plus" disabled aria-label="Attach" title="Attach — not yet">
            <Icon icon="lucide:plus" />
          </button>
          <textarea id="sa-ask" ref={box} className="sa-askbar__input" rows={1} value={text} disabled={busy}
            placeholder={busy ? 'Working on it…' : placeholder} aria-label={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          <button type="submit" className="sa-icon-btn sa-askbar__send" disabled={busy || !text.trim()} aria-label="Ask" title="Ask (Enter)">
            <Icon icon={busy ? 'lucide:loader' : 'lucide:arrow-up'} className={busy ? 'sa-spin' : undefined} />
          </button>
        </div>
      </form>
    </div>
  )
}
