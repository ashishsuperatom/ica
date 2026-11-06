// WHETHER AN ELEMENT IS ON SCREEN — once it has been, it stays so (what waits for it to be seen runs once).
import { createContext, useEffect, useState, type RefObject } from 'react'

/** Whether what is inside has been seen yet — given by whatever waits for it (an answer's part, Answer.tsx RevealPart);
 *  a component that draws itself in (a chart) waits for it. Outside any such wrapper: seen. */
export const SeenContext = createContext(true)

/** True from the moment the element (or, for one drawn as `display: contents`, its first child) is first in view. */
export function useSeen(ref: RefObject<HTMLElement | null>, margin = '0px 0px -10% 0px'): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen) return
    const host = ref.current
    const el = (host && getComputedStyle(host).display === 'contents' ? host.firstElementChild : host) as HTMLElement | null
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect() } }, { rootMargin: margin })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen, margin])
  return seen
}
