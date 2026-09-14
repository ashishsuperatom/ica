// Built from the calendars' weekday flags and their holidays, for the days in { from, to } (to exclusive).
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY = 86400000

export default async (ctx, { from, to }) => {
  const calendars = await ctx.query('F5NETSUITE', `
    SELECT id, name, sunday, monday, tuesday, wednesday, thursday, friday, saturday, TO_NUMBER(workhoursperday) AS hours
      FROM workcalendar`)
  const holidays = await ctx.query('F5NETSUITE', `
    SELECT workcalendar AS calendar_id, TO_CHAR(exceptiondate, 'YYYY-MM-DD') AS day
      FROM workcalendarholiday
     WHERE exceptiondate >= TO_DATE(@from, 'YYYY-MM-DD') AND exceptiondate < TO_DATE(@to, 'YYYY-MM-DD')`, { from, to })
  const off = new Set(holidays.map((h) => `${h.calendar_id}|${h.day}`))
  const rows = []
  for (let t = Date.parse(from + 'T00:00:00Z'); t < Date.parse(to + 'T00:00:00Z'); t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10)
    const weekday = WEEKDAYS[new Date(t).getUTCDay()]
    for (const c of calendars) {
      if (c[weekday] !== 'T' || off.has(`${c.id}|${day}`)) continue
      rows.push({ calendar_id: String(c.id), calendar_name: c.name, work_date: day, hours: Number(c.hours) })
    }
  }
  return { source: 'F5NETSUITE', rows }
}
