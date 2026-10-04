// Pointing at the same thing in two places at once.
//
// A ring and the figures beside it are one picture drawn twice, but they are different technologies — the ring is a
// canvas ECharts owns, the list is HTML — so neither knows when the pointer is over the other's version of the same
// slice. This is the wire between them: a named channel that carries "the thing being pointed at is called X", and
// both ends listen.
//
// Deliberately not React state. The ring was rebuilt eight times over a flicker whose real cause was the page
// re-rendering under the cursor, and hover is the most frequent render there is: a `useState` in the card would put
// the chart back in exactly that position, thirty times a second. So the channel is a plain emitter, the list keeps
// its own state because a list can afford to re-render, and the chart subscribes and calls `dispatchAction` without
// rendering at all.
//
// A channel is named by the caller (the same name the chart remembers its legend under), so two rings on one screen
// never speak to each other.

import { useEffect, useState } from 'react'

type Listener = (name: string | null) => void

const channels = new Map<string, Set<Listener>>()

/** Say what is being pointed at, or null for nothing. */
export function setHighlight(channel: string | undefined, name: string | null) {
  if (!channel) return
  for (const listen of channels.get(channel) ?? []) listen(name)
}

/** Listen without rendering: for whatever draws itself, like a chart. Returns the way to stop. */
export function onHighlight(channel: string | undefined, listen: Listener): () => void {
  if (!channel) return () => {}
  const set = channels.get(channel) ?? new Set<Listener>()
  channels.set(channel, set)
  set.add(listen)
  return () => {
    set.delete(listen)
    if (!set.size) channels.delete(channel)
  }
}

/** Listen as a component: for a list, which can afford to re-render. */
export function useHighlighted(channel?: string): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => onHighlight(channel, setName), [channel])
  return name
}

/**
 * The props a row needs to join in: point at it and the chart lights up its slice, and it lights up when the pointer
 * is over that slice on the chart. Focus counts as pointing, so this works from the keyboard too.
 */
export function pointsAt(channel: string | undefined, name: string) {
  return {
    onMouseEnter: () => setHighlight(channel, name),
    onMouseLeave: () => setHighlight(channel, null),
    onFocus: () => setHighlight(channel, name),
    onBlur: () => setHighlight(channel, null),
  }
}
