// Every employee record with a name, active or not: filter on active for current staff. @asAt is when the question
// reads them; the fields are as recorded today, so a person counts once they were hired on or before that day.
export default (ctx, { asAt }) => ({
  source: 'F5NETSUITE',
  sql: `
    SELECT e.id                              AS employee_id,
           e.firstname || ' ' || e.lastname  AS employee_name,
           e.subsidiary                      AS subsidiary_id,
           BUILTIN.DF(e.subsidiary)          AS subsidiary_name,
           e.department                      AS department_id,
           BUILTIN.DF(e.department)          AS department_name,
           e.supervisor                      AS manager_id,
           BUILTIN.DF(e.supervisor)          AS manager_name,
           e.title                           AS title,
           e.custentity_f5_contractor        AS is_contractor,
           CASE WHEN e.isinactive = 'F' THEN 'T' ELSE 'F' END AS is_active,
           e.workcalendar                    AS calendar_id,
           BUILTIN.DF(e.workcalendar)        AS calendar_name,
           c.symbol                          AS cost_currency,
           TO_NUMBER(e.laborcost)            AS labour_cost
      FROM employee e
      LEFT JOIN subsidiary s ON s.id = e.subsidiary
      LEFT JOIN currency c ON c.id = s.currency
     WHERE e.firstname IS NOT NULL
       AND NVL(e.hiredate, e.datecreated) < TO_DATE(@asAt, 'YYYY-MM-DD') + 1`,
  params: { asAt },
})
