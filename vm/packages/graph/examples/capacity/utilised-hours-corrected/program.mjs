// A FLOW: one row per utilised time entry between @from and @to.
//
// Actual time only. A timebill row is Actual (A), Allocated (B) or Planned (P) time. Allocated and planned
// hours are intentions recorded against the same people and days; counting them adds a second and third copy.
//
// The same population as fte — people, not system accounts — so the two can be compared.
export default (ctx, { from, to }) => ({
  source: 'F5NETSUITE',
  sql: `
    SELECT tb.trandate             AS worked_on,
           e.id                    AS employee_id,
           e.entityid              AS employee_name,
           e.department            AS pillar_id,
           d.name                  AS pillar_name,
           e.subsidiary            AS subsidiary_id,
           s.name                  AS subsidiary_name,
           tb.isbillable           AS billable,
           TO_NUMBER(tb.hours)     AS hours
      FROM timebill tb
      JOIN employee e ON e.id = tb.employee
      LEFT JOIN department d ON d.id = e.department
      LEFT JOIN subsidiary s ON s.id = e.subsidiary
     WHERE tb.isutilized = 'T'
       AND tb.timetype = 'A'
       AND e.firstname IS NOT NULL
       AND tb.trandate >= TO_DATE(@from, 'YYYY-MM-DD')
       AND tb.trandate <  TO_DATE(@to, 'YYYY-MM-DD')`,
  params: { from, to },
})
