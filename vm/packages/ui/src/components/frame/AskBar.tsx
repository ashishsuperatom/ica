// The ask bar: words typed at the foot of a thread (Enter sends, Shift+Enter breaks a line), stuck to the bottom of the
// page, the same on every surface: attaching on the left (not yet), the words, sending on the right. What the words go to
// is the surface's: it is given the send and says whether it is working.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { QUESTION_MAX_CHARS } from '@superatom/platform-types'

/** A kind of conversation the + offers (a workbench …): its agent and how it is shown. */
export interface AskKind { key: string; label: string; icon?: string }

export default function AskBar({ onAsk, busy = false, waits = false, placeholder = 'Ask a question…', working, center = false, kinds = [], kind = null, onKind }: {
  onAsk: (text: string) => void
  /** What the + offers to start instead of a plain conversation; the one chosen, and how it is chosen or dropped. */
  kinds?: AskKind[]
  kind?: string | null
  onKind?: (key: string | null) => void
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
  const [menu, setMenu] = useState(false)
  const chosen = kinds.find((k) => k.key === kind) ?? null
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
          <span className="sa-askbar__plus-wrap">
            <button type="button" className="sa-icon-btn sa-askbar__plus" disabled={!kinds.length || busy} aria-haspopup="menu" aria-expanded={menu}
              aria-label="Start as…" title={kinds.length ? 'Start as…' : 'Nothing to add here yet'} onClick={() => setMenu(!menu)}>
              <Icon icon="lucide:plus" />
            </button>
            {menu && kinds.length > 0 && (
              <div className="sa-askbar__menu" role="menu" onMouseLeave={() => setMenu(false)}>
                {kinds.map((k) => (
                  <button key={k.key} type="button" role="menuitemradio" aria-checked={k.key === kind} className="sa-askbar__menuitem" onClick={() => { onKind?.(k.key === kind ? null : k.key); setMenu(false); box.current?.focus() }}>
                    <Icon icon={k.icon ?? 'lucide:sparkles'} />{k.label}{k.key === kind && <Icon icon="lucide:check" className="sa-askbar__menucheck" />}
                  </button>
                ))}
              </div>
            )}
          </span>
          {chosen && (
            <span className="sa-askbar__kind" title={`This conversation starts with the ${chosen.label.toLowerCase()}`}>
              <Icon icon={chosen.icon ?? 'lucide:sparkles'} />{chosen.label}
              <button type="button" className="sa-askbar__kindx" aria-label={`Not ${chosen.label}`} onClick={() => onKind?.(null)}><Icon icon="lucide:x" /></button>
            </span>
          )}
          <textarea id="sa-ask" ref={box} className="sa-askbar__input" rows={1} value={text} disabled={closed} maxLength={QUESTION_MAX_CHARS}
            placeholder={closed ? 'Working on it…' : busy ? 'Ask more — it waits its turn' : chosen ? `Ask the ${chosen.label.toLowerCase()}…` : placeholder} aria-label={placeholder}
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
