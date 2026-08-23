// Keyboard navigation between questions in the chat feed.
//
// Shift+ArrowUp / Shift+ArrowDown (when NOT typing) smooth-scroll to the previous / next question, each
// pinned PIN px below the top. It is SNAPPY and re-entrant: a small cursor tracks the last target so rapid
// repeat presses advance one question each (3 quick presses = 3 questions), even while a scroll is still
// animating. After a short idle gap the cursor is dropped and the target is re-derived from the live scroll
// position — so it always continues from wherever you actually are, including after a manual scroll.
//
// Edges give feedback instead of silently doing nothing:
//   • Shift+Down past the last question → scroll to the very bottom (reveals the end + the gap).
//   • Shift+Up past the first question   → a faded pill at top-center ("No earlier questions"). This is also
//     the hook for pagination later (swap the text for "Loading earlier questions…" when fetching more).
//
// Questions are marked with [data-role="q"]. Plain arrows and modifier combos are left to the browser.

import { useEffect, useRef } from 'react'

const PIN = 12        // px below the viewport top a question is parked at
const MARGIN = 4      // slack around the pin line so the parked question itself isn't re-selected
const COOLDOWN = 800  // ms: presses within this window chain off the cursor instead of re-deriving

function isTyping(el: Element | null): boolean {
  if (!el) return false
  const t = el as HTMLElement
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
}

function scrollToQuestion(el: HTMLElement) {
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - PIN, behavior: 'smooth' })
}

// A single faded pill at top-center, shown for a beat then faded out. Deliberately low-key.
function edgeToast(msg: string) {
  let el = document.getElementById('sa-qnav-toast') as (HTMLDivElement & { _t?: number }) | null
  if (!el) {
    el = document.createElement('div') as HTMLDivElement & { _t?: number }
    el.id = 'sa-qnav-toast'
    el.style.cssText =
      'position:fixed;top:14px;left:50%;transform:translateX(-50%) translateY(-6px);z-index:9999;' +
      'padding:4px 12px;border-radius:999px;background:rgba(250,248,244,.92);color:#9a9488;' +
      'border:1px solid #eae6df;box-shadow:0 1px 6px rgba(0,0,0,.05);backdrop-filter:blur(6px);' +
      'font:500 12px/1.4 system-ui,-apple-system,sans-serif;letter-spacing:.01em;' +
      'opacity:0;transition:opacity .22s ease,transform .22s ease;pointer-events:none'
    document.body.appendChild(el)
  }
  el.textContent = msg
  requestAnimationFrame(() => { el!.style.opacity = '1'; el!.style.transform = 'translateX(-50%) translateY(0)' })
  clearTimeout(el._t)
  el._t = window.setTimeout(() => { el!.style.opacity = '0'; el!.style.transform = 'translateX(-50%) translateY(-6px)' }, 1400)
}

export function useQuestionNav(enabled: () => boolean) {
  const cursor = useRef<{ idx: number; at: number }>({ idx: -1, at: 0 })
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled   // keep latest without re-subscribing the listener

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
      if (!dir) return
      if (isTyping(document.activeElement) || !enabledRef.current()) return

      const qs = Array.from(document.querySelectorAll('[data-role="q"]')) as HTMLElement[]
      if (!qs.length) return

      const now = Date.now()
      const fresh = cursor.current.idx >= 0 && now - cursor.current.at < COOLDOWN
      const last = qs.length - 1

      // Target index: chain off the cursor for rapid repeats, else re-derive from the live scroll position.
      let idx: number
      if (fresh) {
        idx = cursor.current.idx + dir
      } else if (dir < 0) {
        idx = -1; let best = -Infinity
        qs.forEach((el, i) => { const tp = el.getBoundingClientRect().top; if (tp < PIN - MARGIN && tp > best) { best = tp; idx = i } })   // nearest above
      } else {
        idx = qs.length; let best = Infinity
        qs.forEach((el, i) => { const tp = el.getBoundingClientRect().top; if (tp > PIN + MARGIN && tp < best) { best = tp; idx = i } })   // nearest below
      }

      e.preventDefault()
      if (dir < 0 && idx < 0) {                       // already at the first question — nothing earlier
        edgeToast('No earlier questions')
        cursor.current = { idx: 0, at: now }
      } else if (dir > 0 && idx > last) {             // at/past the last question — reveal the end + the gap
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
        cursor.current = { idx: last, at: now }
      } else {
        idx = Math.max(0, Math.min(last, idx))
        scrollToQuestion(qs[idx])
        cursor.current = { idx, at: now }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
