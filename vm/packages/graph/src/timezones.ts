// ── TIME ZONES: WHICH DAY A MOMENT BELONGS TO ─────────────────────────────────────────────────────────────
//
// Two things depend on a time zone, and they are kept apart.
//
//   TODAY is the date where the person asking is. At 9am in Auckland it is still yesterday in London, and "this
//   month to date" must not lose a day. The zone is the assumption named `timezone` — from the caller, or the
//   organisation, as rules when it differs by person or group.
//
//   A TIMESTAMP belongs to a day only in some zone. A relation whose time column holds moments, not calendar
//   dates, says which zone they are written in (`timeZone` in its shape); a question asked in another zone sees
//   them moved into its own before they are bounded by a span or grouped by day, week or month. A column of
//   calendar dates declares no zone and is never moved: a day recorded as 14 September is that day everywhere.
//
// Sources differ in what they can convert — SuiteQL has no time-zone functions at all — so the conversion is
// arithmetic every source runs: the difference between the two zones is worked out here for each stretch of the
// span between daylight-saving changes, and the SQL adds the right number of minutes for the stretch a moment falls
// in. Exact across a change, on any dialect.

export function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); return true } catch { return false }
}

/** The date in a zone at an instant. */
export function dayIn(zone: string, instant = new Date()): string {
  return instant.toLocaleDateString('en-CA', { timeZone: zone })
}

/** Minutes a zone is ahead of UTC at an instant. */
export function offsetMinutes(zone: string, instant: Date): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant).map((p) => [p.type, p.value]))
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return Math.round((local - Math.floor(instant.getTime() / 1000) * 1000) / 60000)
}

/** A moment written as local time in a zone, `YYYY-MM-DD HH:MM:SS`. */
function localTime(zone: string, instant: Date): string {
  const shifted = new Date(instant.getTime() + offsetMinutes(zone, instant) * 60000)
  return shifted.toISOString().slice(0, 19).replace('T', ' ')
}

export interface Stretch {
  /** The local time, in the column's zone, before which this stretch applies; null for the last. */
  until: string | null
  /** Minutes to add to a moment written in the column's zone to write it in the question's zone. */
  minutes: number
}

/** How to move moments from one zone to another across a span of days, stretch by stretch. The span is widened by
 *  two days each side, so a moment near its edge is moved correctly before it is bounded. */
export function stretches(from: string, to: string, span: { from: string; to: string }): Stretch[] {
  const start = Date.parse(`${span.from}T00:00:00Z`) - 2 * 864e5
  const end = Date.parse(`${span.to}T00:00:00Z`) + 2 * 864e5
  const delta = (t: number) => offsetMinutes(to, new Date(t)) - offsetMinutes(from, new Date(t))
  const out: Stretch[] = []
  let current = delta(start)
  const HOUR = 36e5
  for (let t = start + HOUR; t <= end; t += HOUR) {
    const d = delta(t)
    if (d === current) continue
    // The change happened within the last hour: find the minute.
    let lo = t - HOUR, hi = t
    while (hi - lo > 60000) { const mid = lo + Math.floor((hi - lo) / 120000) * 60000; if (delta(mid) === current) lo = mid; else hi = mid }
    out.push({ until: localTime(from, new Date(hi)), minutes: current })
    current = d
  }
  out.push({ until: null, minutes: current })
  return out
}
