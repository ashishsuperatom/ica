// A STOCK: one row per person employed as at @asAt.
//
// Employment as at a date is hire date to release date. The active flag cannot be used — it says who is
// employed today, not who was employed then. Not every employee record is a person: system accounts and
// placeholders have no first name. Working hours are as recorded today, over a 40-hour week.
export default (ctx, { asAt }) => ({
  source: 'F5NETSUITE',
  sql: `
    SELECT e.id                                                        AS employee_id,
           e.entityid                                                  AS employee_name,
           e.department                                                AS pillar_id,
           d.name                                                      AS pillar_name,
           e.subsidiary                                                AS subsidiary_id,
           s.name                                                      AS subsidiary_name,
           TO_NUMBER(NVL(e.custentity_f5_emp_working_hrs, '0')) / 40   AS fte
      FROM employee e
      LEFT JOIN department d ON d.id = e.department
      LEFT JOIN subsidiary s ON s.id = e.subsidiary
     WHERE e.firstname IS NOT NULL
       AND NVL(e.hiredate, e.datecreated) <= TO_DATE(@asAt, 'YYYY-MM-DD')
       AND (e.releasedate IS NULL OR e.releasedate > TO_DATE(@asAt, 'YYYY-MM-DD'))`,
  params: { asAt },
})
