// A box that eases to its new height instead of snapping to it.
//
// Every card in the app changes size as you use it: a filter returns fewer rows, a view toggle swaps a table for a
// chart, a list goes from the top 10 to the top 25. Snapping moves everything below and the eye loses its place. This
// gives the change a moment — `--settle` in the design tokens, one speed for the whole app.
//
// It has to be JavaScript, and only just: a CSS transition needs two computed heights to move between, and a box whose
// height is decided by its content computes `auto` before and after, so there is nothing to animate. A ResizeObserver
// measures the content and writes the number; the transition is CSS. That is the whole component.
//
// While it is moving the box clips, so shrinking content does not spill past the card. It stops clipping the moment it
// arrives, because a card holds menus and tooltips that have to be allowed out.

import { useEffect, useRef, useState, type ReactNode } from 'react'

export default function Settle({ children, className = '', innerClassName }: { children: ReactNode; className?: string; innerClassName?: string }) {
  const inner = useRef<HTMLDivElement>(null)
  const last = useRef<number | undefined>(undefined)
  const [height, setHeight] = useState<number>()
  const [moving, setMoving] = useState(false)

  useEffect(() => {
    const el = inner.current
    // Without a ResizeObserver the height is never set, the box sizes itself, and the change simply snaps: the old
    // behaviour, which is a fine thing to fall back to.
    if (!el || typeof ResizeObserver === 'undefined') return
    const read = () => {
      const now = el.offsetHeight
      if (now === last.current) return
      if (last.current !== undefined) setMoving(true)
      last.current = now
      setHeight(now)
    }
    const watch = new ResizeObserver(read)
    watch.observe(el)
    read()
    return () => watch.disconnect()
  }, [])

  return (
    <div
      className={`sa-settle ${className}`}
      style={{ height, overflow: moving ? 'hidden' : undefined }}
      onTransitionEnd={(e) => e.propertyName === 'height' && setMoving(false)}
    >
      <div ref={inner} className={innerClassName}>{children}</div>
    </div>
  )
}
