// Allocations whose range overlaps { from, to } (to exclusive), spread over the working days of the allocated
// person's calendar. The spread uses the whole range — an allocation of 80 hours over 10 working days is 8 hours a
// day, however little of it falls inside the span asked — and only the days inside the span are returned.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONDAY_TO_FRIDAY = { sunday: 'F', monday: 'T', tuesday: 'T', wednesday: 'T', thursday: 'T', friday: 'T', saturday: 'F' }
const DAY = 86400000
const PAGE = 4000   // the NetSuite bridge returns at most 5,000 rows a query, so larger reads are paged by id

async function paged(ctx, sql, params) {
  const all = []
  for (let after = 0; ;) {
    const page = await ctx.query('F5NETSUITE', `${sql} AND ra.id > ${after} ORDER BY ra.id FETCH FIRST ${PAGE} ROWS ONLY`, params)
    all.push(...page)
    if (page.length < PAGE) return all
    after = Number(page[page.length - 1].allocation_id)
  }
}

export default async (ctx, { from, to }) => {
  const allocations = await paged(ctx, `
    SELECT ra.id                                   AS allocation_id,
           TO_CHAR(ra.startdate, 'YYYY-MM-DD')     AS start_date,
           TO_CHAR(ra.enddate, 'YYYY-MM-DD')       AS end_date,
           TO_NUMBER(ra.numberhours)               AS total_hours,
           TO_NUMBER(ra.custevent_f5_billing_rate) AS rate,
           CASE ra.allocationtype WHEN 1 THEN 'Hard' WHEN 2 THEN 'Soft' END AS commitment,
           ra.custevent_f5_ra_billable             AS billable,
           ra.allocationresource                   AS resource_id,
           BUILTIN.DF(ra.allocationresource)       AS resource_name,
           e.subsidiary                            AS resource_subsidiary_id,
           BUILTIN.DF(e.subsidiary)                AS resource_subsidiary_name,
           e.department                            AS resource_department_id,
           BUILTIN.DF(e.department)                AS resource_department_name,
           e.title                                 AS resource_title,
           e.workcalendar                          AS calendar_id,
           j.id                                    AS project_id,
           j.entityid || ' ' || j.companyname      AS project_name,
           j.subsidiary                            AS project_subsidiary_id,
           BUILTIN.DF(j.subsidiary)                AS project_subsidiary_name,
           j.custentity_f5_prj_pillar              AS project_pillar_id,
           BUILTIN.DF(j.custentity_f5_prj_pillar)  AS project_pillar_name,
           j.entitystatus                          AS project_status_id,
           BUILTIN.DF(j.entitystatus)              AS project_status_name,
           j.jobtype                               AS project_type_id,
           t.name                                  AS project_type_name,
           j.customer                              AS customer_id,
           BUILTIN.DF(j.customer)                  AS customer_name,
           c.symbol                                AS currency_code
      FROM resourceallocation ra
      JOIN job j ON j.id = ra.project
      LEFT JOIN employee e ON e.id = ra.allocationresource
      LEFT JOIN jobtype t ON t.id = j.jobtype
      LEFT JOIN currency c ON c.id = j.currency
     WHERE ra.startdate < TO_DATE(@to, 'YYYY-MM-DD') AND ra.enddate >= TO_DATE(@from, 'YYYY-MM-DD')`, { from, to })
  if (!allocations.length) return { source: 'F5NETSUITE', rows: [] }

  const earliest = allocations.reduce((m, a) => (a.start_date < m ? a.start_date : m), from)
  const latest = allocations.reduce((m, a) => (a.end_date > m ? a.end_date : m), to)
  const calendars = new Map((await ctx.query('F5NETSUITE', `
    SELECT id, sunday, monday, tuesday, wednesday, thursday, friday, saturday FROM workcalendar`)).map((c) => [String(c.id), c]))
  const holidays = new Set((await ctx.query('F5NETSUITE', `
    SELECT workcalendar AS calendar_id, TO_CHAR(exceptiondate, 'YYYY-MM-DD') AS day
      FROM workcalendarholiday
     WHERE exceptiondate >= TO_DATE(@earliest, 'YYYY-MM-DD') AND exceptiondate <= TO_DATE(@latest, 'YYYY-MM-DD')`, { earliest, latest }))
    .map((h) => `${h.calendar_id}|${h.day}`))

  const worked = (calendarId, t) => {
    const week = calendars.get(String(calendarId)) ?? MONDAY_TO_FRIDAY
    const day = new Date(t)
    return week[WEEKDAYS[day.getUTCDay()]] === 'T' && !holidays.has(`${calendarId}|${day.toISOString().slice(0, 10)}`)
  }
  const spanStart = Date.parse(from + 'T00:00:00Z'), spanEnd = Date.parse(to + 'T00:00:00Z')
  const rows = []
  for (const a of allocations) {
    const start = Date.parse(a.start_date + 'T00:00:00Z'), end = Date.parse(a.end_date + 'T00:00:00Z')
    const days = []
    for (let t = start; t <= end; t += DAY) if (worked(a.calendar_id, t)) days.push(t)
    if (!days.length) continue   // a range with no working day on the person's calendar places no hours
    const { start_date, end_date, total_hours, calendar_id, ...attributes } = a
    const perDay = Number(total_hours ?? 0) / days.length
    for (const t of days) {
      if (t < spanStart || t >= spanEnd) continue
      rows.push({ ...attributes, work_date: new Date(t).toISOString().slice(0, 10), hours: perDay })
    }
  }
  return { source: 'F5NETSUITE', rows }
}
