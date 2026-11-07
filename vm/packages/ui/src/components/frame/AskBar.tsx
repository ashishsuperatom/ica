// The ask bar: words typed at the foot of a thread (Enter sends, Shift+Enter breaks a line), stuck to the bottom of the
// page, the same on every surface: attaching on the left (not yet), the words, sending on the right. What the words go to
// is the surface's: it is given the send and says whether it is working.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { MenuItem } from '../layout/UserProfile'
import { QUESTION_MAX_CHARS } from '@superatom/platform-types'

/** A kind of conversation the + offers (a workbench …): its agent and how it is shown. */
export interface AskKind { key: string; label: string; icon?: string }

/** The most files one question carries. */
const FILES_MAX = 10

export default function AskBar({ onAsk, busy = false, waits = false, placeholder = 'Ask a question…', working, center = false, kinds = [], kind = null, onKind, mark = null, files: takesFiles = false }: {
  /** The question, and the files given with it (pasted, dropped or added). */
  onAsk: (text: string, files: File[]) => void
  /** Files may be given with a question (pasted, dropped, or added from the +). */
  files?: boolean
  /** What the + offers to start instead of a plain conversation; the one chosen, and how it is chosen or dropped. */
  kinds?: AskKind[]
  kind?: string | null
  onKind?: (key: string | null) => void
  /** The kind of conversation this is (a workbench …): its mark, for as long as the conversation lasts. */
  mark?: AskKind | null
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
  // FILES GIVEN WITH THE QUESTION: pasted where one types (an image copied, a screenshot), dropped, or added from the +;
  // shown above the words — an image as itself — each taken out with its ×.
  const [given, setGiven] = useState<{ id: string; file: File; url: string | null }[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const add = (list: FileList | File[] | null) => {
    if (!takesFiles || !list) return
    const next = [...list].slice(0, FILES_MAX).map((file) => ({ id: `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 7)}`, file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null }))
    setGiven((g) => [...g, ...next].slice(0, FILES_MAX))
  }
  const drop = (id: string) => setGiven((g) => { const x = g.find((f) => f.id === id); if (x?.url) URL.revokeObjectURL(x.url); return g.filter((f) => f.id !== id) })
  useEffect(() => () => { for (const f of given) if (f.url) URL.revokeObjectURL(f.url) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = kinds.find((k) => k.key === kind) ?? null
  // The + menu closes on a click outside it or Escape, as every menu does.
  const plus = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => { if (plus.current && !plus.current.contains(e.target as Node)) setMenu(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [menu])
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const el = box.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px` }, [text])
  const closed = busy && !waits
  const send = () => {
    const t = text.trim(); if ((!t && !given.length) || closed || t.length > QUESTION_MAX_CHARS) return
    onAsk(t || (given.length === 1 ? 'Look at this file.' : 'Look at these files.'), given.map((g) => g.file))
    setText(''); setGiven([])
  }
  // The count shows only near the most a question may be.
  const near = text.length > QUESTION_MAX_CHARS * 0.8
  return (
    <div className={`sa-askbar${center ? ' sa-askbar--center' : ''}`} data-copy="skip" data-kind={(mark ?? chosen)?.key ? 'set' : undefined}>
      {busy && working && <div className="sa-askbar__working" aria-live="polite">{working}</div>}
      <form className="sa-askbar__form" onSubmit={(e) => { e.preventDefault(); send() }}
        onDragOver={(e) => { if (takesFiles && e.dataTransfer.types.includes('Files')) e.preventDefault() }}
        onDrop={(e) => { if (takesFiles && e.dataTransfer.files.length) { e.preventDefault(); add(e.dataTransfer.files) } }}>
        {given.length > 0 && (
          <div className="sa-askbar__files">
            {given.map((g) => (
              <span key={g.id} className={g.url ? 'sa-askbar__thumb' : 'sa-pill sa-askbar__filechip'} title={g.file.name}>
                {g.url ? <img src={g.url} alt={g.file.name} /> : <><Icon icon="lucide:file" />{g.file.name}</>}
                <button type="button" className="sa-askbar__filex" aria-label={`Take out ${g.file.name}`} onClick={() => drop(g.id)}><Icon icon="lucide:x" /></button>
              </span>
            ))}
          </div>
        )}
        <div className="sa-askbar__field">
          <span className="sa-askbar__plus-wrap" ref={plus}>
            <button type="button" className="sa-icon-btn sa-askbar__plus" disabled={(!kinds.length && !takesFiles) || closed} aria-haspopup="menu" aria-expanded={menu}
              aria-label="Add" title="Add a file, or start as…" onClick={() => setMenu(!menu)}>
              <Icon icon="lucide:plus" />
            </button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = '' }} />
            {menu && (kinds.length > 0 || takesFiles) && (
              <div className="sa-menu sa-menu--list" role="menu">
                {takesFiles && <MenuItem icon="lucide:paperclip" label="Add a file or image" onClick={() => { setMenu(false); picker.current?.click() }} />}
                {kinds.filter((k) => k.key !== kind).map((k) => <MenuItem key={k.key} icon={k.icon ?? 'lucide:sparkles'} label={k.label} onClick={() => { onKind?.(k.key); setMenu(false); box.current?.focus() }} />)}
                {chosen && <MenuItem icon="solar:chat-round-line-linear" label="A plain chat" onClick={() => { onKind?.(null); setMenu(false); box.current?.focus() }} />}
              </div>
            )}
          </span>
          {chosen && (
            <span className="sa-pill sa-askbar__kind" title={`This conversation starts with the ${chosen.label.toLowerCase()}`}>
              <Icon icon={chosen.icon ?? 'lucide:sparkles'} />{chosen.label}
              <button type="button" className="sa-askbar__kindx" aria-label={`Not ${chosen.label}`} onClick={() => onKind?.(null)}><Icon icon="lucide:x" /></button>
            </span>
          )}
          <textarea id="sa-ask" ref={box} className="sa-askbar__input" rows={1} value={text} disabled={closed} maxLength={QUESTION_MAX_CHARS}
            placeholder={closed ? 'Working on it…' : busy ? 'Ask more — it waits its turn' : chosen ? `Ask the ${chosen.label.toLowerCase()}…` : placeholder} aria-label={placeholder}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { if (takesFiles && e.clipboardData.files.length) { e.preventDefault(); add(e.clipboardData.files) } }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          {mark && <span className="sa-askbar__mark" title={`A ${mark.label.toLowerCase()} conversation`} aria-label={`A ${mark.label.toLowerCase()} conversation`}><Icon icon={mark.icon ?? 'lucide:sparkles'} /></span>}
          {near && <span className="sa-askbar__count" aria-live="polite">{text.length.toLocaleString()} / {QUESTION_MAX_CHARS.toLocaleString()}</span>}
          <button type="submit" className="sa-icon-btn sa-askbar__send" disabled={closed || (!text.trim() && !given.length)} aria-label="Ask" title="Ask (Enter)">
            <Icon icon={busy && !text.trim() ? 'lucide:loader' : 'lucide:arrow-up'} className={busy && !text.trim() ? 'sa-spin' : undefined} />
          </button>
        </div>
      </form>
    </div>
  )
}
