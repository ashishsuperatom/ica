// The ask bar: words typed at the foot of a thread (Enter sends, Shift+Enter breaks a line), stuck to the bottom of the
// page, the same on every surface: attaching on the left (not yet), the words, sending on the right. What the words go to
// is the surface's: it is given the send and says whether it is working.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { MenuItem } from '../layout/UserProfile'
import { ThinkingOrb } from 'thinking-orbs'
import { QUESTION_MAX_CHARS } from '@superatom/platform-types'

/** A kind of conversation the + offers (a workbench …): its agent and how it is shown. */
export interface AskKind { key: string; label: string; icon?: string }

/** A file given with a question, on the platform: its name and the hash it is kept under. */
export type GivenFile = { name: string; hash: string; type?: string }
type Given = { id: string; file: File; url: string | null; progress: number; ref?: GivenFile; failed?: string }

/** How far a file has gone up: a ring filling round, over the file. */
function ProgressRing({ value }: { value: number }) {
  const r = 9, c = 2 * Math.PI * r
  return <span className="sa-askbar__ring" aria-hidden><svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r={r} className="sa-askbar__ring-track" /><circle cx="12" cy="12" r={r} className="sa-askbar__ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.04, Math.min(1, value)))} /></svg></span>
}

/** What a paste holds, read while it lasts: its files, the images its HTML shows (by their address), its plain text. */
function clipboardOf(d: DataTransfer) {
  const files = [...d.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f)
  const html = d.getData('text/html')
  const imgs = html ? [...new DOMParser().parseFromString(html, 'text/html').images].map((im) => im.getAttribute('src') ?? '').filter((u) => /^(data:image\/|https?:|blob:)/.test(u)) : []
  return { files, imgs, text: d.getData('text/plain') }
}
/** EVERY IMAGE A PASTE HOLDS. A clipboard copied from an app with several images in it often holds only one of them as a
 *  file (the last), and all of them in its HTML: those are read (an image written into the HTML, or at an address this
 *  page may read). When the HTML gives more images than the files do, the HTML's are taken — the files' others kept. */
async function imagesOf(got: ReturnType<typeof clipboardOf>): Promise<File[]> {
  const fromHtml = (await Promise.all(got.imgs.slice(0, FILES_MAX).map(async (src, i) => {
    try {
      const b = await (await fetch(src)).blob()
      if (!b.type.startsWith('image/')) return null
      return new File([b], `pasted-${i + 1}.${(b.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '')}`, { type: b.type })
    } catch { return null }   // an address this page may not read
  }))).filter((f): f is File => !!f)
  const images = got.files.filter((f) => f.type.startsWith('image/')), others = got.files.filter((f) => !f.type.startsWith('image/'))
  return [...(fromHtml.length > images.length ? fromHtml : images), ...others]
}

/** The most files one question carries. */
const FILES_MAX = 10

