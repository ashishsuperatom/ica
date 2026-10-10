// What is running for the person, and what ran lately: one list, read once and kept current by the live feed, for the
// sidebar's activity and the activity page alike.
import { useEffect, useState } from 'react'
import type { Request } from './threadSource'

export interface Activity { id: string; state: string; title?: string; progress?: string; detail?: string; updated_at?: string; updatedAt?: string }

/** A line written in Markdown, as words: emphasis marks and an old session id left out. */
export const asWords = (s: unknown) => String(s ?? '').replace(/\s+in session ses-[\w-]+/g, '').replace(/\*\*|__|`/g, '').replace(/(^|\s)_([^_]+)_(?=\s|[.,;:!?]|$)/g, '$1$2').trim()

/** When it last changed, as a moment. */
export const updatedOf = (a: Activity) => a.updated_at ?? a.updatedAt

/** The person's activities: null until read, then newest first, at most 100. */
export function useActivities(request: Request, subscribeLive: (fn: (m: any) => void) => () => void): Activity[] | null {
  const [rows, setRows] = useState<Activity[] | null>(null)
  useEffect(() => { void request({ t: 'activity:list' }).then((r: any) => setRows(Array.isArray(r?.activities) ? r.activities.filter((a: any) => a && typeof a.id === 'string') : [])) }, [request])
  useEffect(() => subscribeLive((m) => {
    if (m?.t === 'activity' && typeof m.activity?.id === 'string') setRows((prev) => [m.activity as Activity, ...(prev ?? []).filter((x) => x.id !== m.activity.id)].slice(0, 100))
  }), [subscribeLive])
  return rows
}
