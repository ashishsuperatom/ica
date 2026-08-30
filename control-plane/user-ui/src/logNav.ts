// Interactions for the ANALYST / SEMANTIC-MODEL event logs — SEPARATE from the chat feed's navigation
// (chat scrolls the whole page; a log is its own scroll-container <div> with a live-appended event stream).
// This hook owns everything those logs need:
//   1. Open the tab → jump to the BOTTOM (the newest content), not the top.
//   2. New content arrives → follow it to the bottom, UNLESS you've scrolled up to read (then stay put).
//   3. Shift+ArrowUp / Shift+ArrowDown → move to the previous / next QUESTION, parked near the top, scrolling
//      the CONTAINER (not the page). Questions are marked `[data-qlog]` inside the log (a DISTINCT attribute from
//      the chat feed's `[data-role="q"]`, so the two navs never see each other's markers).
// One hook instance per log (call it once per agent log view) — they don't share state.
import { useEffect, useRef, type RefObject } from 'react'

const NEAR_BOTTOM = 240  // px from the bottom still counts as "following"

function isTyping(el: Element | null): boolean {
  if (!el) return false
  const t = el as HTMLElement
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
}

// `content` is any value that changes reference/identity whenever the log changes — pass the events array
// itself (a new reference on every merge), NOT its length: streaming edits an event IN PLACE, so the length
// can stay the same while the content grows. Keyed on the array, auto-follow fires on every update.
// `jumpKey` changes whenever the user asks a NEW question → force the log to that latest question (pin to bottom),
// even if they'd scrolled up. Streaming of the SAME question follows only when already near the bottom.
export function useLogNav(ref: RefObject<HTMLElement | null>, active: boolean, content: unknown, jumpKey?: unknown) {
  const pinned = useRef(true)   // is the log scrolled near the bottom? (so new content follows, but reading-up doesn't yank)

  // Track whether we're near the bottom, so auto-follow only fires when the user hasn't scrolled up.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => { pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref, active])

  // FORCE to the bottom when the view OPENS (active) or a NEW question is asked (jumpKey) — pin repeatedly and
  // for a while, because the container may be display:none→flex or its content may render just after this runs,
  // so a single scroll misses. This is why opening Analyst used to land at the top.
  useEffect(() => {
    if (!active) return
    pinned.current = true
    const pin = () => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight }
    pin()
    const raf = requestAnimationFrame(pin)
    const ts = [0, 30, 80, 160, 300, 500, 800, 1200].map(d => window.setTimeout(pin, d))
    return () => { cancelAnimationFrame(raf); ts.forEach(clearTimeout) }
  }, [active, jumpKey, ref])

  // FOLLOW new content to the bottom while near it — via requestAnimationFrame, NOT a debounced setTimeout. A
  // debounce that is cleared on every event STARVES during a continuous stream (it's always one delay away and
  // never fires), which is why the live question didn't follow. rAF fires the next frame regardless.
  useEffect(() => {
    if (!active || !pinned.current) return
    const raf = requestAnimationFrame(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight })
    return () => cancelAnimationFrame(raf)
  }, [content, active, ref])

  // Shift+Arrow → previous / next question, scrolling the CONTAINER.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
      if (!dir) return
      // These are WATCH views (the input is incidental), so Shift+Arrow is always a question-nav gesture — don't
      // bail when a field is focused; blur it so the caret isn't fighting the scroll.
      const ae = document.activeElement as HTMLElement | null
      if (isTyping(ae)) ae?.blur?.()
      const el = ref.current
      if (!el) return
      const qs = Array.from(el.querySelectorAll('[data-qlog]')) as HTMLElement[]   // the question dividers, THIS log only
      if (!qs.length) return
      e.preventDefault()

      // Move RELATIVE TO THE CURRENT VIEW — never by a running index. A running index drifts out of sync near the
      // ends (the last questions can't scroll to the top, so the index runs ahead of the real scroll and then
      // Shift+Down snaps back UP). Instead, anchor on where the questions actually are right now: measure each
      // question's offset below the container top, then Down = the first one below the top line, Up = the last one
      // above it. This can only ever move in the pressed direction.
      const cRect = el.getBoundingClientRect()
      const PIN = 12
      // The question NEAREST the top line is the one you're on; move exactly one from it (idx = anchor ± 1), so it
      // can only go the way you pressed. Then scroll the CONTAINER directly — scrollIntoView guesses the wrong
      // scroll ancestor (it was scrolling the window), which is what made Shift+Down snap back up.
      let anchor = 0, best = Infinity
      qs.forEach((q, i) => { const d = q.getBoundingClientRect().top - cRect.top - PIN; if (Math.abs(d) < best) { best = Math.abs(d); anchor = i } })
      const idx = Math.max(0, Math.min(qs.length - 1, anchor + dir))
      const delta = qs[idx].getBoundingClientRect().top - cRect.top - PIN
      el.scrollTo({ top: el.scrollTop + delta, behavior: 'smooth' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, ref])
}
