// Interactions for the ANALYST / SEMANTIC-MODEL event logs — SEPARATE from the chat feed's navigation
// (chat scrolls the whole page; a log is its own scroll-container <div> with a live-appended event stream).
// This hook owns everything those logs need:
//   1. Open the tab → jump to the BOTTOM (the newest content), not the top.
//   2. New content arrives → follow it to the bottom, UNLESS you've scrolled up to read (then stay put).
//   3. Shift+ArrowUp / Shift+ArrowDown → move to the previous / next QUESTION, parked near the top, scrolling
//      the CONTAINER (not the page). Questions are marked `[data-role="q"]` inside the log.
// One hook instance per log (call it once for analyst, once for semantic) — they don't share state.
import { useEffect, useRef, type RefObject } from 'react'

const PIN = 10          // px below the container top a question is parked at
const MARGIN = 4
const COOLDOWN = 800
const NEAR_BOTTOM = 240  // px from the bottom still counts as "following"

function isTyping(el: Element | null): boolean {
  if (!el) return false
  const t = el as HTMLElement
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
}

export function useLogNav(ref: RefObject<HTMLElement | null>, active: boolean, contentKey: number) {
  const pinned = useRef(true)   // is the log scrolled near the bottom? (so new content follows, but reading-up doesn't yank)
  const cursor = useRef<{ idx: number; at: number }>({ idx: -1, at: 0 })

  // Track whether we're near the bottom, so auto-follow only fires when the user hasn't scrolled up.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => { pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref, active])

  // Open the tab → pin to the bottom. The log often mounts/renders AFTER this runs, so pin repeatedly.
  useEffect(() => {
    if (!active) return
    pinned.current = true
    const pin = () => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight }
    const raf = requestAnimationFrame(pin)
    const ts = [40, 120, 260, 500].map(d => window.setTimeout(pin, d))
    return () => { cancelAnimationFrame(raf); ts.forEach(clearTimeout) }
  }, [active, ref])

  // New content → follow to the bottom, but only if the user is already near it.
  useEffect(() => {
    if (!active || !pinned.current) return
    const t = window.setTimeout(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight }, 60)
    return () => clearTimeout(t)
  }, [contentKey, active, ref])

  // Shift+Arrow → previous / next question, scrolling the CONTAINER.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
      if (!dir || isTyping(document.activeElement)) return
      const el = ref.current
      if (!el) return
      const qs = Array.from(el.querySelectorAll('[data-role="q"]')) as HTMLElement[]
      if (!qs.length) return
      e.preventDefault()

      const ctop = el.getBoundingClientRect().top
      const rel = (q: HTMLElement) => q.getBoundingClientRect().top - ctop   // question top relative to the container's viewport
      const now = Date.now()
      const fresh = cursor.current.idx >= 0 && now - cursor.current.at < COOLDOWN
      const last = qs.length - 1

      let idx: number
      if (fresh) {
        idx = cursor.current.idx + dir
      } else if (dir < 0) {
        idx = -1; let best = -Infinity
        qs.forEach((q, i) => { const tp = rel(q); if (tp < PIN - MARGIN && tp > best) { best = tp; idx = i } })
      } else {
        idx = qs.length; let best = Infinity
        qs.forEach((q, i) => { const tp = rel(q); if (tp > PIN + MARGIN && tp < best) { best = tp; idx = i } })
      }

      if (dir > 0 && idx > last) {                    // past the last → reveal the end
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
        cursor.current = { idx: last, at: now }
      } else {
        idx = Math.max(0, Math.min(last, idx))
        el.scrollTo({ top: el.scrollTop + rel(qs[idx]) - PIN, behavior: 'smooth' })
        cursor.current = { idx, at: now }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, ref])
}