export default function AskBar({ onAsk, busy = false, waits = false, placeholder = 'Ask a question…', working, center = false, kinds = [], kind = null, onKind, mark = null, upload, onStop }: {
  /** The question, and the files given with it (pasted, dropped or added) — each already on the platform. */
  onAsk: (text: string, files: GivenFile[]) => void
  /** Files may be given with a question: each is put on the platform as soon as it is given (its progress shown on it). */
  upload?: (file: File, onProgress: (fraction: number) => void) => Promise<GivenFile>
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
  /** While it works, the orb is a control: it asks whether to stop the turn (as Escape does). */
  onStop?: () => void
  /** Alone on the page (a new chat): in its middle, not stuck to the foot. */
  center?: boolean
}) {
  const [text, setText] = useState('')
  const [menu, setMenu] = useState(false)
  // FILES GIVEN WITH THE QUESTION: pasted where one types (an image copied, a screenshot), dropped, or added from the +;
  // shown above the words — an image as itself — each taken out with its ×. Each goes up AS SOON AS IT IS GIVEN, its
  // progress a ring on it; one that did not go up says why. Sending waits for those still going up.
  const takesFiles = !!upload
  const [given, setGiven] = useState<Given[]>([])
  const going = useRef(new Map<string, Promise<unknown>>())
  const [sending, setSending] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const set = (id: string, x: Partial<Given>) => setGiven((g) => g.map((f) => (f.id === id ? { ...f, ...x } : f)))
  const add = (list: FileList | File[] | null) => {
    if (!upload || !list) return
    const room = FILES_MAX - given.length
    const next: Given[] = [...list].slice(0, Math.max(0, room)).map((file) => ({ id: `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 7)}`, file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, progress: 0 }))
    setGiven((g) => [...g, ...next])
    for (const f of next) {
      const p = upload(f.file, (progress) => set(f.id, { progress })).then((ref) => set(f.id, { ref, progress: 1 }), (e: any) => set(f.id, { failed: String(e?.message ?? e) || 'it did not go up' }))
      going.current.set(f.id, p.finally(() => going.current.delete(f.id)))
    }
  }
  const drop = (id: string) => { going.current.delete(id); setGiven((g) => { const x = g.find((f) => f.id === id); if (x?.url) URL.revokeObjectURL(x.url); return g.filter((f) => f.id !== id) }) }
  const givenRef = useRef(given); givenRef.current = given
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
  const send = async () => {
    const t = text.trim(); if ((!t && !given.length) || closed || sending || t.length > QUESTION_MAX_CHARS) return
    // a file that did not go up stays, saying why: taken out (its ×) or given again, before the question goes
    if (given.some((g) => g.failed)) return
    if (going.current.size) { setSending(true); await Promise.allSettled([...going.current.values()]); setSending(false) }
    const now = givenRef.current
    if (now.some((g) => g.failed)) return
    onAsk(t || (now.length === 1 ? 'Look at this file.' : 'Look at these files.'), now.flatMap((g) => (g.ref ? [g.ref] : [])))
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
              <span key={g.id} className={g.url ? 'sa-askbar__thumb' : 'sa-pill sa-askbar__filechip'} data-state={g.failed ? 'failed' : g.ref ? 'up' : 'going'}
                title={g.failed ? `${g.file.name} — did not go up: ${g.failed}` : g.ref ? g.file.name : `${g.file.name} — going up, ${Math.round(g.progress * 100)}%`}>
                {g.url ? <img src={g.url} alt={g.file.name} /> : <><Icon icon="lucide:file" />{g.file.name}</>}
                {!g.ref && !g.failed && <ProgressRing value={g.progress} />}
                {g.failed && <span className="sa-askbar__filefail"><Icon icon="lucide:triangle-alert" /></span>}
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
            onPaste={(e) => {
              // A clipboard can hold several forms at once (images, their text, their HTML): every image is given with the
              // question, and the plain text goes where one is typing — neither one drops the other. Read now: the
              // clipboard is gone once the paste is over.
              if (!takesFiles) return
              const got = clipboardOf(e.clipboardData)
              if (!got.files.length && !got.imgs.length) return
              e.preventDefault()
              const words = got.text
              if (words) {
                const el = e.currentTarget, at = el.selectionStart ?? text.length, end = el.selectionEnd ?? at
                setText((x) => (x.slice(0, at) + words + x.slice(end)).slice(0, QUESTION_MAX_CHARS))
                requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = at + words.length })
              }
              void imagesOf(got).then(add)
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          {mark && <span className="sa-askbar__mark" title={`A ${mark.label.toLowerCase()} conversation`} aria-label={`A ${mark.label.toLowerCase()} conversation`}><Icon icon={mark.icon ?? 'lucide:sparkles'} /></span>}
          {near && <span className="sa-askbar__count" aria-live="polite">{text.length.toLocaleString()} / {QUESTION_MAX_CHARS.toLocaleString()}</span>}
          {busy && !text.trim() && !given.length && !sending && onStop ? (
            <button type="button" className="sa-icon-btn sa-askbar__send" data-working="" onClick={onStop} aria-label="Working on it — stop answering?" title="Working on it — click (or Esc) to stop">
              <ThinkingOrb state="solving" size={20} aria-hidden />
            </button>
          ) :
          <button type="submit" className="sa-icon-btn sa-askbar__send" data-working={(busy && !text.trim() && !given.length) || sending ? '' : undefined} disabled={closed || sending || given.some((g) => g.failed) || (!text.trim() && !given.length)} aria-label="Ask"
            title={sending ? 'Sends once the files are up' : given.some((g) => g.failed) ? 'A file did not go up — take it out, or give it again' : 'Ask (Enter)'}>
            {/* While it works: a thinking orb (its inline design), where the arrow is — the arrow back once there is more to ask. */}
            {(busy && !text.trim() && !given.length) || sending ? <ThinkingOrb state="solving" size={20} aria-label={sending ? 'Sending once the files are up' : 'Working on it'} /> : <Icon icon="lucide:arrow-up" />}
          </button>}
        </div>
      </form>
    </div>
  )
}
