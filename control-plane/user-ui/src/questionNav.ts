// Keyboard navigation between questions in the chat feed.
//
// Shift+ArrowUp / Shift+ArrowDown (when NOT typing) smooth-scroll to the previous / next question, each
// pinned PIN px below the top. It is SNAPPY and re-entrant: a small cursor tracks the last target so rapid
// repeat presses advance one question each (3 quick presses = 3 questions), even while a scroll is still
// animating. After a short idle gap the cursor is dropped and the target is re-derived from the live scroll
// position — so it always continues from wherever you actually are, including after a manual scroll.
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
      let idx: number
      if (fresh) {
        // Continue from the last target — snappy multi-press, works mid-scroll.
        idx = Math.max(0, Math.min(qs.length - 1, cursor.current.idx + dir))
      } else {
        // Re-derive "current" from the live scroll position, honoring the pin line.
        const tops = qs.map(el => el.getBoundingClientRect().top)
        idx = -1
        if (dir < 0) { let best = -Infinity; tops.forEach((tp, i) => { if (tp < PIN - MARGIN && tp > best) { best = tp; idx = i } }) }   // nearest above
        else { let best = Infinity; tops.forEach((tp, i) => { if (tp > PIN + MARGIN && tp < best) { best = tp; idx = i } }) }            // nearest below
        if (idx < 0) return   // nothing in that direction (e.g. already at the newest / oldest)
      }

      e.preventDefault()
      const el = qs[idx]
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - PIN, behavior: 'smooth' })
      cursor.current = { idx, at: now }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
