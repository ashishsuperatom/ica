// Moving around the thread: the scroll to a block, and Shift+↑ / Shift+↓. Kept apart from the thread runtime and the
// blocks on purpose — it is comfort, not logic, and nothing else depends on how it works.

import { useEffect } from 'react'

/** How long any move takes, whatever the distance: quick, but still visibly a move. */
const MOVE_MS = 320
/** Blocks land this far below the top of the scrolling area (matches scroll-mt-4 on a block). */
const LANDING = 16
let moving = 0

/** The scrolling area the thread lives in. */
function scroller(el?: HTMLElement | null): HTMLElement {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return (document.querySelector('main') as HTMLElement) ?? (document.scrollingElement as HTMLElement)
}

/** Scroll `area` to `to` over MOVE_MS, easing out; `settle` may correct the target once at the end. */
function glide(area: HTMLElement, to: number, settle?: () => number | null) {
  const from = area.scrollTop
  const max = area.scrollHeight - area.clientHeight
  to = Math.max(0, Math.min(to, max))
  const run = ++moving
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(to - from) < 2) {
    area.scrollTop = to
    return
  }
  const t0 = performance.now()
  const step = (now: number) => {
    if (run !== moving) return // a newer move took over
    const t = Math.min(1, (now - t0) / MOVE_MS)
    area.scrollTop = from + (to - from) * (1 - Math.pow(1 - t, 3))
    if (t < 1) return void requestAnimationFrame(step)
    const off = settle?.()
    if (off && Math.abs(off) > 2) area.scrollTop += off
  }
  requestAnimationFrame(step)
}

/**
 * Bring a block to the top of the view. The browser's smooth scroll takes longer the farther it goes, which past a big
 * table feels stuck; a jump loses the sense of moving down the thread. This takes MOVE_MS for any distance, then
 * settles exactly on the block in case blocks passed on the way rendered at a different height.
 */
export function revealBlock(id: string) {
  const el = document.getElementById(`block-${id}`)
  if (!el) return
  const area = scroller(el)
  const offset = () => el.getBoundingClientRect().top - area.getBoundingClientRect().top - LANDING
  glide(area, area.scrollTop + offset(), offset)
}

/** Scroll to the very bottom of the thread. */
function revealEnd() {
  const area = scroller(document.querySelector('.sa-block') as HTMLElement)
  glide(area, area.scrollHeight)
}

/**
 * Shift+↑ / Shift+↓ move one block at a time, as in runtime-react (hooks/useKeyboardNavigation). Plain arrows still
 * scroll; nothing happens while typing in a field.
 *   ↓  next block; from the last block, the bottom of the thread (a block taller than the screen can be read to its end)
 *   ↑  the top of the current block if partway down it, otherwise the block above
 */
export function useBlockKeys(ids: string[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
      if (!ids.length) return
      e.preventDefault()
      const area = scroller(document.getElementById(`block-${ids[0]}`))
      const viewTop = area.getBoundingClientRect().top + LANDING
      const tops = ids.map((id) => document.getElementById(`block-${id}`)?.getBoundingClientRect().top ?? Infinity)
      let current = 0
      tops.forEach((top, i) => top <= viewTop + 8 && (current = i))
      if (e.key === 'ArrowDown') {
        if (current + 1 < ids.length) revealBlock(ids[current + 1])
        else revealEnd()
      } else {
        const atTop = Math.abs(tops[current] - viewTop) < 12
        const target = atTop ? current - 1 : current
        if (target >= 0) revealBlock(ids[target])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ids.join()])
}
