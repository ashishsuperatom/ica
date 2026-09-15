// Allocations overlapping the span, each spread evenly over the weekdays (Monday to Friday) of its own range — 80 hours
// over 10 weekdays is 8 a day — and only the days inside the span kept. An allocation on weekend days only is placed on
// its first day. Which allocations count as on a real project is the graph's "valid project" condition.
//
// Revenue is projected from billable allocations only: hours × the allocation's charge-out rate, except on Milestone
// Fixed Price and Prepayment projects, which are priced at the project's forecasting rate (custentity9) when it has
// one. Billable hours with no rate are unpriced; non-billable hours carry no revenue.
const DAY = 86400000
const PAGE = 4000
const OVERRIDE_TYPES = "('Milestone Fixed Price', 'Prepayment')"

export default async (ctx, { from, to }) => {
  const allocations = []
  for (let after = 0; ;) {
    const page = await ctx.query('F5NETSUITE', `
      SELECT ra.id AS id, TO_CHAR(ra.startdate, 'YYYY-MM-DD') AS start_date, TO_CHAR(ra.enddate, 'YYYY-MM-DD') AS end_date,
             TO_NUMBER(ra.numberhours) AS total_hours,
             CASE WHEN jt.name IN ${OVERRIDE_TYPES} THEN COALESCE(TO_NUMBER(j.custentity9), TO_NUMBER(ra.custevent_f5_billing_rate))
                  ELSE TO_NUMBER(ra.custevent_f5_billing_rate) END AS rate,
             CASE ra.allocationtype WHEN 1 THEN 'Hard' WHEN 2 THEN 'Soft' END AS commitment,
             COALESCE(ra.custevent_f5_ra_billable, 'F') AS billable, ra.allocationresource AS person_id, ra.project AS project_id
        FROM resourceallocation ra
        LEFT JOIN job j ON j.id = ra.project
        LEFT JOIN jobtype jt ON jt.id = j.jobtype
       WHERE ra.startdate < TO_DATE(@to, 'YYYY-MM-DD') AND ra.enddate >= TO_DATE(@from, 'YYYY-MM-DD') AND ra.id > @after
       ORDER BY ra.id FETCH FIRST ${PAGE} ROWS ONLY`, { from, to, after })
    allocations.push(...page)
    if (page.length < PAGE) break
    after = Number(page[page.length - 1].id)
  }

  const start = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z')
  const rows = new Map()
  for (const a of allocations) {
    if (!a.commitment) continue
    const first = Date.parse(a.start_date + 'T00:00:00Z'), last = Date.parse(a.end_date + 'T00:00:00Z')
    const days = []
    for (let t = first; t <= last; t += DAY) { const d = new Date(t).getUTCDay(); if (d >= 1 && d <= 5) days.push(t) }
    if (!days.length) days.push(first)
    const perDay = Number(a.total_hours ?? 0) / days.length
    const billable = a.billable === 'T'
    const rate = billable ? Number(a.rate ?? 0) : 0
    for (const t of days) {
      if (t < start || t >= end) continue
      const day = new Date(t).toISOString().slice(0, 10)
      const key = `${a.person_id}|${a.project_id}|${day}|${a.commitment}|${a.billable}`
      const row = rows.get(key) ?? { person_id: String(a.person_id), project_id: String(a.project_id), day, commitment: a.commitment, billable: a.billable, hours: 0, revenue: 0, unpriced_hours: 0 }
      row.hours += perDay
      if (rate > 0) row.revenue += perDay * rate
      else if (billable) row.unpriced_hours += perDay
      rows.set(key, row)
    }
  }
  return [...rows.values()]
}
