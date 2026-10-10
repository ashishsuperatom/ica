// Moments and sizes the way the screens say them, one way everywhere: how long ago, a day and time, a day, a size.
// A moment may be epoch milliseconds, an ISO string or a Date; nothing (or something unreadable) reads as `none`.
// In the reader's own locale and time zone — these are about when something happened to them, not the data's dates
// (those go through `date`/`fmt` in the project's format).

type Moment = number | string | Date | null | undefined

const toMs = (t: Moment): number | null => {
  if (t === null || t === undefined || t === '') return null
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t)
  return Number.isFinite(ms) ? ms : null
}

/** How long ago: "just now", "4 min ago", "3 h ago", "2 d ago"; a week or more is the day itself. */
export function ago(t: Moment, none = '—'): string {
  const ms = toMs(t)
  if (ms === null) return none
  const m = Math.round((Date.now() - ms) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (m < 1440) return `${Math.round(m / 60)} h ago`
  if (m < 7 * 1440) return `${Math.round(m / 1440)} d ago`
  return day(ms)
}

/** A day and time: "10 Oct 2026, 14:05". */
export function dateTime(t: Moment, none = '—'): string {
  const ms = toMs(t)
  return ms === null ? none : new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A day: "10 Oct 2026". */
export function day(t: Moment, none = '—'): string {
  const ms = toMs(t)
  return ms === null ? none : new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** A size: "980 B", "12.4 KB", "3.1 MB", "1.2 GB". */
export function bytes(n: number | null | undefined, none = '—'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return none
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}
